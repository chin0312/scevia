import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { ServerConfig } from '../config.js'
import type { Database } from '../db/client.js'
import {
  cashBalanceSnapshots,
  cashMovements,
  dataCoverage,
  events,
  fills,
  instruments,
  markets,
  portfolios,
  positionSnapshots,
  providerAccounts,
  settlements,
  sourceRecords,
  syncRuns,
} from '../db/schema.js'
import { ProviderAdapterError } from '../providers/adapter.js'
import { ProviderRegistry, providerRegistry } from '../providers/registry.js'
import { IngestionError, SyncAlreadyRunningError } from '../ingestion/errors.js'
import { IngestionService } from '../ingestion/sync.js'
import { matchesDevelopmentBearer } from './auth.js'

export interface AppOptions {
  config: ServerConfig
  database: Database
  registry?: ProviderRegistry
}

interface PageQuery {
  limit: number
  offset: number
}

interface PortfolioParams {
  portfolioId: string
}

interface AccountParams {
  accountId: string
}

declare module 'fastify' {
  interface FastifyRequest {
    principalId: string | null
  }
}

const uuidSchema = { type: 'string', format: 'uuid' }
const paginationQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    offset: { type: 'integer', minimum: 0, maximum: 100_000, default: 0 },
  },
}
const portfolioParamsSchema = {
  type: 'object',
  required: ['portfolioId'],
  additionalProperties: false,
  properties: { portfolioId: uuidSchema },
}
const accountParamsSchema = {
  type: 'object',
  required: ['accountId'],
  additionalProperties: false,
  properties: { accountId: uuidSchema },
}
const errorResponseSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
      },
    },
  },
}
const paginationResponseProperties = {
  pagination: {
    type: 'object',
    required: ['limit', 'offset', 'returned'],
    properties: {
      limit: { type: 'integer' },
      offset: { type: 'integer' },
      returned: { type: 'integer' },
    },
  },
}
const authSchema = { security: [{ bearerAuth: [] }] }

function paginatedSchema(itemProperties: Record<string, unknown>) {
  return {
    type: 'object',
    required: ['items', 'pagination'],
    properties: {
      items: { type: 'array', items: { type: 'object', properties: itemProperties } },
      ...paginationResponseProperties,
    },
  }
}

function pagination(limit: number, offset: number, returned: number) {
  return { limit, offset, returned }
}

function errorBody(requestId: string, code: string, message: string) {
  return { error: { code, message, requestId } }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const registry = options.registry ?? providerRegistry
  const ingestion = new IngestionService(options.database, registry)
  const app = Fastify({
    logger: {
      level: options.config.nodeEnv === 'test' ? 'silent' : 'info',
      redact: ['req.headers.authorization', 'headers.authorization'],
    },
    bodyLimit: 256_000,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    trustProxy: false,
  })
  app.decorateRequest('principalId', null)

  await app.register(cors, {
    credentials: false,
    origin: (origin, callback) => callback(null, origin !== undefined && options.config.corsOrigins.includes(origin)),
  })
  await app.register(rateLimit, { global: true, max: 100, timeWindow: '1 minute' })
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Scevia API',
        description: 'Read-only portfolio data API. Development bearer authentication is enabled only outside production.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
  })
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    uiConfig: { docExpansion: 'list', deepLinking: false },
  })

  app.setNotFoundHandler((request, reply) => reply.code(404).send(
    errorBody(request.id, 'not_found', 'The requested resource was not found.'),
  ))
  app.setErrorHandler<FastifyError & { validation?: unknown }>((error, request, reply) => {
    if (error.validation) {
      return reply.code(400).send(errorBody(request.id, 'invalid_request', 'The request did not match the API schema.'))
    }
    if (error.statusCode === 429) {
      return reply.code(429).send(errorBody(request.id, 'rate_limited', 'Too many requests.'))
    }
    request.log.error({ requestId: request.id, errorName: error.name }, 'request failed')
    return reply.code(500).send(errorBody(request.id, 'internal_error', 'The request could not be completed.'))
  })

  app.get('/healthz', {
    schema: {
      tags: ['operations'],
      summary: 'Check whether the API process is alive',
      response: { 200: { type: 'object', properties: { status: { type: 'string' } } } },
    },
  }, async () => ({ status: 'ok' }))

  app.get('/readyz', {
    schema: {
      tags: ['operations'],
      summary: 'Check whether the database is reachable',
      response: {
        200: { type: 'object', properties: { status: { type: 'string' } } },
        503: errorResponseSchema,
      },
    },
  }, async (_request, reply) => {
    try {
      await options.database.execute(sql`select 1`)
      return { status: 'ready' }
    } catch {
      return reply.code(503).send(errorBody(reply.request.id, 'database_unavailable', 'The database is unavailable.'))
    }
  })

  app.get('/v1/providers', {
    schema: {
      tags: ['providers'],
      summary: 'List fixture adapters and their declared capabilities',
      response: {
        200: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  providerCode: { type: 'string' },
                  displayName: { type: 'string' },
                  adapterKind: { type: 'string' },
                  accountKinds: { type: 'array', items: { type: 'string' } },
                  operations: { type: 'object', additionalProperties: { type: 'string' } },
                  streams: {
                    type: 'array', items: {
                      type: 'object', required: ['name', 'entities', 'strategy', 'snapshotSemantics'],
                      properties: {
                        name: { type: 'string' },
                        entities: { type: 'array', items: { type: 'string' } },
                        strategy: { type: 'string', enum: ['full_refresh', 'provider_checkpoint'] },
                        snapshotSemantics: { type: 'object', additionalProperties: { type: 'string', enum: ['complete', 'incremental'] } },
                      },
                    },
                  },
                  pagination: { type: 'string' },
                  incrementalSync: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => ({ items: registry.listCapabilities() }))

  await app.register(async (privateApi) => {
    privateApi.addHook('preHandler', async (request, reply) => {
      if (!options.config.devAuthToken || !options.config.devPrincipalId) {
        return reply.code(503).send(errorBody(request.id, 'authentication_unavailable', 'Authentication is not configured.'))
      }
      if (!matchesDevelopmentBearer(request.headers.authorization, options.config.devAuthToken)) {
        return reply.code(401).send(errorBody(request.id, 'unauthorized', 'A valid bearer token is required.'))
      }
      request.principalId = options.config.devPrincipalId
    })

    privateApi.get('/portfolios', {
      schema: {
        ...authSchema,
        tags: ['portfolios'],
        summary: 'List portfolios belonging to the authenticated principal',
        response: {
          200: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object', properties: {
                id: uuidSchema,
                name: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
                providerAccountCount: { type: 'integer' },
              } } },
            },
          },
        },
      },
    }, async (request) => {
      const rows = await options.database.select({
        id: portfolios.id,
        name: portfolios.name,
        createdAt: portfolios.createdAt,
      }).from(portfolios).where(eq(portfolios.ownerId, request.principalId!)).orderBy(portfolios.createdAt)
      const items = await Promise.all(rows.map(async (portfolio) => {
        const [accountCount] = await options.database.select({ count: sql<number>`count(*)::int` })
          .from(providerAccounts).where(eq(providerAccounts.portfolioId, portfolio.id))
        return { ...portfolio, providerAccountCount: accountCount?.count ?? 0 }
      }))
      return { items }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: PageQuery }>('/portfolios/:portfolioId/positions', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List the latest provider-reported or reconstructed position snapshots',
        params: portfolioParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema({
            id: uuidSchema,
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            sourceLabel: { type: 'string' },
            eventId: uuidSchema,
            eventName: { type: 'string' },
            marketId: uuidSchema,
            marketTitle: { type: 'string' },
            instrumentId: uuidSchema,
            outcomeName: { type: 'string' },
            outcomeType: { type: 'string' },
            quantity: { type: 'string' },
            averageCostPrice: { type: ['string', 'null'] },
            markPrice: { type: ['string', 'null'] },
            markAt: { type: ['string', 'null'], format: 'date-time' },
            settlementAssetCode: { type: ['string', 'null'] },
            reconciliationStatus: { type: 'string' },
            origin: { type: 'string' },
            observedAt: { type: 'string', format: 'date-time' },
            retrievedAt: { type: 'string', format: 'date-time' },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const items = await options.database.selectDistinctOn(
        [positionSnapshots.providerAccountId, positionSnapshots.instrumentId],
        {
          id: positionSnapshots.id,
          providerAccountId: providerAccounts.id,
          providerCode: providerAccounts.providerCode,
          sourceLabel: providerAccounts.label,
          eventId: events.id,
          eventName: events.name,
          marketId: markets.id,
          marketTitle: markets.title,
          instrumentId: instruments.id,
          outcomeName: instruments.outcomeName,
          outcomeType: instruments.outcomeType,
          quantity: positionSnapshots.quantity,
          averageCostPrice: positionSnapshots.averageCostPrice,
          markPrice: positionSnapshots.markPrice,
          markAt: positionSnapshots.markAt,
          settlementAssetCode: positionSnapshots.settlementAssetCode,
          reconciliationStatus: positionSnapshots.reconciliationStatus,
          origin: positionSnapshots.origin,
          observedAt: positionSnapshots.observedAt,
          retrievedAt: positionSnapshots.ingestedAt,
        },
      ).from(positionSnapshots)
        .innerJoin(providerAccounts, eq(positionSnapshots.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .innerJoin(instruments, eq(positionSnapshots.instrumentId, instruments.id))
        .innerJoin(markets, eq(instruments.marketId, markets.id))
        .innerJoin(events, eq(markets.eventId, events.id))
        .innerJoin(sourceRecords, eq(positionSnapshots.sourceRecordId, sourceRecords.id))
        .where(and(eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!), eq(positionSnapshots.isCurrent, true)))
        .orderBy(positionSnapshots.providerAccountId, positionSnapshots.instrumentId)
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: PageQuery }>('/portfolios/:portfolioId/fills', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List fills with source fee availability and market metadata',
        params: portfolioParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema({
            id: uuidSchema,
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            externalId: { type: 'string' },
            eventName: { type: 'string' },
            marketTitle: { type: 'string' },
            outcomeName: { type: 'string' },
            direction: { type: 'string' },
            occurredAt: { type: 'string', format: 'date-time' },
            quantity: { type: 'string' },
            price: { type: 'string' },
            feeAmount: { type: ['string', 'null'] },
            feeStatus: { type: 'string' },
            settlementAssetCode: { type: 'string' },
            finality: { type: 'string' },
            retrievedAt: { type: 'string', format: 'date-time' },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const items = await options.database.select({
        id: fills.id,
        providerAccountId: providerAccounts.id,
        providerCode: providerAccounts.providerCode,
        externalId: fills.externalId,
        eventName: events.name,
        marketTitle: markets.title,
        outcomeName: instruments.outcomeName,
        direction: fills.direction,
        occurredAt: fills.occurredAt,
        quantity: fills.quantity,
        price: fills.price,
        feeAmount: fills.feeAmount,
        feeStatus: fills.feeStatus,
        settlementAssetCode: fills.settlementAssetCode,
        finality: fills.finality,
        retrievedAt: sourceRecords.retrievedAt,
      }).from(fills)
        .innerJoin(providerAccounts, eq(fills.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .innerJoin(instruments, eq(fills.instrumentId, instruments.id))
        .innerJoin(markets, eq(instruments.marketId, markets.id))
        .innerJoin(events, eq(markets.eventId, events.id))
        .innerJoin(sourceRecords, eq(fills.sourceRecordId, sourceRecords.id))
        .where(and(eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!)))
        .orderBy(desc(fills.occurredAt), desc(fills.id))
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: PageQuery }>('/portfolios/:portfolioId/cash-movements', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List signed deposits, withdrawals, transfers, and adjustments',
        params: portfolioParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema({
            id: uuidSchema,
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            externalId: { type: 'string' },
            movementKind: { type: 'string' },
            occurredAt: { type: 'string', format: 'date-time' },
            signedAmount: { type: 'string' },
            assetCode: { type: 'string' },
            feeAmount: { type: ['string', 'null'] },
            feeStatus: { type: 'string' },
            retrievedAt: { type: 'string', format: 'date-time' },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const items = await options.database.select({
        id: cashMovements.id,
        providerAccountId: providerAccounts.id,
        providerCode: providerAccounts.providerCode,
        externalId: cashMovements.externalId,
        movementKind: cashMovements.movementKind,
        occurredAt: cashMovements.occurredAt,
        signedAmount: cashMovements.signedAmount,
        assetCode: cashMovements.assetCode,
        feeAmount: cashMovements.feeAmount,
        feeStatus: cashMovements.feeStatus,
        retrievedAt: sourceRecords.retrievedAt,
      }).from(cashMovements)
        .innerJoin(providerAccounts, eq(cashMovements.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .innerJoin(sourceRecords, eq(cashMovements.sourceRecordId, sourceRecords.id))
        .where(and(eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!)))
        .orderBy(desc(cashMovements.occurredAt), desc(cashMovements.id))
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: PageQuery }>('/portfolios/:portfolioId/settlements', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List realized settlement records and reported fee coverage',
        params: portfolioParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema({
            id: uuidSchema,
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            externalId: { type: 'string' },
            marketTitle: { type: 'string' },
            outcomeName: { type: 'string' },
            settledAt: { type: 'string', format: 'date-time' },
            quantity: { type: 'string' },
            payoutAmount: { type: 'string' },
            assetCode: { type: 'string' },
            feeAmount: { type: ['string', 'null'] },
            feeStatus: { type: 'string' },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const items = await options.database.select({
        id: settlements.id,
        providerAccountId: providerAccounts.id,
        providerCode: providerAccounts.providerCode,
        externalId: settlements.externalId,
        marketTitle: markets.title,
        outcomeName: instruments.outcomeName,
        settledAt: settlements.settledAt,
        quantity: settlements.quantity,
        payoutAmount: settlements.payoutAmount,
        assetCode: settlements.assetCode,
        feeAmount: settlements.feeAmount,
        feeStatus: settlements.feeStatus,
      }).from(settlements)
        .innerJoin(providerAccounts, eq(settlements.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .innerJoin(instruments, eq(settlements.instrumentId, instruments.id))
        .innerJoin(markets, eq(instruments.marketId, markets.id))
        .where(and(eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!)))
        .orderBy(desc(settlements.settledAt), desc(settlements.id))
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: PageQuery }>('/portfolios/:portfolioId/cash-balances', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List the latest available cash balance per account and asset',
        params: portfolioParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema({
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            label: { type: 'string' },
            balance: { type: 'string' },
            assetCode: { type: 'string' },
            observedAt: { type: 'string', format: 'date-time' },
            retrievedAt: { type: 'string', format: 'date-time' },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const items = await options.database.selectDistinctOn(
        [cashBalanceSnapshots.providerAccountId, cashBalanceSnapshots.assetCode],
        {
          providerAccountId: providerAccounts.id,
          providerCode: providerAccounts.providerCode,
          label: providerAccounts.label,
          balance: cashBalanceSnapshots.balance,
          assetCode: cashBalanceSnapshots.assetCode,
          observedAt: cashBalanceSnapshots.observedAt,
          retrievedAt: cashBalanceSnapshots.ingestedAt,
        },
      ).from(cashBalanceSnapshots)
        .innerJoin(providerAccounts, eq(cashBalanceSnapshots.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .innerJoin(sourceRecords, eq(cashBalanceSnapshots.sourceRecordId, sourceRecords.id))
        .where(and(eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!), eq(cashBalanceSnapshots.isCurrent, true)))
        .orderBy(cashBalanceSnapshots.providerAccountId, cashBalanceSnapshots.assetCode)
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: PageQuery }>('/portfolios/:portfolioId/sources', {
      schema: {
        ...authSchema,
        tags: ['portfolios'],
        summary: 'List connected data sources without exposing provider account identifiers',
        params: portfolioParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema({
            id: uuidSchema,
            providerCode: { type: 'string' },
            label: { type: 'string' },
            kind: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            disabledAt: { type: ['string', 'null'], format: 'date-time' },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const items = await options.database.select({
        id: providerAccounts.id,
        providerCode: providerAccounts.providerCode,
        label: providerAccounts.label,
        kind: providerAccounts.kind,
        createdAt: providerAccounts.createdAt,
        disabledAt: providerAccounts.disabledAt,
      }).from(providerAccounts)
        .where(eq(providerAccounts.portfolioId, portfolio.id))
        .orderBy(providerAccounts.createdAt)
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: PageQuery }>('/portfolios/:portfolioId/coverage', {
      schema: {
        ...authSchema,
        tags: ['data coverage'],
        summary: 'Show available, partial, and unsupported data by source',
        params: portfolioParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema({
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            sourceLabel: { type: 'string' },
            entityType: { type: 'string' },
            status: { type: 'string' },
            reasonCode: { type: ['string', 'null'] },
            observedRecordStart: { type: ['string', 'null'], format: 'date-time' },
            observedRecordEnd: { type: ['string', 'null'], format: 'date-time' },
            coverageStart: { type: ['string', 'null'], format: 'date-time' },
            coverageEnd: { type: ['string', 'null'], format: 'date-time' },
            sourceAsOf: { type: ['string', 'null'], format: 'date-time' },
            lastAttemptAt: { type: ['string', 'null'], format: 'date-time' },
            lastAttemptStatus: { type: ['string', 'null'] },
            lastAttemptCoverageStatus: { type: ['string', 'null'] },
            lastAttemptReasonCode: { type: ['string', 'null'] },
            lastSuccessfulSyncAt: { type: ['string', 'null'], format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const items = await options.database.select({
        providerAccountId: providerAccounts.id,
        providerCode: providerAccounts.providerCode,
        sourceLabel: providerAccounts.label,
        entityType: dataCoverage.entityType,
        status: dataCoverage.status,
        reasonCode: dataCoverage.reasonCode,
        observedRecordStart: dataCoverage.observedRecordStart,
        observedRecordEnd: dataCoverage.observedRecordEnd,
        coverageStart: dataCoverage.coverageStart,
        coverageEnd: dataCoverage.coverageEnd,
        sourceAsOf: dataCoverage.sourceAsOf,
        lastAttemptAt: dataCoverage.lastAttemptAt,
        lastAttemptStatus: dataCoverage.lastAttemptStatus,
        lastAttemptCoverageStatus: dataCoverage.lastAttemptCoverageStatus,
        lastAttemptReasonCode: dataCoverage.lastAttemptReasonCode,
        lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
        updatedAt: dataCoverage.updatedAt,
      }).from(dataCoverage)
        .innerJoin(providerAccounts, eq(dataCoverage.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .where(and(eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!)))
        .orderBy(providerAccounts.providerCode, dataCoverage.entityType)
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: PageQuery }>('/portfolios/:portfolioId/sync-runs', {
      schema: {
        ...authSchema,
        tags: ['synchronization'],
        summary: 'List recent synchronization runs for a portfolio',
        params: portfolioParamsSchema,
        querystring: paginationQuerySchema,
        response: {
          200: paginatedSchema({
            id: uuidSchema,
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            syncName: { type: 'string' },
            status: { type: 'string' },
            startedAt: { type: 'string', format: 'date-time' },
            finishedAt: { type: ['string', 'null'], format: 'date-time' },
            pagesRead: { type: 'integer' },
            recordsSeen: { type: 'integer' },
            recordsRejected: { type: 'integer' },
            cursorAtStart: { type: ['string', 'null'] },
            cursorAtEnd: { type: ['string', 'null'] },
            checkpointAtStart: { type: ['string', 'null'] },
            checkpointAtEnd: { type: ['string', 'null'] },
            positionSnapshotComplete: { type: 'boolean' },
            cashBalanceSnapshotComplete: { type: 'boolean' },
            errorCode: { type: ['string', 'null'] },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const items = await options.database.select({
        id: syncRuns.id,
        providerAccountId: providerAccounts.id,
        providerCode: providerAccounts.providerCode,
        syncName: syncRuns.syncName,
        status: syncRuns.status,
        startedAt: syncRuns.startedAt,
        finishedAt: syncRuns.finishedAt,
        pagesRead: syncRuns.pagesRead,
        recordsSeen: syncRuns.recordsSeen,
        recordsRejected: syncRuns.recordsRejected,
        cursorAtStart: syncRuns.cursorAtStart,
        cursorAtEnd: syncRuns.cursorAtEnd,
        checkpointAtStart: syncRuns.checkpointAtStart,
        checkpointAtEnd: syncRuns.checkpointAtEnd,
        positionSnapshotComplete: syncRuns.positionSnapshotComplete,
        cashBalanceSnapshotComplete: syncRuns.cashBalanceSnapshotComplete,
        errorCode: syncRuns.errorCode,
      }).from(syncRuns)
        .innerJoin(providerAccounts, eq(syncRuns.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .where(and(eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!)))
        .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.post<{ Params: AccountParams }>('/provider-accounts/:accountId/sync', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        ...authSchema,
        tags: ['synchronization'],
        summary: 'Run a bounded read-only synchronization for an owned provider account',
        params: accountParamsSchema,
        response: {
          200: {
            type: 'object',
            required: ['providerAccountId', 'status', 'streams', 'startedAt', 'finishedAt'],
            properties: {
              providerAccountId: uuidSchema,
              status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
              streams: {
                type: 'array', items: {
                  type: 'object',
                  required: ['streamName', 'status', 'pagesRead', 'recordsSeen', 'errorCode', 'runId'],
                  properties: {
                    streamName: { type: 'string' },
                    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
                    pagesRead: { type: 'integer' },
                    recordsSeen: { type: 'integer' },
                    errorCode: { type: ['string', 'null'] },
                    runId: uuidSchema,
                  },
                },
              },
              startedAt: { type: 'string', format: 'date-time' },
              finishedAt: { type: 'string', format: 'date-time' },
            },
          },
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const account = await getOwnedProviderAccount(options.database, request.params.accountId, request.principalId!)
      if (!account) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      try {
        const result = await ingestion.syncProviderAccount(account.id)
        return reply.code(result.status === 'failed' ? 502 : 200).send(result)
      } catch (error) {
        if (error instanceof SyncAlreadyRunningError) {
          return reply.code(409).send(errorBody(request.id, error.code, 'A synchronization is already running for this account.'))
        }
        if (error instanceof ProviderAdapterError) {
          return reply.code(422).send(errorBody(request.id, error.code, 'This provider account cannot be synchronized by an available adapter.'))
        }
        if (error instanceof IngestionError) {
          if (error.code === 'provider_account_disabled') {
            return reply.code(409).send(errorBody(request.id, error.code, 'The provider account is disabled.'))
          }
          return reply.code(409).send(errorBody(request.id, error.code, 'The synchronization could not be started.'))
        }
        throw error
      }
    })
  }, { prefix: '/v1' })

  return app
}

async function getOwnedPortfolio(database: Database, portfolioId: string, ownerId: string) {
  const [portfolio] = await database.select({ id: portfolios.id, name: portfolios.name })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.ownerId, ownerId)))
    .limit(1)
  return portfolio
}

async function getOwnedProviderAccount(database: Database, accountId: string, ownerId: string) {
  const [account] = await database.select({ id: providerAccounts.id })
    .from(providerAccounts)
    .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
    .where(and(
      eq(providerAccounts.id, accountId),
      eq(portfolios.ownerId, ownerId),
    ))
    .limit(1)
  return account
}

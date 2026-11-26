import type { KalshiMarketDataService } from '../providers/kalshi/market-data.js'
import { ScenarioError } from '../scenarios/engine.js'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { and, desc, eq, sql } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import type { ServerConfig } from '../config.js'
import type { Database } from '../db/client.js'
import {
  cashBalanceSnapshots,
  activityFactOccurrences,
  cashMovements,
  dataCoverage,
  events,
  fills,
  instruments,
  markets,
  portfolios,
  positionSnapshots,
  providerActivityFacts,
  providerAccounts,
  settlements,
  sourceRecords,
  syncRuns,
  users,
} from '../db/schema.js'
import { ProviderAdapterError } from '../providers/adapter.js'
import { ProviderRegistry, providerRegistry } from '../providers/registry.js'
import { PolymarketMarketDataService, PublicMarketError } from '../providers/polymarket/market-data.js'
import { IngestionError, SyncAlreadyRunningError } from '../ingestion/errors.js'
import { IngestionService } from '../ingestion/sync.js'
import { matchesDevelopmentBearer } from './auth.js'
import { registerAccountingRoutes } from './accounting.js'

export interface AppOptions {
  config: ServerConfig
  database: Database
  registry?: ProviderRegistry
  marketData?: PolymarketMarketDataService
  kalshiMarketData?: KalshiMarketDataService
}

interface PageQuery {
  limit: number
  offset: number
}

interface SourcePageQuery extends PageQuery {
  providerAccountId?: string
}

interface PortfolioParams {
  portfolioId: string
}

interface AccountParams {
  accountId: string
}

interface MarketHistoryQuery {
  tokenId: string
  interval: string
  bucketSeconds?: number
  cursor?: string
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
const sourcePaginationQuerySchema = {
  ...paginationQuerySchema,
  properties: { ...paginationQuerySchema.properties, providerAccountId: uuidSchema },
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
const marketCandidateSchema = {
  type: 'object',
  required: ['providerCode', 'eventId', 'eventIdentity', 'eventSlug', 'eventTitle', 'eventDescription', 'eventLifecycle', 'enrichmentStatus', 'enrichmentErrors', 'marketsTruncated', 'markets'],
  properties: {
    providerCode: { type: 'string', const: 'polymarket' },
    eventId: { type: ['string', 'null'] },
    eventIdentity: {
      type: 'object',
      required: ['kind', 'value'],
      properties: {
        kind: { type: 'string', enum: ['provider_event_id', 'slug_only', 'unavailable'] },
        value: { type: ['string', 'null'] },
      },
    },
    eventSlug: { type: ['string', 'null'] },
    eventTitle: { type: ['string', 'null'] },
    eventDescription: { type: ['string', 'null'] },
    eventLifecycle: { type: 'string' },
    enrichmentStatus: { type: 'string', enum: ['complete', 'partial', 'unavailable'] },
    enrichmentErrors: { type: 'array', items: { type: 'string' } },
    marketsTruncated: { type: 'boolean' },
    markets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['providerMarketId', 'providerMarketSlug', 'conditionId', 'slug', 'url', 'title', 'version', 'lifecycle', 'description', 'resolutionSource', 'resolutionRules', 'endDate', 'updatedAt', 'negativeRisk', 'feeMetadata', 'outcomes'],
        properties: {
          providerMarketId: { type: 'string' },
          providerMarketSlug: { type: 'string' },
          conditionId: { type: 'string' },
          slug: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          title: { type: 'string' },
          version: { type: ['string', 'null'] },
          lifecycle: { type: 'string' },
          description: { type: ['string', 'null'] },
          resolutionSource: { type: ['string', 'null'] },
          resolutionRules: { type: ['string', 'null'] },
          endDate: { type: ['string', 'null'], format: 'date-time' },
          updatedAt: { type: ['string', 'null'], format: 'date-time' },
          negativeRisk: { type: ['boolean', 'null'] },
          feeMetadata: {
            type: 'object',
            required: ['status', 'source', 'retrievedAt', 'enabled', 'rate', 'exponent', 'takerOnly', 'makerFeesCharged', 'rebateRate', 'rebateRateSemantics', 'amountUnit', 'historicalFeesAvailable'],
            properties: {
              status: { type: 'string', enum: ['fee_free', 'known', 'incomplete', 'unknown'] },
              source: { type: 'string', const: 'gamma_market' },
              retrievedAt: { type: 'string', format: 'date-time' },
              enabled: { type: ['boolean', 'null'] },
              rate: { type: ['string', 'null'] },
              exponent: { type: ['number', 'null'] },
              takerOnly: { type: ['boolean', 'null'] },
              makerFeesCharged: { type: ['boolean', 'null'] },
              rebateRate: { type: ['string', 'null'] },
              rebateRateSemantics: { type: ['string', 'null'], enum: ['market_level_fraction', null] },
              amountUnit: { type: 'string', const: 'USDC' },
              historicalFeesAvailable: { type: 'boolean', const: false },
            },
          },
          outcomes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['assetId', 'assetIdType', 'positionId', 'clobTokenId', 'name', 'outcomeIndex', 'referencePrice'],
              properties: {
                assetId: { type: ['string', 'null'] },
                assetIdType: { type: 'string', enum: ['position_id', 'clob_token_id', 'unavailable'] },
                positionId: { type: ['string', 'null'] },
                clobTokenId: { type: ['string', 'null'] },
                name: { type: ['string', 'null'] },
                outcomeIndex: { type: 'integer' },
                referencePrice: {
                  type: 'object',
                  required: ['value', 'priceType', 'retrievedAt', 'sourceTimestamp', 'freshness'],
                  properties: {
                    value: { type: ['string', 'null'] },
                    priceType: { type: 'string', const: 'clob_midpoint' },
                    retrievedAt: { type: ['string', 'null'], format: 'date-time' },
                    sourceTimestamp: { type: 'null' },
                    freshness: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
}
const marketSearchResponseSchema = {
  type: 'object',
  required: ['providerCode', 'query', 'retrievedAt', 'items', 'pagination', 'enrichment'],
  properties: {
    providerCode: { type: 'string', const: 'polymarket' },
    query: { type: 'string' },
    retrievedAt: { type: 'string', format: 'date-time' },
    items: { type: 'array', items: marketCandidateSchema },
    pagination: {
      type: 'object',
      required: ['page', 'pageSize', 'hasMore', 'providerHasMore', 'totalResults', 'nextPage', 'continuationAvailable', 'truncated'],
      properties: {
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        hasMore: { type: 'boolean' },
        providerHasMore: { type: ['boolean', 'null'] },
        totalResults: { type: ['integer', 'null'] },
        nextPage: { type: ['integer', 'null'] },
        continuationAvailable: { type: 'boolean' },
        truncated: { type: 'boolean' },
      },
    },
    enrichment: {
      type: 'object',
      required: ['status', 'errors', 'marketsTruncated'],
      properties: {
        status: { type: 'string', enum: ['complete', 'partial'] },
        errors: { type: 'array', items: { type: 'string' } },
        marketsTruncated: { type: 'boolean' },
      },
    },
  },
}
const marketResolveResponseSchema = {
  type: 'object',
  required: ['providerCode', 'resolvedAs', 'sourceUrl', 'retrievedAt', 'item'],
  properties: {
    providerCode: { type: 'string', const: 'polymarket' },
    resolvedAs: { type: 'string', enum: ['event', 'market'] },
    sourceUrl: { type: 'string', format: 'uri' },
    retrievedAt: { type: 'string', format: 'date-time' },
    item: marketCandidateSchema,
  },
}
const priceHistoryResponseSchema = {
  type: 'object',
  required: ['providerCode', 'tokenId', 'interval', 'retrievedAt', 'items', 'nextCursor'],
  properties: {
    providerCode: { type: 'string', const: 'polymarket' },
    tokenId: { type: 'string' },
    interval: { type: 'string' },
    retrievedAt: { type: 'string', format: 'date-time' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tokenId', 'price', 'priceType', 'observedAt', 'timestampBasis', 'resolutionSeconds'],
        properties: {
          tokenId: { type: 'string' },
          price: { type: 'string' },
          priceType: { type: 'string', const: 'provider_price_history' },
          observedAt: { type: 'string', format: 'date-time' },
          timestampBasis: { type: 'string', const: 'provider_observation' },
          resolutionSeconds: { type: 'integer' },
        },
      },
    },
    nextCursor: { type: ['string', 'null'] },
    invalidPointCount: { type: 'integer' },
    complete: { type: 'boolean' },
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
  const liveAllowed = options.config.polymarketLiveEnabled === true
  const marketData = options.marketData ?? new PolymarketMarketDataService()
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
      summary: 'List provider adapters and their declared capabilities',
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
                  liveAccess: { type: 'string' },
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
                        referenceEntities: { type: 'array', items: { type: 'string' } },
                        auxiliaryEntities: { type: 'array', items: { type: 'string' } },
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
  }, async () => ({ items: registry.listCapabilities().map((item) => ({ ...item,
    liveAccess: item.providerCode === 'kalshi' ? 'disabled' : item.providerCode === 'polymarket' && liveAllowed ? 'enabled' : 'unavailable' })) }))

  app.get<{ Querystring: { q: string; limit: number; page: number } }>('/v1/market-data/search', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['public market data'],
      summary: 'Search Polymarket events without a connected portfolio',
      querystring: {
        type: 'object', additionalProperties: false, required: ['q'],
        properties: {
          q: { type: 'string', minLength: 2, maxLength: 120 },
          limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
          page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
        },
      },
      response: { 200: marketSearchResponseSchema, 400: errorResponseSchema, 502: errorResponseSchema, 503: errorResponseSchema },
    },
  }, async (request, reply) => {
    if (!liveAllowed && !options.marketData) {
      return reply.code(503).send(errorBody(request.id, 'provider_live_disabled', 'Live market access is disabled.'))
    }
    try {
      return await marketData.search(request.query.q, request.query.limit ?? 5, request.query.page ?? 1, request.raw.signal)
    } catch (error) {
      if (error instanceof PublicMarketError) {
        return reply.code(error.httpStatus).send(errorBody(request.id, error.code, 'Public market data is temporarily unavailable.'))
      }
      throw error
    }
  })

  app.post<{ Body: { url: string } }>('/v1/market-data/resolve', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['public market data'],
      summary: 'Resolve a supported Polymarket event or market URL through trusted APIs',
      body: {
        type: 'object', additionalProperties: false, required: ['url'],
        properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
      },
      response: { 200: marketResolveResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 502: errorResponseSchema, 503: errorResponseSchema },
    },
  }, async (request, reply) => {
    if (!liveAllowed && !options.marketData) {
      return reply.code(503).send(errorBody(request.id, 'provider_live_disabled', 'Live market access is disabled.'))
    }
    try {
      return await marketData.resolve(request.body.url, request.raw.signal)
    } catch (error) {
      if (error instanceof PublicMarketError) {
        const message = error.httpStatus === 400 ? 'The URL is not a supported Polymarket link.' : 'Public market data is temporarily unavailable.'
        return reply.code(error.httpStatus).send(errorBody(request.id, error.code, message))
      }
      throw error
    }
  })

  app.get<{ Querystring: MarketHistoryQuery }>('/v1/market-data/prices-history', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['public market data'],
      summary: 'Read bounded Polymarket outcome price history',
      querystring: {
        type: 'object', additionalProperties: false, required: ['tokenId'],
        properties: {
          tokenId: { type: 'string', pattern: '^\\d{1,100}$' },
          interval: { type: 'string', enum: ['max', 'all', '1m', '1w', '1d', '6h', '1h'], default: '1w' },
          bucketSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
          cursor: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
      response: { 200: priceHistoryResponseSchema, 400: errorResponseSchema, 502: errorResponseSchema, 503: errorResponseSchema },
    },
  }, async (request, reply) => {
    if (!liveAllowed && !options.marketData) {
      return reply.code(503).send(errorBody(request.id, 'provider_live_disabled', 'Live market access is disabled.'))
    }
    try {
      return await marketData.priceHistory({
        tokenId: request.query.tokenId,
        interval: request.query.interval ?? '1w',
        ...(request.query.bucketSeconds === undefined ? {} : { bucketSeconds: request.query.bucketSeconds }),
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      }, request.raw.signal)
    } catch (error) {
      if (error instanceof PublicMarketError) {
        return reply.code(error.httpStatus).send(errorBody(request.id, error.code, 'Public market data is temporarily unavailable.'))
      }
      throw error
    }
  })

  // Kalshi remains unavailable in production and in the default development server.
  const kalshiMarketData = options.config.nodeEnv === 'test' ? options.kalshiMarketData : undefined
  app.get<{ Querystring: { marketTicker?: string; eventTicker?: string; cursor?: string } }>('/v1/market-catalog/kalshi', {
    schema: { tags: ['public market data'], querystring: { type: 'object', additionalProperties: false, properties: {
      marketTicker: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_-]{0,127}$' },
      eventTicker: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_-]{0,127}$' }, cursor: { type: 'string', maxLength: 4000 },
    } } },
  }, async (request, reply) => {
    if (!kalshiMarketData) return reply.code(503).send(errorBody(request.id, 'kalshi_live_disabled', 'Kalshi live access is disabled.'))
    const { marketTicker, eventTicker, cursor } = request.query
    try {
      if (marketTicker) return { provider: 'kalshi', items: [await kalshiMarketData.lookup(marketTicker, request.raw.signal)], nextCursor: null, partial: false }
      return await kalshiMarketData.list(eventTicker, cursor, request.raw.signal)
    } catch { return reply.code(502).send(errorBody(request.id, 'kalshi_catalog_unavailable', 'Kalshi market evidence is unavailable.')) }
  })
  app.get<{ Querystring: { marketTicker: string; side: 'yes' | 'no'; from: number; through: number; minutes: number } }>('/v1/market-catalog/kalshi/history', {
    schema: { tags: ['public market data'], querystring: { type: 'object', required: ['marketTicker', 'side', 'from', 'through', 'minutes'],
      additionalProperties: false, properties: { marketTicker: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_-]{0,127}$' },
        side: { enum: ['yes', 'no'] }, from: { type: 'integer' }, through: { type: 'integer' }, minutes: { type: 'integer', enum: [1, 60, 1440] } } } },
  }, async (request, reply) => {
    if (!kalshiMarketData) return reply.code(503).send(errorBody(request.id, 'kalshi_live_disabled', 'Kalshi live access is disabled.'))
    try { return await kalshiMarketData.historicalPrices(request.query, request.raw.signal) }
    catch (error) {
      if (error instanceof ProviderAdapterError && error.code === 'kalshi_history_range_invalid') return reply.code(422).send(errorBody(request.id, error.code, 'Invalid archival range.'))
      return reply.code(502).send(errorBody(request.id, 'kalshi_history_unavailable', 'Kalshi archive evidence is unavailable.'))
    }
  })
  app.post<{ Body: { url: string } }>('/v1/market-catalog/kalshi/resolve', {
    schema: { tags: ['public market data'], body: { type: 'object', required: ['url'], additionalProperties: false,
      properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } } } },
  }, async (request, reply) => {
    if (!kalshiMarketData) return reply.code(503).send(errorBody(request.id, 'kalshi_live_disabled', 'Kalshi live access is disabled.'))
    try { return await kalshiMarketData.resolve(request.body.url, request.raw.signal) }
    catch (error) {
      if (error instanceof ProviderAdapterError && error.code === 'kalshi_invalid_market_link') return reply.code(400).send(errorBody(request.id, error.code, 'Unsupported Kalshi link.'))
      return reply.code(502).send(errorBody(request.id, 'kalshi_catalog_unavailable', 'Kalshi market evidence is unavailable.'))
    }
  })

  await app.register(async (privateApi) => {
    privateApi.addHook('preHandler', async (request, reply) => {
      if (options.config.nodeEnv === 'production' || !options.config.devAuthToken || !options.config.devPrincipalId) {
        return reply.code(503).send(errorBody(request.id, 'authentication_unavailable', 'Authentication is not configured.'))
      }
      if (!matchesDevelopmentBearer(request.headers.authorization, options.config.devAuthToken)) {
        return reply.code(401).send(errorBody(request.id, 'unauthorized', 'A valid bearer token is required.'))
      }
      request.principalId = options.config.devPrincipalId
    })

    registerAccountingRoutes(privateApi, options.database, liveAllowed || options.marketData || kalshiMarketData ? async (url, type) => {
      try {
        if (type === 'kalshi_outcome') {
          if (!kalshiMarketData) throw new ScenarioError('kalshi_live_disabled')
          return await kalshiMarketData.resolve(url, AbortSignal.timeout(8000))
        }
        if (!liveAllowed && !options.marketData) throw new ScenarioError('provider_live_disabled')
        return await marketData.resolve(url)
      }
      catch (error) {
        if (error instanceof PublicMarketError || error instanceof ProviderAdapterError) throw new ScenarioError(error.code)
        throw error
      }
    } : undefined)

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

    privateApi.post<{ Body: { name: string } }>('/portfolios', {
      schema: {
        ...authSchema,
        tags: ['portfolios'],
        summary: 'Create a portfolio for the authenticated development principal',
        body: {
          type: 'object', additionalProperties: false, required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
        },
        response: {
          201: {
            type: 'object', required: ['id', 'name', 'createdAt'],
            properties: { id: uuidSchema, name: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } },
          },
          400: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const name = request.body.name.trim()
      if (name.length === 0) return reply.code(400).send(errorBody(request.id, 'invalid_portfolio_name', 'Portfolio name cannot be blank.'))
      await options.database.insert(users).values({
        id: request.principalId!,
        authSubject: `development:${request.principalId!}`,
      }).onConflictDoNothing()
      const [portfolio] = await options.database.insert(portfolios).values({ ownerId: request.principalId!, name }).returning({
        id: portfolios.id,
        name: portfolios.name,
        createdAt: portfolios.createdAt,
      })
      if (!portfolio) throw new Error('portfolio_creation_failed')
      return reply.code(201).send(portfolio)
    })

    privateApi.post<{ Params: PortfolioParams; Body: { walletAddress: string; label?: string } }>(
      '/portfolios/:portfolioId/sources/polymarket',
      {
        schema: {
          ...authSchema,
          tags: ['provider accounts'],
          summary: 'Register a Polymarket public account wallet for read-only tracking',
          params: portfolioParamsSchema,
          body: {
            type: 'object', additionalProperties: false, required: ['walletAddress'],
            properties: {
              walletAddress: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
              label: { type: 'string', minLength: 1, maxLength: 100 },
            },
          },
          response: {
            201: {
              type: 'object', required: ['id', 'providerCode', 'label', 'kind', 'createdAt', 'alreadyRegistered'],
              properties: {
                id: uuidSchema,
                providerCode: { type: 'string', const: 'polymarket' },
                label: { type: 'string' },
                kind: { type: 'string', const: 'public_wallet' },
                createdAt: { type: 'string', format: 'date-time' },
                alreadyRegistered: { type: 'boolean' },
              },
            },
            200: { type: 'object', additionalProperties: true },
            400: errorResponseSchema,
            404: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
        if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
        try {
          registry.get('polymarket')
        } catch (error) {
          if (error instanceof ProviderAdapterError) {
            return reply.code(422).send(errorBody(request.id, 'provider_adapter_unavailable', 'Polymarket tracking is unavailable.'))
          }
          throw error
        }
        const walletAddress = request.body.walletAddress.toLowerCase()
        if (/^0x0{40}$/.test(walletAddress)) {
          return reply.code(400).send(errorBody(request.id, 'invalid_wallet_address', 'Enter a Polymarket account wallet address.'))
        }
        const label = request.body.label?.trim() || `Polymarket ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
        const [created] = await options.database.insert(providerAccounts).values({
          portfolioId: portfolio.id,
          providerCode: 'polymarket',
          externalAccountId: walletAddress,
          label,
          kind: 'public_wallet',
        }).onConflictDoNothing().returning({
          id: providerAccounts.id,
          providerCode: providerAccounts.providerCode,
          label: providerAccounts.label,
          kind: providerAccounts.kind,
          createdAt: providerAccounts.createdAt,
        })
        if (created) return reply.code(201).send({ ...created, alreadyRegistered: false })
        const [existing] = await options.database.select({
          id: providerAccounts.id,
          providerCode: providerAccounts.providerCode,
          label: providerAccounts.label,
          kind: providerAccounts.kind,
          createdAt: providerAccounts.createdAt,
        }).from(providerAccounts).where(and(
          eq(providerAccounts.portfolioId, portfolio.id),
          eq(providerAccounts.providerCode, 'polymarket'),
          eq(providerAccounts.externalAccountId, walletAddress),
        )).limit(1)
        if (!existing) throw new Error('provider_account_registration_failed')
        return reply.code(200).send({ ...existing, alreadyRegistered: true })
      },
    )

    privateApi.get<{ Params: PortfolioParams } & { Querystring: SourcePageQuery }>('/portfolios/:portfolioId/positions', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List the latest provider-reported or reconstructed position snapshots',
        params: portfolioParamsSchema,
        querystring: sourcePaginationQuerySchema,
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
            positionState: { type: 'string', enum: ['provider_reported_positive', 'provider_reported_zero', 'provider_confirmed_closed', 'provider_reported_redeemable', 'not_seen_in_latest_successful_refresh', 'latest_refresh_incomplete', 'unknown'] },
            observationStatus: { type: 'string', enum: ['observed_in_latest_successful_refresh', 'not_seen_in_latest_successful_refresh', 'latest_attempt_incomplete', 'unknown'] },
            lastSuccessfulSyncAt: { type: ['string', 'null'], format: 'date-time' },
            latestAttemptAt: { type: ['string', 'null'], format: 'date-time' },
            latestAttemptStatus: { type: ['string', 'null'] },
            providerStatus: { type: ['string', 'null'] },
            redeemable: { type: ['boolean', 'null'] },
            mergeable: { type: ['boolean', 'null'] },
            archived: { type: ['boolean', 'null'] },
            providerReported: {
              type: 'object',
              properties: {
                currentValue: { type: ['string', 'null'] },
                realizedPnl: { type: ['string', 'null'] },
                unrealizedPnl: { type: ['string', 'null'] },
                totalPnl: { type: ['string', 'null'] },
                entryCost: { type: ['string', 'null'] },
                entryFees: { type: ['string', 'null'] },
                totalCost: { type: ['string', 'null'] },
                totalSize: { type: ['string', 'null'] },
                percentPnl: { type: ['string', 'null'] },
              },
            },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const positionRows = await options.database.selectDistinctOn(
        [positionSnapshots.providerAccountId, positionSnapshots.instrumentId],
        {
          id: positionSnapshots.id,
          syncRunId: positionSnapshots.syncRunId,
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
          providerStatus: positionSnapshots.providerStatus,
          redeemable: positionSnapshots.redeemable,
          mergeable: positionSnapshots.mergeable,
          archived: positionSnapshots.archived,
          lastSuccessfulRunId: dataCoverage.lastSuccessfulRunId,
          lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
          latestAttemptAt: dataCoverage.lastAttemptAt,
          latestAttemptStatus: dataCoverage.lastAttemptStatus,
          providerReported: {
            currentValue: positionSnapshots.providerCurrentValue,
            realizedPnl: positionSnapshots.providerRealizedPnl,
            unrealizedPnl: positionSnapshots.providerUnrealizedPnl,
            totalPnl: positionSnapshots.providerTotalPnl,
            entryCost: positionSnapshots.providerEntryCost,
            entryFees: positionSnapshots.providerEntryFees,
            totalCost: positionSnapshots.providerTotalCost,
            totalSize: positionSnapshots.providerTotalSize,
            percentPnl: positionSnapshots.providerPercentPnl,
          },
        },
      ).from(positionSnapshots)
        .innerJoin(providerAccounts, eq(positionSnapshots.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .innerJoin(instruments, eq(positionSnapshots.instrumentId, instruments.id))
        .innerJoin(markets, eq(instruments.marketId, markets.id))
        .innerJoin(events, eq(markets.eventId, events.id))
        .innerJoin(sourceRecords, eq(positionSnapshots.sourceRecordId, sourceRecords.id))
        .leftJoin(dataCoverage, and(
          eq(dataCoverage.providerAccountId, positionSnapshots.providerAccountId),
          eq(dataCoverage.entityType, 'positions'),
        ))
        .where(and(
          eq(portfolios.id, portfolio.id),
          eq(portfolios.ownerId, request.principalId!),
          eq(positionSnapshots.isCurrent, true),
          request.query.providerAccountId ? eq(providerAccounts.id, request.query.providerAccountId) : undefined,
        ))
        .orderBy(positionSnapshots.providerAccountId, positionSnapshots.instrumentId)
        .limit(limit)
        .offset(offset)
      const items = positionRows.map((position) => {
        const latestAttemptIncomplete = position.latestAttemptAt !== null
          && (position.lastSuccessfulSyncAt === null || position.latestAttemptAt > position.lastSuccessfulSyncAt)
          && position.latestAttemptStatus !== 'complete'
        const observationStatus = latestAttemptIncomplete
          ? 'latest_attempt_incomplete'
          : position.lastSuccessfulRunId === null
            ? 'unknown'
            : position.syncRunId === position.lastSuccessfulRunId
              ? 'observed_in_latest_successful_refresh'
              : 'not_seen_in_latest_successful_refresh'
        const positionState = observationStatus === 'latest_attempt_incomplete'
          ? 'latest_refresh_incomplete'
          : observationStatus === 'not_seen_in_latest_successful_refresh'
            ? 'not_seen_in_latest_successful_refresh'
            : observationStatus === 'unknown'
              ? 'unknown'
              : position.providerStatus?.toUpperCase() === 'CLOSED'
                ? 'provider_confirmed_closed'
                : position.redeemable === true || ['REDEEMABLE', 'REDEEMABLE_LOST'].includes(position.providerStatus?.toUpperCase() ?? '')
                  ? 'provider_reported_redeemable'
                  : new Decimal(position.quantity).isZero()
                    ? 'provider_reported_zero'
                    : 'provider_reported_positive'
        return {
          ...position,
          positionState,
          observationStatus,
          lastSuccessfulSyncAt: position.lastSuccessfulSyncAt,
          latestAttemptAt: position.latestAttemptAt,
          latestAttemptStatus: position.latestAttemptStatus,
        }
      })
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: SourcePageQuery }>('/portfolios/:portfolioId/fills', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List fills with source fee availability and market metadata',
        params: portfolioParamsSchema,
        querystring: sourcePaginationQuerySchema,
        response: {
          200: paginatedSchema({
            id: uuidSchema,
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            externalId: { type: 'string' },
            identityKind: { type: 'string', enum: ['provider_native', 'source_fingerprint'] },
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
        identityKind: fills.identityKind,
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
        .where(and(
          eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!),
          request.query.providerAccountId ? eq(providerAccounts.id, request.query.providerAccountId) : undefined,
        ))
        .orderBy(desc(fills.occurredAt), desc(fills.id))
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: SourcePageQuery }>('/portfolios/:portfolioId/cash-movements', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List signed deposits, withdrawals, transfers, and adjustments',
        params: portfolioParamsSchema,
        querystring: sourcePaginationQuerySchema,
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
        .where(and(
          eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!),
          request.query.providerAccountId ? eq(providerAccounts.id, request.query.providerAccountId) : undefined,
        ))
        .orderBy(desc(cashMovements.occurredAt), desc(cashMovements.id))
        .limit(limit)
        .offset(offset)
      return { items, pagination: pagination(limit, offset, items.length) }
    })

    privateApi.get<{ Params: PortfolioParams } & { Querystring: SourcePageQuery & { syncRunId?: string } }>('/portfolios/:portfolioId/activity-facts', {
      schema: {
        ...authSchema,
        tags: ['portfolio data'],
        summary: 'List provider activity that has not been reconciled to canonical financial records',
        params: portfolioParamsSchema,
        querystring: { ...sourcePaginationQuerySchema, properties: { ...sourcePaginationQuerySchema.properties, syncRunId: uuidSchema } },
        response: {
          200: paginatedSchema({
            id: uuidSchema,
            providerAccountId: uuidSchema,
            providerCode: { type: 'string' },
            observationsInRun: { type: ['integer', 'null'] },
            activityType: { type: 'string' },
            identityKind: { type: 'string', enum: ['provider_native', 'source_fingerprint'] },
            sourceEndpoint: { type: 'string', enum: ['activity', 'trades', 'positions'] },
            occurredAt: { type: ['string', 'null'], format: 'date-time' },
            transactionHash: { type: ['string', 'null'] },
            externalMarketId: { type: ['string', 'null'] },
            externalInstrumentId: { type: ['string', 'null'] },
            side: { type: ['string', 'null'] },
            quantity: { type: ['string', 'null'] },
            amount: { type: ['string', 'null'] },
            assetCode: { type: ['string', 'null'] },
            price: { type: ['string', 'null'] },
            classification: { type: 'string', enum: ['unreconciled', 'unresolved', 'overlap_candidate'] },
            resolutionReason: { type: ['string', 'null'] },
          }),
          404: errorResponseSchema,
        },
      },
    }, async (request, reply) => {
      const portfolio = await getOwnedPortfolio(options.database, request.params.portfolioId, request.principalId!)
      if (!portfolio) return reply.code(404).send(errorBody(request.id, 'not_found', 'The requested resource was not found.'))
      const { limit, offset } = request.query
      const run = request.query.syncRunId
      const occurrence = run ? sql<number>`(select observations from ${activityFactOccurrences}
        where ${activityFactOccurrences.activityFactId} = ${providerActivityFacts.id}
        and ${activityFactOccurrences.syncRunId} = ${run})` : sql<null>`null`
      const items = await options.database.select({
        id: providerActivityFacts.id,
        providerAccountId: providerAccounts.id,
        providerCode: providerAccounts.providerCode,
        identityKind: providerActivityFacts.identityKind,
        sourceEndpoint: providerActivityFacts.sourceEndpoint,
        observationsInRun: occurrence.as('observations_in_run'),
        activityType: providerActivityFacts.activityType,
        occurredAt: providerActivityFacts.occurredAt,
        transactionHash: providerActivityFacts.transactionHash,
        externalMarketId: providerActivityFacts.externalMarketId,
        externalInstrumentId: providerActivityFacts.externalInstrumentId,
        side: providerActivityFacts.side,
        quantity: providerActivityFacts.quantity,
        amount: providerActivityFacts.amount,
        assetCode: providerActivityFacts.assetCode,
        price: providerActivityFacts.price,
        classification: providerActivityFacts.classification,
        resolutionReason: providerActivityFacts.resolutionReason,
      }).from(providerActivityFacts)
        .innerJoin(providerAccounts, eq(providerActivityFacts.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .where(and(
          eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!),
          run ? sql`${occurrence} is not null` : undefined,
          request.query.providerAccountId ? eq(providerAccounts.id, request.query.providerAccountId) : undefined,
        ))
        .orderBy(desc(providerActivityFacts.occurredAt), desc(providerActivityFacts.id))
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

    privateApi.get<{ Params: PortfolioParams } & { Querystring: SourcePageQuery }>('/portfolios/:portfolioId/coverage', {
      schema: {
        ...authSchema,
        tags: ['data coverage'],
        summary: 'Show available, partial, and unsupported data by source',
        params: portfolioParamsSchema,
        querystring: sourcePaginationQuerySchema,
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
            coverageStart: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'Earliest reported coverage bound; together with coverageEnd this is an envelope and does not prove continuous history.',
            },
            coverageEnd: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'Latest reported coverage bound; together with coverageStart this is an envelope and does not prove continuous history.',
            },
            sourceAsOf: { type: ['string', 'null'], format: 'date-time' },
            snapshotAsOf: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'As-of watermark of the latest complete position or cash snapshot published for this entity.',
            },
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
        snapshotAsOf: dataCoverage.snapshotAsOf,
        lastAttemptAt: dataCoverage.lastAttemptAt,
        lastAttemptStatus: dataCoverage.lastAttemptStatus,
        lastAttemptCoverageStatus: dataCoverage.lastAttemptCoverageStatus,
        lastAttemptReasonCode: dataCoverage.lastAttemptReasonCode,
        lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
        updatedAt: dataCoverage.updatedAt,
      }).from(dataCoverage)
        .innerJoin(providerAccounts, eq(dataCoverage.providerAccountId, providerAccounts.id))
        .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
        .where(and(
          eq(portfolios.id, portfolio.id), eq(portfolios.ownerId, request.principalId!),
          request.query.providerAccountId ? eq(providerAccounts.id, request.query.providerAccountId) : undefined,
        ))
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
            rowsReceived: { type: 'integer' },
            sourceRowsRetained: { type: 'integer' },
            invalidRecords: { type: 'integer' },
            recordsPersisted: { type: 'integer' },
            exactDuplicates: { type: 'integer' },
            unresolvedRecords: { type: 'integer' },
            overlapCandidates: { type: 'integer' },
            excludedRecords: { type: 'integer' },
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
        rowsReceived: syncRuns.rowsReceived,
        sourceRowsRetained: syncRuns.sourceRowsRetained,
        invalidRecords: syncRuns.invalidRecords,
        recordsPersisted: syncRuns.recordsPersisted,
        exactDuplicates: syncRuns.exactDuplicates,
        unresolvedRecords: syncRuns.unresolvedRecords,
        overlapCandidates: syncRuns.overlapCandidates,
        excludedRecords: syncRuns.excludedRecords,
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

    privateApi.post<{ Params: AccountParams; Querystring: { scope?: 'all' | 'current' | 'history' } }>('/provider-accounts/:accountId/sync', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        ...authSchema,
        tags: ['synchronization'],
        summary: 'Run a bounded read-only synchronization for an owned provider account',
        params: accountParamsSchema,
        querystring: { type: 'object', properties: { scope: { type: 'string', enum: ['all', 'current', 'history'] } } },
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
                  required: ['streamName', 'status', 'pagesRead', 'recordsSeen', 'rowsReceived', 'sourceRowsRetained', 'invalidRecords', 'recordsPersisted', 'exactDuplicates', 'unresolvedRecords', 'overlapCandidates', 'excludedRecords', 'errorCode', 'runId'],
                  properties: {
                    streamName: { type: 'string' },
                    status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
                    pagesRead: { type: 'integer' },
                    recordsSeen: { type: 'integer' },
                    rowsReceived: { type: 'integer' },
                    sourceRowsRetained: { type: 'integer' },
                    invalidRecords: { type: 'integer' },
                    recordsPersisted: { type: 'integer' },
                    exactDuplicates: { type: 'integer' },
                    unresolvedRecords: { type: 'integer' },
                    overlapCandidates: { type: 'integer' },
                    excludedRecords: { type: 'integer' },
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
        if ((account.providerCode === 'polymarket' && !liveAllowed && !options.registry)
          || (account.providerCode === 'kalshi' && (!options.registry || options.config.nodeEnv !== 'test'))) {
          return reply.code(422).send(errorBody(request.id, 'provider_live_disabled', 'Live account synchronization is disabled.'))
        }
        const result = await ingestion.syncProviderAccount(account.id, request.query.scope)
        if (result.status === 'failed') {
          return reply.code(502).send(errorBody(request.id, 'sync_failed', 'All synchronization streams failed.'))
        }
        return reply.code(200).send(result)
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
  const [account] = await database.select({ id: providerAccounts.id, providerCode: providerAccounts.providerCode })
    .from(providerAccounts)
    .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
    .where(and(
      eq(providerAccounts.id, accountId),
      eq(portfolios.ownerId, ownerId),
    ))
    .limit(1)
  return account
}

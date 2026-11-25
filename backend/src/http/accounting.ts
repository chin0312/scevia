import { createHash } from 'node:crypto'
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { financialImportBatches as batches, portfolios, providerAccounts } from '../db/schema.js'
import { parseFinancialCsv } from '../accounting/csv.js'
import { replayAccounting } from '../accounting/ledger.js'

const uuid = { type: 'string', format: 'uuid' }
const portfolioParams = { type: 'object', required: ['portfolioId'], properties: { portfolioId: uuid } }
const batchParams = { type: 'object', required: ['portfolioId', 'batchId'], properties: { portfolioId: uuid, batchId: uuid } }
const auth = { security: [{ bearerAuth: [] }] }
const prefix = '/portfolios/:portfolioId'
const maxBatches = 25
const missing = { error: { code: 'not_found' } }

export function registerAccountingRoutes(app: FastifyInstance, database: Database) {
  async function owned(portfolioId: string, ownerId: string) {
    const [row] = await database.select({ id: portfolios.id }).from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.ownerId, ownerId))).limit(1)
    return row !== undefined
  }
  app.post<{ Params: { portfolioId: string }; Body: { csv: string } }>(prefix + '/imports/preview', {
    bodyLimit: 512 * 1024,
    schema: {
      ...auth, tags: ['accounting'], summary: 'Validate a canonical CSV and create an expiring preview',
      params: portfolioParams,
      body: { type: 'object', required: ['csv'], additionalProperties: false, properties: { csv: { type: 'string', maxLength: 500000 } } },
    },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    let parsed: ReturnType<typeof parseFinancialCsv>
    try { parsed = parseFinancialCsv(request.body.csv) }
    catch (error) { return reply.code(422).send({ error: { code: (error as Error).message } }) }
    const unresolvedRows = parsed.rows.filter((row) => !row.id || row.type === 'split' || row.type === 'merge').length
    if (parsed.issues.length) return reply.code(422).send({ ...parsed, unresolvedRows, batchId: null })
    const contentHash = createHash('sha256').update(JSON.stringify(parsed.rows.map((row) => JSON.stringify(row)).sort())).digest('hex')
    const now = new Date()
    const preview = await database.transaction(async (tx) => {
      await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, portfolioId)).for('update')
      await tx.delete(batches).where(and(eq(batches.portfolioId, portfolioId), isNull(batches.confirmedAt), lte(batches.expiresAt, now)))
      const existing = await tx.select({ id: batches.id, contentHash: batches.contentHash, expiresAt: batches.expiresAt, confirmedAt: batches.confirmedAt, supersededAt: batches.supersededAt })
        .from(batches).where(eq(batches.portfolioId, portfolioId)).limit(maxBatches)
      const repeat = existing.find((row) => row.contentHash === contentHash)
      if (repeat) return repeat
      if (existing.length >= maxBatches) return null
      const [created] = await tx.insert(batches).values({
        portfolioId, contentHash, observations: parsed.rows, expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      }).returning({ id: batches.id, expiresAt: batches.expiresAt, confirmedAt: batches.confirmedAt, supersededAt: batches.supersededAt })
      return created
    })
    if (!preview) return reply.code(409).send({ error: { code: 'import_batch_limit' } })
    return { batchId: preview.id, expiresAt: preview.expiresAt, confirmedAt: preview.confirmedAt, supersededAt: preview.supersededAt, unresolvedRows, ...parsed }
  })

  const getBatch = async (portfolioId: string, batchId: string) => {
    const [batch] = await database.select().from(batches)
      .where(and(eq(batches.id, batchId), eq(batches.portfolioId, portfolioId))).limit(1)
    return batch
  }
  app.get<{ Params: { portfolioId: string; batchId: string } }>(prefix + '/imports/:batchId', {
    schema: { ...auth, tags: ['accounting'], summary: 'Read an owned import batch', params: batchParams },
  }, async (request, reply) => {
    const { portfolioId, batchId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const batch = await getBatch(portfolioId, batchId)
    if (!batch || (!batch.confirmedAt && batch.expiresAt <= new Date())) return reply.code(404).send(missing)
    return { batchId, expiresAt: batch.expiresAt, confirmedAt: batch.confirmedAt, supersededAt: batch.supersededAt, supersededBy: batch.supersededBy, rowCount: batch.observations.length, observations: batch.observations }
  })

  app.post<{ Params: { portfolioId: string; batchId: string }; Querystring: { replaces?: string } }>(prefix + '/imports/:batchId/confirm', {
    schema: { ...auth, tags: ['accounting'], summary: 'Confirm an owned CSV preview and optionally replace a prior batch',
      params: batchParams, querystring: { type: 'object', properties: { replaces: uuid } } },
  }, async (request, reply) => {
    const { portfolioId, batchId } = request.params
    const { replaces } = request.query
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const result = await database.transaction(async (tx) => {
      await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, portfolioId)).for('update')
      const [batch] = await tx.select().from(batches).where(and(eq(batches.id, batchId), eq(batches.portfolioId, portfolioId)))
      const now = new Date()
      if (!batch || (!batch.confirmedAt && batch.expiresAt <= now)) return { status: 'missing' } as const
      if (batch.confirmedAt && !replaces) return { status: 'confirmed', confirmedAt: batch.confirmedAt } as const
      if (replaces) {
        const [previous] = await tx.select().from(batches).where(and(eq(batches.id, replaces), eq(batches.portfolioId, portfolioId)))
        if (previous?.supersededBy === batchId && batch.confirmedAt) return { status: 'confirmed', confirmedAt: batch.confirmedAt } as const
        if (!previous?.confirmedAt || previous.supersededAt || replaces === batchId || batch.confirmedAt) return { status: 'conflict' } as const
        await tx.update(batches).set({ supersededAt: now, supersededBy: batchId }).where(eq(batches.id, replaces))
      }
      await tx.update(batches).set({ confirmedAt: now }).where(eq(batches.id, batchId))
      return { status: 'confirmed', confirmedAt: now } as const
    })
    if (result.status === 'missing') return reply.code(404).send(missing)
    if (result.status === 'conflict') return reply.code(409).send({ error: { code: 'import_replacement_conflict' } })
    return { batchId, confirmedAt: result.confirmedAt }
  })

  async function loadEvidence(portfolioId: string) {
    const [confirmed, accounts] = await Promise.all([
      database.select({ id: batches.id, observations: batches.observations }).from(batches)
        .where(and(eq(batches.portfolioId, portfolioId), isNotNull(batches.confirmedAt), isNull(batches.supersededAt))).orderBy(batches.id),
      database.select({ id: providerAccounts.id }).from(providerAccounts).where(eq(providerAccounts.portfolioId, portfolioId)).limit(1),
    ])
    const evidence = confirmed.flatMap((batch) => batch.observations.map((observation, index) => ({ batchId: batch.id, row: index + 2, observation })))
    return { evidence, providerEvidencePresent: accounts.length > 0 }
  }

  app.get<{ Params: { portfolioId: string }; Querystring: { asOf?: string } }>(prefix + '/accounting', {
    schema: {
      ...auth, tags: ['accounting'], summary: 'Replay confirmed financial evidence through an optional event-time cutoff',
      params: portfolioParams,
      querystring: { type: 'object', properties: { asOf: { type: 'string', format: 'date-time' } } },
    },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const requested = request.query.asOf
    if (requested && !z.iso.datetime({ offset: true }).safeParse(requested).success) return reply.code(422).send({ error: { code: 'invalid_valuation_cutoff' } })
    const asOf = requested ? new Date(requested).toISOString() : new Date().toISOString()
    const { evidence, providerEvidencePresent } = await loadEvidence(portfolioId)
    return replayAccounting(evidence, asOf, providerEvidencePresent)
  })

  app.get<{ Params: { portfolioId: string }; Querystring: { from: string; through: string } }>(prefix + '/accounting/history', {
    schema: {
      ...auth, tags: ['accounting'], summary: 'Replay daily portfolio valuations over an inclusive UTC range',
      params: portfolioParams,
      querystring: { type: 'object', required: ['from', 'through'], properties: {
        from: { type: 'string', format: 'date' }, through: { type: 'string', format: 'date' },
      } },
    },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const day = 86_400_000
    const start = Date.parse(request.query.from + 'T00:00:00.000Z')
    const end = Date.parse(request.query.through + 'T00:00:00.000Z')
    const days = (end - start) / day + 1
    if (!Number.isInteger(days) || days < 1 || days > 31) {
      return reply.code(422).send({ error: { code: 'valuation_range_limit' } })
    }
    const { evidence, providerEvidencePresent } = await loadEvidence(portfolioId)
    if (evidence.length * days > 100_000) return reply.code(422).send({ error: { code: 'valuation_work_limit' } })
    const points = Array.from({ length: days }, (_, index) => {
      const asOf = new Date(start + (index + 1) * day - 1).toISOString()
      const state = replayAccounting(evidence, asOf, providerEvidencePresent)
      return { asOf, status: state.status, discrepancyCount: state.discrepancies.length, balances: state.cash }
    })
    return { method: 'weighted_average', points }

  })
}

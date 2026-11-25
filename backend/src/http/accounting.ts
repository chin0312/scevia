import { Decimal } from 'decimal.js'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { financialImportBatches as batches, portfolios, providerAccounts, sourceRecords } from '../db/schema.js'
import { parseFinancialCsv } from '../accounting/csv.js'
import { loadProviderEvidence } from '../accounting/provider-evidence.js'
import type { Evidence } from '../accounting/model.js'
import { replayAccounting } from '../accounting/ledger.js'

const uuid = { type: 'string', format: 'uuid' }
const portfolioParams = { type: 'object', required: ['portfolioId'], properties: { portfolioId: uuid } }
const batchParams = { type: 'object', required: ['portfolioId', 'batchId'], properties: { portfolioId: uuid, batchId: uuid } }
const auth = { security: [{ bearerAuth: [] }] }
const prefix = '/portfolios/:portfolioId'
const maxBatches = 25
const maxRetainedBatches = 250
const missing = { error: { code: 'not_found' } }

export function registerAccountingRoutes(app: FastifyInstance, database: Database) {
  async function owned(portfolioId: string, ownerId: string) {
    const [row] = await database.select({ id: portfolios.id }).from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.ownerId, ownerId))).limit(1)
    return row !== undefined
  }
  app.post<{ Params: { portfolioId: string }; Body: { csv: string; providerAccountId?: string; sourceLinks?: Record<string, string> } }>(prefix + '/imports/preview', {
    bodyLimit: 512 * 1024,
    schema: {
      ...auth, tags: ['accounting'], summary: 'Validate a canonical CSV and create an expiring preview',
      params: portfolioParams,
      body: { type: 'object', required: ['csv'], additionalProperties: false, properties: { csv: { type: 'string', maxLength: 500000 }, providerAccountId: uuid, sourceLinks: { type: 'object', maxProperties: 2000, additionalProperties: uuid } } },
    },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const association = request.body.providerAccountId ?? null
    const sourceLinks = request.body.sourceLinks ?? {}
    const [account] = association ? await database.select({ id: providerAccounts.id, venue: providerAccounts.providerCode })
      .from(providerAccounts).where(and(eq(providerAccounts.id, association), eq(providerAccounts.portfolioId, portfolioId))) : []
    if (association && !account) return reply.code(404).send(missing)
    if (!association && Object.keys(sourceLinks).length) return reply.code(422).send({ error: { code: 'source_links_require_account' } })
    let parsed: ReturnType<typeof parseFinancialCsv>
    try { parsed = parseFinancialCsv(request.body.csv) }
    catch (error) { return reply.code(422).send({ error: { code: (error as Error).message } }) }
    const unresolvedRows = parsed.rows.filter((row) => !row.id || ((row.type === 'split' || row.type === 'merge') && !row.completeSet)).length
    if (parsed.issues.length) return reply.code(422).send({ ...parsed, unresolvedRows, batchId: null })
    if (account && parsed.rows.some((row) => row.venue !== account.venue)) {
      return reply.code(422).send({ error: { code: 'associated_venue_mismatch' } })
    }
    const ids = new Set(parsed.rows.map((row) => row.id))
    if (Object.keys(sourceLinks).some((id) => !ids.has(id))) return reply.code(422).send({ error: { code: 'source_link_row_missing' } })
    const linkedIds = [...new Set(Object.values(sourceLinks))]
    if (association && linkedIds.length) {
      const linked = await database.select({ id: sourceRecords.id }).from(sourceRecords)
        .where(and(inArray(sourceRecords.id, linkedIds), eq(sourceRecords.providerAccountId, association)))
      if (linked.length !== linkedIds.length) return reply.code(422).send({ error: { code: 'source_link_outside_account' } })
    }
    const normalizedRows = parsed.rows.map((row) => JSON.stringify(row)).sort()
    const hashInput = association ? [association, Object.entries(sourceLinks).sort(), normalizedRows] : normalizedRows
    const contentHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex')
    const now = new Date()
    const preview = await database.transaction(async (tx) => {
      await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, portfolioId)).for('update')
      await tx.delete(batches).where(and(eq(batches.portfolioId, portfolioId), isNull(batches.confirmedAt), lte(batches.expiresAt, now)))
      const existing = await tx.select({ id: batches.id, contentHash: batches.contentHash, expiresAt: batches.expiresAt, confirmedAt: batches.confirmedAt, supersededAt: batches.supersededAt })
        .from(batches).where(eq(batches.portfolioId, portfolioId)).limit(maxRetainedBatches)
      const repeat = existing.find((row) => row.contentHash === contentHash)
      if (repeat) return repeat
      if (existing.length >= maxRetainedBatches || existing.filter((row) => !row.supersededAt).length >= maxBatches) return null
      const [created] = await tx.insert(batches).values({
        portfolioId, contentHash, associatedAccountId: association, sourceLinks, observations: parsed.rows, expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      }).returning({ id: batches.id, expiresAt: batches.expiresAt, confirmedAt: batches.confirmedAt, supersededAt: batches.supersededAt })
      return created
    })
    if (!preview) return reply.code(409).send({ error: { code: 'import_batch_limit' } })
    const candidate = { id: preview.id, observations: parsed.rows, associatedAccountId: association, sourceLinks }
    const state = await loadEvidence(portfolioId, now.toISOString(), preview.confirmedAt ? undefined : candidate)
    const proposed = state.truncated ? null : replay(state, now.toISOString())
    const previewSummary = proposed ? {
      status: proposed.status,
      discrepancies: proposed.discrepancies.filter((issue) => issue.sources.some((source) => 'batchId' in source && source.batchId === preview.id)),
      matchedEvents: proposed.events.filter((event) => event.sources.some((source) => 'batchId' in source && source.batchId === preview.id)).length,
    } : null
    return { batchId: preview.id, previewSummary, associatedAccountId: association, expiresAt: preview.expiresAt, confirmedAt: preview.confirmedAt, supersededAt: preview.supersededAt, unresolvedRows, ...parsed }
  })

  app.get<{ Params: { portfolioId: string }; Querystring: { offset?: number } }>(prefix + '/imports', {
    schema: { ...auth, tags: ['accounting'], summary: 'List owned import batches', params: portfolioParams,
      querystring: { type: 'object', properties: { offset: { type: 'integer', minimum: 0, maximum: 250 } } } },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const offset = request.query.offset ?? 0
    const rows = await database.select({ batchId: batches.id, createdAt: batches.createdAt, expiresAt: batches.expiresAt,
      confirmedAt: batches.confirmedAt, supersededAt: batches.supersededAt, supersededBy: batches.supersededBy,
      associatedAccountId: batches.associatedAccountId,
    }).from(batches).where(eq(batches.portfolioId, portfolioId)).orderBy(desc(batches.createdAt), desc(batches.id)).limit(25).offset(offset)
    const now = new Date()
    return { items: rows.map((row) => ({ ...row, status: row.supersededAt ? 'superseded' : row.confirmedAt ? 'active'
      : row.expiresAt <= now ? 'expired' : 'preview' })), offset }
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
    return { batchId, associatedAccountId: batch.associatedAccountId, sourceLinks: batch.sourceLinks, expiresAt: batch.expiresAt, confirmedAt: batch.confirmedAt, supersededAt: batch.supersededAt, supersededBy: batch.supersededBy, rowCount: batch.observations.length, observations: batch.observations }
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
      if (batch.supersededAt) return { status: 'conflict' } as const
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

  async function loadEvidence(portfolioId: string, cutoff: string, preview?: Pick<typeof batches.$inferSelect,
    'id' | 'observations' | 'associatedAccountId' | 'sourceLinks'>) {
    const [confirmed, provider] = await database.transaction(async (tx) => {
      const confirmed = await tx.select().from(batches).where(and(eq(batches.portfolioId, portfolioId),
        isNotNull(batches.confirmedAt), isNull(batches.supersededAt))).orderBy(batches.id)
      const provider = await loadProviderEvidence(tx, portfolioId, new Date(cutoff))
      return [confirmed, provider] as const
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    const sources = new Map(provider.evidence.flatMap((item) =>
      'sourceRecordId' in item && !item.unresolvedReason ? [[item.sourceRecordId, item] as const] : []))
    const connectedVenues = new Set(provider.accounts.map((account) => account.venue))
    const imported: Evidence[] = (preview ? [...confirmed, preview] : confirmed).flatMap((batch) => batch.observations.map((row, index): Evidence => {
      const ref = { batchId: batch.id, row: index + 2 }
      const observation = { ...row, account: batch.associatedAccountId ?? row.account }
      const supportOnly = row.type === 'opening_cash' || row.type === 'opening_inventory' || row.type === 'opening_position' || row.type === 'mark'
      if (supportOnly) return { ...ref, observation }
      const requested = row.id && Object.hasOwn(batch.sourceLinks, row.id) ? batch.sourceLinks[row.id] : null
      const providerEvidence = requested ? sources.get(requested) : undefined
      if (providerEvidence && providerEvidence.observation.account === batch.associatedAccountId) {
        const canonical = providerEvidence.observation
        const candidate = { ...observation, id: canonical.id }
        return Object.entries(candidate).every(([key, value]) => canonical[key as keyof typeof canonical] === value)
          ? { ...ref, observation: canonical }
          : { ...ref, observation: candidate, unresolvedReason: 'linked_source_financial_conflict' }
      }
      if (batch.associatedAccountId || connectedVenues.has(row.venue)) {
        return { ...ref, observation, unresolvedReason: requested ? 'linked_source_unavailable' : 'cross_source_overlap_unresolved' }
      }
      return { ...ref, observation }
    }))
    return { ...provider, evidence: [...provider.evidence, ...imported] }
  }

  function replay(input: Awaited<ReturnType<typeof loadEvidence>>, asOf: string) {
    return replayAccounting(input.evidence, asOf, input.truncated)
  }

  function compareSnapshots(input: Awaited<ReturnType<typeof loadEvidence>>, asOf: string) {
    const cached = new Map<string, ReturnType<typeof replayAccounting>>()
    function at(date: Date) {
      const time = date.toISOString()
      const previous = cached.get(time)
      if (previous) return previous
      if ((cached.size + 1) * input.evidence.length > 100_000 || cached.size >= 32) return null
      const state = replay(input, time)
      cached.set(time, state)
      return state
    }
    function compare(observed: string, reconstructed: string | null) {
      return reconstructed === null ? { status: 'not_comparable', difference: null }
        : { status: new Decimal(observed).eq(reconstructed) ? 'observed_components_match' : 'observed_components_differ',
          difference: new Decimal(observed).minus(reconstructed).toFixed() }
    }
    const freshness = (date: Date) => Date.parse(asOf) - date.getTime() > 86_400_000 ? 'historical' : 'recent'
    return {
      positions: input.positions.map((row) => {
        const holding = at(row.observedAt)?.holdings.find((entry) => entry.account === row.account
          && entry.instrument === row.instrument && entry.asset === row.asset)
        const knownQuantity = holding?.quantity ?? null
        const coverage = input.coverage.find((entry) => entry.account === row.account && entry.entity === 'positions')
        const reconstructedAverageCost = holding?.averageCost ?? null
        return { ...row, knownQuantity, reconstructedAverageCost,
          averageCostComparison: row.averageCost === null ? { status: 'not_comparable', difference: null }
            : compare(row.averageCost, reconstructedAverageCost),
          membership: coverage?.lastSuccessfulRunId === row.syncRunId && coverage.lastAttemptStatus === 'complete'
            ? 'seen_in_latest_successful_refresh' : 'uncertain',
          coverageStatus: coverage?.status ?? 'unknown', freshness: freshness(row.observedAt), ...compare(row.quantity, knownQuantity) }
      }),
      cash: input.balances.map((row) => {
        const cash = at(row.observedAt)?.cash.find((entry) => entry.account === row.account && entry.asset === row.asset)
        const reconstructedBalance = cash?.balance ?? null
        return { ...row, reconstructedBalance, freshness: freshness(row.observedAt), ...compare(row.balance, reconstructedBalance) }
      }),
    }
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
    const input = await loadEvidence(portfolioId, asOf)
    if (input.truncated) return reply.code(422).send({ error: { code: 'provider_evidence_limit' } })
    const result = replay(input, asOf)
    return { ...result, providerEvidencePresent: input.evidence.some((item) => 'providerAccountId' in item),
      providerCoverage: input.coverage, activityEvidence: input.activityEvidence, snapshots: compareSnapshots(input, asOf) }
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
    const input = await loadEvidence(portfolioId, new Date(end + day - 1).toISOString())
    if (input.truncated || input.evidence.length * days > 100_000) return reply.code(422).send({ error: { code: 'valuation_work_limit' } })
    const points = Array.from({ length: days }, (_, index) => {
      const asOf = new Date(start + (index + 1) * day - 1).toISOString()
      const state = replay(input, asOf)
      return { asOf, status: state.status, discrepancyCount: state.discrepancies.length, balances: state.cash }
    })
    return { method: 'weighted_average', points }

  })
}

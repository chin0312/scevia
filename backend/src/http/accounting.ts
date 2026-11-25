import { registerScenarioRoutes } from './scenarios.js'
import { methodology, scopedReference, ScenarioError, type ScenarioBaseline } from '../scenarios/engine.js'
import { canonicalInstrumentKeys, instrumentKey } from '../analytics/scope.js'
import { Decimal } from 'decimal.js'
import { createHash, randomUUID } from 'node:crypto'
import { and, count, desc, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { financialImportBatches as batches, portfolios, providerAccounts, sourceRecords, instruments, markets, events, reviewedBinaryRules, reviewedSettlementConstraints, portfolioAccountingDecisions as decisions } from '../db/schema.js'
import { normalizeManualEvent, parseFinancialCsv } from '../accounting/csv.js'
import { loadProviderEvidence } from '../accounting/provider-evidence.js'
import type { Evidence, PortfolioDecision } from '../accounting/model.js'
import { applyDecisions, compose, digest, potentialOverlaps, recordKey, replacementDecisions } from '../accounting/decisions.js'
import { conditionalSettlementResponse, exposureResponse, performanceResponse } from '../analytics/contracts.js'
import { analyzePerformance } from '../analytics/performance.js'
import { analyzeExposure, analyzeReportedExposure } from '../analytics/exposure.js'
import { settlementRisk } from '../analytics/settlement.js'
import { replayAccounting } from '../accounting/ledger.js'

const uuid = { type: 'string', format: 'uuid' }
const portfolioParams = { type: 'object', required: ['portfolioId'], properties: { portfolioId: uuid } }
const batchParams = { type: 'object', required: ['portfolioId', 'batchId'], properties: { portfolioId: uuid, batchId: uuid } }
const auth = { security: [{ bearerAuth: [] }] }
const prefix = '/portfolios/:portfolioId'
const maxBatches = 25
const maxRetainedBatches = 250
type AccountingRead = Pick<Database, 'select' | 'selectDistinctOn'>
const operationalCutoff = '9999-12-31T23:59:59.999Z'
const adjustmentItem = z.object({
  key: z.string().min(1).max(120), action: z.enum(['include', 'distinct', 'exclude', 'restore', 'correct', 'duplicate', 'reset_correction', 'reset_identity', 'reset_duplicate', 'reset_all']),
  correction: z.record(z.string(), z.unknown()).optional(), duplicateOf: z.string().min(1).max(120).optional(),
}).strict()
const recordFilter = z.object({
  account: z.string().min(1).max(160).optional(), venue: z.string().min(1).max(160).optional(),
  instrument: z.string().min(1).max(160).optional(), market: z.string().min(1).max(160).optional(), event: z.uuid().optional(),
  type: z.string().min(1).max(40).optional(), batchId: z.uuid().optional(),
  source: z.enum(['provider', 'import', 'manual']).optional(),
  inclusion: z.enum(['included', 'unresolved', 'excluded']).optional(),
  key: z.string().max(120).optional(),
  from: z.iso.datetime({ offset: true }).optional(), through: z.iso.datetime({ offset: true }).optional(),
  duplicates: z.enum(['yes', 'no']).optional(), review: z.enum(['required', 'clear']).optional(),
  search: z.string().max(100).optional(),
}).strict()
const adjustmentRequest = z.object({
  changes: z.array(adjustmentItem).min(1).max(1000).optional(),
  selection: recordFilter.extend({
    action: z.enum(['include', 'exclude', 'restore', 'reset_correction', 'reset_duplicate', 'reset_identity', 'reset_all']),
    except: z.array(z.string().min(1).max(120)).max(1000).optional(),
  }).refine((value) => Object.keys(value).some((key) => key !== 'action' && key !== 'except')).optional(),
  revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().refine((value) => !!value.changes !== !!value.selection)
const missing = { error: { code: 'not_found' } }
function concurrentWrite(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const pg = ('cause' in error && error.cause ? error.cause : error) as { code?: string; constraint?: string }
  return pg.code === '40001' || pg.code === '40P01'
    || (pg.code === '23505' && ['accounting_decision_revision_unique', 'accounting_decision_operation_unique'].includes(pg.constraint ?? ''))
}


export function registerAccountingRoutes(app: FastifyInstance, database: Database, resolvePublic?: (url: string) => Promise<unknown>) {
  async function owned(portfolioId: string, ownerId: string) {
    const [row] = await database.select({ id: portfolios.id }).from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.ownerId, ownerId))).limit(1)
    return row !== undefined
  }
  app.post<{ Params: { portfolioId: string }; Body: { csv: string; providerAccountId?: string; sourceLinks?: Record<string, string>; replaces?: string; acceptUnlinked?: boolean } }>(prefix + '/imports/preview', {
    bodyLimit: 512 * 1024,
    schema: {
      ...auth, tags: ['accounting'], summary: 'Validate a canonical CSV and create an expiring preview',
      params: portfolioParams,
      body: { type: 'object', required: ['csv'], additionalProperties: false, properties: { csv: { type: 'string', maxLength: 500000 }, providerAccountId: uuid, replaces: uuid, acceptUnlinked: { type: 'boolean' }, sourceLinks: { type: 'object', maxProperties: 2000, additionalProperties: uuid } } },
    },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const replaces = request.body.replaces
    if (replaces) {
      const previous = await getBatch(portfolioId, replaces)
      if (!previous?.confirmedAt || previous.supersededAt) return reply.code(409).send({ error: { code: 'import_replacement_conflict' } })
    }
    const association = request.body.providerAccountId ?? null
    const sourceLinks = request.body.sourceLinks ?? {}
    const acceptUnlinked = request.body.acceptUnlinked === true
    const [account] = association ? await database.select({ id: providerAccounts.id, venue: providerAccounts.providerCode })
      .from(providerAccounts).where(and(eq(providerAccounts.id, association), eq(providerAccounts.portfolioId, portfolioId))) : []
    if (association && !account) return reply.code(404).send(missing)
    if (!association && (acceptUnlinked || Object.keys(sourceLinks).length)) return reply.code(422).send({ error: { code: 'source_links_require_account' } })
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
    const hashInput = association ? [association, Object.entries(sourceLinks).sort(), normalizedRows, ...(acceptUnlinked ? [true] : [])] : normalizedRows
    const contentHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex')
    const now = new Date()
    const preview = await database.transaction(async (tx) => {
      await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, portfolioId)).for('update')
      await tx.delete(batches).where(and(eq(batches.portfolioId, portfolioId), isNull(batches.confirmedAt), lte(batches.expiresAt, now)))
      const existing = await tx.select({ id: batches.id, contentHash: batches.contentHash, expiresAt: batches.expiresAt, confirmedAt: batches.confirmedAt, supersededAt: batches.supersededAt })
        .from(batches).where(and(eq(batches.portfolioId, portfolioId), eq(batches.manual, false))).limit(maxRetainedBatches)
      const repeat = existing.find((row) => row.contentHash === contentHash)
      if (repeat) return repeat
      if (existing.length >= maxRetainedBatches || existing.filter((row) => !row.supersededAt).length >= maxBatches) return null
      const [created] = await tx.insert(batches).values({
        portfolioId, contentHash, associatedAccountId: association, sourceLinks, acceptUnlinked, observations: parsed.rows, expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      }).returning({ id: batches.id, expiresAt: batches.expiresAt, confirmedAt: batches.confirmedAt, supersededAt: batches.supersededAt })
      return created
    })
    if (!preview) return reply.code(409).send({ error: { code: 'import_batch_limit' } })
    const candidate = await getBatch(portfolioId, preview.id)
    if (!candidate) return reply.code(404).send(missing)
    const state = await loadEvidence(portfolioId, operationalCutoff, preview.confirmedAt ? undefined : candidate, undefined, replaces)
    if (state.truncated) return reply.code(422).send({ error: { code: 'provider_evidence_limit' } })
    const reviewRevision = importRevision(state, preview.id, replaces)
    if (!preview.confirmedAt) await database.update(batches).set({ reviewDigest: reviewRevision, reviewReplaces: replaces ?? null })
      .where(and(eq(batches.id, preview.id), eq(batches.portfolioId, portfolioId), isNull(batches.confirmedAt)))
    const proposed = state.truncated ? null : replay(state, now.toISOString())
    const previewSummary = proposed ? {
      status: proposed.status,
      discrepancies: proposed.discrepancies.filter((issue) => issue.sources.some((source) => 'batchId' in source && source.batchId === preview.id)),
      matchedEvents: proposed.events.filter((event) => event.sources.some((source) => 'batchId' in source && source.batchId === preview.id)).length,
    } : null
    return { batchId: preview.id, reviewRevision, replacementDecisions: state.replacement.report, previewSummary, associatedAccountId: association, expiresAt: preview.expiresAt, confirmedAt: preview.confirmedAt, supersededAt: preview.supersededAt, unresolvedRows, ...parsed, rows: candidate.observations }
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
    }).from(batches).where(and(eq(batches.portfolioId, portfolioId), eq(batches.manual, false))).orderBy(desc(batches.createdAt), desc(batches.id)).limit(25).offset(offset)
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
    return { batchId, associatedAccountId: batch.associatedAccountId, sourceLinks: batch.sourceLinks, acceptUnlinked: batch.acceptUnlinked, expiresAt: batch.expiresAt, confirmedAt: batch.confirmedAt, supersededAt: batch.supersededAt, supersededBy: batch.supersededBy, rowCount: batch.observations.length, observations: batch.observations }
  })

  app.post<{ Params: { portfolioId: string; batchId: string }; Querystring: { replaces?: string; reviewRevision?: string } }>(prefix + '/imports/:batchId/confirm', {
    schema: { ...auth, tags: ['accounting'], summary: 'Confirm an owned CSV preview and optionally replace a prior batch',
      params: batchParams, querystring: { type: 'object', properties: { replaces: uuid, reviewRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } },
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
      let carried: Map<string, PortfolioDecision> = new Map()
      let latestDecision = 0
      if (!batch.confirmedAt) {
        const evidence = await loadEvidence(portfolioId, operationalCutoff, batch, tx, replaces)
        const revision = importRevision(evidence, batchId, replaces)
        if (evidence.truncated || !batch.reviewDigest || batch.reviewReplaces !== (replaces ?? null)
          || batch.reviewDigest !== revision || request.query.reviewRevision !== revision) {
          return { status: 'stale' } as const
        }
        carried = evidence.replacement.changes
        latestDecision = evidence.decisionRevision
      }
      if (replaces) {
        const [previous] = await tx.select().from(batches).where(and(eq(batches.id, replaces), eq(batches.portfolioId, portfolioId)))
        if (previous?.supersededBy === batchId && batch.confirmedAt) return { status: 'confirmed', confirmedAt: batch.confirmedAt } as const
        if (!previous?.confirmedAt || previous.supersededAt || replaces === batchId || batch.confirmedAt) return { status: 'conflict' } as const
        await tx.update(batches).set({ supersededAt: now, supersededBy: batchId }).where(eq(batches.id, replaces))
      }
      const inherited = [...carried.entries()]
      for (let offset = 0; offset < inherited.length; offset += 250) {
        await tx.insert(decisions).values(inherited.slice(offset, offset + 250).map(([key, decision], index) => ({
          portfolioId, recordKey: key, decision, revision: latestDecision + offset + index + 1,
        })))
      }
      await tx.update(batches).set({ confirmedAt: now }).where(eq(batches.id, batchId))
      return { status: 'confirmed', confirmedAt: now } as const
    }, { isolationLevel: 'serializable' }).catch((error: unknown) => {
      if (concurrentWrite(error)) return { status: 'stale' } as const
      throw error
    })
    if (result.status === 'missing') return reply.code(404).send(missing)
    if (result.status === 'stale') return reply.code(409).send({ error: { code: 'import_preview_stale' } })
    if (result.status === 'conflict') return reply.code(409).send({ error: { code: 'import_replacement_conflict' } })
    return { batchId, confirmedAt: result.confirmedAt }
  })

  async function loadEvidence(portfolioId: string, cutoff: string, preview?: Pick<typeof batches.$inferSelect,
    'id' | 'observations' | 'associatedAccountId' | 'sourceLinks'> & { manual?: boolean; acceptUnlinked?: boolean }, read?: AccountingRead, replaces?: string, accountScope?: string[]) {
    const readAll = async (tx: AccountingRead) => {
      const confirmed = await tx.select().from(batches).where(and(eq(batches.portfolioId, portfolioId),
        isNotNull(batches.confirmedAt), isNull(batches.supersededAt))).orderBy(batches.id)
      const provider = await loadProviderEvidence(tx, portfolioId, new Date(cutoff),
        accountScope?.filter((account) => z.uuid().safeParse(account).success))
      const latest = await tx.selectDistinctOn([decisions.recordKey], {
        key: decisions.recordKey, decision: decisions.decision, revision: decisions.revision,
      }).from(decisions).where(eq(decisions.portfolioId, portfolioId)).orderBy(decisions.recordKey, desc(decisions.revision)).limit(10001)
      const [last] = await tx.select({ revision: decisions.revision }).from(decisions)
        .where(eq(decisions.portfolioId, portfolioId)).orderBy(desc(decisions.revision)).limit(1)
      return [confirmed, provider, latest, last?.revision ?? 0] as const
    }
    const [confirmed, provider, latest, decisionRevision] = read ? await readAll(read)
      : await database.transaction(readAll, { isolationLevel: 'repeatable read', accessMode: 'read only' })
    const sources = new Map(provider.evidence.flatMap((item) =>
      'sourceRecordId' in item && !item.unresolvedReason ? [[item.sourceRecordId, item] as const] : []))
    const connected = new Set(provider.accounts.filter((account) => account.kind !== 'file_import').map((account) => account.account))
    const supplementCandidates = new Set<string>()
    const imported: Evidence[] = (preview ? [...confirmed, preview] : confirmed).flatMap((batch) => batch.observations.map((row, index): Evidence => {
      const ref = { batchId: batch.id, row: index + 2 }
      const observation = { ...row, account: batch.associatedAccountId ?? row.account }
      const supportOnly = row.type === 'history_complete' || row.type === 'opening_cash' || row.type === 'opening_inventory' || row.type === 'opening_position' || row.type === 'mark'
      if (batch.manual) return { ...ref, observation, authority: 'user_accepted', acquisition: 'manual' }
      if (supportOnly) return { ...ref, observation }
      const requested = row.id && Object.hasOwn(batch.sourceLinks, row.id) ? batch.sourceLinks[row.id] : null
      const providerEvidence = requested ? sources.get(requested) : undefined
      if (providerEvidence && providerEvidence.observation.account === batch.associatedAccountId) {
        const canonical = providerEvidence.observation
        const candidate = { ...observation, id: canonical.id }
        return Object.entries(candidate).every(([key, value]) => key === 'canonicalInstrumentId' || canonical[key as keyof typeof canonical] === value)
          ? { ...ref, observation: canonical, originalObservation: observation, linkedSourceRecordId: requested!,
            ...(providerEvidence.instrumentMetadata ? { instrumentMetadata: providerEvidence.instrumentMetadata } : {}) }
          : { ...ref, observation: candidate, originalObservation: observation, linkedSourceRecordId: requested!, unresolvedReason: 'linked_source_financial_conflict' }
      }
      if (batch.associatedAccountId && connected.has(batch.associatedAccountId)) {
        if (!requested && batch.acceptUnlinked) supplementCandidates.add(recordKey({ ...ref, observation }))
        return { ...ref, observation, unresolvedReason: requested ? 'linked_source_unavailable' : 'cross_source_overlap_unresolved' }
      }
      return { ...ref, observation }
    }))
    const prior = imported.filter((item) => 'batchId' in item && item.batchId === replaces)
    const allEvidence = [...provider.evidence, ...imported.filter((item) => !('batchId' in item) || item.batchId !== replaces)]
    const candidateOverlaps = supplementCandidates.size ? potentialOverlaps(allEvidence) : new Map()
    const rawEvidence = allEvidence.map((item): Evidence => {
      const key = recordKey(item)
      if (!supplementCandidates.has(key) || candidateOverlaps.has(key)) return item
      const { unresolvedReason: _reason, ...resolved } = item
      return { ...resolved, originalObservation: item.observation, observation: { ...item.observation, id: item.observation.id ?? 'local:' + key }, authority: 'user_accepted' }
    })
    const decisionMap = new Map(latest.map(({ key, decision }) => [key, decision]))
    const incoming = rawEvidence.filter((item) => 'batchId' in item && item.batchId === preview?.id)
    const replacement = replaces ? replacementDecisions(prior, incoming,
      rawEvidence.filter((item) => !('batchId' in item) || item.batchId !== preview?.id), decisionMap)
      : { changes: new Map<string, PortfolioDecision>(), report: [] }
    const applied = applyDecisions(rawEvidence, new Map([...decisionMap, ...replacement.changes]))
    return { ...provider, ...applied, rawEvidence, decisionMap, decisionRevision, replacement,
      recordDecisionRevisions: new Map(latest.map(({ key, revision }) => [key, revision])),
      truncated: provider.truncated || latest.length > 10000,
      selected: applied.records.some((record) => record.decision !== null) }

  }

  function importRevision(input: Awaited<ReturnType<typeof loadEvidence>>, batchId: string, replaces?: string) {
    const scopes = new Set(input.records.filter((record) => record.source.kind === 'import' && record.source.batchId === batchId)
      .map(({ original }) => JSON.stringify([original.venue, original.account])))
    return digest([batchId, replaces ?? null, input.replacement.report, [...input.replacement.changes], input.records.filter(({ original }) =>
      scopes.has(JSON.stringify([original.venue, original.account])))
      .map(({ key, revision, decision }) => [key, revision, decision, input.recordDecisionRevisions.get(key) ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
  }

  function replay(input: Awaited<ReturnType<typeof loadEvidence>>, asOf: string) {
    return { ...replayAccounting(input.evidence, asOf, input.truncated), portfolioScope: input.selected ? 'user_selected' : 'available_evidence' }
  }

  app.post<{ Params: { portfolioId: string }; Body: { venue: string; label: string } }>(prefix + '/accounting/accounts', {
    schema: { ...auth, tags: ['accounting'], summary: 'Create an independent imported or manual account',
      params: portfolioParams, body: { type: 'object', additionalProperties: false, required: ['venue', 'label'], properties: {
        venue: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$' },
        label: { type: 'string', minLength: 1, maxLength: 100 },
      } } },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const [account] = await database.insert(providerAccounts).values({
      portfolioId, providerCode: request.body.venue, externalAccountId: 'local:' + randomUUID(),
      label: request.body.label, kind: 'file_import', disabledAt: new Date(),
    }).returning({ id: providerAccounts.id, venue: providerAccounts.providerCode, label: providerAccounts.label })
    return reply.code(201).send(account)
  })

  app.post<{ Params: { portfolioId: string }; Body: { accountId: string; clientId: string; event: Record<string, unknown> } }>(prefix + '/accounting/manual-records', {
    bodyLimit: 8192, schema: { ...auth, tags: ['accounting'], summary: 'Add one user-declared record to an imported account',
      params: portfolioParams, body: { type: 'object', additionalProperties: false, required: ['accountId', 'clientId', 'event'],
        properties: { accountId: uuid, clientId: uuid, event: { type: 'object' } } } },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const { accountId, clientId, event } = request.body
    const [account] = await database.select({ venue: providerAccounts.providerCode }).from(providerAccounts)
      .where(and(eq(providerAccounts.portfolioId, portfolioId), eq(providerAccounts.id, accountId), eq(providerAccounts.kind, 'file_import')))
    if (!account) return reply.code(404).send(missing)
    let observation
    try { observation = normalizeManualEvent({ ...event, venue: account.venue, account: accountId, id: 'manual:' + clientId }) }
    catch { return reply.code(422).send({ error: { code: 'invalid_manual_record' } }) }
    const hash = digest(['manual', accountId, clientId])
    const result = await database.transaction(async (tx) => {
      await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, portfolioId)).for('update')
      const [repeat] = await tx.select().from(batches)
        .where(and(eq(batches.portfolioId, portfolioId), eq(batches.contentHash, hash))).limit(1)
      if (repeat) return digest(repeat.observations[0]) === digest(observation) && !repeat.supersededAt ? repeat : null
      const [capacity] = await tx.select({ total: count() }).from(batches)
        .where(and(eq(batches.portfolioId, portfolioId), eq(batches.manual, true)))
      if ((capacity?.total ?? 0) >= 5000) return null
      const now = new Date()
      const [created] = await tx.insert(batches).values({ portfolioId, contentHash: hash, associatedAccountId: accountId,
        observations: [observation], confirmedAt: now, expiresAt: now, manual: true }).returning()
      return created
    })
    if (!result) return reply.code(409).send({ error: { code: 'manual_record_conflict_or_limit' } })
    return { key: 'import:' + result.id + ':2', batchId: result.id }
  })

  function filterRecords(input: Awaited<ReturnType<typeof loadEvidence>>, q: z.infer<typeof recordFilter>) {
    const adjusted = new Map(input.records.map((record) => [record.key, record.adjusted]))
    const candidates = potentialOverlaps(input.rawEvidence.map((item) => ({
      ...item, observation: adjusted.get(recordKey(item)) ?? item.observation,
    })))
    return input.records.filter((record) => {
      const row = record.adjusted
      const activity = record.providerActivity
      const metadata = row.instrument === record.original.instrument ? record.instrumentMetadata : null
      const requiresReview = record.inclusion === 'unresolved' || record.revisionChanged
        || (record.duplicateLinkStatus !== null && record.duplicateLinkStatus !== 'selected')
      return (!q.account || row.account === q.account) && (!q.venue || row.venue === q.venue)
        && (!q.instrument || row.instrument === q.instrument || activity?.instrument === q.instrument || metadata?.instrument === q.instrument)
        && (!q.market || activity?.market === q.market || metadata?.market === q.market)
        && (!q.event || metadata?.event === q.event) && (!q.type || (activity?.type ?? row.type).toLowerCase() === q.type.toLowerCase())
        && (!q.batchId || (record.source.kind === 'import' && record.source.batchId === q.batchId))
        && (!q.source || record.acquisition === q.source) && (!q.inclusion || record.inclusion === q.inclusion)
        && (!q.key || record.key === q.key) && (!q.from || Date.parse(row.timestamp) >= Date.parse(q.from))
        && (!q.through || Date.parse(row.timestamp) <= Date.parse(q.through))
        && (!q.duplicates || candidates.has(record.key) === (q.duplicates === 'yes'))
        && (!q.review || requiresReview === (q.review === 'required'))
        && (!q.search || [record.key, row.id, record.original.id, record.effective?.observation.id, row.instrument, activity?.externalId, activity?.market, activity?.transactionHash, metadata?.title]
          .some((value) => value?.toLowerCase().includes(q.search!.toLowerCase())))
    }).map((record) => ({ ...record, potentialOverlap: candidates.get(record.key) ?? null }))
  }

  app.get<{ Params: { portfolioId: string }; Querystring: z.infer<typeof recordFilter> & { offset?: number; limit?: number } }>(prefix + '/accounting/records', {
    schema: { ...auth, tags: ['accounting'], summary: 'List normalized financial source records and portfolio decisions',
      params: portfolioParams, querystring: { type: 'object', additionalProperties: false,
        properties: z.toJSONSchema(recordFilter.extend({
          limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(100000).optional(),
        })).properties ?? {} } },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const input = await loadEvidence(portfolioId, operationalCutoff)
    if (input.truncated) return reply.code(422).send({ error: { code: 'provider_evidence_limit' } })
    const records = filterRecords(input, request.query)
      .sort((a, b) => b.adjusted.timestamp.localeCompare(a.adjusted.timestamp) || a.key.localeCompare(b.key))
    const { offset = 0, limit = 50 } = request.query
    return { offset, limit, total: records.length, items: records.slice(offset, offset + limit) }
  })

  async function planChanges(portfolioId: string, request: z.infer<typeof adjustmentRequest>, read?: AccountingRead) {
    const input = await loadEvidence(portfolioId, operationalCutoff, undefined, read)
    if (input.truncated || input.decisionRevision > 100_000) throw new Error('accounting_work_limit')
    const records = new Map(input.records.map((record) => [record.key, record]))
    const changes = new Map<string, PortfolioDecision | null>()
    const selection = request.selection
    const except = new Set(selection?.except)
    const expanded = selection ? filterRecords(input, selection).filter(({ key }) => !except.has(key))
      .map(({ key }) => ({ key, action: selection.action })) : []
    const candidates: Array<z.infer<typeof adjustmentItem>> = request.changes ?? expanded
    if (candidates.length === 0 || candidates.length > 2000) throw new Error('adjustment_selection_limit')
    const ordered = [...candidates].sort((a, b) => a.key.localeCompare(b.key))
    for (const change of ordered) {
      const record = records.get(change.key)
      if (!record || changes.has(change.key)) throw new Error('invalid_record_selection')
      if ((change.action !== 'correct' && change.correction !== undefined)
        || (change.action !== 'duplicate' && change.duplicateOf !== undefined)) throw new Error('unexpected_adjustment_fields')
      const { original } = record
      const next = compose(record.decision)
      if (change.action === 'reset_all') { changes.set(change.key, null); continue }
      if (change.action === 'restore') { delete next.membership; delete next.membershipRevision }
      if (change.action === 'reset_correction') delete next.financial
      if (change.action === 'reset_identity') delete next.identity
      if (change.action === 'reset_duplicate') delete next.duplicate
      if (change.action === 'exclude') { next.membership = 'excluded'; next.membershipRevision = record.revision }
      if (change.action === 'include') {
        next.membership = 'included'
        next.membershipRevision = record.revision
        if (record.source.kind === 'import' && (record.originalReason || !original.id) && !next.identity) {
          next.identity = { mode: 'include', revision: record.revision }
        }
      }
      if (change.action === 'distinct') next.identity = { mode: 'distinct', revision: record.revision }
      if (record.source.kind === 'provider' && (change.action === 'distinct' || (change.action === 'include' && record.originalReason !== null))) {
        throw new Error('provider_evidence_cannot_be_promoted')
      }

      if (change.action === 'correct') {
        if (record.source.kind !== 'import' || !change.correction || (record.linkedSourceRecordId && record.dimensions.identity?.mode !== 'distinct')) throw new Error('import_correction_required')
        const { coveredThrough, entitlementId, relatedEventId, feeTiming, completeSet, canonicalInstrumentId, ...base } = record.adjusted
        if (coveredThrough || entitlementId || relatedEventId || feeTiming || completeSet) throw new Error('replace_complex_event_via_import')
        const values = normalizeManualEvent({ ...base, ...change.correction, venue: base.venue, account: base.account, id: base.id })
        if (canonicalInstrumentId && values.instrument === canonicalInstrumentId) values.canonicalInstrumentId = canonicalInstrumentId
        next.financial = { revision: record.revision, values }
      }
      if (change.action === 'duplicate') {
        const target = change.duplicateOf ? records.get(change.duplicateOf) : undefined
        if (!target || target.key === record.key || target.inclusion !== 'included' || !target.effectiveRevision || target.dimensions.duplicate
          || ordered.some((item) => item.key === target.key)
          || target.original.account !== original.account || target.original.venue !== original.venue
          || target.original.asset !== original.asset || target.original.type !== original.type) throw new Error('invalid_duplicate_target')
        next.duplicate = { target: target.key, revision: target.effectiveRevision, sourceRevision: record.revision }
      }
      changes.set(change.key, Object.keys(next).length ? next : null)
    }
    const affectedAccounts = new Set(ordered.map(({ key }) => {
      const { venue, account } = records.get(key)!.original
      return JSON.stringify([venue, account])
    }))
    const revision = digest([selection ?? null, ordered, input.records.filter(({ original }) =>
      affectedAccounts.has(JSON.stringify([original.venue, original.account])))
      .map(({ key, revision, decision }) => [key, revision, decision, input.recordDecisionRevisions.get(key) ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
    const next = new Map([...input.decisionMap, ...changes])
    return { changes, revision, input, next }
  }

  for (const mode of ['preview', 'confirm'] as const) {
    app.post<{ Params: { portfolioId: string }; Body: unknown }>(prefix + '/accounting/adjustments/' + mode, {
      bodyLimit: 256 * 1024,
      schema: { ...auth, tags: ['accounting'], summary: mode + ' a bounded selection of accounting decisions', params: portfolioParams },
    }, async (request, reply) => {
      const { portfolioId } = request.params
      if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
      const parsed = adjustmentRequest.safeParse(request.body)
      if (!parsed.success) return reply.code(422).send({ error: { code: 'invalid_adjustments' } })
      try {
        if (mode === 'preview') {
          const plan = await planChanges(portfolioId, parsed.data)
          const proposed = applyDecisions(plan.input.rawEvidence, plan.next)
          const asOf = new Date().toISOString()
          const before = replayAccounting(plan.input.evidence, asOf)
          const after = replayAccounting(proposed.evidence, asOf)
          return { revision: plan.revision, affected: plan.changes.size, before: before.cash, after: after.cash,
            beforeHoldings: before.holdings, afterHoldings: after.holdings,
            beforeDiscrepancyCount: before.discrepancies.length, afterDiscrepancyCount: after.discrepancies.length }
        }
        const committed = await database.transaction(async (tx) => {
          await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, portfolioId)).for('update')
          if (!parsed.data.revision) return null
          const operationDigest = digest(parsed.data)
          const [receipt] = await tx.select({ applied: decisions.operationCount }).from(decisions)
            .where(and(eq(decisions.portfolioId, portfolioId), eq(decisions.operationDigest, operationDigest))).limit(1)
          if (receipt) return receipt
          const plan = await planChanges(portfolioId, parsed.data, tx)
          if (plan.revision !== parsed.data.revision) return null
          const entries = [...plan.changes.entries()]
          for (let offset = 0; offset < entries.length; offset += 250) {
            await tx.insert(decisions).values(entries.slice(offset, offset + 250).map(([recordKey, decision], index) => ({
              portfolioId, recordKey, decision, revision: plan.input.decisionRevision + offset + index + 1,
              ...(offset === 0 && index === 0 ? { operationDigest, operationCount: entries.length } : {}),
            })))
          }
          return { applied: plan.changes.size }
        }, { isolationLevel: 'serializable' })
        if (!committed) return reply.code(409).send({ error: { code: 'adjustment_preview_stale' } })
        return committed
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (/^[a-z_]+$/.test(code)) return reply.code(422).send({ error: { code } })
        if (concurrentWrite(error)) {
          return reply.code(409).send({ error: { code: 'adjustment_preview_stale' } })
        }
        throw error
      }
    })
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
    return { comparisonScope: input.selected ? 'user_selected_vs_provider_account' : 'known_components_vs_provider_account',
      positions: input.positions.map((row) => {
        const holding = at(row.observedAt)?.holdings.find((entry) => entry.account === row.account
          && entry.instrument === row.instrument && entry.asset === row.asset)
        const knownQuantity = holding?.quantity ?? null
        const coverage = input.coverage.find((entry) => entry.account === row.account && entry.entity === 'positions')
        const reconstructedAverageCost = holding?.averageCost ?? null
        return { ...row, knownQuantity, reconstructedAverageCost,
          averageCostComparison: row.averageCost === null ? { status: 'not_comparable', difference: null }
            : compare(row.averageCost, reconstructedAverageCost),
          membership: freshness(row.observedAt) === 'recent' && coverage?.lastSuccessfulRunId === row.syncRunId && coverage.lastAttemptStatus === 'complete'
            && coverage.lastSuccessfulSyncAt !== null && coverage.lastSuccessfulSyncAt.toISOString() <= asOf
            && coverage.lastAttemptAt !== null && coverage.lastAttemptAt.toISOString() <= asOf
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

  const AnalyticalDecimal = Decimal.clone({ precision: 70, rounding: Decimal.ROUND_HALF_EVEN })
  const analyticsQuery = z.object({
    asset: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
    asOf: z.iso.datetime({ offset: true }),
    accounts: z.string().max(4000).optional(), venue: z.string().min(1).max(160).optional(),
  })
  const performanceQuery = analyticsQuery.extend({ from: z.iso.datetime({ offset: true }),
    sampling: z.enum(['daily', 'weekly', 'monthly']).optional() })
  function selectAccounts(input: Awaited<ReturnType<typeof loadEvidence>>, requested?: string, venue?: string) {
    const available = new Set([...input.accounts.filter((account) => !venue || account.venue === venue).map((account) => account.account),
      ...input.records.filter((record) => !venue || record.adjusted.venue === venue).map((record) => record.adjusted.account)])
    const accounts = requested === undefined ? [...available].sort() : [...new Set(requested.split(','))].sort()
    if (accounts.length > 100 || accounts.some((account) => !available.has(account))) return null
    return accounts
  }
  function analyticalContext(input: Awaited<ReturnType<typeof loadEvidence>>, accounts: string[], asOf: string, asset: string, venue?: string) {
    const accountSet = new Set(accounts)
    const inScope = (row: { account: string; venue: string }) => accountSet.has(row.account) && (!venue || row.venue === venue)
    const evidence = input.evidence.filter((item) => inScope(item.observation))
    const identities = new Map<string, { venue: string; account: string; assets: Set<string> }>()
    for (const row of [...input.accounts, ...input.records.map((item) => item.adjusted), ...input.positions, ...input.balances]) {
      if (!inScope(row)) continue
      const key = JSON.stringify([row.venue, row.account])
      const identity = identities.get(key) ?? { venue: row.venue, account: row.account, assets: new Set<string>() }
      if ('asset' in row && row.asset && row.asset !== 'UNKNOWN') identity.assets.add(row.asset)
      if ('feeAsset' in row && row.feeAsset) identity.assets.add(row.feeAsset)
      identities.set(key, identity)
    }
    const accountIdentities = [...identities.values()].sort((left, right) => left.venue.localeCompare(right.venue)
      || left.account.localeCompare(right.account)).map(({ venue, account, assets }) => ({ venue, account,
      knownAssets: [...assets].sort(), selectedAssetEvidence: assets.has(asset) ? 'observed' : 'unknown' }))
    return { evidence, context: { asOf, asset, accounts, accountIdentities, venue: venue ?? null,
      evidenceRevision: digest(input.records.filter((record) => inScope(record.adjusted))
        .map((record) => [record.key, record.revision, record.decision]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
      coverageRevision: digest(input.coverage.filter(inScope)
        .map((row) => [row.venue, row.account, row.entity, row.status, row.lastSuccessfulRunId, row.lastAttemptStatus,
          row.lastAttemptAt?.toISOString(), row.lastSuccessfulSyncAt?.toISOString()])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))),
      accountingScope: input.records.some((record) => inScope(record.adjusted) && record.decision !== null)
        ? 'user_selected' : 'available_evidence',
      fullAccountCoverage: 'unverified',
    } }
  }

  app.get<{ Params: { portfolioId: string }; Querystring: unknown }>(prefix + '/analytics/performance', {
    schema: { ...auth, tags: ['analytics'], summary: 'Read selected-asset historical portfolio performance',
      params: portfolioParams, response: { 200: performanceResponse }, querystring: { type: 'object', required: ['asset', 'asOf', 'from'],
        properties: z.toJSONSchema(performanceQuery).properties ?? {} } },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const query = performanceQuery.safeParse(request.query)
    if (!query.success) return reply.code(422).send({ error: { code: 'invalid_analytics_scope' } })
    const asOf = new Date(query.data.asOf).toISOString()
    const from = new Date(query.data.from).toISOString()
    if (from >= asOf) return reply.code(422).send({ error: { code: 'invalid_analytics_range' } })
    return database.transaction(async (tx) => {
      const input = await loadEvidence(portfolioId, asOf, undefined, tx, undefined, query.data.accounts?.split(','))
      if (input.truncated) return reply.code(422).send({ error: { code: 'provider_evidence_limit' } })
      const accounts = selectAccounts(input, query.data.accounts, query.data.venue)
      if (!accounts) return reply.code(422).send({ error: { code: 'invalid_analytics_accounts' } })
      const { context, evidence } = analyticalContext(input, accounts, asOf, query.data.asset, query.data.venue)
      try {
        const data = analyzePerformance(evidence, accounts, query.data.asset, from, asOf, context.accountIdentities)
        const canonicalKeys = canonicalInstrumentKeys(evidence, asOf)
        const identified = [...new Set(data.attribution.instruments
          .filter((row) => canonicalKeys.has(instrumentKey(row, row.instrument)) && z.uuid().safeParse(row.instrument).success)
          .map((row) => row.instrument))]
        const metadata = identified.length ? await tx.select({ instrument: instruments.id, market: markets.id, event: markets.eventId })
          .from(instruments).innerJoin(markets, eq(instruments.marketId, markets.id)).where(inArray(instruments.id, identified)) : []
        const identities = new Map(metadata.map((row) => [row.instrument, row]))
        const instrumentAttribution = data.attribution.instruments.map((row) => {
          const identity = canonicalKeys.has(instrumentKey(row, row.instrument)) ? identities.get(row.instrument) : undefined
          return { ...row, market: identity?.market ?? null, event: identity?.event ?? null }
        })
        type AttributionRow = typeof instrumentAttribution[number]
        function groupAttribution(keyOf: (row: AttributionRow) => string) {
          const groups = new Map<string, AttributionRow[]>()
          for (const row of instrumentAttribution) {
            const key = keyOf(row)
            const group = groups.get(key)
            if (group) group.push(row)
            else groups.set(key, [row])
          }
          return [...groups].map(([id, rows]) => {
            const total = (key: 'knownRealized' | 'knownUnrealizedChange') => {
              const known = rows.flatMap((row) => row[key] === null ? [] : [row[key]])
              return { subtotal: known.length ? known.reduce((value, amount) => value.plus(amount), new AnalyticalDecimal(0)).toFixed() : null,
                known: known.length, unavailable: rows.length - known.length }
            }
            const realized = total('knownRealized')
            const unrealized = total('knownUnrealizedChange')
            return { id, knownRealized: realized.subtotal, knownUnrealizedChange: unrealized.subtotal,
              realizedComponents: realized.known, unavailableRealizedComponents: realized.unavailable,
              unrealizedComponents: unrealized.known, unavailableUnrealizedComponents: unrealized.unavailable }
          })
        }
        const attribution = { ...data.attribution, instruments: instrumentAttribution,
          byEvent: groupAttribution((row) => row.event ?? row.identity).map((row) => ({ ...row, event: row.id })),
          byMarket: groupAttribution((row) => row.market ?? row.identity),
          byInstrument: groupAttribution((row) => row.market ? row.instrument : row.identity),
          byAccount: groupAttribution((row) => JSON.stringify([row.venue, row.account])),
          byVenue: groupAttribution((row) => row.venue),
        }
        const catalogRevision = digest(metadata.sort((left, right) => left.instrument.localeCompare(right.instrument)))
        const sampling = query.data.sampling ?? 'daily'
        if (sampling === 'daily') return { context, catalogRevision, from, sampling, ...data, attribution }
        const history = data.history.filter((point, index, points) => {
          if (index === 0 || index === points.length - 1) return true
          const date = new Date(point.asOf)
          return sampling === 'weekly' ? date.getUTCDay() === 0 : new Date(date.getTime() + 1).getUTCDate() === 1
        })
        return { context, catalogRevision, from, sampling, ...data, attribution, history }
      }
      catch (error) {
        if (error instanceof Error && ['analytics_range_limit', 'analytics_replay_limit'].includes(error.message)) {
          return reply.code(422).send({ error: { code: error.message } })
        }
        throw error
      }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  })

  async function loadExposureCatalog(tx: AccountingRead, asOf: string, asset: string, ids: string[], held: string[],
    recentSnapshotIds: string[], selected: string[] = []) {
    const relevant = ids.length ? await tx.select({ instrument: instruments.id, market: instruments.marketId }).from(instruments)
      .where(inArray(instruments.id, ids)) : []
    if (selected.some((id) => !relevant.some((row) => row.instrument === id))) throw new ScenarioError('catalog_instrument_not_found')
    const marketIds = [...new Set(relevant.map((item) => item.market))]
    const loadGraph = async (seedInstruments: Set<string>) => {
      const seedMarkets = [...new Set(relevant.filter((row) => seedInstruments.has(row.instrument)).map((row) => row.market))]
      const graph = new Set((seedMarkets.length ? await tx.select({ market: reviewedBinaryRules.marketId })
        .from(reviewedBinaryRules).where(and(inArray(reviewedBinaryRules.marketId, seedMarkets),
          lte(reviewedBinaryRules.reviewedAt, new Date(asOf)), eq(reviewedBinaryRules.assetCode, asset))) : [])
        .map((rule) => rule.market))
      let graphLimit = graph.size > 256
      let edges: Array<{ left: string; right: string; kind: 'equivalent' | 'exclusive' | 'implies'; evidence: string; reviewedAt: Date }> = []
      let graphRounds = 0
      while (graph.size && !graphLimit) {
        if (++graphRounds > 256) { graphLimit = true; break }
        const nodes = [...graph]
        edges = await tx.select({ left: reviewedSettlementConstraints.leftMarketId, right: reviewedSettlementConstraints.rightMarketId,
          kind: reviewedSettlementConstraints.kind, evidence: reviewedSettlementConstraints.evidence, reviewedAt: reviewedSettlementConstraints.reviewedAt,
        }).from(reviewedSettlementConstraints).where(and(
          or(inArray(reviewedSettlementConstraints.leftMarketId, nodes), inArray(reviewedSettlementConstraints.rightMarketId, nodes)),
          lte(reviewedSettlementConstraints.reviewedAt, new Date(asOf)))).limit(1001)
        if (edges.length > 1000) { graphLimit = true; break }
        for (const edge of edges) { graph.add(edge.left); graph.add(edge.right) }
        graphLimit = graph.size > 256
        if (nodes.length === graph.size) break
      }
      return { graph, edges: graphLimit ? [] : edges, graphLimit }
    }
    const effective = await loadGraph(new Set([...held, ...selected]))
    const reported = await loadGraph(new Set(recentSnapshotIds))
    const includedMarkets = [...new Set([...marketIds,
      ...(effective.graphLimit ? [] : effective.graph), ...(reported.graphLimit ? [] : reported.graph)])]

    const metadata = includedMarkets.length ? await tx.select({
      instrument: instruments.id, market: markets.id, event: events.id, outcome: instruments.outcomeName,
      resolvesAt: events.resolvesAt, title: markets.title, lifecycle: markets.lifecycle, providerMarket: markets.externalId, provider: markets.providerCode, nativeInstrument: instruments.externalId,
      settlementAsset: instruments.settlementAssetCode, marketAsset: markets.settlementAssetCode,
    }).from(instruments).innerJoin(markets, eq(instruments.marketId, markets.id))
      .innerJoin(events, eq(markets.eventId, events.id)).where(inArray(markets.id, includedMarkets)) : []
    const rules = includedMarkets.length ? await tx.select({
      market: reviewedBinaryRules.marketId, event: markets.eventId, yes: reviewedBinaryRules.yesInstrumentId,
      no: reviewedBinaryRules.noInstrumentId, asset: reviewedBinaryRules.assetCode, evidence: reviewedBinaryRules.evidence,
      reviewedAt: reviewedBinaryRules.reviewedAt,
    }).from(reviewedBinaryRules).innerJoin(markets, eq(reviewedBinaryRules.marketId, markets.id))
      .where(inArray(reviewedBinaryRules.marketId, includedMarkets)) : []
    return { metadata, rules, effective, reported }
  }

  async function loadExposureInputs(tx: AccountingRead, portfolioId: string, asOf: string, asset: string,
    scope: Pick<z.infer<typeof analyticsQuery>, 'accounts' | 'venue'>, selected: string[] = []) {
    const input = await loadEvidence(portfolioId, asOf, undefined, tx, undefined, scope.accounts?.split(','))
    if (input.truncated) throw new ScenarioError('provider_evidence_limit')
    const accounts = selectAccounts(input, scope.accounts, scope.venue)
    if (!accounts) throw new ScenarioError('invalid_analytics_accounts')
    const { context, evidence } = analyticalContext(input, accounts, asOf, asset, scope.venue)
    const state = replayAccounting(evidence, asOf)
    const snapshots = input.positions.filter((row) => accounts.includes(row.account) && row.asset === asset && (!scope.venue || row.venue === scope.venue))
    const holdings = state.holdings.filter((row) => row.asset === asset && new AnalyticalDecimal(row.quantity).gt(0))
    const canonicalKeys = canonicalInstrumentKeys(evidence, asOf)
    const canonicalHoldings = holdings.filter((row) => canonicalKeys.has(instrumentKey(row, row.instrument)))
    const ids = [...new Set([...canonicalHoldings, ...snapshots]
      .map((row) => row.instrument).concat(selected).filter((id) => z.uuid().safeParse(id).success))]
    if (ids.length > 2000) throw new ScenarioError('analytics_instrument_limit')
    const held = canonicalHoldings.filter((row) => row.quantityStatus === 'reconstructed_from_declaration').map((row) => row.instrument)
    const recentSnapshotIds = snapshots.filter((row) => new AnalyticalDecimal(row.quantity).gt(0)
      && Date.parse(asOf) - row.observedAt.getTime() <= 86_400_000).map((row) => row.instrument)
    const { metadata, rules, effective, reported } = await loadExposureCatalog(tx, asOf, asset, ids, held, recentSnapshotIds, selected)
    const edgeOrder = (left: { left: string; right: string }, right: { left: string; right: string }) =>
      left.left.localeCompare(right.left) || left.right.localeCompare(right.right)
    const response = { context, metadataBasis: 'current_catalog',
      snapshotRevision: digest(snapshots.map((row) => ({ ...row, observedAt: row.observedAt.toISOString(),
        markAt: row.markAt?.toISOString() ?? null })).sort((left, right) => left.venue.localeCompare(right.venue) || left.account.localeCompare(right.account)
          || left.instrument.localeCompare(right.instrument) || left.sourceRecordId.localeCompare(right.sourceRecordId))),
      catalogRevision: digest(metadata.map((row) => ({ ...row, resolvesAt: row.resolvesAt?.toISOString() ?? null }))
        .sort((left, right) => left.instrument.localeCompare(right.instrument))),
      reportedExposure: analyzeReportedExposure(snapshots, input.coverage, asOf, asset, metadata, rules, reported.edges, reported.graphLimit),
      settlementEvidenceRevision: digest([
        rules.map((rule) => ({ ...rule, reviewedAt: rule.reviewedAt.toISOString() })).sort((left, right) => left.market.localeCompare(right.market)),
        { effectiveLimit: effective.graphLimit, reportedLimit: reported.graphLimit,
          effective: effective.edges.sort(edgeOrder).map((edge) => ({ ...edge, reviewedAt: edge.reviewedAt.toISOString() })),
          reported: reported.edges.sort(edgeOrder).map((edge) => ({ ...edge, reviewedAt: edge.reviewedAt.toISOString() })) },
      ]),
      ...analyzeExposure(state, asset, accounts, metadata, rules, effective.edges, effective.graph, effective.graphLimit, context.accountIdentities, canonicalKeys) }
    return { response, state, canonicalKeys, metadata, effective, rules, evidence }
  }

  registerScenarioRoutes(app, database, owned, async (tx, portfolioId, source, publicInstruments): Promise<ScenarioBaseline> => {
    const { mode, asset, local } = source
    const publicMatches = publicInstruments.length ? await tx.select({ id: instruments.id, token: instruments.externalId,
      market: markets.externalId, provider: markets.providerCode }).from(instruments).innerJoin(markets, eq(instruments.marketId, markets.id))
      .where(and(eq(markets.providerCode, 'polymarket'), inArray(instruments.externalId, publicInstruments.map((row) => row.nativeInstrument!)))) : []
    const aliases: Record<string, string> = {}
    const normalizedPublic = publicInstruments.map((row) => {
      const exact = publicMatches.find((entry) => entry.provider === row.provider && entry.market === row.nativeMarket && entry.token === row.nativeInstrument)
      if (exact) aliases[row.id] = exact.id
      return { ...row, id: exact?.id ?? row.id }
    })
    const catalog = [...new Set([...source.catalog, ...Object.values(aliases)])]
    const venueFor = (provider: string) => ['polymarket', 'kalshi'].includes(provider) ? provider : undefined
    const metadataFor = (entry: Awaited<ReturnType<typeof loadExposureCatalog>>['metadata'][number]) => {
      const venue = venueFor(entry.provider)
      return { market: entry.market, event: entry.event, outcome: entry.outcome, lifecycle: entry.lifecycle,
        provider: entry.provider, nativeMarket: entry.providerMarket, nativeInstrument: entry.nativeInstrument, providerMarket: entry.providerMarket,
        settlementAsset: entry.settlementAsset ?? entry.marketAsset, resolvesAt: entry.resolvesAt?.toISOString() ?? null,
        ...(venue ? { venue } : {}) }
    }
    const asOf = new Date(source.asOf).toISOString()
    const actual = mode === 'actual' ? await loadExposureInputs(tx, portfolioId, asOf, asset,
      { accounts: source.accounts.join(','), ...(source.venue === undefined ? {} : { venue: source.venue }) }, catalog) : null
    const model = actual ?? await loadExposureCatalog(tx, asOf, asset, catalog, [], [], catalog)
    const listings = new Map(model.metadata.map((row) => [row.instrument, row]))
    const baselineInstruments = new Map(normalizedPublic.map((row) => [row.id, row]))
    for (const id of catalog) {
      const entry = listings.get(id)!
      if ((entry.settlementAsset ?? entry.marketAsset) && (entry.settlementAsset ?? entry.marketAsset) !== asset) throw new ScenarioError('catalog_instrument_asset_mismatch')
      baselineInstruments.set(id, { id, mark: null, ...baselineInstruments.get(id), ...metadataFor(entry) })
    }
    for (const row of local) baselineInstruments.set(row.id, { id: row.id, mark: row.mark, markSource: 'declared_local' })
    const bucketKey = (row: { venue: string; account: string }) => JSON.stringify([row.venue, row.account])
    const cashRows = actual?.state.cash.filter((row) => row.asset === asset) ?? []
    const positions = actual?.state.holdings.filter((row) => row.asset === asset) ?? []
    const buckets = mode === 'scratch' ? source.buckets.map((row) => ({ ...row, pending: '0' }))
      : actual!.response.context.accountIdentities.map((scope) => {
        const cash = cashRows.find((row) => row.venue === scope.venue && row.account === scope.account)
        const scoped = positions.filter((row) => row.venue === scope.venue && row.account === scope.account)
        const pendingKnown = cash?.openingInventoryAt != null && scoped.every((row) => row.settlementAvailability === 'selected_entitlements_only')
        const pending = pendingKnown ? scoped.reduce((value, row) => value.plus(row.pending), new AnalyticalDecimal(0)).toFixed() : null
        const providers = [...new Set(scoped.flatMap((row) => {
          const provider = actual!.canonicalKeys.has(instrumentKey(row, row.instrument)) ? listings.get(row.instrument)?.provider : undefined
          return provider && venueFor(provider) ? [provider] : []
        }))]
        const tradingVenue = venueFor(scope.venue) ?? (providers.length === 1 ? providers[0] : undefined)
        const inventoryComplete = pendingKnown && !actual!.state.discrepancies.some(({ scope: issue, reason }) =>
          issue.venue === scope.venue && issue.account === scope.account && (issue.asset === asset || issue.asset === 'UNKNOWN')
          && reason !== 'same_time_marks_conflict' && (issue.instrument !== null || issue.type === 'opening_inventory' || issue.type === 'unresolved_activity'))
        return { id: bucketKey(scope), inventoryComplete, ...(tradingVenue ? { tradingVenue } : {}), venue: scope.venue, account: scope.account, cash: cash?.balance ?? null, pending,
          coverage: cash?.historyCoverage ?? 'unverified', inventoryAt: cash?.openingInventoryAt ?? null,
          pendingEntitlements: scoped.flatMap((row) => row.entitlements.map((entitlement) =>
            ({ instrument: row.instrument, ...entitlement }))) }
      })
    const holdings = positions.filter((row) => new AnalyticalDecimal(row.quantity).gt(0)).map((row) => {
      const isCanonical = actual!.canonicalKeys.has(instrumentKey(row, row.instrument))
      const identity = isCanonical ? listings.get(row.instrument) : undefined
      const id = identity ? row.instrument : 'holding:' + digest([row.venue, row.account, row.instrument])
      const candidateMark = row.markStatus === 'estimated' ? row.mark : null
      baselineInstruments.set(id, { id, mark: null, ...baselineInstruments.get(id), ...(identity ? metadataFor(identity) : {}) })
      return { bucket: bucketKey(row), instrument: id, quantity: row.quantity,
        quantityKnown: row.quantityStatus === 'reconstructed_from_declaration', basis: row.basisAvailability === 'selected_events_only' ? row.basis : null,
        originalInstrument: row.instrument, mark: candidateMark, markAt: row.markAt }
    })
    for (const [id, instrument] of baselineInstruments) {
      if (!listings.has(id) || instrument.mark !== null || !actual) continue
      const observations = new Map(holdings.filter((row) => row.instrument === id && row.quantityKnown && row.mark !== null && row.markAt !== null)
        .map((row) => [row.bucket, { scope: row.bucket, price: row.mark!, asOf: row.markAt! }]))
      const markedScopes = new Map<string, { scope: string; asOf: string; prices: Set<string> }>()
      for (const item of actual.evidence) {
        const row = item.observation
        if (item.unresolvedReason || row.type !== 'mark' || row.instrument !== id || row.asset !== asset || row.price === null
          || row.timestamp > asOf || Date.parse(asOf) - Date.parse(row.timestamp) > 86_400_000
          || (!('providerAccountId' in item) && row.canonicalInstrumentId !== id && !actual.canonicalKeys.has(instrumentKey(row, id)))) continue
        const scope = bucketKey(row)
        const prior = markedScopes.get(scope)
        if (!prior || prior.asOf < row.timestamp) markedScopes.set(scope, { scope, asOf: row.timestamp, prices: new Set([row.price]) })
        else if (prior.asOf === row.timestamp) prior.prices.add(row.price)
      }
      for (const row of markedScopes.values()) {
        if (observations.has(row.scope)) continue
        if (row.prices.size === 1) observations.set(row.scope, { ...row, price: row.prices.values().next().value! })
      }
      const reference = scopedReference([...observations.values()])
      if (reference) baselineInstruments.set(id, { ...instrument, ...reference })
    }
    if (!buckets.length || buckets.length > 100 || holdings.length > 250) throw new ScenarioError('baseline_scope_limit')
    const rules = model.rules.filter((rule) => model.effective.graph.has(rule.market) && rule.asset === asset && rule.reviewedAt.toISOString() <= asOf
      && [rule.yes, rule.no].every((id) => listings.get(id)?.market === rule.market)
      && ['open', 'closed'].includes(listings.get(rule.yes)?.lifecycle ?? '')
      && model.metadata.filter((entry) => entry.market === rule.market).length === 2)
      .map((rule) => ({ id: rule.market, yes: rule.yes, no: rule.no, asset, evidence: rule.evidence, reviewedAt: rule.reviewedAt.toISOString() }))
    const constraints = model.effective.edges.map((edge) => ({ ...edge, reviewedAt: edge.reviewedAt.toISOString() }))
    return { methodology, mode, asset, asOf, buckets: buckets.sort((a, b) => a.id.localeCompare(b.id)),
      holdings: holdings.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.instrument.localeCompare(b.instrument)),
      instruments: [...baselineInstruments.values()].sort((a, b) => a.id.localeCompare(b.id)),
      rules: rules.sort((a, b) => a.id.localeCompare(b.id)),
      constraints: constraints.sort((a, b) => a.left.localeCompare(b.left) || a.right.localeCompare(b.right)),
      publicInstruments, instrumentAliases: aliases,
      reservedRules: model.rules.filter((rule) => rule.reviewedAt.toISOString() <= asOf)
        .map((rule) => ({ id: rule.market, yes: rule.yes, no: rule.no })).sort((a, b) => a.id.localeCompare(b.id)),
      settlementGraphLimited: model.effective.graphLimit,
      missingRules: [...model.effective.graph].filter((id) => !rules.some((rule) => rule.id === id)).sort(),
      revisions: actual ? { public: digest(publicInstruments), financial: actual.response.context.evidenceRevision, coverage: actual.response.context.coverageRevision,
        catalog: actual.response.catalogRevision, snapshots: actual.response.snapshotRevision, settlement: actual.response.settlementEvidenceRevision }
        : { public: digest(publicInstruments), catalog: digest(model.metadata.map((row) => ({ ...row, resolvesAt: row.resolvesAt?.toISOString() ?? null })).sort((a, b) => a.instrument.localeCompare(b.instrument))),
          settlement: digest([rules.sort((a, b) => a.id.localeCompare(b.id)), constraints.sort((a, b) => a.left.localeCompare(b.left) || a.right.localeCompare(b.right))]) } }
  }, resolvePublic)

  app.get<{ Params: { portfolioId: string }; Querystring: unknown }>(prefix + '/analytics/exposure', {
    schema: { ...auth, tags: ['analytics'], summary: 'Read allocation, resolution timeline and reviewed settlement risk',
      params: portfolioParams, response: { 200: exposureResponse }, querystring: { type: 'object', required: ['asset', 'asOf'],
        properties: z.toJSONSchema(analyticsQuery).properties ?? {} } },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const query = analyticsQuery.safeParse(request.query)
    if (!query.success) return reply.code(422).send({ error: { code: 'invalid_analytics_scope' } })
    const { asset } = query.data
    const asOf = new Date(query.data.asOf).toISOString()
    try {
      return await database.transaction(async (tx) => (await loadExposureInputs(tx, portfolioId, asOf, asset, query.data)).response,
        { isolationLevel: 'repeatable read', accessMode: 'read only' })
    } catch (error) {
      if (error instanceof ScenarioError) return reply.code(422).send({ error: { code: error.message } })
      throw error
    }
  })

  app.get<{ Params: { portfolioId: string } }>(prefix + '/analytics/scope', {
    schema: { ...auth, tags: ['analytics'], summary: 'Discover accounts and denominations in selected financial evidence', params: portfolioParams },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const asOf = new Date().toISOString()
    const input = await loadEvidence(portfolioId, asOf)
    const accountKey = (venue: string, id: string) => JSON.stringify([venue, id])
    const accounts = new Map<string, { id: string; venue: string; assets: Map<string, Set<string>> }>()
    const register = (venue: string, id: string, asset?: string | null, evidence?: string) => {
      const key = accountKey(venue, id)
      let row = accounts.get(key)
      if (!row) {
        row = { id, venue, assets: new Map() }
        accounts.set(key, row)
      }
      if (asset && evidence && asset !== 'UNKNOWN') {
        const sources = row.assets.get(asset) ?? new Set<string>()
        sources.add(evidence)
        row.assets.set(asset, sources)
      }
    }
    for (const row of input.accounts) register(row.venue, row.account)
    for (const { adjusted } of input.records) register(adjusted.venue, adjusted.account)
    for (const { observation } of input.evidence) {
      register(observation.venue, observation.account, observation.asset, observation.type === 'mark'
        ? 'reference_mark' : observation.type === 'opening_inventory' ? 'inventory_declaration'
          : observation.instrument ? 'selected_position_activity' : 'selected_cash_activity')
      register(observation.venue, observation.account, observation.feeAsset, 'fee_denomination')
    }
    for (const row of input.positions) register(row.venue, row.account, row.asset, 'provider_position_snapshot')
    for (const row of input.balances) register(row.venue, row.account, row.asset, 'provider_balance_snapshot')
    return { asOf, status: input.truncated ? 'partial' : 'available',
      accounts: [...accounts.values()].sort((left, right) => left.venue.localeCompare(right.venue) || left.id.localeCompare(right.id))
        .map(({ id, venue, assets }) => ({ id, venue, assets: [...assets.keys()].sort(),
          assetEvidence: [...assets.keys()].sort().map((asset) => ({ asset, sources: [...assets.get(asset)!].sort() })) })) }
  })

  const conditionalQuery = z.object({
    account: z.string().min(1).max(160), venue: z.string().min(1).max(160),
    asOf: z.iso.datetime({ offset: true }), asset: z.string().min(1).max(80),
    yes: z.string().min(1).max(160), no: z.string().min(1).max(160),
    unitPayout: z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/),
  }).strict()
  app.post<{ Params: { portfolioId: string }; Body: unknown }>(prefix + '/analytics/conditional-settlement', {
    bodyLimit: 4096,
    schema: { ...auth, tags: ['analytics'], summary: 'Calculate an isolated user-declared binary payout',
      params: portfolioParams, body: { type: 'object' }, response: { 200: conditionalSettlementResponse } },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const parsed = conditionalQuery.safeParse(request.body)
    if (!parsed.success || parsed.data.yes === parsed.data.no || new AnalyticalDecimal(parsed.data.unitPayout).lte(0)) {
      return reply.code(422).send({ error: { code: 'invalid_payout_declaration' } })
    }
    const { account, venue, asset, yes, no, unitPayout } = parsed.data
    const asOf = new Date(parsed.data.asOf).toISOString()
    const input = await loadEvidence(portfolioId, asOf, undefined, undefined, undefined, [account])
    if (input.truncated) return reply.code(422).send({ error: { code: 'provider_evidence_limit' } })
    if (!selectAccounts(input, account, venue)) return reply.code(422).send({ error: { code: 'invalid_analytics_accounts' } })
    const { evidence, context } = analyticalContext(input, [account], asOf, asset, venue)
    const rows = replayAccounting(evidence, asOf).holdings.filter((row) => row.venue === venue && row.asset === asset
      && (row.instrument === yes || row.instrument === no) && new AnalyticalDecimal(row.quantity).gt(0))
    return { context, scope: 'user_declared_contract_known_selected_quantities',
      quantityCoverage: !rows.length ? 'unavailable' : rows.every((row) => row.quantityStatus === 'reconstructed_from_declaration')
        ? 'reconstructed_from_declaration' : 'known_partial_quantities',
      declaration: { venue, yes, no, unitPayout },
      holdings: rows.map(({ instrument, quantity, quantityStatus }) => ({ instrument, quantity, quantityStatus })),
      result: rows.length ? settlementRisk([{ id: 'declared', yes, no, unitPayout, asset, legs: rows.map((row) => ({
        account, venue, instrument: row.instrument, quantity: row.quantity, mark: row.markStatus === 'estimated' ? row.mark : null,
      })) }], []) : { status: 'unavailable', reason: 'no_matching_selected_positions' } }
  })

  app.get<{ Params: { portfolioId: string }; Querystring: { asOf?: string; view?: 'summary' | 'detail' } }>(prefix + '/accounting', {
    schema: {
      ...auth, tags: ['accounting'], summary: 'Replay confirmed financial evidence through an optional event-time cutoff',
      params: portfolioParams,
      querystring: { type: 'object', properties: { asOf: { type: 'string', format: 'date-time' }, view: { enum: ['summary', 'detail'] } } },
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
    const accountCoverage = input.accounts.map(({ account, venue, kind }) => ({
      account, venue, kind, externalAccountCompleteness: 'unverified',
      historyAvailability: kind === 'file_import' ? 'user_evidence' :
        input.coverage.some((scope) => scope.account === account && scope.status === 'partial') ? 'provider_partial' : 'provider_unverified',
      observedState: input.positions.some((position) => position.account === account)
        || input.balances.some((balance) => balance.account === account) ? 'reported_snapshot_available' : 'unavailable',
      replayEvidence: result.events.some((event) => event.account === account) ? 'available' : 'unavailable',
    }))
    const { events, ledger, discrepancies, ...summary } = result
    const coverage = { providerEvidencePresent: input.rawEvidence.some((item) => 'providerAccountId' in item),
      providerCoverage: input.coverage, accountCoverage, discrepancyCount: discrepancies.length }
    if (request.query.view === 'summary') return { ...summary, ...coverage }
    return { ...summary, ...coverage, events, ledger, discrepancies,
      activityEvidence: input.activityEvidence, snapshots: compareSnapshots(input, asOf) }

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
      return { asOf, status: state.status, portfolioScope: state.portfolioScope, discrepancyCount: state.discrepancies.length, balances: state.cash }
    })
    return { method: 'weighted_average', points }

  })
}

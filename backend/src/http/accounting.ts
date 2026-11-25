import { Decimal } from 'decimal.js'
import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { financialImportBatches as batches, portfolios, providerAccounts, sourceRecords, portfolioAccountingDecisions as decisions } from '../db/schema.js'
import { normalizeManualEvent, parseFinancialCsv } from '../accounting/csv.js'
import { loadProviderEvidence } from '../accounting/provider-evidence.js'
import type { Evidence, PortfolioDecision } from '../accounting/model.js'
import { applyDecisions, digest, potentialOverlaps, recordKey } from '../accounting/decisions.js'
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
  key: z.string().min(1).max(120), action: z.enum(['include', 'distinct', 'exclude', 'restore', 'correct', 'duplicate']),
  correction: z.record(z.string(), z.unknown()).optional(), duplicateOf: z.string().min(1).max(120).optional(),
}).strict()
const adjustmentRequest = z.object({
  changes: z.array(adjustmentItem).min(1).max(200).optional(),
  selection: z.object({
    action: z.enum(['include', 'exclude', 'restore']),
    account: z.string().min(1).max(160).optional(), batchId: z.uuid().optional(),
    instrument: z.string().min(1).max(160).optional(), type: z.string().min(1).max(40).optional(),
    inclusion: z.enum(['included', 'unresolved', 'excluded']).optional(),
    except: z.array(z.string().min(1).max(120)).max(200).optional(),
  }).strict().refine((value) => !!(value.account || value.batchId || value.instrument)).optional(),
  revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().refine((value) => !!value.changes !== !!value.selection)
const missing = { error: { code: 'not_found' } }

export function registerAccountingRoutes(app: FastifyInstance, database: Database) {
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
        .from(batches).where(eq(batches.portfolioId, portfolioId)).limit(maxRetainedBatches)
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
    return { batchId: preview.id, reviewRevision, previewSummary, associatedAccountId: association, expiresAt: preview.expiresAt, confirmedAt: preview.confirmedAt, supersededAt: preview.supersededAt, unresolvedRows, ...parsed, rows: candidate.observations }
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
      if (!batch.confirmedAt) {
        const evidence = await loadEvidence(portfolioId, operationalCutoff, batch, tx, replaces)
        const revision = importRevision(evidence, batchId, replaces)
        if (evidence.truncated || !batch.reviewDigest || batch.reviewReplaces !== (replaces ?? null)
          || batch.reviewDigest !== revision || (request.query.reviewRevision && request.query.reviewRevision !== revision)) {
          return { status: 'stale' } as const
        }
      }
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
    if (result.status === 'stale') return reply.code(409).send({ error: { code: 'import_preview_stale' } })
    if (result.status === 'conflict') return reply.code(409).send({ error: { code: 'import_replacement_conflict' } })
    return { batchId, confirmedAt: result.confirmedAt }
  })

  async function loadEvidence(portfolioId: string, cutoff: string, preview?: Pick<typeof batches.$inferSelect,
    'id' | 'observations' | 'associatedAccountId' | 'sourceLinks'> & { manual?: boolean; acceptUnlinked?: boolean }, read?: AccountingRead, replaces?: string) {
    const readAll = async (tx: AccountingRead) => {
      const confirmed = await tx.select().from(batches).where(and(eq(batches.portfolioId, portfolioId),
        isNotNull(batches.confirmedAt), isNull(batches.supersededAt))).orderBy(batches.id)
      const provider = await loadProviderEvidence(tx, portfolioId, new Date(cutoff))
      const latest = await tx.selectDistinctOn([decisions.recordKey], {
        key: decisions.recordKey, decision: decisions.decision, revision: decisions.revision,
      }).from(decisions).where(eq(decisions.portfolioId, portfolioId)).orderBy(decisions.recordKey, desc(decisions.revision)).limit(10001)
      const [last] = await tx.select({ revision: decisions.revision }).from(decisions)
        .where(eq(decisions.portfolioId, portfolioId)).orderBy(desc(decisions.revision)).limit(1)
      return [confirmed.filter((batch) => batch.id !== replaces), provider, latest, last?.revision ?? 0] as const
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
        return Object.entries(candidate).every(([key, value]) => canonical[key as keyof typeof canonical] === value)
          ? { ...ref, observation: canonical, originalObservation: observation, linkedSourceRecordId: requested! }
          : { ...ref, observation: candidate, originalObservation: observation, linkedSourceRecordId: requested!, unresolvedReason: 'linked_source_financial_conflict' }
      }
      if (batch.associatedAccountId && connected.has(batch.associatedAccountId)) {
        if (!requested && batch.acceptUnlinked) supplementCandidates.add(recordKey({ ...ref, observation }))
        return { ...ref, observation, unresolvedReason: requested ? 'linked_source_unavailable' : 'cross_source_overlap_unresolved' }
      }
      return { ...ref, observation }
    }))
    const allEvidence = [...provider.evidence, ...imported]
    const candidateOverlaps = supplementCandidates.size ? potentialOverlaps(allEvidence) : new Map()
    const rawEvidence = allEvidence.map((item): Evidence => {
      const key = recordKey(item)
      if (!supplementCandidates.has(key) || candidateOverlaps.has(key)) return item
      const { unresolvedReason: _reason, ...resolved } = item
      return { ...resolved, originalObservation: item.observation, observation: { ...item.observation, id: item.observation.id ?? 'local:' + key }, authority: 'user_accepted' }
    })
    const decisionMap = new Map(latest.map(({ key, decision }) => [key, decision]))
    const applied = applyDecisions(rawEvidence, decisionMap)
    return { ...provider, ...applied, rawEvidence, decisionMap, decisionRevision,
      truncated: provider.truncated || latest.length > 10000,
      selected: applied.records.some((record) => record.decision !== null) }

  }

  function importRevision(input: Awaited<ReturnType<typeof loadEvidence>>, batchId: string, replaces?: string) {
    const scopes = new Set(input.records.filter((record) => record.source.kind === 'import' && record.source.batchId === batchId)
      .map(({ original }) => JSON.stringify([original.venue, original.account])))
    return digest([batchId, replaces ?? null, input.records.filter(({ original }) =>
      scopes.has(JSON.stringify([original.venue, original.account])))
      .map(({ key, revision, decision }) => [key, revision, decision]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
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
      const existing = await tx.select().from(batches).where(eq(batches.portfolioId, portfolioId)).limit(maxRetainedBatches)
      const repeat = existing.find((row) => row.contentHash === hash)
      if (repeat) return digest(repeat.observations[0]) === digest(observation) && !repeat.supersededAt ? repeat : null
      if (existing.length >= maxRetainedBatches || existing.filter((row) => !row.supersededAt).length >= maxBatches) return null
      const now = new Date()
      const [created] = await tx.insert(batches).values({ portfolioId, contentHash: hash, associatedAccountId: accountId,
        observations: [observation], confirmedAt: now, expiresAt: now, manual: true }).returning()
      return created
    })
    if (!result) return reply.code(409).send({ error: { code: 'manual_record_conflict_or_limit' } })
    return { key: 'import:' + result.id + ':2', batchId: result.id }
  })

  app.get<{ Params: { portfolioId: string }; Querystring: Record<string, string | number | undefined> }>(prefix + '/accounting/records', {
    schema: { ...auth, tags: ['accounting'], summary: 'List normalized financial source records and portfolio decisions',
      params: portfolioParams, querystring: { type: 'object', additionalProperties: false, properties: {
        account: { type: 'string', maxLength: 160 }, venue: { type: 'string', maxLength: 160 }, instrument: { type: 'string', maxLength: 160 },
        type: { type: 'string', maxLength: 40 }, batchId: uuid, source: { enum: ['provider', 'import', 'manual'] },
        inclusion: { enum: ['included', 'unresolved', 'excluded'] }, key: { type: 'string', maxLength: 120 },
        from: { type: 'string', format: 'date-time' }, through: { type: 'string', format: 'date-time' },
        duplicates: { enum: ['yes', 'no'] },
        search: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0, maximum: 100000 },
      } } },
  }, async (request, reply) => {
    const { portfolioId } = request.params
    if (!await owned(portfolioId, request.principalId!)) return reply.code(404).send(missing)
    const input = await loadEvidence(portfolioId, operationalCutoff)
    if (input.truncated) return reply.code(422).send({ error: { code: 'provider_evidence_limit' } })
    const candidates = potentialOverlaps(input.rawEvidence)
    const q = request.query
    const records = input.records.filter((record) => {
      const row = record.effective?.observation ?? record.original
      return (!q.account || row.account === q.account) && (!q.venue || row.venue === q.venue)
        && (!q.instrument || row.instrument === q.instrument) && (!q.type || row.type === q.type)
        && (!q.batchId || (record.source.kind === 'import' && record.source.batchId === q.batchId))
        && (!q.source || record.acquisition === q.source) && (!q.inclusion || record.inclusion === q.inclusion)
        && (!q.key || record.key === q.key) && (!q.from || Date.parse(row.timestamp) >= Date.parse(String(q.from)))
        && (!q.through || Date.parse(row.timestamp) <= Date.parse(String(q.through)))
        && (!q.duplicates || candidates.has(record.key) === (q.duplicates === 'yes'))
        && (!q.search || [record.key, row.id, row.instrument].some((value) => value?.toLowerCase().includes(String(q.search).toLowerCase())))
    }).sort((a, b) => b.original.timestamp.localeCompare(a.original.timestamp) || a.key.localeCompare(b.key))
    const offset = Number(q.offset ?? 0)
    const limit = Number(q.limit ?? 50)
    return { offset, limit, total: records.length, items: records.slice(offset, offset + limit)
      .map((record) => ({ ...record, potentialOverlap: candidates.get(record.key) ?? null })) }
  })

  async function planChanges(portfolioId: string, request: z.infer<typeof adjustmentRequest>, read?: AccountingRead) {
    const input = await loadEvidence(portfolioId, operationalCutoff, undefined, read)
    if (input.truncated || input.decisionRevision > 100_000) throw new Error('accounting_work_limit')
    const records = new Map(input.records.map((record) => [record.key, record]))
    const changes = new Map<string, PortfolioDecision | null>()
    const selection = request.selection
    const except = new Set(selection?.except)
    const expanded = selection ? input.records.filter((record) => {
      const event = record.effective?.observation ?? record.original
      return !except.has(record.key) && (!selection.account || event.account === selection.account)
        && (!selection.instrument || event.instrument === selection.instrument)
        && (!selection.type || event.type === selection.type) && (!selection.inclusion || record.inclusion === selection.inclusion)
        && (!selection.batchId || (record.source.kind === 'import' && record.source.batchId === selection.batchId))
    }).map(({ key }) => ({ key, action: selection.action })) : []
    const candidates: Array<z.infer<typeof adjustmentItem>> = request.changes ?? expanded
    if (candidates.length === 0 || candidates.length > 200) throw new Error('adjustment_selection_limit')
    const ordered = [...candidates].sort((a, b) => a.key.localeCompare(b.key))
    for (const change of ordered) {
      const record = records.get(change.key)
      if (!record || changes.has(change.key)) throw new Error('invalid_record_selection')
      if ((change.action !== 'correct' && change.correction !== undefined)
        || (change.action !== 'duplicate' && change.duplicateOf !== undefined)) throw new Error('unexpected_adjustment_fields')
      const { original } = record
      if (change.action === 'restore') { changes.set(change.key, null); continue }
      if (record.source.kind === 'provider' && (change.action === 'distinct' || (change.action === 'include' && record.originalReason !== null))) {
        throw new Error('provider_evidence_cannot_be_promoted')
      }
      const next: PortfolioDecision = { action: change.action, evidenceRevision: record.revision }
      if (change.action === 'correct') {
        if (record.source.kind !== 'import' || !change.correction || (record.effective?.linkedSourceRecordId && record.decision?.action !== 'distinct')) throw new Error('import_correction_required')
        const { coveredThrough, entitlementId, relatedEventId, feeTiming, completeSet, ...base } = original
        if (coveredThrough || entitlementId || relatedEventId || feeTiming || completeSet) throw new Error('replace_complex_event_via_import')
        next.correction = normalizeManualEvent({ ...base, ...change.correction, venue: base.venue, account: base.account,
          id: record.decision?.action === 'distinct' ? record.effective?.observation.id : base.id })
      }
      if (change.action === 'duplicate') {
        const target = change.duplicateOf ? records.get(change.duplicateOf) : undefined
        if (!target || target.key === record.key || target.inclusion !== 'included'
          || ordered.some((item) => item.key === target.key)
          || target.original.account !== original.account || target.original.venue !== original.venue
          || target.original.asset !== original.asset || target.original.type !== original.type) throw new Error('invalid_duplicate_target')
        next.duplicateOf = target.key
        next.duplicateRevision = target.revision
      }
      changes.set(change.key, next)
    }
    const affectedAccounts = new Set(ordered.map(({ key }) => {
      const { venue, account } = records.get(key)!.original
      return JSON.stringify([venue, account])
    }))
    const revision = digest([selection ?? null, ordered, input.records.filter(({ original }) =>
      affectedAccounts.has(JSON.stringify([original.venue, original.account])))
      .map(({ key, revision, decision }) => [key, revision, decision]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
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
          const plan = await planChanges(portfolioId, parsed.data, tx)
          if (plan.revision !== parsed.data.revision) return null
          await tx.insert(decisions).values([...plan.changes.entries()].map(([recordKey, decision], index) => ({
            portfolioId, recordKey, decision, revision: plan.input.decisionRevision + index + 1,
          })))
          return { applied: plan.changes.size }
        }, { isolationLevel: 'repeatable read' })
        if (!committed) return reply.code(409).send({ error: { code: 'adjustment_preview_stale' } })
        return committed
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (/^[a-z_]+$/.test(code)) return reply.code(422).send({ error: { code } })
        if (error && typeof error === 'object' && 'cause' in error
          && (error.cause as { code?: string } | null)?.code === '40001') {
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

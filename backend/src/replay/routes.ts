import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { digest } from '../accounting/decisions.js'
import type { Database } from '../db/client.js'
import { historicalReplays as saved, portfolios, users } from '../db/schema.js'
import { fxAnchors, loadFx, reportingCurrency } from '../fx/reference.js'
import { replayConfig, ReplayError } from './contracts.js'
import { evaluateReplay, validateReplay } from './engine.js'
import { compactReplayPoint, comparisonEvidenceQualifications, freezeReplay, presentReplay, replaySnapshot, replaySummary, sharedEvidenceChanges, type FrozenReplayResult } from './result.js'
import { replayEvidence, resolutionCutoffs } from './evidence.js'

const collectionParams = z.object({ collectionId: z.uuid(), replayId: z.uuid().optional() })
const metadata = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).nullable().optional() })
const revision = z.number().int().positive()
const token = z.uuid()
const idNotFound = { error: { code: 'not_found' } }
const detailQuery = z.object({ detail: z.literal('full').optional() }).strict()
const readQuery = detailQuery.extend({ at: z.iso.datetime({ offset: true }).optional() }).strict()
const display = <T extends { result: FrozenReplayResult }>(row: T, detail = false) =>
  ({ ...row, result: presentReplay(row.result, detail) })
const invalidQuery = { error: { code: 'invalid_replay_detail_query' } }
const staleRevision = { error: { code: 'stale_replay_revision' } }
type Frozen = { configuration: z.infer<typeof replayConfig>; result: FrozenReplayResult }

export function registerHistoricalReplay(app: FastifyInstance, db: Database, maxDays = 365) {
  const root = '/simulations/:collectionId/replays'
  const previews = new Map<string, { owner: string; collection: string; expires: number; frozen: Frozen }>()
  const scope = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = collectionParams.safeParse(request.params)
    if (!parsed.success) { await reply.code(404).send(idNotFound); return null }
    const owner = request.principalId!
    const { collectionId, replayId } = parsed.data
    const [collection] = await db.select({ id: portfolios.id }).from(portfolios)
      .where(and(eq(portfolios.id, collectionId), eq(portfolios.ownerId, owner), eq(portfolios.simulationOnly, true))).limit(1)
    if (!collection) { await reply.code(404).send(idNotFound); return null }
    return { collectionId, replayId, owner }
  }
  const preview = (previewToken: string, owner: string, collectionId: string) => {
    const row = previews.get(previewToken)
    return row && row.expires > Date.now() && row.owner === owner && row.collection === collectionId ? row.frozen : null
  }
  const find = async (collectionId: string, id: string) => (await db.select().from(saved)
    .where(and(eq(saved.collectionId, collectionId), eq(saved.id, id))).limit(1))[0]
  async function insert(collectionId: string, details: z.infer<typeof metadata>, frozen: Frozen) {
    return db.transaction(async (tx) => {
      await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, collectionId)).for('update')
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(saved).where(eq(saved.collectionId, collectionId))
      if (count!.total >= 24) return null
      return (await tx.insert(saved).values({ collectionId, ...details, ...frozen }).returning())[0]!
    })
  }

  app.post(root + '/evaluate', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    const query = detailQuery.safeParse(request.query)
    if (!query.success) return reply.code(422).send(invalidQuery)
    const body = replayConfig.safeParse(request.body)
    if (!body.success) return reply.code(422).send({ error: { code: 'invalid_replay_configuration', issues: body.error.issues } })
    try {
      const frozen = await db.transaction(async (tx) => {
        const [preference] = await tx.select({ currency: users.reportingCurrency, fiatSource: users.fiatReferenceSource,
          stablecoinSource: users.stablecoinReferenceSource }).from(users).where(eq(users.id, owned.owner))
        const configuration = { ...body.data, currency: body.data.currency ?? reportingCurrency.safeParse(preference?.currency).data ?? 'USD' as const }
        const evaluationAt = new Date().toISOString()
        validateReplay(configuration, evaluationAt, maxDays)
        const data = await replayEvidence(tx, configuration, evaluationAt)
        const lifecycleCutoffs = resolutionCutoffs(configuration, data.catalog, data.lifecycle)
        const rates = await loadFx(tx, configuration.from, configuration.through, { assets: configuration.buckets.map((row) => row.asset),
          currency: configuration.currency, mode: configuration.mode, cutoffs: [...lifecycleCutoffs, ...fxAnchors(configuration.cashFlows.map((row) => row.at)),
            ...configuration.positions.flatMap((row) => [row.entry.at, ...row.exits.map((exit) => exit.at)])] })
        const result = freezeReplay(evaluateReplay(configuration, data, rates, evaluationAt, preference))
        return { configuration, result }
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
      if (Buffer.byteLength(JSON.stringify(frozen)) > 2_500_000) return reply.code(422).send({ error: { code: 'replay_output_work_limit' } })
      for (const [key, row] of previews) if (row.expires <= Date.now()) previews.delete(key)
      if (previews.size >= 8) previews.delete(previews.keys().next().value!)
      const previewToken = randomUUID()
      const expires = Date.now() + 15 * 60_000
      previews.set(previewToken, { owner: owned.owner, collection: owned.collectionId, expires, frozen })
      return { previewToken, expiresAt: new Date(expires).toISOString(), ...display(frozen, query.data.detail === 'full') }
    } catch (error) {
      if (error instanceof ReplayError) return reply.code(422).send({ error: { code: error.code, details: error.details } })
      if (error instanceof Error && ['analytics_replay_limit', 'analytics_range_limit'].includes(error.message)) {
        return reply.code(422).send({ error: { code: 'replay_analytics_work_limit' } })
      }
      throw error
    }
  })
  app.get(root, async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    return { items: await db.select({ id: saved.id, name: saved.name, description: saved.description,
      revision: saved.revision, updatedAt: saved.updatedAt }).from(saved).where(eq(saved.collectionId, owned.collectionId))
      .orderBy(desc(saved.updatedAt), desc(saved.id)).limit(40) }
  })
  app.post(root, async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    const body = metadata.extend({ previewToken: token }).strict().safeParse(request.body)
    if (!body.success) return reply.code(422).send({ error: { code: 'invalid_replay_save' } })
    const { previewToken, ...details } = body.data
    const frozen = preview(previewToken, owned.owner, owned.collectionId)
    if (!frozen) return reply.code(409).send({ error: { code: 'replay_preview_unavailable' } })
    const result = await insert(owned.collectionId, details, frozen)
    return result ? reply.code(201).send(display(result)) : reply.code(409).send({ error: { code: 'replay_storage_limit' } })
  })
  app.get(root + '/:replayId', async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    const query = readQuery.safeParse(request.query)
    if (!query.success || (query.data.at && query.data.detail)) return reply.code(422).send(invalidQuery)
    const row = await find(owned.collectionId, owned.replayId!)
    if (!row) return reply.code(404).send(idNotFound)
    if (query.data.at) {
      const asOf = new Date(query.data.at).toISOString()
      const snapshot = replaySnapshot(row.result, asOf)
      return snapshot ? { id: row.id, revision: row.revision, snapshot } : reply.code(404).send({ error: { code: 'replay_valuation_point_not_found' } })
    }
    return display(row, query.data.detail === 'full')
  })
  app.patch(root + '/:replayId', async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    const body = metadata.partial().extend({ revision, previewToken: token.optional() }).strict()
      .refine(({ name, description, previewToken }) => name !== undefined || description !== undefined || previewToken !== undefined).safeParse(request.body)
    if (!body.success) return reply.code(422).send({ error: { code: 'invalid_replay_update' } })
    const { revision: expected, previewToken, ...details } = body.data
    const frozen = previewToken ? preview(previewToken, owned.owner, owned.collectionId) : null
    if (previewToken && !frozen) return reply.code(409).send({ error: { code: 'replay_preview_unavailable' } })
    const [row] = await db.update(saved).set({ ...details, ...frozen, revision: expected + 1, updatedAt: new Date() }).where(and(
      eq(saved.collectionId, owned.collectionId), eq(saved.id, owned.replayId!), eq(saved.revision, expected))).returning()
    return row ? display(row) : (await find(owned.collectionId, owned.replayId!) ? reply.code(409).send(staleRevision) : reply.code(404).send(idNotFound))
  })
  app.delete(root + '/:replayId', async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    const query = z.object({ revision: z.coerce.number().int().positive() }).strict().safeParse(request.query)
    if (!query.success) return reply.code(422).send({ error: { code: 'invalid_replay_revision' } })
    const [row] = await db.delete(saved).where(and(eq(saved.collectionId, owned.collectionId), eq(saved.id, owned.replayId!),
      eq(saved.revision, query.data.revision))).returning({ id: saved.id })
    return row ? reply.code(204).send() : await find(owned.collectionId, owned.replayId!)
      ? reply.code(409).send(staleRevision) : reply.code(404).send(idNotFound)
  })
  app.post(root + '/:replayId/duplicate', async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    const body = metadata.strict().safeParse(request.body)
    if (!body.success) return reply.code(422).send({ error: { code: 'invalid_replay_save' } })
    const existing = await find(owned.collectionId, owned.replayId!)
    if (!existing) return reply.code(404).send(idNotFound)
    const row = await insert(owned.collectionId, body.data, { configuration: existing.configuration, result: existing.result })
    return row ? reply.code(201).send(display(row)) : reply.code(409).send({ error: { code: 'replay_storage_limit' } })
  })
  app.post(root + '/compare', async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    const body = z.object({ replayIds: z.array(z.uuid()).min(2).max(4) }).strict()
      .refine(({ replayIds }) => new Set(replayIds).size === replayIds.length).safeParse(request.body)
    if (!body.success) return reply.code(422).send({ error: { code: 'invalid_replay_comparison' } })
    const rows = await db.select().from(saved).where(and(eq(saved.collectionId, owned.collectionId), inArray(saved.id, body.data.replayIds)))
    if (rows.length !== body.data.replayIds.length) return reply.code(404).send(idNotFound)
    const ordered = body.data.replayIds.map((id) => rows.find((row) => row.id === id)!)
    const first = ordered[0]!
    const comparable = (basis: (row: typeof first) => unknown) => ordered.every((row) => digest(basis(row)) === digest(basis(first)))
    const sharedChanges = sharedEvidenceChanges(ordered.map(({ result }) => result))
    const firstGrid = first.result.history.filter(({ asOf }) => asOf === first.configuration.from
      || asOf === first.configuration.through || asOf.endsWith('T23:59:59.999Z')).map(({ asOf }) => asOf)
    const points = ordered.map(({ result }) => new Map(result.history.map((point) => [point.asOf, point])))
    const grid = firstGrid.filter((asOf) => points.every((history) => history.has(asOf)))
    const dimensions = {
      period: comparable(({ configuration }) => [configuration.from, configuration.through]),
      reporting: comparable(({ configuration }) => [configuration.currency, configuration.assumedUsdPerUnit ?? null]),
      methodology: comparable(({ result }) => result.methodology),
      fees: comparable(({ configuration }) => [...new Set(configuration.positions.flatMap(({ entry, exits }) =>
        [entry.fee, ...exits.map((exit) => exit.fee)].map((fee) => digest(fee))))].sort()),
      sharedEvidence: sharedChanges.length === 0,
      grid: grid.length >= 2 && grid.length === firstGrid.length,
      coverage: ordered.every(({ result }) => result.status === 'evaluated' && result.history.every((point) => point.index !== null)
        && !result.warnings.some((warning) => warning.code === 'assumed_trading_window')),
    }
    const compatible = Object.values(dimensions).every(Boolean)
    return { compatible, dimensions, grid,
      evidenceQualifications: { ...comparisonEvidenceQualifications(ordered.map(({ result }) => result), grid),
        sameSourcePreference: comparable(({ result }) => result.evidence.preference ?? null) },
      sharedEvidenceChanges: sharedChanges.slice(0, 100),
      sharedEvidenceChangesTruncated: sharedChanges.length > 100,
      items: ordered.map(({ id, name, revision: version, result }, index) => ({
        id, name, revision: version, evidenceRevision: result.evidenceRevision, summary: replaySummary(result),
        funding: result.funding, risk: result.risk, positions: result.positions, native: result.native,
        history: result.history.map((point) => {
          const { asOf, completeValue, knownComponentsSubtotal, financialCoverage, fxCoverage, referenceQuality } = compactReplayPoint(point)
          return { asOf, completeValue, knownComponentsSubtotal, financialCoverage, fxCoverage, referenceQuality }
        }),
        normalized: compatible ? grid.map((asOf) => ({ asOf, index: points[index]!.get(asOf)!.index,
          referenceQuality: points[index]!.get(asOf)!.referenceQuality ?? null })) : [],
      })) }
  })
}

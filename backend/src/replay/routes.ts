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
import { replayEvidence } from './evidence.js'

const collectionParams = z.object({ collectionId: z.uuid(), replayId: z.uuid().optional() })
const metadata = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).nullable().optional() })
const revision = z.number().int().positive()
const token = z.uuid()
const idNotFound = { error: { code: 'not_found' } }
const staleRevision = { error: { code: 'stale_replay_revision' } }
type Frozen = { configuration: z.infer<typeof replayConfig>; result: ReturnType<typeof evaluateReplay> }

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
      if (count!.total >= 40) return null
      return (await tx.insert(saved).values({ collectionId, ...details, ...frozen }).returning())[0]!
    })
  }

  app.post(root + '/evaluate', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
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
        const lifecycleCutoffs = [...data.lifecycle.values()].flatMap((rows) => rows.flatMap((row) => {
          const at = row.resolution?.settlementTime ?? row.resolution?.knownAt
            ?? (['resolved', 'settled', 'disputed'].includes(row.lifecycle) ? row.retrievedAt.toISOString() : null)
          const eligible = configuration.mode === 'knowledge' && at && row.retrievedAt.toISOString() > at ? row.retrievedAt.toISOString() : at
          return eligible && eligible > configuration.from && eligible <= configuration.through ? [eligible] : []
        }))
        const rates = await loadFx(tx, configuration.from, configuration.through, { assets: configuration.buckets.map((row) => row.asset),
          currency: configuration.currency, mode: configuration.mode, cutoffs: [...lifecycleCutoffs, ...fxAnchors(configuration.cashFlows.map((row) => row.at)),
            ...configuration.positions.flatMap((row) => [row.entry.at, ...row.exits.map((exit) => exit.at)])] })
        const result = evaluateReplay(configuration, data, rates, evaluationAt, preference)
        return { configuration, result }
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
      if (Buffer.byteLength(JSON.stringify(frozen)) > 4_000_000) return reply.code(422).send({ error: { code: 'replay_output_work_limit' } })
      for (const [key, row] of previews) if (row.expires <= Date.now()) previews.delete(key)
      if (previews.size >= 12) previews.delete(previews.keys().next().value!)
      const previewToken = randomUUID()
      const expires = Date.now() + 15 * 60_000
      previews.set(previewToken, { owner: owned.owner, collection: owned.collectionId, expires, frozen })
      return { previewToken, expiresAt: new Date(expires).toISOString(), ...frozen }
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
    return result ? reply.code(201).send(result) : reply.code(409).send({ error: { code: 'replay_storage_limit' } })
  })
  app.get(root + '/:replayId', async (request, reply) => {
    const owned = await scope(request, reply)
    if (!owned) return
    return await find(owned.collectionId, owned.replayId!) ?? reply.code(404).send(idNotFound)
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
    return row ?? (await find(owned.collectionId, owned.replayId!) ? reply.code(409).send(staleRevision) : reply.code(404).send(idNotFound))
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
    return row ? reply.code(201).send(row) : reply.code(409).send({ error: { code: 'replay_storage_limit' } })
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
    const dimensions = {
      period: comparable(({ configuration }) => [configuration.from, configuration.through]),
      reporting: comparable(({ configuration, result }) => [configuration.currency, configuration.assumedUsdPerUnit ?? null, result.evidence.preference]),
      methodology: comparable(({ result }) => result.methodology),
      fees: comparable(({ configuration }) => [...new Set(configuration.positions.flatMap(({ entry, exits }) =>
        [entry.fee, ...exits.map((exit) => exit.fee)].map((fee) => digest(fee))))].sort()),
      coverage: ordered.every(({ result }) => result.status === 'evaluated' && result.history.every((point) => point.index !== null)
        && !result.warnings.some((warning) => warning.code === 'assumed_trading_window')),
    }
    const compatible = Object.values(dimensions).every(Boolean)
    return { compatible, dimensions, items: ordered.map(({ id, name, revision: version, result }) => ({
      id, name, revision: version, summary: result.summary, funding: result.funding, risk: result.risk, positions: result.positions,
      history: result.history.map(({ asOf, completeValue, index }) => ({ asOf, completeValue, index: compatible ? index : null })),
    })) }
  })
}

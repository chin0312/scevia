import { evaluationResponse, comparisonResponse } from '../scenarios/contracts.js'
import { publicSelection, selectPublicOutcome } from '../scenarios/public-market.js'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { digest } from '../accounting/decisions.js'
import type { Database } from '../db/client.js'
import { portfolioScenarios as scenarios, portfolios } from '../db/schema.js'
import { evaluate, validateInstrumentIdentities, ScenarioError, type ScenarioBaseline, type ScenarioInput, type ScenarioInstrument } from '../scenarios/engine.js'

const id = z.string().trim().min(1).max(200)
const bucketId = z.string().min(1).max(450)
const cashAmount = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/)
const fraction = cashAmount.refine((value) => /^(?:0+(?:\.\d+)?|0*1(?:\.0+)?)$/.test(value))
const time = z.iso.datetime({ offset: true })
const sourceCommon = {
  asset: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/), asOf: time,
  catalog: z.array(z.uuid()).max(250).default([]),
  publicOutcomes: z.array(publicSelection).max(6).default([]),
  local: z.array(z.object({ id: id.refine((value) => value.startsWith('local:') && value.length <= 160), mark: cashAmount.nullable() }).strict()).max(250).default([]),
}
const source = z.discriminatedUnion('mode', [
  z.object({ ...sourceCommon, mode: z.literal('actual'), accounts: z.array(id.refine((value) => !value.includes(','))).min(1).max(100),
    venue: id.optional() }).strict(),
  z.object({ ...sourceCommon, mode: z.literal('scratch'), buckets: z.array(z.object({
    id, venue: id, account: id, cash: cashAmount,
  }).strict()).min(1).max(100) }).strict(),
])
export type BaselineSource = z.infer<typeof source>

const fee = z.union([
  z.object({ mode: z.literal('fixed'), value: cashAmount }).strict(),
  z.object({ mode: z.literal('rate'), value: fraction }).strict(),
  z.object({ mode: z.enum(['excluded', 'unavailable']) }).strict(),
  z.object({ mode: z.literal('provider'), role: z.enum(['maker', 'taker']) }).strict(),
])
const input = z.object({
  operations: z.array(z.object({ bucket: bucketId, instrument: id,
    kind: z.enum(['buy', 'sell', 'exit', 'target_quantity', 'buy_notional', 'target_weight']),
    amount: cashAmount.optional(), price: cashAmount, fee,
  }).strict().superRefine((op, ctx) => {
    if (op.kind === 'exit' ? op.amount !== undefined : op.amount === undefined) ctx.addIssue({ code: 'custom', message: 'invalid_operation_amount' })
    if (op.kind === 'target_weight' && op.amount !== undefined && !fraction.safeParse(op.amount).success) {
      ctx.addIssue({ code: 'custom', message: 'invalid_target_weight' })
    }
  })).max(250).default([]),
  funding: z.array(z.object({ bucket: bucketId, added: cashAmount, withdrawn: cashAmount.optional(), assumedCash: cashAmount.optional() }).strict()).max(100).default([]),
  marks: z.array(z.object({ instrument: id, price: cashAmount }).strict()).max(250).default([]),
  rules: z.array(z.object({ id: id.refine((value) => value.startsWith('local:')), yes: id, no: id,
    unitPayout: cashAmount.optional() }).strict()).max(100).default([]),
  constraints: z.array(z.object({ left: id, right: id, kind: z.enum(['equivalent', 'exclusive', 'implies']) }).strict()).max(250).default([]),
  outcomes: z.array(z.object({ group: id, winner: z.enum(['yes', 'no']) }).strict()).max(100).default([]),
}).strict()
const name = z.string().trim().min(1).max(120)
const revision = z.number().int().min(1)
const create = z.object({ name, source, input, baselineToken: z.string().length(64).optional() }).strict()
const update = z.object({ name: name.optional(), revision, input: input.optional() }).strict()
const rebase = z.object({ revision, asOf: time, previewToken: z.string().length(64).optional(), copyName: name.optional() }).strict()
const revisionOnly = z.object({ revision }).strict()
const extend = z.object({ revision, catalog: sourceCommon.catalog, local: sourceCommon.local,
  publicOutcomes: sourceCommon.publicOutcomes, input: input.optional() }).strict()
const evaluation = z.union([z.object({ source, input }).strict(), z.object({ scenarioId: z.uuid(), input: input.optional() }).strict()])
const ids = z.object({ scenarioIds: z.array(z.uuid()).min(2).max(8) }).strict()
type Scope = { portfolioId: string; scenarioId?: string }
type Read = Pick<Database, 'select' | 'selectDistinctOn'>

function fingerprint(frozen: ScenarioBaseline) {
  // A fresh public retrieval carries a new timestamp even when its selected economic data is unchanged.
  return digest({ ...frozen, instruments: frozen.instruments.map(({ latestPriceAt: _latest, feeSchedule, ...row }) => ({
    ...row, feeSchedule: feeSchedule && { ...feeSchedule, retrievedAt: null },
  })), revisions: { ...frozen.revisions, public: null } })
}
const assumptionDigest = ({ operations, ...assumptions }: ScenarioInput) => digest({
  ...assumptions, execution: operations.map(({ bucket, instrument, price, fee }) => ({ bucket, instrument, price, fee }))
    .sort((left, right) => left.bucket.localeCompare(right.bucket) || left.instrument.localeCompare(right.instrument)),
})
const unique = (values: string[]) => new Set(values).size === values.length
function validateSource(value: BaselineSource) {
  if (!unique(value.catalog) || !unique(value.local.map((entry) => entry.id)) || value.catalog.length + value.local.length + value.publicOutcomes.length > 250
    || !unique(value.publicOutcomes.map((row) => row.assetIdType + row.assetId))
    || (value.mode === 'scratch' && (!unique(value.buckets.map((entry) => entry.id))
      || !unique(value.buckets.map((entry) => JSON.stringify([entry.venue, entry.account])))))) throw new ScenarioError('duplicate_baseline_input')
}

function run(baseline: ScenarioBaseline, changes: ScenarioInput) {
  const result = evaluate(baseline, changes)
  const conditional = result.settlement.conditional.result
  if (conditional.status === 'unavailable' && ['invalid_group_identity', 'invalid_group_outcomes', 'conflicting_instrument_assignment',
    'invalid_constraint', 'invalid_quantity', 'invalid_payout_unit', 'invalid_payoff_identity', 'incompatible_settlement_assets'].includes(conditional.reason)) {
    throw new ScenarioError(conditional.reason)
  }
  return result
}

export function registerScenarioRoutes(app: FastifyInstance, db: Database,
  owned: (portfolioId: string, ownerId: string) => Promise<boolean>,
  baseline: (tx: Read, portfolioId: string, source: BaselineSource, publicInstruments: ScenarioInstrument[]) => Promise<ScenarioBaseline>,
  resolvePublic?: (url: string) => Promise<unknown>) {
  const path = '/portfolios/:portfolioId/scenarios'
  const capture = async (portfolioId: string, value: BaselineSource, frozenPublic?: ScenarioInstrument[]) => {
    validateSource(value)
    if (!frozenPublic && value.publicOutcomes.length && !resolvePublic) throw new ScenarioError('provider_live_disabled')
    const pending = new Map<string, Promise<unknown>>()
    const resolved = frozenPublic ?? await Promise.all(value.publicOutcomes.map(async (selection) => {
      if (!pending.has(selection.url)) pending.set(selection.url, resolvePublic!(selection.url))
      return selectPublicOutcome(await pending.get(selection.url), selection, value.asset, new Date(value.asOf).toISOString())
    }))
    return db.transaction(async (tx) => {
      const frozen = await baseline(tx, portfolioId, value, resolved)
      validateInstrumentIdentities(frozen.instruments)
      return frozen
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  }
  const find = async (portfolioId: string, scenarioId: string) => (await db.select().from(scenarios)
    .where(and(eq(scenarios.portfolioId, portfolioId), eq(scenarios.id, scenarioId))).limit(1))[0]
  const save = (portfolioId: string, value: { name: string; source: BaselineSource; baseline: ScenarioBaseline; input: ScenarioInput }) =>
    db.transaction(async (tx) => {
      await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, portfolioId)).for('update')
      const [total] = await tx.select({ count: count() }).from(scenarios).where(eq(scenarios.portfolioId, portfolioId))
      if (total!.count >= 50) throw new ScenarioError('scenario_count_limit')
      const [saved] = await tx.insert(scenarios).values({ portfolioId, ...value }).returning()
      return saved
    })
  function route<S extends z.ZodType>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', suffix: string, schema: S,
    handler: (scope: Scope, body: z.infer<S>, reply: FastifyReply) => Promise<unknown>, response?: object) {
    app.route<{ Params: Scope; Body: unknown }>({ method, url: path + suffix, bodyLimit: 196_608,
      // Zod validates the original body in the handler so AJV cannot strip fields from alternate union branches.
      validatorCompiler: ({ httpPart }) => (value) => {
        if (httpPart !== 'params') return { value }
        const params = z.object({ portfolioId: z.uuid(), scenarioId: z.uuid().optional() }).safeParse(value)
        return params.success ? { value: params.data } : { error: new Error('invalid_scenario_scope') }
      },
      schema: { tags: ['scenarios'], security: [{ bearerAuth: [] }], params: { type: 'object',
        properties: { portfolioId: { type: 'string', format: 'uuid' }, scenarioId: { type: 'string', format: 'uuid' } } },
      ...(response ? { response: { 200: response } } : {}),
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any', io: 'input', override: ({ jsonSchema }) => { delete jsonSchema.default } }) }) },
      handler: async (request, reply) => {
        const scope = request.params
        if (!await owned(scope.portfolioId, request.principalId!)) return notFound(reply)
        const parsed = schema.safeParse(request.body)
        if (!parsed.success) return reply.code(422).send({ error: { code: 'invalid_scenario_input' } })
        try {
          return await handler(scope, parsed.data, reply)
        } catch (error) {
          if (error instanceof ScenarioError) return reply.code(422).send({ error: { code: error.message } })
          throw error
        }
      },
    })
  }
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: { code: 'not_found' } })
  const stale = (reply: FastifyReply) => reply.code(409).send({ error: { code: 'scenario_revision_changed' } })

  route('GET', '', z.undefined(), async ({ portfolioId }) => ({ items: await db.select({
    id: scenarios.id, name: scenarios.name, revision: scenarios.revision, createdAt: scenarios.createdAt, updatedAt: scenarios.updatedAt,
  }).from(scenarios).where(eq(scenarios.portfolioId, portfolioId)).orderBy(desc(scenarios.updatedAt)).limit(50) }))
  route('GET', '/:scenarioId', z.undefined(), async ({ portfolioId, scenarioId }, _, reply) =>
    await find(portfolioId, scenarioId!) ?? notFound(reply))
  route('POST', '/baseline', source, async ({ portfolioId }, value) => {
    const frozen = await capture(portfolioId, value)
    return { ...frozen, baselineToken: fingerprint(frozen) }
  })
  route('POST', '', create, async ({ portfolioId }, value, reply) => {
    const frozen = await capture(portfolioId, value.source)
    if (value.baselineToken && value.baselineToken !== fingerprint(frozen)) return stale(reply)
    run(frozen, value.input)
    return reply.code(201).send(await save(portfolioId, { name: value.name, source: value.source, input: value.input, baseline: frozen }))
  })
  route('PATCH', '/:scenarioId', update, async ({ portfolioId, scenarioId }, changes, reply) => {
    const current = await find(portfolioId, scenarioId!)
    if (!current) return notFound(reply)
    if (current.revision !== changes.revision) return stale(reply)
    const next = changes.input ?? current.input
    run(current.baseline, next)
    const [row] = await db.update(scenarios).set({ name: changes.name ?? current.name, input: next, updatedAt: new Date(), revision: changes.revision + 1 })
      .where(and(eq(scenarios.portfolioId, portfolioId), eq(scenarios.id, current.id), eq(scenarios.revision, changes.revision))).returning()
    return row ?? stale(reply)
  })
  route('POST', '/:scenarioId/delete', revisionOnly, async ({ portfolioId, scenarioId }, changes, reply) => {
    if (!await find(portfolioId, scenarioId!)) return notFound(reply)
    const [row] = await db.delete(scenarios).where(and(eq(scenarios.portfolioId, portfolioId), eq(scenarios.id, scenarioId!),
      eq(scenarios.revision, changes.revision))).returning({ id: scenarios.id })
    return row ? reply.code(204).send() : stale(reply)
  })
  route('POST', '/:scenarioId/duplicate', z.object({ name }).strict(), async ({ portfolioId, scenarioId }, value, reply) => {
    const current = await find(portfolioId, scenarioId!)
    if (!current) return notFound(reply)
    return reply.code(201).send(await save(portfolioId, { name: value.name, source: current.source, baseline: current.baseline, input: current.input }))
  })
  route('POST', '/evaluate', evaluation, async ({ portfolioId }, value, reply) => {
    if ('source' in value) return run(await capture(portfolioId, value.source), value.input)
    const current = await find(portfolioId, value.scenarioId)
    if (!current) return notFound(reply)
    return run(current.baseline, value.input ?? current.input)
  }, evaluationResponse)
  route('POST', '/:scenarioId/instruments', extend, async ({ portfolioId, scenarioId }, value, reply) => {
    const current = await find(portfolioId, scenarioId!)
    if (!current) return notFound(reply)
    if (current.revision !== value.revision) return stale(reply)
    const { catalog, local, publicOutcomes } = value
    if (!catalog.length && !local.length && !publicOutcomes.length) throw new ScenarioError('empty_instrument_extension')
    const updatedSource = { ...current.source, catalog: [...current.source.catalog, ...catalog],
      local: [...current.source.local, ...local], publicOutcomes: [...current.source.publicOutcomes, ...publicOutcomes] }
    validateSource(updatedSource)
    // Capture only new instrument evidence. Keep every original valuation, balance and rule pinned.
    const added = await capture(portfolioId, { mode: 'scratch', asset: current.baseline.asset, asOf: current.baseline.asOf,
      buckets: [{ id: 'catalog', account: 'catalog', venue: 'catalog', cash: '0' }], catalog, local, publicOutcomes })
    const original = current.baseline
    const instruments = [...original.instruments, ...added.instruments]
    if (instruments.length > 250 || !unique(instruments.map((row) => row.id))) throw new ScenarioError('instrument_extension_conflict')
    validateInstrumentIdentities(instruments)
    const originalIds = new Set([...original.rules.map((rule) => rule.id), ...(original.missingRules ?? [])])
    const newRules = added.rules.filter((rule) => !originalIds.has(rule.id))
    const missingRules = [...new Set([...(original.missingRules ?? []), ...(added.missingRules ?? []).filter((id) => !originalIds.has(id))])]
    const newIds = new Set([...newRules.map((rule) => rule.id), ...missingRules.filter((id) => !originalIds.has(id))])
    const rules = [...original.rules, ...newRules]
    const constraints = [...original.constraints, ...added.constraints.filter((edge) => newIds.has(edge.left) || newIds.has(edge.right))]
    if (rules.length + missingRules.length > 256 || constraints.length > 1000) throw new ScenarioError('instrument_extension_graph_limit')
    const expanded = { ...original, instruments, rules, constraints, missingRules,
      settlementGraphLimited: original.settlementGraphLimited === true || added.settlementGraphLimited === true,
      revisions: { ...original.revisions, instrumentExtensions: digest([original.revisions, added.revisions, added.instruments]) } }
    const changes = value.input ?? current.input
    run(expanded, changes)
    const [row] = await db.update(scenarios).set({ source: updatedSource, baseline: expanded, input: changes,
      revision: value.revision + 1, updatedAt: new Date() }).where(and(eq(scenarios.portfolioId, portfolioId),
      eq(scenarios.id, current.id), eq(scenarios.revision, value.revision))).returning()
    return row ?? stale(reply)
  })
  route('POST', '/:scenarioId/rebase', rebase, async ({ portfolioId, scenarioId }, value, reply) => {
    const current = await find(portfolioId, scenarioId!)
    if (!current) return notFound(reply)
    if (current.revision !== value.revision) return stale(reply)
    if (current.source.mode !== 'actual') throw new ScenarioError('rebase_requires_actual_baseline')
    const updatedSource = { ...current.source, asOf: value.asOf }
    const candidate = await capture(portfolioId, updatedSource, current.baseline.instruments.filter((row) => row.id.startsWith('polymarket:')))
    const token = digest([current.id, current.revision, candidate])
    if (!value.previewToken) {
      let result: ReturnType<typeof run> | null = null
      let limitation: string | null = null
      try { result = run(candidate, current.input) }
      catch (error) { if (!(error instanceof ScenarioError)) throw error; limitation = error.message }
      return { previewToken: token, changed: digest(current.baseline) !== digest(candidate),
        previous: current.baseline, candidate, result, limitation }
    }
    if (token !== value.previewToken) return stale(reply)
    run(candidate, current.input)
    if (value.copyName) return reply.code(201).send(await save(portfolioId, {
      name: value.copyName, source: updatedSource, baseline: candidate, input: current.input,
    }))
    const [row] = await db.update(scenarios).set({ baseline: candidate, source: updatedSource,
      revision: current.revision + 1, updatedAt: new Date() })
      .where(and(eq(scenarios.portfolioId, portfolioId), eq(scenarios.id, current.id), eq(scenarios.revision, value.revision))).returning()
    return row ?? stale(reply)
  })
  route('POST', '/compare', ids, async ({ portfolioId }, value, reply) => {
    if (!unique(value.scenarioIds)) throw new ScenarioError('duplicate_comparison_scenario')
    const rows = await db.select().from(scenarios).where(and(eq(scenarios.portfolioId, portfolioId), inArray(scenarios.id, value.scenarioIds)))
    if (rows.length !== value.scenarioIds.length) return notFound(reply)
    const ordered = value.scenarioIds.map((scenarioId) => rows.find((row) => row.id === scenarioId)!)
    return { compatibility: { sameAsset: rows.every((row) => row.baseline.asset === rows[0]!.baseline.asset),
      sameBaseline: rows.every((row) => digest(row.baseline) === digest(rows[0]!.baseline)),
      sameAssumptions: rows.every((row) => assumptionDigest(row.input) === assumptionDigest(rows[0]!.input)), conversion: 'none' },
    items: ordered.map((row) => ({ id: row.id, name: row.name, revision: row.revision, result: run(row.baseline, row.input) })) }
  }, comparisonResponse)
}

import { Decimal } from 'decimal.js'
import { randomBytes } from 'node:crypto'
import { evaluationResponse, comparisonResponse } from '../scenarios/contracts.js'
import { publicSelection, selectPublicOutcome } from '../scenarios/public-market.js'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { digest } from '../accounting/decisions.js'
import type { Database } from '../db/client.js'
import { portfolioScenarios as scenarios, portfolios } from '../db/schema.js'
import { evaluate, validateScenarioOperations, validateInstrumentIdentities, ScenarioError, type ScenarioBaseline, type ScenarioInput, type ScenarioInstrument } from '../scenarios/engine.js'

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
    venue: id.optional(), useReportedKalshiSnapshot: z.boolean().optional() }).strict(),
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
  hypotheticalBuckets: z.array(z.object({ id: bucketId.refine((value) => value.startsWith('hypothetical:')),
    venue: id, account: id, asset: sourceCommon.asset, startingCapital: cashAmount }).strict()).max(100).optional(),
  operations: z.array(z.object({ bucket: bucketId, instrument: id,
    kind: z.enum(['buy', 'sell', 'exit', 'target_quantity', 'buy_notional', 'target_weight']),
    amount: cashAmount.optional(), price: cashAmount, fee, abstract: z.boolean().optional(),
  }).strict().superRefine((op, ctx) => {
    if (op.kind === 'exit' ? op.amount !== undefined : op.amount === undefined) ctx.addIssue({ code: 'custom', message: 'invalid_operation_amount' })
    if (op.kind === 'target_weight' && op.amount !== undefined && !fraction.safeParse(op.amount).success) {
      ctx.addIssue({ code: 'custom', message: 'invalid_target_weight' })
    }
  })).max(250).default([]),
  funding: z.array(z.object({ bucket: bucketId, added: cashAmount, withdrawn: cashAmount.optional(), assumedCash: cashAmount.optional() }).strict()).max(100).default([]),
  marks: z.array(z.object({ instrument: id, price: cashAmount }).strict()).max(250).default([]),
  rules: z.array(z.object({ id: id.max(160), yes: id, no: id, asset: sourceCommon.asset.optional(),
    unitPayout: cashAmount.optional() }).strict()).max(100).default([]),
  constraints: z.array(z.object({ left: id, right: id, kind: z.enum(['equivalent', 'exclusive', 'implies']) }).strict()).max(250).default([]),
  outcomes: z.array(z.object({ group: id, winner: z.enum(['yes', 'no']) }).strict()).max(100).default([]),
}).strict()
const name = z.string().trim().min(1).max(120)
const revision = z.number().int().min(1)
const create = z.object({ name, source, input, baselineToken: z.string().length(64).optional() }).strict()
const update = z.object({ name: name.optional(), revision, input: input.optional() }).strict()
const rebase = z.object({ revision, asOf: time, previewToken: z.string().length(64).optional(), copyName: name.optional(), input: input.optional() }).strict()
const revisionOnly = z.object({ revision }).strict()
const instrumentSelection = z.object({ catalog: sourceCommon.catalog, local: sourceCommon.local, publicOutcomes: sourceCommon.publicOutcomes })
const extend = instrumentSelection.extend({ revision, input: input.optional() }).strict()
const previewExtension = instrumentSelection.extend({ baselineToken: z.string().length(64) }).strict()
const evaluation = z.union([z.object({ source, input }).strict(), z.object({ baselineToken: z.string().length(64), input }).strict(), z.object({ scenarioId: z.uuid(), input: input.optional() }).strict()])
const ids = z.object({ scenarioIds: z.array(z.uuid()).min(2).max(8) }).strict()
type Scope = { portfolioId: string; scenarioId?: string }
type Read = Pick<Database, 'select' | 'selectDistinctOn'>

const assumptionDigest = ({ operations, ...assumptions }: ScenarioInput) => digest({
  ...assumptions, execution: operations.map(({ bucket, instrument, price, fee }) => ({ bucket, instrument, price, fee }))
    .sort((left, right) => left.bucket.localeCompare(right.bucket) || left.instrument.localeCompare(right.instrument)),
})
function baselineChanges(previous: ScenarioBaseline, candidate: ScenarioBaseline) {
  const changed = <T,>(before: T[], after: T[], identity: (row: T) => string) => {
    const left = new Map(before.map((row) => [identity(row), row]))
    const right = new Map(after.map((row) => [identity(row), row]))
    return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap((id) => {
      const from = left.get(id) ?? null
      const to = right.get(id) ?? null
      return digest(from) === digest(to) ? [] : [{ id, before: from, after: to }]
    })
  }
  return { holdings: changed(previous.holdings, candidate.holdings, (row) => JSON.stringify([row.bucket, row.originalInstrument ?? row.instrument])),
    cash: changed(previous.buckets, candidate.buckets, (row) => row.id), instruments: changed(previous.instruments, candidate.instruments, (row) => row.id),
    rules: changed(previous.rules, candidate.rules, (row) => row.id),
    constraintsChanged: digest(previous.constraints) !== digest(candidate.constraints),
    aliasesChanged: digest(previous.instrumentAliases ?? {}) !== digest(candidate.instrumentAliases ?? {}) }
}

function settlementCoverage(result: ReturnType<typeof run>['settlement']['verified']['result']) {
  if (result.status === 'no_open_exposure') return [result.status]
  return [result.status, 'reason' in result ? result.reason : null, 'components' in result ? result.components : null]
}

function comparisonDimensions(rows: Array<{ baseline: ScenarioBaseline; input: ScenarioInput; result: ReturnType<typeof run> }>) {
  const same = (project: (row: typeof rows[number]) => unknown) => rows.every((row) => digest(project(row)) === digest(project(rows[0]!)))
  return {
    sameFinancialBaseline: same(({ baseline }) => [baseline.mode, baseline.asOf, baseline.asset, baseline.buckets,
      baseline.holdings.map(({ mark: _mark, markAt: _markAt, ...holding }) => holding)]),
    sameAccountScope: same(({ baseline, input }) => [baseline.buckets.map(({ id, venue, account }) => [id, venue, account]),
      (input.hypotheticalBuckets ?? []).map(({ id, venue, account, asset }) => [id, venue, account, asset])]),
    sameActualValuationReferences: same(({ baseline }) => baseline.holdings.map((row) => {
      const fallback = row.mark === undefined ? baseline.instruments.find((item) => item.id === row.instrument) : undefined
      return [row.bucket, row.instrument, row.mark ?? fallback?.mark ?? null, row.markAt ?? fallback?.markAt ?? null]
    })),
    sameValuationAssumptions: same(({ baseline, input }) => [baseline.asOf,
      baseline.instruments.flatMap(({ id, mark, markAt, markSource }) => mark === null ? [] : [[id, mark, markAt, markSource]]),
      input.marks.map((row) => ({ ...row, instrument: baseline.instrumentAliases?.[row.instrument] ?? row.instrument }))
        .sort((a, b) => a.instrument.localeCompare(b.instrument))]),
    sameFeeAssumptions: same(({ baseline, input }) => input.operations.map(({ bucket, instrument, fee }) => {
      const id = baseline.instrumentAliases?.[instrument] ?? instrument
      const schedule = fee.mode === 'provider' ? baseline.instruments.find((row) => row.id === id)?.feeSchedule : undefined
      return { bucket, id, fee: 'value' in fee ? { ...fee, value: new Decimal(fee.value).toFixed() } : fee,
        schedule: schedule ? { version: schedule.version, rate: new Decimal(schedule.rate).toFixed(), denomination: schedule.denomination, source: schedule.source } : null }
    }).sort((a, b) => a.bucket.localeCompare(b.bucket) || a.id.localeCompare(b.id))),
    sameCapitalBudget: rows.every((row) => row.result.weightBudget !== null && row.result.weightBudget === rows[0]!.result.weightBudget)
      && same(({ baseline, result }) => [baseline.asset, result.bridge.addedCapital, result.bridge.withdrawnCapital]),
    sameFundingAssumptions: same(({ input }) => [input.funding, input.hypotheticalBuckets ?? []]),
    sameFeeMethodology: same(({ baseline, input }) => [...new Set(input.operations.map(({ instrument, fee }) => {
      const id = baseline.instrumentAliases?.[instrument] ?? instrument
      const schedule = baseline.instruments.find((row) => row.id === id)?.feeSchedule
      return fee.mode === 'provider' ? digest([fee.mode, fee.role, schedule?.version ?? 'unavailable', schedule?.denomination]) : fee.mode
    }))].sort()),
    sameSettlementScope: same(({ baseline, input, result }) => [baseline.asset, baseline.rules, baseline.constraints, input.rules, input.constraints, input.outcomes,
      result.settlement.verified.coverage, result.settlement.verified.unsupported, settlementCoverage(result.settlement.verified.result), result.settlement.conditional.coverage,
      result.settlement.conditional.unsupported, settlementCoverage(result.settlement.conditional.result)]),
  }
}
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
  resolvePublic?: (url: string, type: import('../scenarios/public-market.js').PublicSelection['assetIdType'], assetId?: string) => Promise<unknown>) {
  const path = '/portfolios/:portfolioId/scenarios'
  const previews = new Map<string, { portfolioId: string; source: BaselineSource; baseline: ScenarioBaseline; expires: number }>()
  const previewLimit = 64
  const previewLifetime = 15 * 60_000
  const capture = async (portfolioId: string, value: BaselineSource, frozenPublic?: ScenarioInstrument[]) => {
    validateSource(value)
    if (!frozenPublic && value.publicOutcomes.length && !resolvePublic) throw new ScenarioError('provider_live_disabled')
    const pending = new Map<string, Promise<unknown>>()
    const resolved = frozenPublic ?? await Promise.all(value.publicOutcomes.map(async (selection) => {
      const key = selection.assetIdType === 'kalshi_outcome' ? 'kalshi:' + selection.url + ':' + selection.assetId : 'polymarket:' + selection.url
      if (!pending.has(key)) pending.set(key, resolvePublic!(selection.url, selection.assetIdType, selection.assetId))
      return selectPublicOutcome(await pending.get(key), selection, value.asset, new Date(value.asOf).toISOString())
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
  const pinPreview = (portfolioId: string, value: BaselineSource, frozen: ScenarioBaseline) => {
    const now = Date.now()
    if (previews.size >= previewLimit) previews.delete(previews.keys().next().value!)
    const baselineToken = randomBytes(32).toString('hex')
    previews.set(baselineToken, { portfolioId, source: value, baseline: frozen, expires: now + previewLifetime })
    return { ...frozen, baselineToken, baselineSource: value }
  }
  const readPreview = (portfolioId: string, token: string) => {
    const preview = previews.get(token)
    if (!preview || preview.portfolioId !== portfolioId) throw new ScenarioError('baseline_preview_unavailable')
    if (preview.expires <= Date.now()) {
      previews.delete(token)
      throw new ScenarioError('baseline_preview_expired')
    }
    return preview
  }
  route('POST', '/baseline', source, async ({ portfolioId }, value) =>
    pinPreview(portfolioId, value, await capture(portfolioId, value)))
  route('POST', '/baseline/instruments', previewExtension, async ({ portfolioId }, value) => {
    const preview = readPreview(portfolioId, value.baselineToken)
    const extended = await extendBaseline(portfolioId, preview, value)
    return pinPreview(portfolioId, extended.source, extended.baseline)
  })
  route('POST', '', create, async ({ portfolioId }, value, reply) => {
    const preview = value.baselineToken ? readPreview(portfolioId, value.baselineToken) : undefined
    if (preview && digest(preview.source) !== digest(value.source)) throw new ScenarioError('baseline_preview_source_changed')
    const frozen = preview?.baseline ?? await capture(portfolioId, value.source)
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
    if ('baselineToken' in value) return run(readPreview(portfolioId, value.baselineToken).baseline, value.input)
    if ('source' in value) return run(await capture(portfolioId, value.source), value.input)
    const current = await find(portfolioId, value.scenarioId)
    if (!current) return notFound(reply)
    return run(current.baseline, value.input ?? current.input)
  }, evaluationResponse)
  const denominationEvaluation = z.object({
    components: z.array(z.object({ baselineToken: z.string().length(64), input }).strict()).min(2).max(4),
    assumedUsdPerUnit: z.partialRecord(z.enum(['USDC', 'PUSD']), cashAmount.refine((value) => new Decimal(value).gt(0))).optional(),
  }).strict()
  route('POST', '/evaluate-denominations', denominationEvaluation, async ({ portfolioId }, value) => {
    const components = value.components.map(({ baselineToken, input: edits }) => {
      const { baseline } = readPreview(portfolioId, baselineToken)
      return run(baseline, edits)
    })
    if (!unique(components.map((row) => row.asset))) throw new ScenarioError('duplicate_scenario_denomination')
    if (!components.every((row) => row.baselineAsOf === components[0]!.baselineAsOf)) throw new ScenarioError('scenario_cutoff_mismatch')
    const rates: Record<string, string> = { ...(value.assumedUsdPerUnit ?? {}), USD: '1' }
    const comparable = components.every((row) => row.bridge.endingValue !== null && row.additionalCapitalRequired === '0' && rates[row.asset])
    const Report = Decimal.clone({ precision: 70 })
    return {
      components, indicativeUsd: comparable ? { valuationBasis: 'assumed_reporting_conversion', rates,
        value: components.reduce((sum, row) => sum.plus(new Report(row.bridge.endingValue!).mul(rates[row.asset]!)), new Report(0)).toFixed(),
      } : null,
      fundingTransfers: false, jointSettlement: { status: 'unavailable', reason: 'cross_denomination_joint_settlement_unsupported' },
    }
  })
  async function extendBaseline(portfolioId: string, current: { source: BaselineSource; baseline: ScenarioBaseline },
    value: z.infer<typeof instrumentSelection>) {
    const { catalog, local, publicOutcomes } = value
    if (!catalog.length && !local.length && !publicOutcomes.length) throw new ScenarioError('empty_instrument_extension')
    const updatedSource = { ...current.source, catalog: [...current.source.catalog, ...catalog],
      local: [...current.source.local, ...local], publicOutcomes: [...current.source.publicOutcomes, ...publicOutcomes] }
    validateSource(updatedSource)
    // Capture only new instrument evidence. Keep every original valuation, balance and rule pinned.
    const added = await capture(portfolioId, { mode: 'scratch', asset: current.baseline.asset, asOf: current.baseline.asOf,
      buckets: [{ id: 'catalog', account: 'catalog', venue: 'catalog', cash: '0' }], catalog, local, publicOutcomes })
    const original = current.baseline
    const instrumentMap = new Map(original.instruments.map((row) => [row.id, row]))
    for (const row of added.instruments) {
      const previous = instrumentMap.get(row.id)
      if (!previous) instrumentMap.set(row.id, row)
      else if (Object.values(added.instrumentAliases ?? {}).includes(row.id)) {
        instrumentMap.set(row.id, { ...row, ...previous, mark: previous.mark ?? row.mark, markAt: previous.mark === null ? row.markAt ?? null : previous.markAt ?? null,
          ...(previous.mark === null && row.markSource ? { markSource: row.markSource } : {}) })
      } else throw new ScenarioError('instrument_extension_conflict')
    }
    const instruments = [...instrumentMap.values()]
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
      publicInstruments: [...(original.publicInstruments ?? original.instruments.filter((row) => (row.id.startsWith('polymarket:') || row.id.startsWith('kalshi:')))), ...(added.publicInstruments ?? [])],
      instrumentAliases: { ...original.instrumentAliases, ...added.instrumentAliases },
      reservedRules: [...new Map([...(added.reservedRules ?? []), ...(original.reservedRules ?? [])].map((row) => [row.id, row])).values()],
      settlementGraphLimited: original.settlementGraphLimited === true || added.settlementGraphLimited === true,
      revisions: { ...original.revisions, instrumentExtensions: digest([original.revisions, added.revisions, added.instruments]) } }
    return { source: updatedSource, baseline: expanded }
  }
  route('POST', '/:scenarioId/instruments', extend, async ({ portfolioId, scenarioId }, value, reply) => {
    const current = await find(portfolioId, scenarioId!)
    if (!current) return notFound(reply)
    if (current.revision !== value.revision) return stale(reply)
    const { source: updatedSource, baseline: expanded } = await extendBaseline(portfolioId, current, value)
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
    const updatedSource = { ...current.source, asOf: value.asOf,
      catalog: [...new Set([...current.source.catalog, ...current.baseline.instruments.filter((row) => z.uuid().safeParse(row.id).success)
        .map((row) => row.id)])] }
    const candidate = await capture(portfolioId, updatedSource, current.baseline.publicInstruments
      ?? current.baseline.instruments.filter((row) => (row.id.startsWith('polymarket:') || row.id.startsWith('kalshi:'))))
    const currentIds = new Set(candidate.instruments.map((row) => row.id))
    for (const instrument of current.baseline.instruments) {
      if (!currentIds.has(instrument.id) && instrument.id.startsWith('holding:')) {
        candidate.instruments.push({ id: instrument.id, mark: null })
      }
    }
    const changes = value.input ?? current.input
    const identityConflicts = changes.operations.flatMap((operation, operationIndex) => {
      const oldId = current.baseline.instrumentAliases?.[operation.instrument] ?? operation.instrument
      const old = current.baseline.holdings.find((row) => row.bucket === operation.bucket && row.instrument === oldId)
      if (!old) return []
      const replacement = candidate.holdings.find((row) => row.bucket === old.bucket
        && (row.originalInstrument ?? row.instrument) === (old.originalInstrument ?? old.instrument))
      const reason = replacement && replacement.instrument !== old.instrument ? 'instrument_association_changed'
        : !replacement && old.quantityObservation ? 'holding_no_longer_observed'
          : !replacement && operation.kind === 'exit' ? 'holding_already_closed' : null
      return reason ? [{ operationIndex, bucket: operation.bucket, instrument: operation.instrument, reason }] : []
    })
    const token = digest([current.id, current.revision, candidate, changes])
    if (!value.previewToken) {
      let result: ReturnType<typeof run> | null = null
      let limitation: string | null = null
      const conflicts = [...identityConflicts]
      try { if (identityConflicts.length) throw new ScenarioError(identityConflicts[0]!.reason); result = run(candidate, changes) }
      catch (error) {
        if (!(error instanceof ScenarioError)) throw error
        limitation = error.message
        changes.operations.forEach((operation, operationIndex) => {
          try { validateScenarioOperations(candidate, { ...changes, operations: [operation] }) }
          catch (conflict) {
            if (!(conflict instanceof ScenarioError)) throw conflict
            if (conflict.operationIndex !== undefined) conflicts.push({ operationIndex, bucket: operation.bucket,
              instrument: operation.instrument, reason: conflict.message })
          }
        })
      }
      return { previewToken: token, changed: digest(current.baseline) !== digest(candidate),
        previous: current.baseline, candidate, result, limitation, conflicts,
        changes: baselineChanges(current.baseline, candidate), reviewedInput: changes }
    }
    if (token !== value.previewToken) return stale(reply)
    if (identityConflicts.length) throw new ScenarioError(identityConflicts[0]!.reason)
    run(candidate, changes)
    if (value.copyName) return reply.code(201).send(await save(portfolioId, {
      name: value.copyName, source: updatedSource, baseline: candidate, input: changes,
    }))
    const [row] = await db.update(scenarios).set({ baseline: candidate, source: updatedSource, input: changes,
      revision: current.revision + 1, updatedAt: new Date() })
      .where(and(eq(scenarios.portfolioId, portfolioId), eq(scenarios.id, current.id), eq(scenarios.revision, value.revision))).returning()
    return row ?? stale(reply)
  })
  route('POST', '/compare', ids, async ({ portfolioId }, value, reply) => {
    if (!unique(value.scenarioIds)) throw new ScenarioError('duplicate_comparison_scenario')
    const rows = await db.select().from(scenarios).where(and(eq(scenarios.portfolioId, portfolioId), inArray(scenarios.id, value.scenarioIds)))
    if (rows.length !== value.scenarioIds.length) return notFound(reply)
    const ordered = value.scenarioIds.map((scenarioId) => rows.find((row) => row.id === scenarioId)!)
    const evaluations = ordered.map((row) => ({ ...row, result: run(row.baseline, row.input) }))
    return { compatibility: { ...comparisonDimensions(evaluations), sameAsset: rows.every((row) => row.baseline.asset === rows[0]!.baseline.asset),
      sameBaseline: rows.every((row) => digest(row.baseline) === digest(rows[0]!.baseline)),
      sameAssumptions: rows.every((row) => assumptionDigest(row.input) === assumptionDigest(rows[0]!.input)), conversion: 'none' },
    items: evaluations.map(({ id, name, revision, result }) => ({ id, name, revision, result })) }
  }, comparisonResponse)
}

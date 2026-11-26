import { connectedMarkets } from '../analytics/exposure.js'
import { Decimal } from 'decimal.js'
import { concentration } from '../analytics/performance.js'
import { settlementRisk, type BinaryGroup, type SettlementConstraint } from '../analytics/settlement.js'

const D = Decimal.clone({ precision: 70, rounding: Decimal.ROUND_HALF_EVEN })
const zero = () => new D(0)
const sum = (values: Decimal[]) => values.reduce((total, value) => total.plus(value), zero())
const add = (left: Decimal | null, right: Decimal | null) => left === null || right === null ? null : left.plus(right)
export const methodology = 'weighted-average-scenario-v1'
export interface FundingBucket { id: string; venue: string; account: string; cash: string | null; pending: string | null; inventoryComplete?: boolean; inventoryAt?: string | null; tradingVenue?: string; cashObservation?: { sourceRecordId: string; asOf: string } }
export interface ScenarioInstrument {
  id: string; mark: string | null; markAt?: string | null; market?: string; event?: string; resolvesAt?: string | null
  venue?: string; provider?: string; nativeMarket?: string; nativeInstrument?: string; settlementAsset?: string | null; outcome?: string | null; providerMarket?: string; lifecycle?: string
  referenceScopes?: string[]
  nativeOutcomeIndex?: number
  nativeIdType?: 'position_id' | 'clob_token_id'
  markSource?: 'scoped_holding_consensus' | 'public_retrieval_at_cutoff' | 'assumed_current_quote' | 'declared_local'
  latestPrice?: string | null; latestPriceAt?: string | null
  feeSchedule?: { version: 'polymarket-price-variance-v1'; rate: string; retrievedAt: string; source: 'gamma_market'; denomination: 'USDC' }
}
export interface ScenarioHolding { bucket: string; instrument: string; quantity: string; basis: string | null; quantityKnown?: boolean; mark?: string | null; markAt?: string | null; originalInstrument?: string; quantityObservation?: { sourceRecordId: string; asOf: string } }
export interface ScenarioBaseline {
  methodology: typeof methodology; mode: 'actual' | 'scratch'; asset: string; asOf: string
  buckets: FundingBucket[]; instruments: ScenarioInstrument[]; holdings: ScenarioHolding[]
  rules: Omit<BinaryGroup, 'legs'>[]; constraints: SettlementConstraint[]
  missingRules?: string[]
  publicInstruments?: ScenarioInstrument[]
  instrumentAliases?: Record<string, string>
  reservedRules?: Array<{ id: string; yes: string; no: string }>
  settlementGraphLimited?: boolean
  revisions: Record<string, string>
}
export type Fee =
  | { mode: 'fixed' | 'rate'; value: string }
  | { mode: 'excluded' | 'unavailable' }
  | { mode: 'provider'; role: 'maker' | 'taker' }
export interface Operation {
  bucket: string; instrument: string; kind: 'buy' | 'sell' | 'exit' | 'target_quantity' | 'buy_notional' | 'target_weight'
  amount?: string | undefined; price: string; fee: Fee; abstract?: boolean | undefined
}
export interface ScenarioInput {
  hypotheticalBuckets?: Array<{ id: string; venue: string; account: string; asset: string; startingCapital: string }> | undefined
  operations: Operation[]
  funding: Array<{ bucket: string; added: string; withdrawn?: string | undefined; assumedCash?: string | undefined }>
  marks: Array<{ instrument: string; price: string }>
  rules: Array<Omit<BinaryGroup, 'legs' | 'fixed' | 'asset' | 'unitPayout'> & { unitPayout?: string | undefined; asset?: string | undefined }>
  constraints: SettlementConstraint[]
  outcomes: Array<{ group: string; winner: 'yes' | 'no' }>
}
const key = (bucket: string, instrument: string) => JSON.stringify([bucket, instrument])
const amount = (input: string | null) => input === null ? null : new D(input)
const fixed = (input: Decimal | null) => input?.toFixed() ?? null
export class ScenarioError extends Error {
  constructor(message: string, readonly operationIndex?: number) { super(message) }
}

export function validateInstrumentIdentities(instruments: ScenarioInstrument[]) {
  const nativeIdentities = new Set<string>()
  for (const row of instruments) {
    if (!row.provider || !row.nativeMarket || !row.nativeInstrument) continue
    const id = JSON.stringify([row.provider, row.nativeMarket, row.nativeInstrument])
    if (nativeIdentities.has(id)) throw new ScenarioError('duplicate_native_instrument')
    nativeIdentities.add(id)
  }
}

export function scopedReference(observations: Array<{ scope: string; price: string; asOf: string }>) {
  const prices = new Set(observations.map(({ price }) => new D(price).toFixed()))
  if (prices.size !== 1) return null
  return { mark: prices.values().next().value!, markAt: observations.map(({ asOf }) => asOf).sort()[0]!,
    referenceScopes: [...new Set(observations.map(({ scope }) => scope))].sort(), markSource: 'scoped_holding_consensus' as const }
}

export const evaluate = (baseline: ScenarioBaseline, input: ScenarioInput) => evaluateInternal(baseline, input)!
export function validateScenarioOperations(baseline: ScenarioBaseline, input: ScenarioInput) {
  evaluateInternal(baseline, input, true)
}

function evaluateInternal(baseline: ScenarioBaseline, changes: ScenarioInput, operationsOnly = false) {
  const resolve = (id: string) => Object.hasOwn(baseline.instrumentAliases ?? {}, id) ? baseline.instrumentAliases![id]! : id
  const input = { ...changes, operations: changes.operations.map((op) => ({ ...op, instrument: resolve(op.instrument) })),
    marks: changes.marks.map((row) => ({ ...row, instrument: resolve(row.instrument) })),
    rules: changes.rules.map((rule) => ({ ...rule, yes: resolve(rule.yes), no: resolve(rule.no) })) }
  if (baseline.methodology !== methodology) throw new ScenarioError('unsupported_methodology')
  const instruments = new Map(baseline.instruments.map((row) => [row.id, row]))
  const buckets = new Map(baseline.buckets.map((row) => [row.id, {
    ...row, cash: amount(row.cash), pending: amount(row.pending), added: zero(), withdrawn: zero(), assumed: null as Decimal | null,
    buys: zero(), sales: zero(), fees: zero() as Decimal | null,
  }]))
  for (const row of input.hypotheticalBuckets ?? []) {
    if (row.asset !== baseline.asset || buckets.has(row.id) || [...buckets.values()].some((bucket) =>
      bucket.venue === row.venue && bucket.account === row.account)) throw new ScenarioError('invalid_hypothetical_bucket')
    buckets.set(row.id, { ...row, cash: zero(), pending: zero(), inventoryComplete: true,
      added: new D(row.startingCapital), withdrawn: zero(), assumed: null, buys: zero(), sales: zero(), fees: zero() })
  }
  const hypotheticalBuckets = new Map((input.hypotheticalBuckets ?? []).map((row) => [row.id, row]))
  const inventoryComplete = baseline.buckets.every((bucket) => bucket.inventoryComplete !== false)
  const holdings = new Map(baseline.holdings.map((row) => [key(row.bucket, row.instrument), {
    ...row, quantity: new D(row.quantity), basis: amount(row.basis),
  }]))
  const verifiedMaxima = new Map(baseline.rules.flatMap((rule) =>
    [rule.yes, rule.no].map((id) => [id, new D(rule.unitPayout ?? '1')] as const)))
  const recordedMaximum = (id: string) => verifiedMaxima.get(id)
    ?? (instruments.get(id)?.provider === 'polymarket' ? new D(1) : null)
  const holdingMark = (row: { instrument: string; mark?: string | null }) => {
    const value = amount(row.mark === undefined ? instruments.get(row.instrument)?.mark ?? null : row.mark)
    const max = recordedMaximum(row.instrument)
    return value !== null && (value.lt(0) || max?.lt(value)) ? null : value
  }
  const overrides = new Map(input.marks.map((row) => [row.instrument, new D(row.price)]))
  if (overrides.size !== input.marks.length || [...overrides.keys()].some((id) => !instruments.has(id))) throw new ScenarioError('invalid_mark_scope')
  const fundingIds = new Set<string>()
  for (const funding of input.funding) {
    const bucket = buckets.get(funding.bucket)
    if (!bucket || fundingIds.has(funding.bucket)) throw new ScenarioError('invalid_funding_scope')
    fundingIds.add(funding.bucket)
    if (funding.assumedCash !== undefined && bucket.cash !== null) throw new ScenarioError('known_cash_cannot_be_assumed')
    bucket.assumed = amount(funding.assumedCash ?? null)
    bucket.added = bucket.added.plus(funding.added)
    bucket.withdrawn = new D(funding.withdrawn ?? 0)
  }
  const marked = (rows: Iterable<{ instrument: string; quantity: Decimal; quantityKnown?: boolean; mark?: string | null }>, proposed: boolean) => {
    let total: Decimal | null = inventoryComplete ? zero() : null
    for (const row of rows) {
      if (row.quantity.isZero() && row.quantityKnown !== false) continue
      const price = (proposed ? overrides.get(row.instrument) : undefined) ?? holdingMark(row)
      total = add(total, row.quantityKnown === false ? null : price?.mul(row.quantity) ?? null)
    }
    return total
  }
  const reviewed = [...baseline.rules, ...(baseline.reservedRules ?? [])]
  const conditionalRules = input.rules.map(({ unitPayout, asset, ...rule }) => {
    const yes = instruments.get(rule.yes)
    const no = instruments.get(rule.no)
    if (!yes || !no || yes.id === no.id || (asset !== undefined && asset !== baseline.asset)
      || [yes, no].some((row) => row.settlementAsset && row.settlementAsset !== baseline.asset)
      || ((yes.market || no.market) && yes.market !== no.market)
      || (yes.nativeOutcomeIndex !== undefined && yes.nativeOutcomeIndex === no.nativeOutcomeIndex)
      || (yes.venue && no.venue && yes.venue !== no.venue)
      || (unitPayout !== undefined && !new D(unitPayout).gt(0))) throw new ScenarioError('invalid_conditional_payout')
    if (reviewed.some((item) => item.id === rule.id || item.id === yes.market
      || [item.yes, item.no].some((id) => id === yes.id || id === no.id))
      || baseline.missingRules?.includes(rule.id)) throw new ScenarioError('reviewed_payout_cannot_be_overridden')
    const established = [recordedMaximum(yes.id), recordedMaximum(no.id)].filter((unit): unit is Decimal => unit !== null)
    const payout = new D(unitPayout ?? '1')
    if (established.some((unit) => !unit.eq(payout))) throw new ScenarioError('conditional_payout_unit_mismatch')
    return { ...rule, unitPayout: payout.toFixed(), asset: baseline.asset,
      authority: established.length ? 'conditional_established_unit' : 'conditional_abstract_unit' }
  })
  if (new Set(conditionalRules.flatMap((rule) => [rule.yes, rule.no])).size !== conditionalRules.length * 2) {
    throw new ScenarioError('conflicting_instrument_assignment')
  }
  const maxima = new Map([...conditionalRules, ...baseline.rules].flatMap((rule) =>
    [rule.yes, rule.no].map((id) => [id, new D(rule.unitPayout ?? '1')] as const)))
  const maximum = (instrument: ScenarioInstrument) => recordedMaximum(instrument.id) ?? maxima.get(instrument.id) ?? null
  for (const [id, price] of overrides) if (maximum(instruments.get(id)!)?.lt(price)) throw new ScenarioError('reference_price_exceeds_payout')
  const initialMarked = marked(holdings.values(), false)
  const pending = [...buckets.values()].reduce((total, bucket) => add(total, bucket.pending), zero() as Decimal | null)
  const actualOpeningCash = [...buckets.values()].reduce((total, bucket) => add(total, bucket.cash), zero() as Decimal | null)
  const openingCash = [...buckets.values()].reduce((total, bucket) => add(total, bucket.cash ?? bucket.assumed), zero() as Decimal | null)
  const capital = sum([...buckets.values()].map((bucket) => bucket.added))
  const withdrawn = sum([...buckets.values()].map((bucket) => bucket.withdrawn))
  const netCapital = capital.minus(withdrawn)
  const startingValue = add(add(initialMarked, openingCash), pending)
  // Targets share one pre-execution cash-inclusive budget, adjusted for explicit capital.
  const weightBudget = startingValue?.plus(netCapital) ?? null
  const weightTotal = sum(input.operations.filter((op) => op.kind === 'target_weight').map((op) => new D(op.amount!)))
  if (weightTotal.gt(1)) throw new ScenarioError('target_weights_exceed_one')
  let executionEffect: Decimal | null = zero()
  let remarkEffect: Decimal | null = zero()
  let realized: Decimal | null = zero()
  const used = new Set<string>()
  const operations = input.operations.map((op, index) => {
    const id = key(op.bucket, op.instrument)
    const bucket = buckets.get(op.bucket)
    if (!bucket || !instruments.has(op.instrument) || used.has(id)) throw new ScenarioError('invalid_operation_scope', index)
    used.add(id)
    const existing = holdings.get(id)
    if (!existing && bucket.inventoryComplete === false) throw new ScenarioError('inventory_unavailable', index)
    const prior = existing ?? { bucket: op.bucket, instrument: op.instrument, quantity: zero(), basis: zero(), quantityKnown: true }
    if (prior.quantityKnown === false) throw new ScenarioError('quantity_unavailable', index)
    const price = new D(op.price)
    const requested = new D(op.amount ?? '0')
    let delta = requested
    if (op.kind === 'exit') delta = prior.quantity.neg()
    if (op.kind === 'sell') delta = requested.neg()
    if (op.kind === 'target_quantity') delta = requested.minus(prior.quantity)
    if (op.kind === 'buy_notional') {
      if (price.lte(0)) throw new ScenarioError('positive_execution_price_required', index)
      delta = requested.div(price).toDecimalPlaces(18, Decimal.ROUND_DOWN)
    }
    if (op.kind === 'target_weight') {
      const reference = overrides.get(op.instrument) ?? holdingMark(prior)
      if (!reference?.gt(0) || !weightBudget?.gt(0)) throw new ScenarioError('target_weight_basis_unavailable', index)
      delta = requested.mul(weightBudget).div(reference).toDecimalPlaces(18, Decimal.ROUND_DOWN).minus(prior.quantity)
    }
    const nextQuantity = prior.quantity.plus(delta)
    if (nextQuantity.lt(0)) throw new ScenarioError('short_sale_unsupported', index)
    const notional = delta.abs().mul(price)
    const instrument = instruments.get(op.instrument)!
    const abstract = op.abstract === true || bucket.venue === 'abstract'
    const venue = bucket.tradingVenue ?? bucket.venue
    const mappedImport = existing?.originalInstrument === instrument.id && !['polymarket', 'kalshi'].includes(bucket.venue)
    if (instrument.venue && instrument.venue !== venue && bucket.venue !== 'abstract' && !mappedImport) {
      throw new ScenarioError('instrument_venue_mismatch', index)
    }
    if (maximum(instrument)?.lt(price)) throw new ScenarioError('execution_price_exceeds_payout', index)
    if (!delta.isZero() && !abstract && instrument.lifecycle && !['open', 'unknown'].includes(instrument.lifecycle)) {
      throw new ScenarioError('instrument_not_open', index)
    }
    if (instrument.settlementAsset && instrument.settlementAsset !== baseline.asset) throw new ScenarioError('instrument_asset_mismatch', index)
    const schedule = instrument.feeSchedule
    const providerFee = op.fee.mode === 'provider' && schedule?.denomination === baseline.asset && price.lte(1)
      ? op.fee.role === 'maker' ? zero() : delta.abs().mul(schedule.rate).mul(price).mul(new D(1).minus(price)).toDecimalPlaces(5, Decimal.ROUND_HALF_UP)
      : null
    const fee = delta.isZero() || op.fee.mode === 'excluded' ? zero()
      : op.fee.mode === 'fixed' ? new D(op.fee.value)
        : op.fee.mode === 'rate' ? notional.mul(op.fee.value).toDecimalPlaces(8, Decimal.ROUND_CEIL) : providerFee
    bucket.fees = add(bucket.fees, fee)
    const reference = holdingMark(prior) ?? (prior.quantity.isZero() ? overrides.get(op.instrument) ?? null : null)
    if (!delta.isZero()) executionEffect = add(executionEffect, reference === null ? null : delta.mul(reference.minus(price)))
    let basis = prior.basis
    let pnl: Decimal | null = zero()
    if (delta.gt(0)) {
      bucket.buys = bucket.buys.plus(notional)
      basis = add(basis, add(notional, fee))
    } else if (delta.lt(0)) {
      bucket.sales = bucket.sales.plus(notional)
      const released = basis?.mul(delta.abs()).div(prior.quantity) ?? null
      basis = nextQuantity.isZero() ? zero() : add(basis, released?.neg() ?? null)
      pnl = fee === null || released === null ? null : notional.minus(fee).minus(released)
      realized = add(realized, pnl)
    }
    holdings.set(id, { ...prior, quantity: nextQuantity, basis })
    return { ...op, executionApplicability: abstract ? 'abstract' : instrument.venue && !instrument.settlementAsset ? 'denomination_unverified'
      : instrument.lifecycle === 'open' ? 'open_market_assumption' : 'lifecycle_unverified',
      initialQuantity: prior.quantity.toFixed(), proposedQuantity: nextQuantity.toFixed(),
      delta: delta.toFixed(), notional: notional.toFixed(), feeAmount: fixed(fee), feeStatus: delta.isZero() ? 'no_trade' : fee === null ? 'unavailable' : op.fee.mode, realized: fixed(pnl),
      remainingBasis: fixed(basis), netProceeds: delta.lt(0) ? fixed(fee === null ? null : notional.minus(fee)) : null }
  })
  if (operationsOnly) return undefined
  const proposed = [...holdings.values()]
  for (const row of proposed) {
    const override = overrides.get(row.instrument)
    const previous = holdingMark(row)
    const newPosition = !baseline.holdings.some((item) => item.bucket === row.bucket && item.instrument === row.instrument)
    if (override && !row.quantity.isZero()) remarkEffect = add(remarkEffect, previous === null ? (newPosition ? zero() : null) : override.minus(previous).mul(row.quantity))
  }
  const funding = [...buckets.values()].map((bucket) => {
    const available = bucket.cash ?? bucket.assumed
    const ending = add(available?.plus(bucket.added).minus(bucket.withdrawn).plus(bucket.sales).minus(bucket.buys) ?? null, bucket.fees?.neg() ?? null)
    return { bucket: bucket.id, venue: bucket.venue, account: bucket.account, asset: baseline.asset,
      actualOrScratchStartingCash: hypotheticalBuckets.has(bucket.id) ? null : fixed(bucket.cash),
      cashObservation: bucket.cashObservation ?? null,
      hypotheticalStartingCapital: hypotheticalBuckets.get(bucket.id)?.startingCapital ?? null,
      additionalCapital: fixed(bucket.added.minus(hypotheticalBuckets.get(bucket.id)?.startingCapital ?? 0)), assumedStartingCash: fixed(bucket.assumed), addedCapital: fixed(bucket.added), withdrawnCapital: fixed(bucket.withdrawn),
      grossSales: fixed(bucket.sales), purchases: fixed(bucket.buys), fees: fixed(bucket.fees), endingCash: fixed(ending),
      shortfall: ending === null ? null : D.max(0, ending.neg()).toFixed() }
  })
  const total = (field: 'endingCash' | 'shortfall' | 'fees') => funding.reduce((value, row) => add(value, amount(row[field])), zero() as Decimal | null)
  const openingCashNonnegative = [...buckets.values()].every((bucket) => (bucket.cash ?? bucket.assumed)?.gte(0) === true)
  const endingCash = total('endingCash')
  const fees = total('fees')
  const shortfall = total('shortfall')
  const knownAdditionalCapitalRequired = sum(funding.flatMap((row) => row.shortfall === null ? [] : [new D(row.shortfall)]))
  const endingMarked = marked(proposed, true)
  const endingValue = add(add(endingMarked, endingCash), pending)
  const explained = add(add(add(startingValue, netCapital), executionEffect), add(remarkEffect, fees?.neg() ?? null))
  const allocation = (rows: typeof proposed, after: boolean) => {
    const values = rows.flatMap((row) => {
      if (row.quantityKnown === false || row.quantity.isZero()) return []
      const price = (after ? overrides.get(row.instrument) : undefined) ?? holdingMark(row)
      return price === null ? [] : [{ ...row, value: price.mul(row.quantity) }]
    })
    const dimension = (identity: (row: (typeof values)[number]) => string | undefined) => {
      const grouped = new Map<string, Decimal>()
      let unmapped = zero()
      let identifiedHoldings = 0
      let unmappedHoldings = 0
      for (const row of values) {
        const id = identity(row)
        if (id === undefined) {
          unmapped = unmapped.plus(row.value)
          unmappedHoldings += 1
        } else {
          grouped.set(id, (grouped.get(id) ?? zero()).plus(row.value))
          identifiedHoldings += 1
        }
      }
      const metrics = concentration([...grouped.values()].map((value) => value.toFixed()))
      return { metrics, availability: !metrics ? 'unavailable' : unmappedHoldings || (after ? endingMarked : initialMarked) === null
        ? 'known_subset' : 'known_marked_scope', identifiedHoldings, unmappedHoldings, unmapped: unmapped.toFixed(), rows: [...grouped].map(([id, value], index) =>
        ({ id, value: value.toFixed(), weight: metrics?.weights[index] ?? null })) }
    }
    const cash = after ? endingCash : openingCash
    const open = after ? endingMarked : initialMarked
    const cashInclusive = cash === null || open === null || pending === null
      || (after ? funding.some((row) => row.endingCash === null || new D(row.endingCash).lt(0)) : !openingCashNonnegative)
      ? null : concentration([open.toFixed(), cash.toFixed(), pending.toFixed()])
    const market = dimension((row) => instruments.get(row.instrument)?.market)
    const event = dimension((row) => instruments.get(row.instrument)?.event)
    const inclusive = (view: typeof market) => {
      const denominator = cashInclusive?.denominator ?? null
      const rows = [...view.rows.map(({ id, value }) => ({ id, kind: 'identified', value })),
        { id: 'unmapped', kind: 'unmapped', value: view.unmapped },
        { id: 'cash', kind: 'cash', value: fixed(cash) }, { id: 'pending', kind: 'pending', value: fixed(pending) }]
      return { denominator, rows: rows.map((row) => ({ ...row,
        weight: denominator === null || row.value === null ? null : new D(row.value).div(denominator).toFixed() })) }
    }
    const basisRows = rows.filter((row) => !row.quantity.isZero()).map((row) => ({
      id: key(row.bucket, row.instrument), bucket: row.bucket, instrument: row.instrument, value: fixed(row.basis),
    }))
    const basisMetrics = concentration(basisRows.flatMap((row) => row.value === null ? [] : [row.value]))
    const resolution = new Map<string, { positions: number; knownValue: Decimal }>()
    for (const row of rows.filter((item) => !item.quantity.isZero())) {
      const at = instruments.get(row.instrument)?.resolvesAt
      const days = at ? (Date.parse(at) - Date.parse(baseline.asOf)) / 86_400_000 : NaN
      const group = !Number.isFinite(days) ? 'unknown' : days <= 0 ? 'past_hint' : days <= 7 ? 'next_7_days' : days <= 30 ? 'next_30_days' : 'later'
      const total = resolution.get(group) ?? { positions: 0, knownValue: zero() }
      total.positions += 1
      total.knownValue = total.knownValue.plus(values.find((value) => value.bucket === row.bucket && value.instrument === row.instrument)?.value ?? 0)
      resolution.set(group, total)
    }
    return { instrument: dimension((row) => instruments.get(row.instrument)?.market ? row.instrument : key(row.bucket, row.instrument)),
      market, event, cashInclusiveMarket: inclusive(market), cashInclusiveEvent: inclusive(event),
      account: dimension((row) => row.bucket), venue: dimension((row) => buckets.get(row.bucket)?.venue),
      acquisitionBasis: basisMetrics,
      acquisitionBasisRows: { denominator: basisMetrics?.denominator ?? null,
        unavailable: basisRows.filter((row) => row.value === null).length,
        rows: basisRows.map((row) => ({ ...row, weight: row.value === null || !basisMetrics
          ? null : new D(row.value).div(basisMetrics.denominator).toFixed() })) },
      resolutionExposure: [...resolution].map(([id, row]) => ({ id, positions: row.positions, knownValue: row.knownValue.toFixed() })),
      cashInclusive }
  }
  const modeled = (rows: typeof proposed, after: boolean, hypothetical: boolean) => {
    const rules = hypothetical ? [...baseline.rules, ...conditionalRules] : baseline.rules
    if (hypothetical && (new Set(rules.map((rule) => rule.id)).size !== rules.length
      || new Set(rules.flatMap((rule) => [rule.yes, rule.no])).size !== rules.length * 2)) {
      throw new ScenarioError('conflicting_instrument_assignment')
    }
    const outcomes = new Map(input.outcomes.map(({ group, winner }) => [group, winner]))
    if (hypothetical && baseline.rules.some((rule) => rule.fixed !== undefined && outcomes.has(rule.id) && outcomes.get(rule.id) !== rule.fixed)) {
      return { authority: 'scenario_assumptions', declaredPayouts: conditionalRules, unsupported: [], result: { status: 'unavailable' as const, reason: 'no_feasible_outcomes' },
        cashInclusive: null, basisRelative: null, coverage: 'unavailable_or_supported_subset' }
    }
    if (hypothetical && (outcomes.size !== input.outcomes.length || [...outcomes.keys()].some((id) => !rules.some((rule) => rule.id === id)))) {
      throw new ScenarioError('invalid_outcome_scope')
    }
    const financialCash = after ? endingCash : openingCash
    const cashRangeEligible = financialCash !== null && pending !== null && !financialCash.lt(0)
      && (after ? shortfall?.isZero() : openingCashNonnegative)
    const authority = hypothetical ? 'scenario_assumptions' : 'reviewed_rules'
    const declaredPayouts = hypothetical ? conditionalRules : []
    const confirmedEmpty = inventoryComplete && (baseline.mode === 'scratch' || baseline.buckets.every((bucket) =>
      bucket.inventoryComplete === true || (bucket.inventoryComplete === undefined && bucket.inventoryAt != null)))
      && rows.every((row) => row.quantity.isZero() && row.quantityKnown !== false)
    if (confirmedEmpty && (!hypothetical || (!outcomes.size && !input.constraints.length))) {
      const value = cashRangeEligible ? financialCash.plus(pending).toFixed() : null
      return { authority, declaredPayouts, unsupported: [], coverage: 'confirmed_no_open_exposure',
        result: { status: 'no_open_exposure' as const, grossPayout: '0' },
        cashInclusive: value === null ? null : { best: value, worst: value }, basisRelative: { best: '0', worst: '0' } }
    }
    const allGroups = rules.map((rule) => ({
      ...rule, ...(hypothetical && outcomes.has(rule.id) ? { fixed: outcomes.get(rule.id)! } : {}),
      legs: rows.flatMap((row) => row.quantityKnown === false || row.quantity.isZero() || ![rule.yes, rule.no].includes(row.instrument) ? [] : [{
        instrument: row.instrument, venue: buckets.get(row.bucket)!.venue, account: buckets.get(row.bucket)!.account,
        quantity: row.quantity.toFixed(), mark: fixed((after ? overrides.get(row.instrument) : undefined) ?? holdingMark(row)),
      }]),
    }))
    if (hypothetical && allGroups.some((group) => conditionalRules.some((rule) => rule.id === group.id)
      && group.legs.some((leg) => leg.mark !== null && new D(leg.mark).gt(group.unitPayout ?? '1')))) {
      throw new ScenarioError('reference_price_exceeds_payout')
    }
    const constraints = hypothetical ? [...baseline.constraints, ...input.constraints] : baseline.constraints
    const knownGroups = new Set([...allGroups.map((group) => group.id), ...(baseline.missingRules ?? [])])
    if (constraints.some((edge) => !knownGroups.has(edge.left) || !knownGroups.has(edge.right))) {
      throw new ScenarioError('invalid_constraint')
    }
    const included = connectedMarkets(allGroups.filter((group) => group.legs.length || (hypothetical && outcomes.has(group.id)))
      .map((group) => group.id), constraints)
    const result = baseline.settlementGraphLimited ? { status: 'unavailable' as const, reason: 'reviewed_graph_limit' }
      : settlementRisk(allGroups.filter((group) => included.has(group.id)),
      constraints.filter((edge) => included.has(edge.left) && included.has(edge.right)),
      baseline.missingRules?.filter((id) => included.has(id)))
    const unsupported = rows.filter((row) => !row.quantity.isZero() && (row.quantityKnown === false
      || !rules.some((rule) => [rule.yes, rule.no].includes(row.instrument)))).map((row) => key(row.bucket, row.instrument))
    const cash = after ? endingCash : openingCash
    const allBasis = rows.reduce((known, row) => add(known, row.basis), zero() as Decimal | null)
    return { authority, declaredPayouts, unsupported, result,
      coverage: result.status !== 'exact' ? 'unavailable_or_supported_subset' : inventoryComplete && !unsupported.length ? 'complete_selected_model' : 'supported_subset',
      cashInclusive: result.status === 'exact' && inventoryComplete && !unsupported.length && cash !== null && pending !== null && !cash.lt(0)
        && (after ? shortfall?.isZero() : openingCashNonnegative) ? { best: cash.plus(pending).plus(result.best.payout).toFixed(),
          worst: cash.plus(pending).plus(result.worst.payout).toFixed() } : null,
      basisRelative: result.status === 'exact' && inventoryComplete && !unsupported.length && allBasis !== null
        ? { best: new D(result.best.payout).minus(allBasis).toFixed(), worst: new D(result.worst.payout).minus(allBasis).toFixed() } : null }
  }
  const baselinePositions = new Map(baseline.holdings.map((row) => [key(row.bucket, row.instrument), row]))
  const original = baseline.holdings.map((row) => ({ ...row, quantity: new D(row.quantity), basis: amount(row.basis) }))
  const settlement = { before: modeled(original, false, false), verified: modeled(proposed, true, false),
    conditional: modeled(proposed, true, true) }
  return { methodology, asset: baseline.asset, mode: baseline.mode, baselineAsOf: baseline.asOf, revisions: baseline.revisions,
    status: funding.some((row) => row.shortfall !== null && new D(row.shortfall).gt(0)) ? 'underfunded'
      : shortfall === null || endingValue === null ? 'partial' : 'calculated',
    funding, additionalCapitalRequired: fixed(shortfall), knownAdditionalCapitalRequired: knownAdditionalCapitalRequired.toFixed(),
    availability: { funding: shortfall === null ? 'partial' : 'complete', underfunded: knownAdditionalCapitalRequired.gt(0),
      quantities: inventoryComplete && proposed.every((row) => row.quantityKnown !== false) ? 'complete' : 'partial',
      valuation: endingValue === null ? 'partial' : 'complete',
      basis: inventoryComplete && proposed.every((row) => row.basis !== null) ? 'complete' : 'partial',
      realized: realized === null ? 'partial' : 'complete',
      unrealized: endingMarked !== null && proposed.every((row) => row.basis !== null) ? 'complete' : 'partial',
      fees: fees === null ? 'partial' : 'complete', settlement: settlement.verified.coverage },
    valuationBasis: baseline.instruments.some((row) => row.markSource === 'assumed_current_quote') ? 'mixed_current_quote_assumption' : 'frozen_with_explicit_overrides', operations, weightBudget: fixed(weightBudget),
    fundingOrder: 'net_batch_sales_available_for_purchases',
    positions: proposed.map((row) => {
      const before = baselinePositions.get(key(row.bucket, row.instrument))
      const originalReference = before ? holdingMark(before) : null
      const initialValue = before?.quantityKnown === false ? null : !before || new D(before.quantity).isZero()
        ? zero() : originalReference?.mul(before.quantity) ?? null
      const reference = overrides.get(row.instrument) ?? holdingMark(row)
      const value = row.quantityKnown === false ? null : row.quantity.isZero() ? zero() : reference?.mul(row.quantity) ?? null
      return { ...row, quantity: row.quantity.toFixed(), basis: fixed(row.basis), mark: fixed(reference),
        quantityObservation: before?.quantityObservation ?? null,
        initialQuantity: before?.quantity ?? '0', initialBasis: before ? before.basis : '0',
        initialValue: fixed(initialValue), initialMark: fixed(originalReference),
        value: fixed(value), unrealized: fixed(add(value, row.basis?.neg() ?? null)), resolvesAt: instruments.get(row.instrument)?.resolvesAt ?? null }
    }),
    bridge: { evidenceStartingValue: fixed(add(add(initialMarked, actualOpeningCash), pending)), startingValue: fixed(startingValue), addedCapital: fixed(capital), withdrawnCapital: fixed(withdrawn), executionEffect: fixed(executionEffect),
      fees: fixed(fees?.neg() ?? null), remarkEffect: fixed(remarkEffect), endingValue: fixed(endingValue),
      normalizedChange: explained === null || endingValue === null || !shortfall?.isZero() || !weightBudget?.gt(0)
        ? null : endingValue.minus(weightBudget).div(weightBudget).toFixed(),
      unexplained: endingValue === null || explained === null ? null : endingValue.minus(explained).toFixed() },
    knownPending: fixed(pending), hypotheticalRealized: fixed(realized),
    allocation: { before: allocation(original, false), after: allocation(proposed, true) },
    settlement,
  }
}

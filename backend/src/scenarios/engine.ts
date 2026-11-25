import { connectedMarkets } from '../analytics/exposure.js'
import { Decimal } from 'decimal.js'
import { concentration } from '../analytics/performance.js'
import { settlementRisk, type BinaryGroup, type SettlementConstraint } from '../analytics/settlement.js'

const D = Decimal.clone({ precision: 70, rounding: Decimal.ROUND_HALF_EVEN })
const zero = () => new D(0)
const sum = (values: Decimal[]) => values.reduce((total, value) => total.plus(value), zero())
const add = (left: Decimal | null, right: Decimal | null) => left === null || right === null ? null : left.plus(right)
export const methodology = 'weighted-average-scenario-v1'
export interface FundingBucket { id: string; venue: string; account: string; cash: string | null; pending: string | null }
export interface ScenarioInstrument {
  id: string; mark: string | null; markAt?: string | null; market?: string; event?: string; resolvesAt?: string | null
  venue?: string; settlementAsset?: string | null; outcome?: string | null; providerMarket?: string; lifecycle?: string
  latestPrice?: string | null; latestPriceAt?: string | null
  feeSchedule?: { version: 'polymarket-price-variance-v1'; rate: string; retrievedAt: string; source: 'gamma_market'; denomination: 'USDC' }
}
export interface ScenarioHolding { bucket: string; instrument: string; quantity: string; basis: string | null; quantityKnown?: boolean; mark?: string | null; markAt?: string | null }
export interface ScenarioBaseline {
  methodology: typeof methodology; mode: 'actual' | 'scratch'; asset: string; asOf: string
  buckets: FundingBucket[]; instruments: ScenarioInstrument[]; holdings: ScenarioHolding[]
  rules: Omit<BinaryGroup, 'legs'>[]; constraints: SettlementConstraint[]
  missingRules?: string[]
  settlementGraphLimited?: boolean
  revisions: Record<string, string>
}
export type Fee =
  | { mode: 'fixed' | 'rate'; value: string }
  | { mode: 'excluded' | 'unavailable' }
  | { mode: 'provider'; role: 'maker' | 'taker' }
export interface Operation {
  bucket: string; instrument: string; kind: 'buy' | 'sell' | 'exit' | 'target_quantity' | 'buy_notional' | 'target_weight'
  amount?: string | undefined; price: string; fee: Fee
}
export interface ScenarioInput {
  operations: Operation[]
  funding: Array<{ bucket: string; added: string; withdrawn?: string | undefined; assumedCash?: string | undefined }>
  marks: Array<{ instrument: string; price: string }>
  rules: Array<Omit<BinaryGroup, 'legs' | 'fixed' | 'asset' | 'unitPayout'> & { unitPayout?: string | undefined }>
  constraints: SettlementConstraint[]
  outcomes: Array<{ group: string; winner: 'yes' | 'no' }>
}
const key = (bucket: string, instrument: string) => JSON.stringify([bucket, instrument])
const amount = (input: string | null) => input === null ? null : new D(input)
const fixed = (input: Decimal | null) => input?.toFixed() ?? null
export class ScenarioError extends Error {}

export function evaluate(baseline: ScenarioBaseline, input: ScenarioInput) {
  if (baseline.methodology !== methodology) throw new ScenarioError('unsupported_methodology')
  const instruments = new Map(baseline.instruments.map((row) => [row.id, row]))
  const buckets = new Map(baseline.buckets.map((row) => [row.id, {
    ...row, cash: amount(row.cash), pending: amount(row.pending), added: zero(), withdrawn: zero(), assumed: null as Decimal | null,
    buys: zero(), sales: zero(), fees: zero() as Decimal | null,
  }]))
  const holdings = new Map(baseline.holdings.map((row) => [key(row.bucket, row.instrument), {
    ...row, quantity: new D(row.quantity), basis: amount(row.basis),
  }]))
  const mark = (instrument: string) => amount(instruments.get(instrument)?.mark ?? null)
  const holdingMark = (row: { instrument: string; mark?: string | null }) =>
    row.mark === undefined ? mark(row.instrument) : amount(row.mark)
  const overrides = new Map(input.marks.map((row) => [row.instrument, new D(row.price)]))
  if (overrides.size !== input.marks.length || [...overrides.keys()].some((id) => !instruments.has(id))) throw new ScenarioError('invalid_mark_scope')
  const fundingIds = new Set<string>()
  for (const funding of input.funding) {
    const bucket = buckets.get(funding.bucket)
    if (!bucket || fundingIds.has(funding.bucket)) throw new ScenarioError('invalid_funding_scope')
    fundingIds.add(funding.bucket)
    if (funding.assumedCash !== undefined && bucket.cash !== null) throw new ScenarioError('known_cash_cannot_be_assumed')
    bucket.assumed = amount(funding.assumedCash ?? null)
    bucket.added = new D(funding.added)
    bucket.withdrawn = new D(funding.withdrawn ?? 0)
  }
  const marked = (rows: Iterable<{ instrument: string; quantity: Decimal; quantityKnown?: boolean; mark?: string | null }>, proposed: boolean) => {
    let total: Decimal | null = zero()
    for (const row of rows) {
      if (row.quantity.isZero() && row.quantityKnown !== false) continue
      const price = (proposed ? overrides.get(row.instrument) : undefined) ?? holdingMark(row)
      total = add(total, row.quantityKnown === false ? null : price?.mul(row.quantity) ?? null)
    }
    return total
  }
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
  const operations = input.operations.map((op) => {
    const id = key(op.bucket, op.instrument)
    const bucket = buckets.get(op.bucket)
    if (!bucket || !instruments.has(op.instrument) || used.has(id)) throw new ScenarioError('invalid_operation_scope')
    used.add(id)
    const prior = holdings.get(id) ?? { bucket: op.bucket, instrument: op.instrument, quantity: zero(), basis: zero(), quantityKnown: true }
    if (prior.quantityKnown === false) throw new ScenarioError('quantity_unavailable')
    const price = new D(op.price)
    const requested = new D(op.amount ?? '0')
    let delta = requested
    if (op.kind === 'exit') delta = prior.quantity.neg()
    if (op.kind === 'sell') delta = requested.neg()
    if (op.kind === 'target_quantity') delta = requested.minus(prior.quantity)
    if (op.kind === 'buy_notional') {
      if (price.lte(0)) throw new ScenarioError('positive_execution_price_required')
      delta = requested.div(price).toDecimalPlaces(18, Decimal.ROUND_DOWN)
    }
    if (op.kind === 'target_weight') {
      const reference = overrides.get(op.instrument) ?? holdingMark(prior)
      if (!reference?.gt(0) || !weightBudget?.gt(0)) throw new ScenarioError('target_weight_basis_unavailable')
      delta = requested.mul(weightBudget).div(reference).toDecimalPlaces(18, Decimal.ROUND_DOWN).minus(prior.quantity)
    }
    const nextQuantity = prior.quantity.plus(delta)
    if (nextQuantity.lt(0)) throw new ScenarioError('short_sale_unsupported')
    const notional = delta.abs().mul(price)
    const instrument = instruments.get(op.instrument)!
    if (instrument.venue && instrument.venue !== bucket.venue) throw new ScenarioError('instrument_venue_mismatch')
    if (instrument.settlementAsset && instrument.settlementAsset !== baseline.asset) throw new ScenarioError('instrument_asset_mismatch')
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
    return { ...op, initialQuantity: prior.quantity.toFixed(), proposedQuantity: nextQuantity.toFixed(),
      delta: delta.toFixed(), notional: notional.toFixed(), feeAmount: fixed(fee), feeStatus: delta.isZero() ? 'no_trade' : fee === null ? 'unavailable' : op.fee.mode, realized: fixed(pnl),
      remainingBasis: fixed(basis), netProceeds: delta.lt(0) ? fixed(fee === null ? null : notional.minus(fee)) : null }
  })
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
      actualOrScratchStartingCash: fixed(bucket.cash), assumedStartingCash: fixed(bucket.assumed), addedCapital: fixed(bucket.added), withdrawnCapital: fixed(bucket.withdrawn),
      grossSales: fixed(bucket.sales), purchases: fixed(bucket.buys), fees: fixed(bucket.fees), endingCash: fixed(ending),
      shortfall: ending === null ? null : D.max(0, ending.neg()).toFixed() }
  })
  const total = (field: 'endingCash' | 'shortfall' | 'fees') => funding.reduce((value, row) => add(value, amount(row[field])), zero() as Decimal | null)
  const openingCashNonnegative = [...buckets.values()].every((bucket) => (bucket.cash ?? bucket.assumed)?.gte(0) === true)
  const endingCash = total('endingCash')
  const fees = total('fees')
  const shortfall = total('shortfall')
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
    return { instrument: dimension((row) => instruments.get(row.instrument)?.market ? row.instrument : key(row.bucket, row.instrument)),
      market: dimension((row) => instruments.get(row.instrument)?.market), event: dimension((row) => instruments.get(row.instrument)?.event),
      account: dimension((row) => row.bucket), venue: dimension((row) => buckets.get(row.bucket)?.venue),
      acquisitionBasis: concentration(rows.flatMap((row) => row.basis === null || row.quantity.isZero() ? [] : [row.basis.toFixed()])),
      cashInclusive }
  }
  const modeled = (rows: typeof proposed, after: boolean, hypothetical: boolean) => {
    const rules = hypothetical ? [...baseline.rules, ...input.rules.map(({ unitPayout, ...rule }) =>
      ({ ...rule, ...(unitPayout === undefined ? {} : { unitPayout }), asset: baseline.asset }))] : baseline.rules
    if (hypothetical && (input.rules.some((rule) => rule.yes === rule.no || (rule.unitPayout !== undefined && !new D(rule.unitPayout).gt(0)))
      || input.rules.some((rule) => ![rule.yes, rule.no].every((id) => id.startsWith('local:') && instruments.has(id))))) {
      throw new ScenarioError('scenario_rule_requires_local_instruments')
    }
    if (hypothetical && (new Set(rules.map((rule) => rule.id)).size !== rules.length
      || new Set(rules.flatMap((rule) => [rule.yes, rule.no])).size !== rules.length * 2)) {
      throw new ScenarioError('conflicting_instrument_assignment')
    }
    const outcomes = new Map(input.outcomes.map(({ group, winner }) => [group, winner]))
    if (hypothetical && baseline.rules.some((rule) => rule.fixed !== undefined && outcomes.has(rule.id) && outcomes.get(rule.id) !== rule.fixed)) {
      return { authority: 'scenario_assumptions', unsupported: [], result: { status: 'unavailable' as const, reason: 'no_feasible_outcomes' },
        cashInclusive: null, basisRelative: null }
    }
    if (hypothetical && (outcomes.size !== input.outcomes.length || [...outcomes.keys()].some((id) => !rules.some((rule) => rule.id === id)))) {
      throw new ScenarioError('invalid_outcome_scope')
    }
    const allGroups = rules.map((rule) => ({
      ...rule, ...(hypothetical && outcomes.has(rule.id) ? { fixed: outcomes.get(rule.id)! } : {}),
      legs: rows.flatMap((row) => row.quantityKnown === false || row.quantity.isZero() || ![rule.yes, rule.no].includes(row.instrument) ? [] : [{
        instrument: row.instrument, venue: buckets.get(row.bucket)!.venue, account: buckets.get(row.bucket)!.account,
        quantity: row.quantity.toFixed(), mark: fixed((after ? overrides.get(row.instrument) : undefined) ?? holdingMark(row)),
      }]),
    }))
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
    return { authority: hypothetical ? 'scenario_assumptions' : 'reviewed_rules', unsupported, result,
      cashInclusive: result.status === 'exact' && !unsupported.length && cash !== null && pending !== null && !cash.lt(0)
        && (after ? shortfall?.isZero() : openingCashNonnegative) ? { best: cash.plus(pending).plus(result.best.payout).toFixed(),
          worst: cash.plus(pending).plus(result.worst.payout).toFixed() } : null,
      basisRelative: result.status === 'exact' && !unsupported.length && allBasis !== null
        ? { best: new D(result.best.payout).minus(allBasis).toFixed(), worst: new D(result.worst.payout).minus(allBasis).toFixed() } : null }
  }
  const baselinePositions = new Map(baseline.holdings.map((row) => [key(row.bucket, row.instrument), row]))
  const original = baseline.holdings.map((row) => ({ ...row, quantity: new D(row.quantity), basis: amount(row.basis) }))
  return { methodology, asset: baseline.asset, mode: baseline.mode, baselineAsOf: baseline.asOf, revisions: baseline.revisions,
    status: funding.some((row) => row.shortfall !== null && new D(row.shortfall).gt(0)) ? 'underfunded'
      : shortfall === null || endingValue === null ? 'partial' : 'calculated',
    funding, additionalCapitalRequired: fixed(shortfall), operations, weightBudget: fixed(weightBudget),
    fundingOrder: 'net_batch_sales_available_for_purchases',
    positions: proposed.map((row) => {
      const reference = overrides.get(row.instrument) ?? holdingMark(row)
      const value = row.quantityKnown === false ? null : row.quantity.isZero() ? zero() : reference?.mul(row.quantity) ?? null
      return { ...row, quantity: row.quantity.toFixed(), basis: fixed(row.basis), mark: fixed(reference),
        initialQuantity: baselinePositions.get(key(row.bucket, row.instrument))?.quantity ?? '0',
        value: fixed(value), unrealized: fixed(add(value, row.basis?.neg() ?? null)), resolvesAt: instruments.get(row.instrument)?.resolvesAt ?? null }
    }),
    bridge: { evidenceStartingValue: fixed(add(add(initialMarked, actualOpeningCash), pending)), startingValue: fixed(startingValue), addedCapital: fixed(capital), withdrawnCapital: fixed(withdrawn), executionEffect: fixed(executionEffect),
      fees: fixed(fees?.neg() ?? null), remarkEffect: fixed(remarkEffect), endingValue: fixed(endingValue),
      normalizedChange: explained === null || endingValue === null || !weightBudget?.gt(0)
        ? null : endingValue.minus(weightBudget).div(weightBudget).toFixed(),
      unexplained: endingValue === null || explained === null ? null : endingValue.minus(explained).toFixed() },
    knownPending: fixed(pending), hypotheticalRealized: fixed(realized),
    allocation: { before: allocation(original, false), after: allocation(proposed, true) },
    settlement: { before: modeled(original, false, false), verified: modeled(proposed, true, false),
      conditional: modeled(proposed, true, true) },
  }
}

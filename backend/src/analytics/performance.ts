import { Decimal } from 'decimal.js'
import { replayAccounting } from '../accounting/ledger.js'
import type { Evidence } from '../accounting/model.js'

const D = Decimal.clone({ precision: 70, rounding: Decimal.ROUND_HALF_EVEN })
const decimal = (n: string | number) => new D(n)
const sum = (values: string[]) => values.reduce((a, b) => a.plus(b), decimal(0))
export const dayMs = 86_400_000
export const metric = (value: Decimal | null, reason: string) => value === null
  ? { value: null, availability: 'unavailable' as const, reason }
  : { value: value.toFixed(), availability: 'calculated' as const, reason: null }

export function linkedReturn(subperiods: Array<{ opening: string; closing: string }>) {
  if (!subperiods.length || subperiods.some((point) => decimal(point.opening).lte(0) || decimal(point.closing).lt(0))) return null
  return subperiods.reduce((index, point) => index.mul(decimal(point.closing).div(point.opening)), decimal(1)).minus(1)
}

export function drawdowns(index: string[]) {
  let peak = decimal(0)
  let worst = decimal(0)
  const series = index.map((value) => {
    const point = decimal(value)
    if (point.gt(peak)) peak = point
    const drawdown = peak.gt(0) ? point.div(peak).minus(1) : decimal(0)
    if (drawdown.lt(worst)) worst = drawdown
    return drawdown.toFixed()
  })
  return { maximum: worst.toFixed(), series }
}

export function concentration(values: string[]) {
  const total = sum(values)
  if (total.lte(0) || values.some((value) => decimal(value).lt(0))) return null
  const weights = values.map((value) => decimal(value).div(total))
  const hhi = weights.reduce((result, weight) => result.plus(weight.pow(2)), decimal(0))
  return { denominator: total.toFixed(), weights: weights.map((weight) => weight.toFixed()),
    hhi: hhi.toFixed(), effectiveExposures: decimal(1).div(hhi).toFixed() }
}

export function annualizedMoneyWeightedReturn(flows: Array<{ timestamp: string; amount: string }>) {
  const nonzero = flows.filter((flow) => !decimal(flow.amount).isZero())
  if (nonzero.length < 2 || nonzero.length > 64) return null
  const signs = nonzero.map((flow) => decimal(flow.amount).isPositive())
  if (signs.slice(1).filter((sign, index) => sign !== signs[index]).length !== 1) return null
  const origin = Date.parse(nonzero[0]!.timestamp)
  const dated = nonzero.map((flow) => ({
    amount: decimal(flow.amount), years: decimal(Date.parse(flow.timestamp) - origin).div(365 * dayMs),
  }))
  if (dated.some(({ years }) => !years.isFinite() || years.lt(0)) || dated.at(-1)!.years.isZero()) return null
  const npv = (rate: Decimal) => dated.reduce((value, item) => value.plus(item.amount.div(rate.plus(1).pow(item.years))), decimal(0))
  let low = decimal('-0.99')
  let high = decimal(100)
  const lowValue = npv(low)
  if (lowValue.isZero()) return low
  const upperValue = npv(high)
  if (upperValue.isZero()) return high
  if (lowValue.isPositive() === upperValue.isPositive()) return null
  for (let step = 0; step < 64; step += 1) {
    const midpoint = low.plus(high).div(2)
    const value = npv(midpoint)
    if (value.isZero()) return midpoint
    if (value.isPositive() === lowValue.isPositive()) low = midpoint
    else high = midpoint
  }
  return low.plus(high).div(2).toDecimalPlaces(12)
}

export function dailyVolatility(index: Array<{ asOf: string; index: string | null }>) {
  const returns: Decimal[] = []
  for (let i = 1; i < index.length; i += 1) {
    const previous = index[i - 1]!
    const point = index[i]!
    if (Date.parse(point.asOf) - Date.parse(previous.asOf) !== dayMs) continue
    if (previous.index === null || point.index === null || decimal(previous.index).lte(0)) return null
    returns.push(decimal(point.index).div(previous.index).minus(1))
  }
  if (returns.length < 2) return null
  const mean = returns.reduce((value, point) => value.plus(point), decimal(0)).div(returns.length)
  return returns.reduce((value, point) => value.plus(point.minus(mean).pow(2)), decimal(0))
    .div(returns.length - 1).sqrt().mul(decimal(365).sqrt()).toDecimalPlaces(12)
}

type Replay = ReturnType<typeof replayAccounting>

function valuation(replay: Replay, accounts: string[], asset: string, openingCutoff: string) {
  const balances = replay.cash.filter((bucket) => bucket.asset === asset)
  const complete = accounts.every((account) => balances.some((bucket) => bucket.account === account))
    && balances.length > 0 && balances.every((bucket) => bucket.portfolioValue !== null)
  return {
    asOf: replay.asOf, accounts: balances.length,
    knownValue: balances.some((bucket) => bucket.portfolioValue !== null)
      ? sum(balances.flatMap((bucket) => bucket.portfolioValue ?? [])).toFixed() : null,
    value: complete ? sum(balances.map((bucket) => bucket.portfolioValue!)).toFixed() : null,
    returnEligible: complete && balances.every((bucket) => bucket.historyCoverage === 'user_declared_complete'
      && bucket.historyFrom !== null && bucket.historyFrom <= openingCutoff && bucket.netContributions !== null),
  }
}

export function analyzePerformance(evidence: Evidence[], accounts: string[], asset: string, from: string, through: string) {
  const start = Date.parse(from)
  const end = Date.parse(through)
  const days = Math.floor((end - start) / dayMs) + 1
  if (days < 1 || days > 366) throw new Error('analytics_range_limit')
  const cache = new Map<string, ReturnType<typeof valuation>>()
  let replayCount = 0
  const replayAt = (asOf: string) => {
    replayCount += 1
    if (replayCount * evidence.length > 200_000 || replayCount > 800) throw new Error('analytics_replay_limit')
    return replayAccounting(evidence, asOf)
  }
  const initialState = replayAt(from)
  const endingState = through === from ? initialState : replayAt(through)
  const opening = valuation(initialState, accounts, asset, from)
  const ending = valuation(endingState, accounts, asset, from)
  cache.set(from, opening)
  cache.set(through, ending)
  const at = (asOf: string) => {
    const existing = cache.get(asOf)
    if (existing) return existing
    const point = valuation(replayAt(asOf), accounts, asset, from)
    cache.set(asOf, point)
    return point
  }
  const events = endingState.events.filter((event) => event.timestamp > from && event.timestamp <= through)
  const byId = new Map(events.map((event) => [event.economicId, event]))
  const entries = endingState.ledger.filter((entry) => entry.asset === asset && byId.has(entry.eventId))
  const postedIds = new Set(entries.map((entry) => entry.eventId))
  const posted = events.filter((event) => event.asset === asset && postedIds.has(event.economicId))
  const flows = new Map<string, Decimal>()
  let flowClassificationKnown = true
  for (const event of posted) {
    if (!['deposit', 'withdrawal'].includes(event.type)) continue
    if (event.sources.some((source) => 'providerAccountId' in source)) { flowClassificationKnown = false; continue }
    const amount = decimal(event.amount!)
    flows.set(event.timestamp, (flows.get(event.timestamp) ?? decimal(0)).plus(event.type === 'deposit' ? amount : amount.neg()))
  }
  const netFlows = sum([...flows.values()].map((value) => value.toFixed()))
  const flowPoints = [...flows.entries()].sort(([a], [b]) => a.localeCompare(b))
  const boundaries = flowPoints.map(([timestamp, flow]) => {
    const before = at(new Date(Date.parse(timestamp) - 1).toISOString())
    const after = at(timestamp)
    // A same-time mark or trade can make the contribution boundary ambiguous.
    const valid = before.returnEligible && after.returnEligible && before.value !== null && after.value !== null
      && decimal(after.value).minus(before.value).eq(flow)
      && !events.some((event) => event.timestamp === timestamp && !['deposit', 'withdrawal'].includes(event.type))
    return { timestamp, flow: flow.toFixed(), before: before.value, after: after.value, valid }
  })
  const returnTo = (point: ReturnType<typeof valuation>) => {
    if (!opening.returnEligible || !point.returnEligible
      || opening.value === null || point.value === null) return null
    let base = opening.value
    const subperiods = []
    for (const boundary of boundaries) {
      if (boundary.timestamp > point.asOf) break
      if (!boundary.valid || boundary.before === null || boundary.after === null) return null
      subperiods.push({ opening: base, closing: boundary.before })
      base = boundary.after
    }
    return linkedReturn([...subperiods, { opening: base, closing: point.value }])
  }
  const points = [opening]
  for (let midnight = Math.floor(start / dayMs) * dayMs + dayMs - 1; midnight < end; midnight += dayMs) {
    if (midnight > start) points.push(at(new Date(midnight).toISOString()))
  }
  if (end !== start) points.push(ending)
  const indices = points.map((point) => returnTo(point)?.plus(1).mul(100).toFixed() ?? null)
  const risk = indices.length >= 2 && indices.every((point) => point !== null) ? drawdowns(indices as string[]) : null
  const eligibleBridge = opening.returnEligible && ending.returnEligible && flowClassificationKnown
    && opening.value !== null && ending.value !== null
  const pnl = eligibleBridge ? decimal(ending.value!).minus(opening.value!).minus(netFlows) : null
  const attribution = new Map<string, Decimal>()
  for (const entry of entries) {
    if (entry.realized === null) continue
    const instrument = entry.instrument ?? byId.get(entry.eventId)?.instrument ?? 'unallocated'
    attribution.set(instrument, (attribution.get(instrument) ?? decimal(0)).plus(entry.realized))
  }
  const unrealizedByInstrument = new Map<string, Decimal>()
  for (const [state, sign] of [[initialState, -1], [endingState, 1]] as const) {
    for (const holding of state.holdings) {
      if (holding.asset !== asset || holding.unrealized === null) continue
      const prior = unrealizedByInstrument.get(holding.instrument) ?? decimal(0)
      unrealizedByInstrument.set(holding.instrument, prior.plus(decimal(holding.unrealized).mul(sign)))
    }
  }
  const knownUnrealizedChange = sum([...unrealizedByInstrument.values()].map((value) => value.toFixed()))
  const mwr = eligibleBridge && decimal(opening.value!).gt(0) ? annualizedMoneyWeightedReturn([
    { timestamp: from, amount: decimal(opening.value!).neg().toFixed() },
    ...boundaries.map((boundary) => ({ timestamp: boundary.timestamp, amount: decimal(boundary.flow).neg().toFixed() })),
    { timestamp: through, amount: ending.value! },
  ]) : null
  const realized = sum([...attribution.values()].map((amount) => amount.toFixed()))
  const eligibleTrades = posted.filter((event) => event.type === 'buy' || event.type === 'sell')
  const standaloneCharges = posted.filter((event) => event.type === 'fee' || event.type === 'rebate')
  const reportedFees = eligibleTrades.filter((event) => event.fee !== null && (event.feeAsset ?? event.asset) === asset)
  return {
    methodology: { valuation: 'selected_accounting_evidence', return: 'cash_flow_boundary_twr', time: 'UTC', drawdown: 'flow_adjusted_sampled_index' },
    opening, ending, cashFlowBoundaries: boundaries,
    bridge: {
      valueChange: metric(opening.value !== null && ending.value !== null ? decimal(ending.value).minus(opening.value) : null, 'valuation_missing'),
      knownNetContributions: netFlows.toFixed(),
      netInvestmentGain: metric(pnl, 'coverage_or_cash_flow_classification_missing'),
    },
    returns: { twr: metric(returnTo(ending), 'coverage_value_or_flow_boundary_missing'),
      annualizedMwr: metric(mwr, 'eligible_cash_flow_schedule_or_unique_bounded_root_missing'),
      annualizedVolatility: metric(dailyVolatility(points.map((point, index) => ({ asOf: point.asOf, index: indices[index] ?? null }))),
        'eligible_daily_return_series_missing'),
      maximumDrawdown: metric(risk ? decimal(risk.maximum) : null, 'eligible_index_series_missing') },
    history: points.map((point, index) => ({ ...point, returnIndex: indices[index], drawdown: risk?.series[index] ?? null })),
    attribution: { scope: 'known_posted_and_marked_components', knownRealized: realized.toFixed(),
      knownUnrealizedChange: knownUnrealizedChange.toFixed(),
      instruments: [...new Set([...attribution.keys(), ...unrealizedByInstrument.keys()])].map((instrument) => ({
        instrument, knownRealized: attribution.get(instrument)?.toFixed() ?? null,
        knownUnrealizedChange: unrealizedByInstrument.get(instrument)?.toFixed() ?? null,
      })),
      unattributedResidual: pnl?.minus(realized).minus(knownUnrealizedChange).toFixed() ?? null },
    trading: { fills: eligibleTrades.length, buys: eligibleTrades.filter((event) => event.type === 'buy').length,
      sells: eligibleTrades.filter((event) => event.type === 'sell').length,
      grossNotional: eligibleTrades.reduce((total, event) => total.plus(decimal(event.quantity!).mul(event.price!)), decimal(0)).toFixed(),
      attachedFeeObservations: reportedFees.length, missingAttachedFees: eligibleTrades.filter((event) => event.fee === null).length,
      knownAttachedFees: sum(reportedFees.map((event) => event.fee!)).toFixed(),
      knownStandaloneFees: sum(standaloneCharges.filter((item) => item.type === 'fee').map((item) => item.amount!)).toFixed(),
      knownStandaloneRebates: sum(standaloneCharges.filter((item) => item.type === 'rebate').map((item) => item.amount!)).toFixed(),
      feeScope: 'posted_trade_attached_fees_in_selected_asset' },
  }
}

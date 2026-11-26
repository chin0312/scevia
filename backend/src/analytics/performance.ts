import { coversAccounts, type AccountIdentity } from './scope.js'
import { Decimal } from 'decimal.js'
import { replayAccounting } from '../accounting/ledger.js'
import type { Evidence } from '../accounting/model.js'

const D = Decimal.clone({ precision: 70, rounding: Decimal.ROUND_HALF_EVEN })
const decimal = (n: string | number | Decimal) => new D(n)
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
  let peakIndex = 0
  let worst = decimal(0)
  let worstPeakIndex = 0
  let troughIndex = 0
  const series = index.map((value, i) => {
    const point = decimal(value)
    if (point.gt(peak)) { peak = point; peakIndex = i }
    const drawdown = peak.gt(0) ? point.div(peak).minus(1) : decimal(0)
    if (drawdown.lt(worst)) { worst = drawdown; worstPeakIndex = peakIndex; troughIndex = i }
    return drawdown.toFixed()
  })
  const recovery = !worst.isZero() && index[worstPeakIndex] !== undefined
    ? index.findIndex((point, i) => i > troughIndex && decimal(point).gte(index[worstPeakIndex]!)) : -1
  return { maximum: worst.toFixed(), series, episode: worst.isZero() ? null : {
    peakIndex: worstPeakIndex, troughIndex, recoveryIndex: recovery < 0 ? null : recovery,
  } }

}

export function concentration(values: string[]) {
  const total = sum(values)
  if (total.lte(0) || values.some((value) => decimal(value).lt(0))) return null
  const weights = values.map((value) => decimal(value).div(total))
  const hhi = weights.reduce((result, weight) => result.plus(weight.pow(2)), decimal(0))
  return { denominator: total.toFixed(), weights: weights.map((weight) => weight.toFixed()),
    hhi: hhi.toFixed(), effectiveExposures: decimal(1).div(hhi).toFixed(),
    topShares: [1, 3, 5].map((count) => ({ count, weight: weights.slice().sort((a, b) => b.comparedTo(a)).slice(0, count)
      .reduce((total, weight) => total.plus(weight), decimal(0)).toFixed() })) }
}

export function annualizedMoneyWeightedReturn(flows: Array<{ timestamp: string; amount: string }>) {
  const grouped = new Map<number, Decimal>()
  for (const flow of flows) {
    const time = Date.parse(flow.timestamp)
    if (!Number.isFinite(time)) return null
    grouped.set(time, (grouped.get(time) ?? decimal(0)).plus(flow.amount))
  }
  const nonzero = [...grouped.entries()].filter(([, amount]) => !amount.isZero())
    .sort(([a], [b]) => a - b).map(([time, amount]) => ({ timestamp: new Date(time).toISOString(), amount }))
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
  const solution = low.plus(high).div(2).toDecimalPlaces(12)
  const tolerance = dated.reduce((total, item) => total.plus(item.amount.abs()), decimal(0)).mul('0.000000001')
  return npv(solution).abs().lte(tolerance) ? solution : null
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

type ValuationReplay = Pick<Replay, 'asOf' | 'cash'> & { holdings: Pick<Replay['holdings'][number], 'asset' | 'quantity' | 'markAt'>[] }

function upperBound(sorted: readonly number[], cutoff: number) {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! <= cutoff) low = middle + 1
    else high = middle
  }
  return low
}

function valuation(replay: ValuationReplay, accounts: string[], asset: string, openingCutoff: string, scopes: Array<{ venue: string; account: string }>) {
  const balances = replay.cash.filter((bucket) => bucket.asset === asset)
  const complete = coversAccounts(balances, accounts, scopes) && balances.every((bucket) => bucket.referencePortfolioValue !== null)
  const markTimes = replay.holdings.filter((row) => row.asset === asset && decimal(row.quantity).gt(0) && row.markAt !== null)
    .map((row) => row.markAt!).sort()
  return {
    asOf: replay.asOf, accounts: balances.length,
    knownValue: balances.some((bucket) => bucket.referencePortfolioValue !== null)
      ? sum(balances.flatMap((bucket) => bucket.referencePortfolioValue ?? [])).toFixed() : null,
    value: complete ? sum(balances.map((bucket) => bucket.referencePortfolioValue!)).toFixed() : null,
    oldestReferenceMarkAt: markTimes[0] ?? null,
    staleReferenceCount: markTimes.filter((time) => Date.parse(replay.asOf) - Date.parse(time) > dayMs).length,
    valuationQuality: !complete ? 'unavailable' as const
      : markTimes.some((time) => time !== replay.asOf)
        ? 'carry_forward_reference_estimate' as const : 'reconstructed_selected_value' as const,
    returnEligible: complete && balances.every((bucket) => ['user_declared_complete', 'simulated_ledger_complete'].includes(bucket.historyCoverage)
      && bucket.historyFrom !== null && bucket.historyFrom <= openingCutoff && bucket.netContributions !== null),
  }
}

export function analyzePerformance(evidence: Evidence[], accounts: string[], asset: string, from: string, through: string, selectedScopes?: AccountIdentity[], requestedCutoffs: string[] = []) {
  const start = Date.parse(from)
  const end = Date.parse(through)
  const days = Math.floor((end - start) / dayMs) + 1
  if (days < 1 || days > 366) throw new Error('analytics_range_limit')
  const cache = new Map<string, ReturnType<typeof valuation>>()
  let replayCount = 0
  let replayWork = 0
  const replayAt = (rows: Evidence[], asOf: string) => {
    replayCount += 1
    replayWork += rows.length
    if (replayWork > 1_600_000 || replayCount > 18_000) throw new Error('analytics_replay_limit')
    return replayAccounting(rows, asOf)
  }
  const initialState = replayAt(evidence, from)
  const endingState = through === from ? initialState : replayAt(evidence, through)
  const scopes = selectedScopes ?? [...new Map(evidence.map(({ observation: { venue, account } }) =>
    [JSON.stringify([venue, account]), { venue, account }])).values()]
  const opening = valuation(initialState, accounts, asset, from, scopes)
  const ending = valuation(endingState, accounts, asset, from, scopes)
  cache.set(from, opening)
  cache.set(through, ending)
  const partitions = new Map<string, Evidence[]>()
  for (const row of evidence) {
    const key = JSON.stringify([row.observation.venue, row.observation.account])
    const partition = partitions.get(key) ?? []
    partition.push(row)
    partitions.set(key, partition)
  }
  // Account/venue scopes have no shared inventory or cash. Reuse their projections until
  // another source row arrives or a declaration window ends.
  const prepared = [...partitions.values()].map((partition) => {
    const rows = partition.slice().sort((a, b) => a.observation.timestamp.localeCompare(b.observation.timestamp))
    const times = rows.map((row) => Date.parse(row.observation.timestamp))
    const breakpoints = [...new Set(rows.flatMap((row, index) => {
      const time = times[index]!
      return [time,
        ...(row.observation.coveredThrough ? [Date.parse(row.observation.coveredThrough) + 1] : [])]
    }))].sort((a, b) => a - b)
    return { rows, times, breakpoints, projections: new Map<number, Omit<ValuationReplay, 'asOf'>>() }
  })
  const at = (asOf: string) => {
    const existing = cache.get(asOf)
    if (existing) return existing
    const cutoff = Date.parse(asOf)
    const combined: ValuationReplay = { asOf, cash: [], holdings: [] }
    for (const partition of prepared) {
      const interval = upperBound(partition.breakpoints, cutoff)
      let projection = partition.projections.get(interval)
      if (!projection) {
        const prefix = upperBound(partition.times, cutoff)
        if (!prefix) continue
        const state = replayAt(partition.rows.slice(0, prefix), asOf)
        projection = {
          cash: state.cash.filter((row) => row.asset === asset),
          holdings: state.holdings.filter((row) => row.asset === asset && decimal(row.quantity).gt(0))
            .map(({ asset, quantity, markAt }) => ({ asset, quantity, markAt })),
        }
        partition.projections.set(interval, projection)
      }
      combined.cash.push(...projection.cash)
      combined.holdings.push(...projection.holdings)
    }
    const point = valuation(combined, accounts, asset, from, scopes)
    cache.set(asOf, point)
    return point
  }
  const events = endingState.events.filter((event) => event.timestamp > from && event.timestamp <= through)
  const byId = new Map(events.map((event) => [event.economicId, event]))
  const entries = endingState.ledger.filter((entry) => entry.asset === asset && byId.has(entry.eventId))
  const postedIds = new Set(entries.map((entry) => entry.eventId))
  const posted = events.filter((event) => event.asset === asset && postedIds.has(event.economicId))
  const flows = new Map<string, Decimal>()
  const unclassifiedFlowTimes: string[] = []
  for (const event of posted) {
    if (!['deposit', 'withdrawal'].includes(event.type)) continue
    if (event.sources.some((source) => 'providerAccountId' in source)) { unclassifiedFlowTimes.push(event.timestamp); continue }
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
    return { timestamp, flow: flow.toFixed(), before: before.value, after: after.value,
      beforeQuality: before.valuationQuality, afterQuality: after.valuationQuality, valid }
  })
  type Point = ReturnType<typeof valuation>
  const qualityFor = (first: Point, last: Point, includeBoundaries: boolean) =>
    first.valuationQuality === 'carry_forward_reference_estimate' || last.valuationQuality === 'carry_forward_reference_estimate'
      || (includeBoundaries && boundaries.some((boundary) => boundary.timestamp > first.asOf && boundary.timestamp <= last.asOf
        && (boundary.beforeQuality === 'carry_forward_reference_estimate' || boundary.afterQuality === 'carry_forward_reference_estimate')))
      ? 'carry_forward_reference_estimate' as const : 'reconstructed_selected_value' as const
  const returnBetween = (first: Point, last: Point) => {
    if (unclassifiedFlowTimes.some((time) => time > first.asOf && time <= last.asOf)
      || !first.returnEligible || !last.returnEligible || first.value === null || last.value === null) return null
    let base = first.value
    const subperiods = []
    for (const boundary of boundaries) {
      if (boundary.timestamp <= first.asOf) continue
      if (boundary.timestamp > last.asOf) break
      if (!boundary.valid || boundary.before === null || boundary.after === null) return null
      subperiods.push({ opening: base, closing: boundary.before })
      base = boundary.after
    }
    return linkedReturn([...subperiods, { opening: base, closing: last.value }])
  }
  const returnTo = (point: Point) => returnBetween(opening, point)
  const points = [opening]
  for (let midnight = Math.floor(start / dayMs) * dayMs + dayMs - 1; midnight < end; midnight += dayMs) {
    if (midnight > start) points.push(at(new Date(midnight).toISOString()))
  }
  if (end !== start) points.push(ending)
  const qualityMetric = (value: Decimal | null, reason: string, quality: string) => ({
    ...metric(value, reason), quality: value === null ? 'unavailable' : quality,
  })
  const periodFlows = (first: Point, last: Point) => boundaries
    .filter(({ timestamp }) => timestamp > first.asOf && timestamp <= last.asOf)
    .reduce((total, boundary) => total.plus(boundary.flow), decimal(0))
  function isCalendarBoundary(point: Point, frequency: 'daily' | 'weekly' | 'monthly') {
    const date = new Date(point.asOf)
    if (date.getTime() % dayMs !== dayMs - 1) return false
    return frequency === 'daily' || (frequency === 'weekly' ? date.getUTCDay() === 0
      : new Date(date.getTime() + 1).getUTCDate() === 1)
  }
  function periodic(frequency: 'daily' | 'weekly' | 'monthly') {
    const grid = points.filter((point, index) => index === 0 || index === points.length - 1 || isCalendarBoundary(point, frequency))
    return grid.slice(1).map((last, index) => {
      const first = grid[index]!
      return { from: first.asOf, through: last.asOf, openingValue: first.value, endingValue: last.value,
        partial: !isCalendarBoundary(first, frequency) || !isCalendarBoundary(last, frequency),
        knownNetExternalFlows: periodFlows(first, last).toFixed(),
        twr: qualityMetric(returnBetween(first, last), 'coverage_value_or_flow_boundary_missing', qualityFor(first, last, true)) }
    })
  }
  const indices = points.map((point) => returnTo(point)?.plus(1).mul(100).toFixed() ?? null)
  const dailyReturns = points.map((point, index) => {
    const prior = points[index - 1]
    const previous = indices[index - 1]
    const current = indices[index]
    return prior && Date.parse(point.asOf) - Date.parse(prior.asOf) === dayMs
      && previous != null && current != null && decimal(previous).gt(0)
      ? decimal(current).div(previous).minus(1).toFixed() : null
  })
  const sampledQuality = points.some((point) => qualityFor(opening, point, true) === 'carry_forward_reference_estimate')
    ? 'carry_forward_reference_estimate' : 'reconstructed_selected_value'
  const risk = indices.length >= 2 && indices.every((point) => point !== null) ? drawdowns(indices as string[]) : null
  const eligibleBridge = opening.returnEligible && ending.returnEligible && unclassifiedFlowTimes.length === 0
    && opening.value !== null && ending.value !== null
  const pnl = eligibleBridge ? decimal(ending.value!).minus(opening.value!).minus(netFlows) : null
  const attribution = new Map<string, Decimal>()
  const activities = new Map<string, Decimal>()
  const instrumentKey = (venue: string, account: string, instrument: string) => JSON.stringify([venue, account, instrument])
  for (const entry of entries) {
    if (entry.realized === null) continue
    const event = byId.get(entry.eventId)!
    const key = instrumentKey(event.venue, event.account, entry.instrument ?? event.instrument ?? 'unallocated')
    attribution.set(key, (attribution.get(key) ?? decimal(0)).plus(entry.realized))
    activities.set(event.type, (activities.get(event.type) ?? decimal(0)).plus(entry.realized))
  }
  const unrealizedByInstrument = new Map<string, { opening?: Decimal; ending?: Decimal }>()
  const marksMissing = new Set<string>()
  const uncertaintyByAccount = (state: Replay, venue: string, account: string) =>
    state.discrepancies.some(({ scope }) => scope.account === account && scope.venue === venue
      && (scope.asset === asset || scope.asset === 'UNKNOWN'))
  for (const [state, side] of [[initialState, 'opening'], [endingState, 'ending']] as const) {
    for (const holding of state.holdings) {
      if (holding.asset !== asset) continue
      const key = instrumentKey(holding.venue, holding.account, holding.instrument)
      if (holding.unrealized === null && (!decimal(holding.quantity).isZero() || uncertaintyByAccount(state, holding.venue, holding.account))) {
        marksMissing.add(key)
        continue
      }
      const values = unrealizedByInstrument.get(key) ?? {}
      values[side] = decimal(holding.unrealized ?? 0)
      unrealizedByInstrument.set(key, values)
    }
  }
  const unrealizedChange = new Map<string, Decimal>()
  for (const [key, values] of unrealizedByInstrument) {
    const [venue, account] = JSON.parse(key) as [string, string, string]
    if (marksMissing.has(key)) continue
    // Missing position can only stand for zero when that endpoint has a usable declared account state.
    const usable = (state: Replay) => state.cash.some((bucket) => bucket.venue === venue && bucket.account === account
      && bucket.asset === asset && bucket.openingInventoryAt !== null) && !uncertaintyByAccount(state, venue, account)
    if ((!values.opening && !usable(initialState)) || (!values.ending && !usable(endingState))) continue
    unrealizedChange.set(key, (values.ending ?? decimal(0)).minus(values.opening ?? 0))
  }
  const knownUnrealizedChange = sum([...unrealizedChange.values()].map((value) => value.toFixed()))
  const mwr = eligibleBridge && decimal(opening.value!).gt(0) ? annualizedMoneyWeightedReturn([
    { timestamp: from, amount: decimal(opening.value!).neg().toFixed() },
    ...boundaries.map((boundary) => ({ timestamp: boundary.timestamp, amount: decimal(boundary.flow).neg().toFixed() })),
    { timestamp: through, amount: ending.value! },
  ]) : null
  const realized = sum([...attribution.values()].map((amount) => amount.toFixed()))
  const eligibleTrades = posted.filter((event) => event.type === 'buy' || event.type === 'sell')
  const postedFeeRows = entries.flatMap((entry) => entry.feeEffect
    ? [{ ...entry.feeEffect, eventId: entry.eventId, timestamp: byId.get(entry.eventId)!.timestamp,
      venue: byId.get(entry.eventId)!.venue, account: byId.get(entry.eventId)!.account }] : [])
  const feeSum = (rows: typeof postedFeeRows, kind: 'execution' | 'standalone' | 'funding', negative: boolean) => sum(rows
    .filter((row) => row.kind === kind && row.amount !== null && (negative ? decimal(row.amount).lt(0) : decimal(row.amount).gte(0)))
    .map((row) => decimal(row.amount!).abs().toFixed()))
  const notional = (trades: typeof eligibleTrades) =>
    trades.reduce((total, event) => total.plus(decimal(event.quantity!).mul(event.price!)), decimal(0))
  function feeSummary(rows: typeof postedFeeRows) {
    const charges = feeSum(rows, 'execution', false)
    const rebates = feeSum(rows, 'execution', true)
    return { grossExecutionCharges: charges.toFixed(), executionRebates: rebates.toFixed(),
      netExecutionFees: charges.minus(rebates).toFixed(), standaloneCharges: feeSum(rows, 'standalone', false).toFixed(),
      standaloneRebates: feeSum(rows, 'standalone', true).toFixed(), fundingCharges: feeSum(rows, 'funding', false).toFixed(),
      fundingRebates: feeSum(rows, 'funding', true).toFixed(), unknownEffects: rows.filter((row) => row.amount === null).length,
      observedZeroEffects: rows.filter((row) => row.amount === '0').length }
  }
  function tradeSummary(trades: typeof eligibleTrades) {
    const buys = trades.filter((event) => event.type === 'buy')
    const sells = trades.filter((event) => event.type === 'sell')
    const gross = notional(trades)
    return { fills: trades.length, buys: buys.length, sells: sells.length,
      buyNotional: notional(buys).toFixed(), sellNotional: notional(sells).toFixed(), grossNotional: gross.toFixed(),
      averageExecutionNotional: trades.length === 0 ? null : gross.div(trades.length).toFixed() }
  }
  function groupActivity<Row extends { venue: string; account: string }, Total>(rows: Row[], summarize: (rows: Row[]) => Total) {
    const groups = new Map<string, { venue: string; account: string; rows: Row[] }>()
    for (const row of rows) {
      const key = JSON.stringify([row.venue, row.account])
      const group = groups.get(key) ?? { venue: row.venue, account: row.account, rows: [] }
      group.rows.push(row)
      groups.set(key, group)
    }
    return [...groups.values()].map(({ venue, account, rows }) => ({ venue, account, totals: summarize(rows) }))
  }
  const periodicSeries = (frequency: 'daily' | 'weekly' | 'monthly') => periodic(frequency).map((point) => {
    const within = ({ timestamp }: { timestamp: string }) => timestamp > point.from && timestamp <= point.through
    const trades = eligibleTrades.filter(within)
    return { ...point, trading: tradeSummary(trades), fees: feeSummary(postedFeeRows.filter(within)) }
  })
  const executionByTrade = new Map(postedFeeRows.filter((row) => row.kind === 'execution').map((row) => [row.eventId, row.amount]))
  const compatibleFees = eligibleTrades.map((event) => executionByTrade.get(event.economicId))
  const compatibleNotional = notional(eligibleTrades)
  const feeToNotional = compatibleNotional.gt(0) && compatibleFees.every((fee) => fee != null)
    ? sum(compatibleFees).div(compatibleNotional) : null
  const feeRows = postedFeeRows
  const executionCharges = feeSum(feeRows, 'execution', false)
  const executionRebates = feeSum(feeRows, 'execution', true)
  const exits = entries.filter((entry) => byId.get(entry.eventId)?.type === 'sell' && entry.realized !== null)
  const gains = sum(exits.filter((entry) => decimal(entry.realized!).gt(0)).map((entry) => entry.realized!))
  const losses = sum(exits.filter((entry) => decimal(entry.realized!).lt(0)).map((entry) => entry.realized!)).abs()
  const wins = exits.filter((entry) => decimal(entry.realized!).gt(0)).length
  return {
    methodology: { valuation: 'selected_accounting_evidence', return: 'cash_flow_boundary_twr', time: 'UTC', drawdown: 'flow_adjusted_sampled_index' },
    opening, ending, unclassifiedFlowTimes, anchors: requestedCutoffs.map(at), cashFlowBoundaries: boundaries, work: { replays: replayCount, inputRowsReplayed: replayWork },
    bridge: {
      valueChange: qualityMetric(opening.value !== null && ending.value !== null ? decimal(ending.value).minus(opening.value) : null, 'valuation_missing', qualityFor(opening, ending, false)),
      knownNetContributions: netFlows.toFixed(),
      netInvestmentGain: qualityMetric(pnl, 'coverage_or_cash_flow_classification_missing', qualityFor(opening, ending, false)),
    },
    returns: { twr: qualityMetric(returnTo(ending), 'coverage_value_or_flow_boundary_missing', qualityFor(opening, ending, true)),
      annualizedMwr: qualityMetric(mwr, 'eligible_cash_flow_schedule_or_unique_bounded_root_missing', qualityFor(opening, ending, false)),
      annualizedVolatility: qualityMetric(dailyVolatility(points.map((point, index) => ({ asOf: point.asOf, index: indices[index] ?? null }))),
        'eligible_daily_return_series_missing', sampledQuality),
      maximumDrawdown: qualityMetric(risk ? decimal(risk.maximum) : null, 'eligible_index_series_missing', sampledQuality),
      indexCoverage: indices.every((value) => value !== null) ? 'complete_sample_grid' :
        indices.some((value) => value !== null) ? 'gapped_sample_grid' : 'unavailable',
      drawdownEpisode: risk?.episode ? { peak: points[risk.episode.peakIndex]!.asOf, trough: points[risk.episode.troughIndex]!.asOf,
        recovery: risk.episode.recoveryIndex === null ? null : points[risk.episode.recoveryIndex]!.asOf } : null,
      twrValuationBasis: 'reconstructed_selected_values_and_eligible_reference_marks' },
    periodicReturns: { daily: periodicSeries('daily'), weekly: periodicSeries('weekly'), monthly: periodicSeries('monthly') },
    history: points.map((point, index) => {
      const knownFlows = periodFlows(opening, point)
      return { ...point, returnIndex: indices[index], dailyReturn: dailyReturns[index], drawdown: risk?.series[index] ?? null,
        indexQuality: indices[index] === null ? 'unavailable' : qualityFor(opening, point, true),
        knownCumulativeNetContributions: knownFlows.toFixed(),
        knownIntervalExternalFlows: index === 0 ? null : periodFlows(points[index - 1]!, point).toFixed(),
        investmentGainSinceOpening: opening.returnEligible && point.returnEligible && opening.value !== null && point.value !== null
          && !unclassifiedFlowTimes.some((time) => time <= point.asOf) ? decimal(point.value).minus(opening.value).minus(knownFlows).toFixed() : null }
    }),
    attribution: { scope: 'known_posted_and_marked_components', knownRealized: realized.toFixed(),
      knownUnrealizedChange: knownUnrealizedChange.toFixed(),
      unrealizedAvailability: [...new Set([...unrealizedByInstrument.keys(), ...marksMissing])]
        .every((key) => unrealizedChange.has(key)) && eligibleBridge ? 'complete_for_selected_evidence' : 'partial',
      unavailableUnrealizedInstruments: [...new Set([...unrealizedByInstrument.keys(), ...marksMissing])]
        .filter((key) => !unrealizedChange.has(key)).length,
      instruments: [...new Set([...attribution.keys(), ...unrealizedByInstrument.keys(), ...marksMissing])].map((identity) => {
        const [venue, account, instrument] = JSON.parse(identity) as [string, string, string]
        return { identity, venue, account, instrument, knownRealized: attribution.get(identity)?.toFixed() ?? null,
          knownUnrealizedChange: unrealizedChange.get(identity)?.toFixed() ?? null }
      }),
      byActivity: [...activities].map(([type, amount]) => ({ type, knownRealized: amount.toFixed() })),
      unattributedResidual: pnl?.minus(realized).minus(knownUnrealizedChange).toFixed() ?? null },
    fees: { asset, ...feeSummary(feeRows), byAccount: groupActivity(feeRows, feeSummary), coverage: 'known_posted_components' },
    trading: { knownRealizedExitFills: exits.length, winningExitFills: wins,
      lossExitFills: exits.filter((entry) => decimal(entry.realized!).lt(0)).length,
      exitWinRate: metric(exits.length ? decimal(wins).div(exits.length) : null, 'no_known_realized_exits'),
      exitProfitFactor: metric(losses.gt(0) ? gains.div(losses) : null, 'no_known_gross_exit_loss'),
      ...tradeSummary(eligibleTrades),
      byAccount: groupActivity(eligibleTrades, tradeSummary),
      netExecutionFeeToNotional: metric(feeToNotional, 'compatible_posted_fees_or_notional_missing'),
      grossRealizedExitGains: gains.toFixed(), grossRealizedExitLosses: losses.toFixed(),
      attachedFeeObservations: feeRows.filter((row) => row.kind === 'execution' && row.amount !== null).length,
      missingAttachedFees: feeRows.filter((row) => row.kind === 'execution' && row.amount === null).length,
      knownAttachedFees: executionCharges.minus(executionRebates).toFixed(),
      knownStandaloneFees: feeSum(feeRows, 'standalone', false).toFixed(),
      knownStandaloneRebates: feeSum(feeRows, 'standalone', true).toFixed(),
      feeScope: 'posted_fee_effects_in_selected_asset' },
  }
}

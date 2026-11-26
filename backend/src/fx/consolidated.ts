import { Decimal } from 'decimal.js'
import { analyzePerformance, drawdowns, linkedReturn } from '../analytics/performance.js'
import type { Evidence } from '../accounting/model.js'
import { reportAmounts, type FxMode, type FxOptions, type loadFx } from './reference.js'

type Rates = Awaited<ReturnType<typeof loadFx>>
const D = Decimal.clone({ precision: 60 })
const scope = ({ venue, account }: { venue: string; account: string }) => JSON.stringify([venue, account])

export function consolidatePerformance(evidence: Evidence[], rates: Rates, assets: string[], currency: string,
  from: string, through: string, mode: FxMode, unsupportedScope = false, financialKnown = (_time: string) => true, preference: FxOptions = {}, financialPeriodKnown = financialKnown,
  replay?: { cutoffs: string[]; assumedUsdPerUnit?: Partial<Record<'USDC' | 'PUSD', string>> | undefined;
    projectAt?: NonNullable<Parameters<typeof analyzePerformance>[7]>; mixedFlowTimes?: Set<string> }) {
  const times = [...new Set(evidence.filter(({ observation }) => ['deposit', 'withdrawal'].includes(observation.type)
    && observation.timestamp > from && observation.timestamp <= through).map(({ observation }) => observation.timestamp))].sort()
  if (times.length * assets.length > 1200) throw new Error('analytics_replay_limit')
  const before = (time: string) => new Date(Date.parse(time) - 1).toISOString()
  const native = assets.map((asset) => {
    const scopes = [...new Map(evidence.filter(({ observation }) => observation.asset === asset)
      .map(({ observation }) => [scope(observation), { venue: observation.venue, account: observation.account }])).values()]
    const data = analyzePerformance(evidence, [...new Set(scopes.map((item) => item.account))], asset, from, through, scopes,
      [...new Set([...times.flatMap((time) => [before(time), time]), ...(replay?.cutoffs ?? [])])], replay?.projectAt)
    return { asset, data, points: new Map([...data.history, ...data.anchors].map((value) => [value.asOf, value])) }
  })
  const at = (time: string) => {
    const points = native.map(({ asset, points }) => ({ asset, point: financialKnown(time) ? points.get(time) : undefined }))
    const completeFinancial = !unsupportedScope && points.length > 0 && points.every(({ point }) => point?.value != null)
    const amounts = reportAmounts(rates, points.map(({ asset, point }) => ({ asset, value: point?.value ?? point?.knownValue ?? null })), currency, time, { ...preference, mode }, replay?.assumedUsdPerUnit)
    return { asOf: time, ...amounts, completeValue: completeFinancial ? amounts.completeValue : null,
      financialCoverage: completeFinancial ? 'selected_complete' : 'partial_or_unavailable',
      fxCoverage: points.length && amounts.components.every((item) => item.reportingValue !== null) ? 'eligible' : 'partial_or_unavailable',
      eligible: completeFinancial && amounts.completeValue !== null && points.every(({ point }) => point?.returnEligible) }
  }
  const flows = times.map((time) => {
    const contributions = !financialKnown(time) ? [] : native.flatMap(({ asset, data }) => data.cashFlowBoundaries.filter((row) => row.timestamp === time)
      .map((row) => ({ asset, value: row.flow, valid: row.valid })))
    const known = reportAmounts(rates, contributions, currency, time, { ...preference, mode }, replay?.assumedUsdPerUnit)
    const prior = at(before(time)); const after = at(time)
    return { timestamp: time, before: prior, after, contributions, converted: known,
      valid: !replay?.mixedFlowTimes?.has(time) && contributions.length > 0 && contributions.every((item) => item.valid)
        && prior.components.every((item, index) => item.value === '0'
          || item.reference.rate === after.components[index]?.reference.rate)
        && prior.eligible && after.eligible && known.completeValue !== null }
  })
  const opening = at(from)
  const grid = [...new Set([...(native[0]?.data.history ?? []).map(({ asOf }) => asOf), ...(replay?.cutoffs ?? [])])].sort()
  const history = grid.map((asOf) => {
    const point = at(asOf)
    const localFlows = flows.filter((flow) => flow.timestamp <= asOf)
    const eligible = financialPeriodKnown(asOf) && opening.eligible && point.eligible && localFlows.every((flow) => flow.valid)
      && native.every(({ data }) => !data.unclassifiedFlowTimes.some((time) => time <= asOf))
    const spans: Array<{ opening: string; closing: string }> = []
    let initial = opening.completeValue
    if (eligible) {
      for (const flow of localFlows) {
        spans.push({ opening: initial!, closing: flow.before.completeValue! })
        initial = flow.after.completeValue
      }
      spans.push({ opening: initial!, closing: point.completeValue! })
    }
    const twr = eligible ? linkedReturn(spans)?.toFixed() ?? null : null
    return { ...point, twr, index: twr === null ? null : new D(twr).plus(1).toFixed() }
  })
  const sampled = history.length && history.every((point) => point.index !== null) ? drawdowns(history.map((point) => point.index!)) : null
  const ending = history.at(-1)
  return { currency, evidenceMode: mode, ...(mode === 'knowledge' ? { financialKnowledge: 'conservative_current_evidence_only' } : {}), methodology: 'consolidated_cash_flow_boundary_twr', opening, ending: ending ?? null,
    twr: ending?.twr ?? null, maximumDrawdown: sampled?.maximum ?? null, cashFlowBoundaries: flows,
    history: history.map((item, index) => ({ ...item, drawdown: sampled?.series[index] ?? null })),
    native: mode === 'knowledge' && !financialPeriodKnown(through) ? [] : native.map(({ asset, data }) => ({ asset, opening: data.opening, ending: data.ending, returns: data.returns })) }
}

import { Decimal } from 'decimal.js'
import { drawdowns, linkedReturn, type analyzePerformance } from '../analytics/performance.js'
import { selectRate, type loadFx } from './reference.js'

type Data = ReturnType<typeof analyzePerformance>

export function reportingPerformance(rows: Awaited<ReturnType<typeof loadFx>>, data: Data, asset: string, currency: string) {
  const d = Decimal.clone({ precision: 60 })
  const convert = (value: string | null, at: string) => {
    const reference = selectRate(rows, asset, currency, at)
    return { reference, value: value === null || reference.rate === null ? null : new d(value).mul(reference.rate).toFixed() }
  }
  const opening = convert(data.opening.value, data.opening.asOf)
  const flows = data.cashFlowBoundaries.map((boundary) => {
    const before = convert(boundary.before, new Date(Date.parse(boundary.timestamp) - 1).toISOString())
    const after = convert(boundary.after, boundary.timestamp)
    const flow = convert(boundary.flow, boundary.timestamp)
    return { asOf: boundary.timestamp, before, after, flow,
      eligible: boundary.valid && before.value !== null && after.value !== null && flow.value !== null
        && before.reference.rate === after.reference.rate }
  })
  const history = data.history.map((point) => {
    const result = convert(point.value, point.asOf)
    const active = flows.filter((flow) => flow.asOf <= point.asOf)
    const comparable = opening.value !== null && result.value !== null && point.returnIndex !== null
      && active.every((flow) => flow.eligible)
    let base = opening.value
    const periods: Array<{ opening: string; closing: string }> = []
    if (comparable) {
      for (const flow of active) {
        periods.push({ opening: base!, closing: flow.before.value! })
        base = flow.after.value
      }
      periods.push({ opening: base!, closing: result.value! })
    }
    const twr = comparable ? linkedReturn(periods)?.toFixed() ?? null : null
    return { asOf: point.asOf, ...result, twr, index: twr === null ? null : new d(1).plus(twr).toFixed() }
  })
  const last = history.at(-1)
  const completeIndex = history.length > 0 && history.every((point) => point.index !== null)
  const drawdown = completeIndex ? drawdowns(history.map((point) => point.index!)) : null
  const netFlows = flows.every((flow) => flow.flow.value !== null)
    ? flows.reduce((sum, flow) => sum.plus(flow.flow.value!), new d(0)) : null
  const gain = data.bridge.netInvestmentGain.value !== null && opening.value !== null && last?.value != null && netFlows !== null
    ? new d(last.value).minus(opening.value).minus(netFlows).toFixed() : null
  return { asset, currency, methodology: 'point_in_time_reference', opening, ending: last ?? null, cashFlowBoundaries: flows,
    netInvestmentGain: gain, twr: last?.twr ?? null, maximumDrawdown: drawdown?.maximum ?? null, history }
}

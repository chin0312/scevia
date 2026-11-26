/* Analytical read models for Analytics and Risk, shaped like the backend's Phase 4 contracts (backend/src/analytics/
   contracts.ts): quality-labelled metrics that carry an availability and a reason instead of a default, flow-adjusted
   index and drawdown history, calendar-period returns, trade cohorts, concentration (HHI, effective exposures, top-N
   shares), same-path settlement contributions and resolution buckets.

   In this build they are computed from the bundled read model (lib/finance.ts) and only from what it actually holds:
   weekly valuation snapshots, closed trades and open positions. At Phase 10 the backend's performance and exposure
   responses replace the adapters below (`performanceFromSeries`, `concentration`, `worstPathContributions`,
   `resolutionBuckets`); the presentation reads the same shapes. Nothing here is a second ledger: every input is an
   existing figure, and anything that needs evidence this build doesn't have (daily values, dated investor flows,
   orderbooks) is reported unavailable with its reason. */
import type { ClosedTrade } from '../data/types'
import { daysBetween, isResolved, tradeNet, type EventExposure, type Outcome, type SeriesPoint } from './finance'

const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)

/* ───────────── Quality-labelled metrics ───────────── */
export type MetricQuality = 'reconstructed' | 'estimate' | 'unavailable'
export interface QualityMetric { value: number | null; availability: 'calculated' | 'unavailable'; reason: string | null; quality: MetricQuality }
const ok = (value: number, quality: MetricQuality = 'estimate'): QualityMetric => ({ value, availability: 'calculated', reason: null, quality })
const na = (reason: string): QualityMetric => ({ value: null, availability: 'unavailable', reason, quality: 'unavailable' })

export interface IndexPoint { date: string; index: number | null; drawdown: number | null }
export interface PeriodReturn { period: string; value: number | null; partial: boolean }
export interface PerformanceReadModel {
  sampling: 'daily' | 'weekly'
  twr: QualityMetric; annualizedMwr: QualityMetric; annualizedVolatility: QualityMetric; maximumDrawdown: QualityMetric
  /** Flow-adjusted index (start = 1) and drawdown from its prior peak at each sampled date. */
  index: IndexPoint[]
  monthly: PeriodReturn[]
}

/** Flow-adjusted returns from sampled valuations. Each interval's return is (closing value − net external flow) ÷
 *  opening value − 1, so a deposit is never a gain. With weekly snapshots the flow is assumed at the interval end,
 *  which makes this an estimate; the backend uses values immediately before and after each flow. An interval with a
 *  nonpositive opening value breaks the chain: everything after it is unavailable, never patched. */
export function performanceFromSeries(pts: SeriesPoint[], sampling: 'daily' | 'weekly' = 'weekly'): PerformanceReadModel {
  const index: IndexPoint[] = []
  const intervals: { end: string; r: number | null }[] = []
  let idx: number | null = pts.length ? 1 : null, peak = 1, broken = false
  pts.forEach((p, i) => {
    if (i > 0) {
      const prev = pts[i - 1], flow = p.deposits - prev.deposits
      const r = !broken && prev.value > 0 ? (p.value - flow) / prev.value - 1 : null
      if (r == null) broken = true
      intervals.push({ end: p.date, r })
      idx = r == null || idx == null ? null : idx * (1 + r)
    }
    if (idx != null) peak = Math.max(peak, idx)
    index.push({ date: p.date, index: idx, drawdown: idx == null ? null : idx / peak - 1 })
  })
  const last = index.at(-1)?.index ?? null
  const dds = index.map((x) => x.drawdown).filter((x): x is number => x != null)
  const short = pts.length < 2
  const monthsMap = new Map<string, (number | null)[]>()
  for (const iv of intervals) { const m = iv.end.slice(0, 7); monthsMap.set(m, [...(monthsMap.get(m) ?? []), iv.r]) }
  const keys = [...monthsMap.keys()]
  const monthly: PeriodReturn[] = keys.map((m, i) => {
    const rs = monthsMap.get(m)!
    const value = rs.some((r) => r == null) ? null : rs.reduce<number>((a, r) => a * (1 + (r as number)), 1) - 1
    return { period: m, value, partial: i === 0 || i === keys.length - 1 }
  })
  return {
    sampling,
    twr: short ? na('Needs at least two valuations in the period') : last == null ? na('A valuation in the period is zero or negative, so the return chain breaks') : ok(last - 1),
    annualizedMwr: na('Needs dated investor cash flows from the accounting service'),
    annualizedVolatility: sampling === 'daily' && !broken && intervals.length >= 2 ? ok(stdev(intervals.map((x) => x.r as number)) * Math.sqrt(365)) : na(sampling === 'daily' ? 'Needs two or more complete daily intervals' : 'Needs daily valuations'),
    maximumDrawdown: short ? na('Needs at least two valuations in the period') : dds.length < 2 ? na('A valuation in the period is zero or negative, so the return chain breaks') : ok(Math.min(0, ...dds)),
    index, monthly,
  }
}
function stdev(xs: number[]) {
  const m = sum(xs, (x) => x) / xs.length
  return Math.sqrt(sum(xs, (x) => (x - m) ** 2) / (xs.length - 1))
}

/* ───────────── Trade cohorts ───────────── */
export const COHORT_DIMS = ['Entry price', 'Side', 'Category', 'Platform', 'Holding period', 'Position size', 'Exit type'] as const
export type CohortDim = (typeof COHORT_DIMS)[number]
export interface Cohort {
  key: string; label: string; trades: ClosedTrade[]
  /** Closed trades in the cohort; resolved = settled at $1 or $0 (exits before resolution excluded). */
  n: number; resolved: number; wins: number; winRate: number | null
  net: number; fees: number; notional: number
  /** Net P&L ÷ entry notional (shares × entry price). */
  returnOnEntry: number | null
  avgGain: number | null; avgLoss: number | null
  /** Entry-price cohorts only: the average entry price of resolved trades (the market's price, not a forecast). */
  impliedWinRate: number | null
}
const ENTRY: [number, number][] = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0001]]
const HOLD: [number, number, string][] = [[0, 7, 'Under 7 days'], [7, 31, '7 to 30 days'], [31, 91, '31 to 90 days'], [91, Infinity, 'Over 90 days']]
const SIZE: [number, number, string][] = [[0, 250, 'Under $250'], [250, 1000, '$250 to $1,000'], [1000, 5000, '$1,000 to $5,000'], [5000, Infinity, 'Over $5,000']]
export const notionalOf = (t: ClosedTrade) => t.shares * t.entry
export const holdingDays = (t: ClosedTrade) => Math.max(0, daysBetween(t.opened, t.closed))

function keyOf(t: ClosedTrade, d: CohortDim): [string, string, number] {
  switch (d) {
    case 'Entry price': { const i = ENTRY.findIndex(([lo, hi]) => t.entry >= lo && t.entry < hi); const [lo, hi] = ENTRY[i]; return [String(i), `$${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}`, i] }
    case 'Side': return [t.side, t.side, t.side === 'YES' ? 0 : 1]
    case 'Category': return [t.category, t.category, 0]
    case 'Platform': return [t.platform, t.platform === 'pm' ? 'Polymarket' : 'Kalshi', t.platform === 'pm' ? 0 : 1]
    case 'Holding period': { const h = holdingDays(t), i = HOLD.findIndex(([lo, hi]) => h >= lo && h < hi); return [String(i), HOLD[i][2], i] }
    case 'Position size': { const v = notionalOf(t), i = SIZE.findIndex(([lo, hi]) => v >= lo && v < hi); return [String(i), SIZE[i][2], i] }
    case 'Exit type': return [t.outcome, t.outcome === 'Closed early' ? 'Sold before resolution' : t.outcome === 'Won' ? 'Resolved in your favour' : 'Resolved against you', ['Won', 'Lost', 'Closed early'].indexOf(t.outcome)]
  }
}
export function cohorts(trades: ClosedTrade[], d: CohortDim): Cohort[] {
  const groups = new Map<string, { label: string; order: number; trades: ClosedTrade[] }>()
  for (const t of trades) { const [k, label, order] = keyOf(t, d); const g = groups.get(k) ?? { label, order, trades: [] }; g.trades.push(t); groups.set(k, g) }
  const out = [...groups.entries()].map(([key, g]): Cohort => {
    const ts = g.trades, rs = ts.filter(isResolved), wins = rs.filter((t) => t.outcome === 'Won').length
    const nets = ts.map(tradeNet), gains = nets.filter((x) => x > 0), losses = nets.filter((x) => x < 0)
    const notional = sum(ts, notionalOf), net = sum(nets, (x) => x)
    return {
      key, label: g.label, trades: ts, n: ts.length, resolved: rs.length, wins, winRate: rs.length ? wins / rs.length : null,
      net, fees: sum(ts, (t) => t.fees), notional, returnOnEntry: notional > 0 ? net / notional : null,
      avgGain: gains.length ? sum(gains, (x) => x) / gains.length : null, avgLoss: losses.length ? sum(losses, (x) => x) / losses.length : null,
      impliedWinRate: d === 'Entry price' && rs.length ? sum(rs, (t) => t.entry) / rs.length : null,
    }
  })
  const order = new Map([...groups.entries()].map(([k, g]) => [k, g.order]))
  return d === 'Category' ? out.sort((a, b) => b.net - a.net) : out.sort((a, b) => order.get(a.key)! - order.get(b.key)!)
}

/* ───────────── Trade analysis ───────────── */
export const RETURN_BINS: [number, number, string][] = [[-Infinity, -0.5, 'Below −50%'], [-0.5, -0.1, '−50% to −10%'], [-0.1, 0.1, '−10% to +10%'], [0.1, 0.5, '+10% to +50%'], [0.5, 1, '+50% to +100%'], [1, Infinity, 'Above +100%']]
export function returnDistribution(trades: ClosedTrade[]) {
  const rets = trades.flatMap((t) => (notionalOf(t) > 0 ? [{ t, r: tradeNet(t) / notionalOf(t) }] : []))
  return { excluded: trades.length - rets.length, bins: RETURN_BINS.map(([lo, hi, label]) => { const ts = rets.filter((x) => x.r >= lo && x.r < hi).map((x) => x.t); return { label, n: ts.length, net: sum(ts, tradeNet), trades: ts } }) }
}
export function activityByMonth(trades: ClosedTrade[]) {
  const m = new Map<string, ClosedTrade[]>()
  for (const t of trades) { const k = t.closed.slice(0, 7); m.set(k, [...(m.get(k) ?? []), t]) }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, ts]) => ({ month, n: ts.length, notional: sum(ts, notionalOf), fees: sum(ts, (t) => t.fees), net: sum(ts, tradeNet), trades: ts }))
}
export function byMarket(trades: ClosedTrade[]) {
  const m = new Map<string, ClosedTrade[]>()
  for (const t of trades) m.set(t.market, [...(m.get(t.market) ?? []), t])
  return [...m.entries()].map(([market, ts]) => ({ market, n: ts.length, net: sum(ts, tradeNet), fees: sum(ts, (t) => t.fees), trades: ts })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
}
/** Fees ÷ entry notional. Unavailable when any fee is an estimate the source didn't report, or there's no notional. */
export function feeBurden(trades: ClosedTrade[]): QualityMetric {
  const notional = sum(trades, notionalOf)
  if (!trades.length || notional <= 0) return na('No closed trades in this period')
  const v = sum(trades, (t) => t.fees) / notional
  return trades.some((t) => !t.feeKnown) ? { ...ok(v), quality: 'estimate', reason: 'Includes estimated fees' } : ok(v, 'reconstructed')
}

/* ───────────── Concentration ───────────── */
export interface Concentration { denominator: number; hhi: number; effective: number; top: { count: number; weight: number }[]; missing: number }
/** HHI over positive known values (missing values are counted, never treated as zero), the effective number of
 *  exposures (1 ÷ HHI) and top-N shares. Effective exposures aren't independent risks: it's only a size spread. */
export function concentration(rows: { value: number | null }[], tops = [1, 3, 5]): Concentration | null {
  const known = rows.map((r) => r.value).filter((v): v is number => v != null && v > 0)
  const denominator = sum(known, (v) => v)
  if (!known.length || denominator <= 0) return null
  const w = known.map((v) => v / denominator).sort((a, b) => b - a)
  const hhi = sum(w, (x) => x * x)
  return { denominator, hhi, effective: 1 / hhi, top: tops.map((n) => ({ count: n, weight: sum(w.slice(0, n), (x) => x) })), missing: rows.length - known.length }
}

/* ───────────── Settlement ───────────── */
/** Each event's settlement P&L under one joint outcome (the portfolio's worst or best feasible path). The
 *  contributions add up to that path's total; they're never each event's own worst case. */
export function pathContributions(exps: EventExposure[], path: Record<string, Outcome>) {
  return exps.filter((e) => path[e.event.id]).map((e) => ({ e, outcome: path[e.event.id], pnl: e.pnl[path[e.event.id]] })).sort((a, b) => a.pnl - b.pnl)
}

/* ───────────── Resolution timing ───────────── */
export const TIMING_BUCKETS = ['Overdue', 'Within 30 days', '31 to 90 days', '91 to 365 days', 'Later', 'No date'] as const
/** Capital committed by scheduled resolution date. Overdue: the scheduled date has passed and the market isn't
 *  settled in the data. A schedule says nothing about when cash becomes available. */
export function resolutionBuckets(exps: EventExposure[], today: string) {
  const bucket = (e: EventExposure) => {
    if (!e.resolves) return 'No date'
    const d = daysBetween(today, e.resolves)
    return d < 0 ? 'Overdue' : d <= 30 ? 'Within 30 days' : d <= 90 ? '31 to 90 days' : d <= 365 ? '91 to 365 days' : 'Later'
  }
  return TIMING_BUCKETS.map((label) => { const es = exps.filter((e) => bucket(e) === label); return { label, n: es.length, cost: sum(es, (e) => e.cost), exps: es } })
}

/** Gross payout, settlement P&L against cost and change from current value for the whole portfolio under one joint
 *  outcome. Holdings whose event isn't in the path have no supported settlement here and are counted, not valued. */
export function pathSummary(hs: { eventId: string; side: string; shares: number; cost: number; mark: number | null }[], path: Record<string, Outcome>) {
  const held = hs.filter((h) => h.shares > 0), inPath = held.filter((h) => path[h.eventId])
  const payout = sum(inPath, (h) => (h.side === path[h.eventId] ? h.shares : 0))
  const cost = sum(inPath, (h) => h.cost)
  const value = inPath.some((h) => h.mark == null) ? null : sum(inPath, (h) => h.shares * (h.mark as number))
  return { payout, pnl: payout - cost, change: value == null ? null : payout - value, unsupported: held.length - inPath.length }
}

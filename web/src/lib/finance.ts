/**
 * Shared, pure calculation layer. Every number on every page comes from here so pages can't disagree.
 *
 * Definitions (also shown in the UI's ⓘ tips):
 *  - Cost basis        Σ shares × fill price of open positions. Fees are NOT in the cost basis.
 *  - Unrealized P&L    Σ shares × (mark − average cost) of open positions, before fees.
 *  - Realized P&L      Σ over closed trades of shares × (exit − entry) − that trade's fees.
 *  - Fees paid         closed-trade fees + fees on fills of still-open positions.
 *  - Net P&L           realized P&L + unrealized P&L − fees on open fills  (each fee counted once).
 *  - Net deposits      deposits − withdrawals. Never counted as performance.
 *  - Cash              net deposits + realized P&L − Σ (cost + fees) of open fills.
 *  - Portfolio value   cash + Σ shares × mark.   Identity: value − net deposits = net P&L.
 *  - Settlement payoff a contract pays $1 per share if its side wins, $0 otherwise.
 */
import { CASH_FLOWS, CLOSED_TRADES, EVENTS, FEE_RATE, HISTORY_START, LAST_VISIT, OPEN_POSITIONS, PORTFOLIO, TODAY } from '../data/portfolio'
import type { Category, ClosedTrade, DataSource, OpenPosition, Platform, RelClass, Relation, RiskEvent, Side } from '../data/types'
export type { RelClass, Relation }

export type PlatformFilter = 'all' | Platform
const inPlatform = (f: PlatformFilter, p: Platform) => f === 'all' || f === p
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)
export const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
export const daysBetween = (a: string, b: string) => Math.round((dayMs(b) - dayMs(a)) / 86400000)
export const addDays = (iso: string, d: number) => new Date(dayMs(iso) + d * 86400000).toISOString().slice(0, 10)
export const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
  new Date(dayMs(iso)).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })

/* ───────────── Sources & coverage ───────────── */
export const sourceOf = (p: Platform): DataSource => PORTFOLIO.sources[p] ?? { label: p === 'pm' ? 'Polymarket' : 'Kalshi', asOf: TODAY, stale: false }
/** What a source's numbers are based on: open positions, fills, settlements, and how many fees are estimates. */
export function coverage(p: Platform) {
  const open = OPEN_POSITIONS.filter((x) => x.platform === p), closed = CLOSED_TRADES.filter((t) => t.platform === p)
  return {
    open: open.length,
    fills: open.reduce((a, x) => a + x.fills.length, 0) + closed.reduce((a, t) => a + (t.outcome === 'Closed early' ? 2 : 1), 0),
    settlements: closed.filter((t) => t.outcome !== 'Closed early').length,
    feeEstimates: closed.filter((t) => !t.feeKnown).length,
  }
}

/* ───────────── Positions ───────────── */
export interface Position extends OpenPosition {
  shares: number; avg: number; cost: number; fees: number; value: number; upl: number
  ifWin: number; ifLose: number; days: number; opened: string
}
export function derivePosition(p: OpenPosition): Position {
  const shares = sum(p.fills, (f) => f.shares), cost = sum(p.fills, (f) => f.shares * f.price)
  const value = shares * p.mark
  return {
    ...p, shares, cost, avg: cost / shares, fees: sum(p.fills, (f) => f.fee), value, upl: value - cost,
    ifWin: shares - cost, ifLose: -cost, days: daysBetween(TODAY, p.resolves), opened: p.fills[0].date,
  }
}
export const POSITIONS: Position[] = OPEN_POSITIONS.map(derivePosition)
export const POS_BY_ID: Record<string, Position> = Object.fromEntries(POSITIONS.map((p) => [p.id, p]))
export const positionsFor = (f: PlatformFilter) => POSITIONS.filter((p) => inPlatform(f, p.platform))

/* ───────────── Closed trades ───────────── */
export const tradeGross = (t: ClosedTrade) => t.shares * (t.exit - t.entry)
export const tradeNet = (t: ClosedTrade) => tradeGross(t) - t.fees
export const isResolved = (t: ClosedTrade) => t.outcome !== 'Closed early'
export const tradesIn = (f: PlatformFilter, start = HISTORY_START, end = TODAY) =>
  CLOSED_TRADES.filter((t) => inPlatform(f, t.platform) && t.closed > start && t.closed <= end)
// note: `start` is exclusive so consecutive periods never double count a trade.

/* ───────────── Account at a date ───────────── */
export interface Account {
  netDeposits: number; cash: number; positionsValue: number; totalValue: number; committed: number
  unrealized: number; openFees: number; realized: number; closedFees: number; fees: number; netPnl: number
  wins: number; resolved: number; closedCount: number; openCount: number; feeEstimates: number
}
export function account(f: PlatformFilter = 'all'): Account {
  const flows = CASH_FLOWS.filter((c) => inPlatform(f, c.platform) && c.date <= TODAY)
  const closed = CLOSED_TRADES.filter((t) => inPlatform(f, t.platform) && t.closed <= TODAY)
  const pos = positionsFor(f)
  const netDeposits = sum(flows, (c) => c.amount)
  const realized = sum(closed, tradeNet), closedFees = sum(closed, (t) => t.fees)
  const committed = sum(pos, (p) => p.cost), openFees = sum(pos, (p) => p.fees)
  const positionsValue = sum(pos, (p) => p.value), unrealized = positionsValue - committed
  const cash = netDeposits + realized - committed - openFees
  const resolved = closed.filter(isResolved)
  return {
    netDeposits, cash, positionsValue, totalValue: cash + positionsValue, committed, unrealized, openFees, realized, closedFees,
    fees: closedFees + openFees, netPnl: realized + unrealized - openFees, wins: resolved.filter((t) => t.outcome === 'Won').length,
    resolved: resolved.length, closedCount: closed.length, openCount: pos.length, feeEstimates: closed.filter((t) => !t.feeKnown).length,
  }
}

/* ───────────── History (weekly marks) ─────────────
   Open positions' marks move from first fill price → mark at last visit → today's mark, with deterministic
   noise that is zero at the anchors. Closed trades move from entry → exit. History is built per position,
   so a platform's curve is its own history, never a scaled copy of the total. */
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
function pathPrice(id: string, from: string, p0: number, to: string, p1: number, at: string) {
  const span = Math.max(1, daysBetween(from, to)), x = Math.min(1, Math.max(0, daysBetween(from, at) / span))
  const wobble = Math.sin((hash(id) % 628) / 100 + x * 9) * 0.06 * Math.sin(Math.PI * x)
  return Math.min(0.99, Math.max(0.01, p0 + (p1 - p0) * x + wobble))
}
export function markAt(p: OpenPosition, date: string) {
  if (date >= TODAY) return p.mark
  if (date >= LAST_VISIT) return pathPrice(`${p.id}b`, LAST_VISIT, p.markAtLastVisit, TODAY, p.mark, date)
  return pathPrice(p.id, p.fills[0].date, p.fills[0].price, LAST_VISIT, p.markAtLastVisit, date)
}

/** Cumulative net P&L up to and including `date` (same formula as `account` at TODAY). */
export function netPnlAt(f: PlatformFilter, date: string) {
  let v = 0
  for (const t of CLOSED_TRADES) {
    if (!inPlatform(f, t.platform) || t.opened > date) continue
    if (t.closed <= date) v += tradeNet(t)
    else v += t.shares * (pathPrice(t.id, t.opened, t.entry, t.closed, t.exit, date) - t.entry)
  }
  for (const p of OPEN_POSITIONS) {
    if (!inPlatform(f, p.platform)) continue
    const m = markAt(p, date)
    for (const fl of p.fills) if (fl.date <= date) v += fl.shares * (m - fl.price) - fl.fee
  }
  return v
}
export const depositsAt = (f: PlatformFilter, date: string) => sum(CASH_FLOWS.filter((c) => inPlatform(f, c.platform) && c.date <= date), (c) => c.amount)

export interface SeriesPoint { date: string; deposits: number; netPnl: number; value: number }
export function series(f: PlatformFilter, start = HISTORY_START, end = TODAY): SeriesPoint[] {
  const dates: string[] = []
  for (let d = start; d < end; d = addDays(d, 7)) dates.push(d)
  dates.push(end)
  return dates.map((date) => { const deposits = depositsAt(f, date), netPnl = netPnlAt(f, date); return { date, deposits, netPnl, value: deposits + netPnl } })
}

/* ───────────── Periods ───────────── */
export const PERIODS = ['1M', '3M', '6M', 'YTD', 'All'] as const
export type Period = (typeof PERIODS)[number]
export interface Range { start: string; end: string }
export function periodRange(p: Period): Range & { label: string; prior: Range | null } {
  const end = TODAY
  const start = p === '1M' ? addDays(end, -30) : p === '3M' ? addDays(end, -91) : p === '6M' ? addDays(end, -182) : p === 'YTD' ? '2025-12-31' : HISTORY_START
  // Prior period: the same calendar span one year earlier for YTD, otherwise the window of equal length just before.
  const prior0 = p === 'YTD' ? { start: '2024-12-31', end: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}` } : { start: addDays(start, -daysBetween(start, end)), end: start }
  const prior = p === 'All' || prior0.start < addDays(HISTORY_START, -1) ? null : prior0
  return { start, end, label: `${fmtDate(addDays(start, 1), { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmtDate(end, { month: 'short', day: 'numeric', year: 'numeric' })}`, prior }
}

export interface PeriodStats {
  /** netPnl = realized + unrealizedChange − openFillFees.
   *  realized counts each trade closed in the period in full, including P&L that built up before the period
   *  started; that earlier part reappears as a negative unrealizedChange, so the sum stays correct. */
  netPnl: number; realized: number; unrealizedChange: number; openFillFees: number; fees: number; trades: ClosedTrade[]
  wins: number; losses: number; resolved: number; winRate: number | null; avgWin: number | null; avgLoss: number | null
  profitFactor: number | null; months: { month: string; realized: number }[]
  drawdown: { amount: number; from: string; to: string; recoveredOn: string | null } | null
}
export function periodStats(f: PlatformFilter, r: Range): PeriodStats {
  const trades = tradesIn(f, r.start, r.end)
  const realized = sum(trades, tradeNet)
  const netPnl = netPnlAt(f, r.end) - netPnlAt(f, r.start)
  const openFillFees = sum(OPEN_POSITIONS.filter((p) => inPlatform(f, p.platform)).flatMap((p) => p.fills), (fl) => (fl.date > r.start && fl.date <= r.end ? fl.fee : 0))
  const res = trades.filter(isResolved), wins = res.filter((t) => t.outcome === 'Won')
  const posNet = trades.filter((t) => tradeNet(t) > 0), negNet = trades.filter((t) => tradeNet(t) < 0)
  const grossWin = sum(posNet, tradeNet), grossLoss = -sum(negNet, tradeNet)
  const monthKeys: string[] = []
  for (let d = r.start; d <= r.end; d = addDays(d, 1)) { const m = d.slice(0, 7); if (d > r.start && !monthKeys.includes(m)) monthKeys.push(m) }
  const months = monthKeys.map((m) => ({ month: m, realized: sum(trades.filter((t) => t.closed.startsWith(m)), tradeNet) }))
  // drawdown on the weekly cumulative net P&L inside the period
  const pts = series(f, r.start, r.end)
  let peak = pts[0], dd: PeriodStats['drawdown'] = null
  for (const p of pts) {
    if (p.netPnl > peak.netPnl) peak = p
    const draw = peak.netPnl - p.netPnl
    if (draw > (dd?.amount ?? 0.5)) dd = { amount: draw, from: peak.date, to: p.date, recoveredOn: null }
  }
  if (dd) { const target = pts.find((p) => p.date > dd!.to && p.netPnl >= dd!.amount + pts.find((q) => q.date === dd!.to)!.netPnl); dd.recoveredOn = target?.date ?? null }
  return {
    netPnl, realized, unrealizedChange: netPnl - realized + openFillFees, openFillFees, fees: sum(trades, (t) => t.fees) + openFillFees, trades,
    wins: wins.length, losses: res.length - wins.length, resolved: res.length, winRate: res.length ? wins.length / res.length : null,
    avgWin: posNet.length ? grossWin / posNet.length : null, avgLoss: negNet.length ? grossLoss / negNet.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null, months, drawdown: dd,
  }
}

export function attribution(trades: ClosedTrade[], by: 'category' | 'platform') {
  const m = new Map<string, { net: number; n: number }>()
  for (const t of trades) { const k = by === 'category' ? t.category : t.platform; const g = m.get(k) ?? { net: 0, n: 0 }; g.net += tradeNet(t); g.n += 1; m.set(k, g) }
  return [...m.entries()].map(([key, g]) => ({ key, ...g })).sort((a, b) => b.net - a.net)
}

export const BUCKETS = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0001]] as const
export function entryBuckets(trades: ClosedTrade[]) {
  const res = trades.filter(isResolved)
  return BUCKETS.map(([lo, hi]) => {
    const ts = res.filter((t) => t.entry >= lo && t.entry < hi)
    return {
      label: `$${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}`, n: ts.length,
      winRate: ts.length ? ts.filter((t) => t.outcome === 'Won').length / ts.length : null,
      implied: ts.length ? sum(ts, (t) => t.entry) / ts.length : null,
      net: sum(ts, tradeNet), trades: ts,
    }
  })
}

/** Insights are computed, never hand-written. Each returns null when the sample is too small (n < 5). */
export function insights(trades: ClosedTrade[]) {
  const res = trades.filter(isResolved)
  const long = res.filter((t) => t.entry < 0.25)
  const early = trades.filter((t) => t.outcome === 'Closed early')
  const missed = early.filter((t) => t.heldWouldWin)
  const leftOnTable = sum(missed, (t) => t.shares * (1 - t.exit))
  const avoided = sum(early.filter((t) => !t.heldWouldWin), (t) => t.shares * t.exit)
  // Same basis as attribution: all closed trades (net of fees). Win rate uses resolved trades only.
  const byCat = (Object.keys(EDGE_LABEL) as Category[]).map((c) => {
    const ts = trades.filter((t) => t.category === c), rs = ts.filter(isResolved)
    const net = sum(ts, tradeNet), biggest = Math.max(0, ...ts.map(tradeNet))
    return { c, n: ts.length, resolved: rs.length, winRate: rs.length ? rs.filter((t) => t.outcome === 'Won').length / rs.length : 0, net, topShare: net > 0 ? biggest / net : 1, trades: ts }
  }).filter((x) => x.n >= 5)
  const strongest = [...byCat].sort((a, b) => b.net - a.net)[0] ?? null
  const longCats = attribution(long, 'category')
  return {
    longshots: long.length >= 5 ? { n: long.length, wins: long.filter((t) => t.outcome === 'Won').length, net: sum(long, tradeNet), implied: sum(long, (t) => t.entry) / long.length, worstCategory: [...longCats].sort((a, b) => a.net - b.net)[0]?.key ?? null, trades: long } : null,
    earlyExits: early.length >= 5 ? { n: early.length, missed: missed.length, leftOnTable, avoided, trades: early } : null,
    strongest: strongest && strongest.net > 0 ? strongest : null,
  }
}
const EDGE_LABEL: Record<Category, true> = { Economics: true, Climate: true, Crypto: true, Politics: true, Sports: true }

/* ───────────── Events & relationships ───────────── */
export type Outcome = 'YES' | 'NO'
/** The portfolio's relationships with the user's override for the one classifiable pair (BTC × ETH) applied. */
export const relationsFor = (crypto: RelClass): Relation[] =>
  PORTFOLIO.relations.map((r) => ((r.a === 'btc' && r.b === 'eth') || (r.a === 'eth' && r.b === 'btc') ? { ...r, cls: crypto } : r))
export function pairRelation(a: string, b: string, rels: Relation[]): RelClass | null {
  if (a === b) return 'equivalent'
  return rels.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a))?.cls ?? null
}
/** A joint outcome is feasible unless it breaks a confirmed constraint:
 *  mutually exclusive → both can't resolve YES; equivalent → must resolve the same way.
 *  Related, unknown and unclassified pairs impose no constraint (and are flagged as caveats instead). */
export function isFeasible(o: Record<string, Outcome>, rels: Relation[]) {
  return rels.every((r) => {
    if (!(r.a in o) || !(r.b in o)) return true
    if (r.cls === 'mutex') return !(o[r.a] === 'YES' && o[r.b] === 'YES')
    if (r.cls === 'equivalent') return o[r.a] === o[r.b]
    return true
  })
}
/** Exhaustive enumeration is exponential (2^n joint outcomes) and uses 32-bit masks, so it is capped.
 *  Above the cap, ranges are reported as unavailable instead of approximated. A bounded or decomposed engine is
 *  required before unrestricted real portfolios (see docs/METHODOLOGY.md). */
export const MAX_JOINT_EVENTS = 16
export function* jointOutcomes(ids: string[]): Generator<Record<string, Outcome>> {
  if (ids.length > MAX_JOINT_EVENTS) throw new RangeError(`jointOutcomes: ${ids.length} events exceeds ${MAX_JOINT_EVENTS}`)
  for (let mask = 0; mask < 2 ** ids.length; mask++) yield Object.fromEntries(ids.map((id, i) => [id, Math.floor(mask / 2 ** i) % 2 ? 'YES' : 'NO'])) as Record<string, Outcome>
}
export interface OutcomeRange { min: number; max: number; argmin: Record<string, Outcome>; argmax: Record<string, Outcome>; feasible: number; excluded: number }
/** Min/max of `fn` over feasible joint outcomes only. Impossible combinations are excluded, never patched afterwards.
 *  Returns null when there are too many events to enumerate exactly. */
export function outcomeRange(ids: string[], rels: Relation[], fn: (o: Record<string, Outcome>) => number): OutcomeRange | null {
  if (ids.length > MAX_JOINT_EVENTS) return null
  let min = Infinity, max = -Infinity, argmin: Record<string, Outcome> = {}, argmax: Record<string, Outcome> = {}, feasible = 0, excluded = 0
  for (const o of jointOutcomes(ids)) {
    if (!isFeasible(o, rels)) { excluded++; continue }
    feasible++
    const v = fn(o)
    if (v < min) { min = v; argmin = o }
    if (v > max) { max = v; argmax = o }
  }
  return { min, max, argmin, argmax, feasible, excluded }
}

/* ───────────── Holdings (base portfolio or a scenario) ───────────── */
export interface Holding { id: string; eventId: string; platform: Platform; side: Side; shares: number; cost: number; mark: number }
export const baseHoldings = (): Record<string, Holding> =>
  Object.fromEntries(POSITIONS.map((p) => [p.id, { id: p.id, eventId: p.eventId, platform: p.platform, side: p.side, shares: p.shares, cost: p.cost, mark: p.mark }]))
const payout = (h: Holding, o: Outcome) => (h.side === o ? h.shares : 0)
/** P&L of an event's holdings vs. their cost basis if the event resolves `o` (excludes fees already paid). */
export const eventPnl = (hs: Holding[], eventId: string, o: Outcome) => sum(hs.filter((h) => h.eventId === eventId), (h) => payout(h, o) - h.cost)

/** Exposure to one binary event, combining every holding on it (any platform, either side).
 *  `cost` is gross capital committed; settlement P&L is computed per outcome from each holding's own side,
 *  so opposing YES/NO holdings offset. `side` is 'Mixed' when the holdings don't all share one side. */
export interface EventExposure {
  event: RiskEvent; positions: Position[]; platforms: Platform[]; side: Side | 'Mixed'; cost: number
  /** P&L at settlement vs. cost basis for each outcome (fees already paid not included). */
  pnl: Record<Outcome, number>
  best: { outcome: Outcome; pnl: number }; worst: { outcome: Outcome; pnl: number }
  /** Most the event can lose at settlement (0 when every outcome is at or above cost). */
  maxLoss: number
  days: number; resolves: string; share: number
}
export const opposite = (o: Outcome): Outcome => (o === 'YES' ? 'NO' : 'YES')
/** Pure: exposure for a set of holdings on one event. */
export function eventExposureOf(event: RiskEvent, ps: Position[], totalCost: number): EventExposure {
  const cost = sum(ps, (p) => p.cost)
  const pnl: Record<Outcome, number> = { YES: sum(ps, (p) => (p.side === 'YES' ? p.shares : 0)) - cost, NO: sum(ps, (p) => (p.side === 'NO' ? p.shares : 0)) - cost }
  const sides = new Set(ps.map((p) => p.side))
  const side: Side | 'Mixed' = sides.size === 1 ? ps[0].side : 'Mixed'
  // Single-sided: "best" is the held side. Mixed: whichever outcome pays more (ties → YES).
  const bestO: Outcome = side === 'Mixed' ? (pnl.YES >= pnl.NO ? 'YES' : 'NO') : side
  const worstO = opposite(bestO)
  return {
    event, positions: ps, platforms: [...new Set(ps.map((p) => p.platform))], side, cost, pnl,
    best: { outcome: bestO, pnl: pnl[bestO] }, worst: { outcome: worstO, pnl: pnl[worstO] }, maxLoss: Math.max(0, -Math.min(pnl.YES, pnl.NO)),
    days: ps[0].days, resolves: ps[0].resolves, share: totalCost ? cost / totalCost : 0,
  }
}
export function exposures(f: PlatformFilter = 'all'): EventExposure[] {
  const pos = positionsFor(f), total = sum(pos, (p) => p.cost)
  return EVENTS.map((event) => {
    const ps = pos.filter((p) => p.eventId === event.id)
    return ps.length ? eventExposureOf(event, ps, total) : null
  }).filter((x): x is EventExposure => x !== null).sort((a, b) => b.cost - a.cost)
}
/** How to name an outcome for an exposure: relative to the user's side when single-sided, plain YES/NO when mixed. */
export const outcomeLabel = (e: Pick<EventExposure, 'side'>, o: Outcome) => (e.side === 'Mixed' ? `If ${o}` : `If ${o} (${o === e.side ? 'for you' : 'against you'})`)

/** Settlement range over feasible joint outcomes (P&L vs. cost basis) for the given holdings. */
export function settlementRange(hs: Holding[], rels: Relation[]): OutcomeRange | null {
  const ids = [...new Set(hs.filter((h) => h.shares > 0).map((h) => h.eventId))]
  return outcomeRange(ids, rels, (o) => sum(ids, (id) => eventPnl(hs, id, o[id])))
}

/** Settlement range for a subset of events (e.g. a table filter), or null when the subset is empty.
 *  Relationships still apply inside the subset. Portfolio-level figures must use `settlementRange` on all holdings. */
export function settlementRangeFor(eventIds: string[], rels: Relation[]) {
  const ids = new Set(eventIds)
  const hs = Object.values(baseHoldings()).filter((h) => ids.has(h.eventId))
  return hs.length ? settlementRange(hs, rels) : null
}

/* ───────────── Scenario simulation ───────────── */
export interface Adjustment { id: string; to: number; price: number }
export interface Simulation {
  holdings: Record<string, Holding>; cash: Record<Platform, number>
  /** Realized P&L locked in by hypothetical sales (after their fees). Purchases never create realized P&L. */
  realized: number; fees: number
  /** Invalid inputs. These adjustments are left out of the results. */
  errors: Record<string, string>
  /** Cash a platform would need on top of its balance to fund the scenario's purchases. The trades stay in
   *  the results (shown as if funded): a funding gap is a property of the scenario, not an input error. */
  shortfall: Record<Platform, number>
  /** Per position: realized P&L from hypothetical sales and fees on hypothetical trades. */
  realizedBy: Record<string, number>; feesBy: Record<string, number>
}
export const MIN_PRICE = 0.01, MAX_PRICE = 0.99
export function validatePrice(v: number) {
  if (!Number.isFinite(v)) return 'Enter a number'
  if (v < MIN_PRICE || v > MAX_PRICE) return 'Price must be between $0.01 and $0.99'
  return null
}
export function simulate(adjs: Adjustment[], opts: { includeFees: boolean }): Simulation {
  const holdings = baseHoldings()
  const cash: Record<Platform, number> = { pm: account('pm').cash, ks: account('ks').cash }
  let realized = 0, fees = 0
  const errors: Record<string, string> = {}, realizedBy: Record<string, number> = {}, feesBy: Record<string, number> = {}
  for (const a of adjs) {
    const h = holdings[a.id]
    if (!h) { errors[a.id] = 'Unknown position'; continue }
    const priceErr = validatePrice(a.price)
    if (priceErr) { errors[a.id] = priceErr; continue }
    const to = Math.max(0, Math.round(a.to))
    const d = to - h.shares
    if (d === 0) continue
    const notional = Math.abs(d) * a.price, fee = opts.includeFees ? notional * FEE_RATE[h.platform] : 0
    fees += fee; feesBy[a.id] = fee
    if (d > 0) { h.cost += notional; cash[h.platform] -= notional + fee }
    else {
      const q = -d, avg = h.cost / h.shares, r = q * (a.price - avg) - fee
      realized += r; realizedBy[a.id] = r
      h.cost -= q * avg; cash[h.platform] += notional - fee
    }
    h.shares = to
    if (to === 0) h.cost = 0
  }
  const gap = (v: number) => (v < -0.005 ? -v : 0)
  const shortfall: Record<Platform, number> = { pm: gap(cash.pm), ks: gap(cash.ks) }
  return { holdings, cash, realized, fees, errors, shortfall, realizedBy, feesBy }
}

export interface ScenarioMetrics {
  cash: number; positionsValue: number; totalValue: number; committed: number; realized: number; fees: number
  /** null when the joint-outcome range can't be computed exactly (too many events). */
  worstValue: number | null; bestValue: number | null; worst: Record<string, Outcome>; best: Record<string, Outcome>; excluded: number
  /** Largest settlement loss of a single event, with opposing holdings netted. */
  largestEventLoss: number
  /** No invalid inputs. */
  valid: boolean
  /** Total extra cash needed across platforms (0 when the scenario fits current balances). */
  shortfall: number
}
/** Everything is expressed as portfolio value (cash + holdings) so a purchase can never look like profit:
 *  buying moves cash into contracts; at mark it costs the spread and fees; only settlement changes the range. */
export function scenarioMetrics(sim: Simulation, rels: Relation[]): ScenarioMetrics {
  const hs = Object.values(sim.holdings).filter((h) => h.shares > 0)
  const cash = sim.cash.pm + sim.cash.ks
  const positionsValue = sum(hs, (h) => h.shares * h.mark)
  const committed = sum(hs, (h) => h.cost)
  const ids = [...new Set(hs.map((h) => h.eventId))]
  const range = ids.length ? outcomeRange(ids, rels, (o) => sum(hs, (h) => payout(h, o[h.eventId]))) : { min: 0, max: 0, argmin: {}, argmax: {}, feasible: 1, excluded: 0 }
  // Worst settlement of each event on its own, using each holding's side (opposing holdings offset).
  const largestEventLoss = Math.max(0, ...ids.map((id) => -Math.min(eventPnl(hs, id, 'YES'), eventPnl(hs, id, 'NO'))))
  return {
    cash, positionsValue, totalValue: cash + positionsValue, committed, realized: sim.realized, fees: sim.fees,
    worstValue: range ? cash + range.min : null, bestValue: range ? cash + range.max : null, worst: range?.argmin ?? {}, best: range?.argmax ?? {},
    excluded: range?.excluded ?? 0, largestEventLoss, valid: Object.keys(sim.errors).length === 0, shortfall: sim.shortfall.pm + sim.shortfall.ks,
  }
}

/** P&L of the positions in `eventIds` for a joint outcome, including realized P&L and fees from the scenario's own trades.
 *  Buy fees count as a cost here (they're not in the cost basis); sale fees are already inside realizedBy. */
export function groupPnl(sim: Simulation, eventIds: string[], o: Record<string, Outcome>) {
  const hs = Object.values(sim.holdings).filter((h) => eventIds.includes(h.eventId))
  let v = 0
  for (const h of hs) {
    v += (h.shares > 0 ? payout(h, o[h.eventId]) - h.cost : 0)
    v += sim.realizedBy[h.id] ?? 0
    if (!(h.id in sim.realizedBy)) v -= sim.feesBy[h.id] ?? 0
  }
  return v
}

/* ───────────── Allocation ───────────── */
export interface AllocationSegment {
  key: string; value: number
  /** Share of open-position market value in scope (cash excluded). */
  share: number
  positions: { p: Position; shareOfSegment: number; shareOfOpen: number }[]
}
/** Open-position market value grouped by category or platform. Basis: shares × mark; cash is not included. */
export function allocation(f: PlatformFilter, by: 'category' | 'platform') {
  const pos = positionsFor(f), total = sum(pos, (p) => p.value)
  const groups = new Map<string, Position[]>()
  for (const p of pos) { const k = by === 'category' ? p.category : p.platform; groups.set(k, [...(groups.get(k) ?? []), p]) }
  const segments: AllocationSegment[] = [...groups.entries()].map(([key, ps]) => {
    const value = sum(ps, (p) => p.value)
    return {
      key, value, share: total ? value / total : 0,
      positions: [...ps].sort((a, b) => b.value - a.value).map((p) => ({ p, shareOfSegment: value ? p.value / value : 0, shareOfOpen: total ? p.value / total : 0 })),
    }
  }).sort((a, b) => b.value - a.value)
  return { total, segments }
}

/** Relationships that involve an event (including equivalent contracts merged into it). */
export function eventRelations(id: string, rels: Relation[]) {
  return rels.filter((r) => r.a === id || r.b === id).map((r) => ({ other: EVENTS.find((e) => e.id === (r.a === id ? r.b : r.a))!, cls: r.cls })).filter((x) => x.other)
}

/**
 * Fictional sample portfolio — the same data used in design-concepts/v2.
 * No real accounts, no network. Replace with adapters when real data lands.
 */
import { rng } from '../lib/format'

export type Platform = 'pm' | 'ks'
export type Side = 'YES' | 'NO'
export type Category = 'Economics' | 'Climate' | 'Crypto' | 'Politics' | 'Sports'

export interface Position {
  id: string
  market: string
  event: string
  eventId: string
  category: Category
  platform: Platform
  side: Side
  shares: number
  avg: number
  mark: number
  resolves: string
  days: number
}

export interface DerivedPosition extends Position {
  cost: number
  value: number
  upl: number
  ifWin: number
  ifLose: number
}

const RAW: Position[] = [
  { id: 'fedk', market: 'Fed cuts rates at Dec 2026 FOMC', event: 'Dec 2026 FOMC decision', eventId: 'fed', category: 'Economics', platform: 'ks', side: 'YES', shares: 4200, avg: 0.58, mark: 0.64, resolves: 'Dec 16', days: 22 },
  { id: 'fedp', market: 'Fed rate cut in December?', event: 'Dec 2026 FOMC decision', eventId: 'fed', category: 'Economics', platform: 'pm', side: 'YES', shares: 3000, avg: 0.61, mark: 0.64, resolves: 'Dec 16', days: 22 },
  { id: 'cpi', market: 'Nov CPI YoY above 3.0%', event: 'Nov 2026 CPI print', eventId: 'cpi', category: 'Economics', platform: 'ks', side: 'NO', shares: 3000, avg: 0.71, mark: 0.66, resolves: 'Dec 10', days: 16 },
  { id: 'rec', market: 'US recession declared in 2027', event: 'NBER recession call', eventId: 'rec', category: 'Economics', platform: 'pm', side: 'NO', shares: 5000, avg: 0.79, mark: 0.82, resolves: 'Dec 31 ’27', days: 402 },
  { id: 'hot', market: '2026 hottest year on record', event: 'NOAA annual report', eventId: 'hot', category: 'Climate', platform: 'ks', side: 'YES', shares: 9000, avg: 0.88, mark: 0.93, resolves: 'Jan 14', days: 51 },
  { id: 'shut', market: 'Government shutdown before Feb 1', event: 'FY27 appropriations', eventId: 'shut', category: 'Politics', platform: 'pm', side: 'YES', shares: 7000, avg: 0.38, mark: 0.47, resolves: 'Feb 1', days: 69 },
  { id: 'btc', market: 'Bitcoin above $150k on Dec 31', event: 'BTC year-end close', eventId: 'btc', category: 'Crypto', platform: 'pm', side: 'YES', shares: 8000, avg: 0.34, mark: 0.29, resolves: 'Dec 31', days: 37 },
  { id: 'eth', market: 'ETH ETFs net inflows > $1B in Nov', event: 'Nov ETF flows', eventId: 'eth', category: 'Crypto', platform: 'ks', side: 'YES', shares: 3500, avg: 0.45, mark: 0.52, resolves: 'Dec 2', days: 8 },
  { id: 'cel', market: 'Celtics win 2027 NBA Finals', event: '2027 NBA Finals', eventId: 'cel', category: 'Sports', platform: 'pm', side: 'YES', shares: 6500, avg: 0.21, mark: 0.26, resolves: 'Jun ’27', days: 205 },
  { id: 'chf', market: 'Chiefs win Super Bowl LXI', event: 'Super Bowl LXI', eventId: 'chf', category: 'Sports', platform: 'pm', side: 'YES', shares: 4000, avg: 0.17, mark: 0.12, resolves: 'Feb 14', days: 82 },
]

export const derive = (p: Position): DerivedPosition => {
  const cost = p.shares * p.avg
  const value = p.shares * p.mark
  return { ...p, cost, value, upl: value - cost, ifWin: p.shares - cost, ifLose: -cost }
}

export const POSITIONS: DerivedPosition[] = RAW.map(derive)
export const POS_BY_ID = Object.fromEntries(POSITIONS.map((p) => [p.id, p])) as Record<string, DerivedPosition>

export const PLATFORM_NAME: Record<Platform, string> = { pm: 'Polymarket', ks: 'Kalshi' }
export const CATEGORIES: Category[] = ['Economics', 'Climate', 'Crypto', 'Politics', 'Sports']
export const CAT_COLOR: Record<Category, string> = {
  Economics: 'var(--color-data-1)', Climate: 'var(--color-data-3)', Crypto: 'var(--color-data-2)', Politics: 'var(--color-data-4)', Sports: 'var(--color-data-5)',
}

export const ACCOUNT = {
  totalValue: 35003.2,
  cash: 6345.2,
  cashByPlatform: { pm: 4102, ks: 2243 },
  netDeposits: 28740.8,
  realized: 4870.4,
  fees: 412.6,
  netPnl: 6262.4,
  resolvedCount: 64,
  wins: 37,
}

/** Event-level grouping (same outcome on two platforms counts once). */
export type Relation = 'eq' | 'macro' | 'unk' | undefined
export interface RiskEvent { id: string; name: string; ids: string[]; category: Category; resolves: string; days: number; relation: Relation }
export const EVENTS: RiskEvent[] = [
  { id: 'hot', name: '2026 hottest year on record', ids: ['hot'], category: 'Climate', resolves: 'Jan 14', days: 51, relation: undefined },
  { id: 'fed', name: 'Dec 2026 FOMC decision', ids: ['fedk', 'fedp'], category: 'Economics', resolves: 'Dec 16', days: 22, relation: 'eq' },
  { id: 'rec', name: 'US recession in 2027', ids: ['rec'], category: 'Economics', resolves: 'Dec ’27', days: 402, relation: 'macro' },
  { id: 'btc', name: 'Bitcoin above $150k, Dec 31', ids: ['btc'], category: 'Crypto', resolves: 'Dec 31', days: 37, relation: 'unk' },
  { id: 'shut', name: 'Shutdown before Feb 1', ids: ['shut'], category: 'Politics', resolves: 'Feb 1', days: 69, relation: undefined },
  { id: 'cpi', name: 'Nov CPI above 3.0%', ids: ['cpi'], category: 'Economics', resolves: 'Dec 10', days: 16, relation: 'macro' },
  { id: 'eth', name: 'ETH ETF inflows > $1B (Nov)', ids: ['eth'], category: 'Crypto', resolves: 'Dec 2', days: 8, relation: 'unk' },
  { id: 'cel', name: 'Celtics win 2027 Finals', ids: ['cel'], category: 'Sports', resolves: 'Jun ’27', days: 205, relation: undefined },
  { id: 'chf', name: 'Chiefs win Super Bowl LXI', ids: ['chf'], category: 'Sports', resolves: 'Feb 14', days: 82, relation: undefined },
]
export const eventStats = (e: RiskEvent) => {
  const ps = e.ids.map((i) => POS_BY_ID[i])
  return {
    cost: ps.reduce((a, p) => a + p.cost, 0),
    win: ps.reduce((a, p) => a + p.ifWin, 0),
    side: ps[0].side,
    platforms: [...new Set(ps.map((p) => p.platform))] as Platform[],
  }
}
export const COMMITTED = POSITIONS.reduce((a, p) => a + p.cost, 0)

/** 27 weekly points: total value and stepped net deposits (ends at today's value). */
export function valueSeries() {
  const r = rng(11), N = 27, dep: number[] = [], val: number[] = []
  let pnl = 2347.65
  for (let i = 0; i < N; i++) {
    const d = i < 9 ? 20000 : i < 18 ? 25000 : ACCOUNT.netDeposits
    pnl += (r() - 0.4) * 900 + (i === 12 ? 620 : 0) - (i === 20 ? 540 : 0)
    dep.push(d); val.push(d + pnl)
  }
  const adj = (ACCOUNT.totalValue - val[N - 1]) / 8
  for (let i = N - 8; i < N; i++) val[i] += adj * (i - (N - 9))
  const labels = Array.from({ length: N }, (_, i) => {
    const d = new Date(2026, 4, 24 + i * 7)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  })
  labels[N - 1] = 'Nov 24'
  return { val, dep, labels }
}

export interface ResolvedTrade { platform: Platform; market: string; category: Category; side: Side; outcome: 'Won' | 'Lost' | 'Closed early'; shares: number; entry: number; exit: number; fees: number; pnl: number; closed: string }
export const RESOLVED: ResolvedTrade[] = [
  { platform: 'ks', market: 'Fed holds at Nov 2026 FOMC', category: 'Economics', side: 'YES', outcome: 'Won', shares: 3800, entry: 0.72, exit: 1, fees: 18.4, pnl: 1045.6, closed: 'Nov 5' },
  { platform: 'pm', market: 'October hottest on record (global)', category: 'Climate', side: 'YES', outcome: 'Won', shares: 5000, entry: 0.81, exit: 1, fees: 0, pnl: 950, closed: 'Nov 12' },
  { platform: 'ks', market: 'Oct jobs report above 150k', category: 'Economics', side: 'NO', outcome: 'Closed early', shares: 2000, entry: 0.55, exit: 0.68, fees: 6.8, pnl: 253.2, closed: 'Nov 1' },
  { platform: 'pm', market: 'Lakers win season opener vs. Warriors', category: 'Sports', side: 'YES', outcome: 'Lost', shares: 2500, entry: 0.22, exit: 0, fees: 0, pnl: -550, closed: 'Oct 28' },
  { platform: 'pm', market: 'ETH above $5k on Oct 31', category: 'Crypto', side: 'YES', outcome: 'Lost', shares: 3000, entry: 0.19, exit: 0, fees: 0, pnl: -570, closed: 'Oct 31' },
  { platform: 'pm', market: 'Senate passes stopgap by Sep 30', category: 'Politics', side: 'YES', outcome: 'Won', shares: 4000, entry: 0.63, exit: 1, fees: 0, pnl: 1480, closed: 'Sep 30' },
]

export interface Activity { at: string; text: string; platform: Platform; kind: 'buy' | 'sell' | 'settle' }
export const ACTIVITY: Activity[] = [
  { at: '4m ago', text: 'Synced 3 new fills · Shutdown YES', platform: 'pm', kind: 'buy' },
  { at: 'Nov 22', text: 'Imported Kalshi CSV · 188 fills', platform: 'ks', kind: 'settle' },
  { at: 'Nov 21', text: 'Bought 2,000 YES · Government shutdown before Feb 1 @ 0.41', platform: 'pm', kind: 'buy' },
  { at: 'Nov 12', text: 'Settled YES · October hottest on record · +$950', platform: 'pm', kind: 'settle' },
  { at: 'Nov 5', text: 'Settled YES · Fed holds at Nov FOMC · +$1,045.60', platform: 'ks', kind: 'settle' },
]

/** Per-platform split of account-level figures (sums to ACCOUNT). Used when a view is filtered to one platform. */
export const PLATFORM_ACCOUNT: Record<Platform, { realized: number; fees: number; wins: number; resolved: number; cash: number; source: string; stale: boolean }> = {
  pm: { realized: 2602.1, fees: 197.4, wins: 21, resolved: 38, cash: 4102, source: 'Public wallet · live', stale: false },
  ks: { realized: 2268.3, fees: 215.2, wins: 16, resolved: 26, cash: 2243.2, source: 'CSV import · Nov 22', stale: true },
}

export interface Fill { date: string; action: 'Buy' | 'Sell'; shares: number; price: number; fee: number }
/** Deterministic mock fills whose weighted average equals the position's average cost. */
export function fillsFor(p: Position): Fill[] {
  const s1 = Math.round((p.shares * 0.5) / 100) * 100, s2 = Math.round((p.shares * 0.3) / 100) * 100, s3 = p.shares - s1 - s2
  const p1 = +(p.avg - 0.02).toFixed(3), p2 = +(p.avg + 0.01).toFixed(3)
  const p3 = +((p.avg * p.shares - p1 * s1 - p2 * s2) / s3).toFixed(3)
  const fee = (sh: number, px: number) => (p.platform === 'ks' ? +(sh * px * 0.007).toFixed(2) : 0)
  return [
    { date: 'Oct 2', action: 'Buy', shares: s1, price: p1, fee: fee(s1, p1) },
    { date: 'Oct 19', action: 'Buy', shares: s2, price: p2, fee: fee(s2, p2) },
    { date: 'Nov 8', action: 'Buy', shares: s3, price: p3, fee: fee(s3, p3) },
  ]
}

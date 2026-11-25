/**
 * Scevia sample ledger — the single fictional data source for every page.
 *
 * Everything shown in the app is derived from these records by `lib/finance.ts`:
 * cash flows (deposits/withdrawals), fills of open positions, closed trades, current marks
 * and event groupings. Nothing here is real account data. It is deterministic so tests and
 * screenshots are stable.
 */
import { sampleFeeSchedule } from './sampleFees'
import { rng } from '../lib/format'
import type { CashFlow, Category, ClosedOutcome, ClosedTrade, Fill, OpenPosition, Platform, PortfolioData, RiskEvent, Side } from './types'

/** "Today" for the sample portfolio. All periods are measured back from here. */
const TODAY = '2026-11-24'
/** Start of the sample history. */
const HISTORY_START = '2025-01-06'
/** The user's previous visit, used by "What changed". */
const LAST_VISIT = '2026-11-17'

/** Fees recorded on the sample's historical fills (fictional history). Not used for hypothetical trades. */
const FEE_RATE: Record<Platform, number> = { pm: 0, ks: 0.007 }

/* ── Cash flows (deposits > 0, withdrawals < 0). Never counted as performance. ── */
const CASH_FLOWS: CashFlow[] = [
  { date: '2025-01-06', platform: 'pm', amount: 9000 },
  { date: '2025-01-06', platform: 'ks', amount: 6000 },
  { date: '2025-06-02', platform: 'pm', amount: 3000 },
  { date: '2025-10-06', platform: 'ks', amount: 4000 },
  { date: '2026-03-02', platform: 'pm', amount: 2500 },
  { date: '2026-05-11', platform: 'ks', amount: -1500 },
  { date: '2026-07-13', platform: 'pm', amount: 2000 },
  { date: '2026-08-10', platform: 'ks', amount: 5000 },
]

/* ── Open positions: fills are the source of truth for average cost and fees ── */

const fee = (p: Platform, notional: number) => Math.round(notional * FEE_RATE[p] * 100) / 100
/** Three buys whose weighted average is exactly `avg`. */
function fills(p: Platform, shares: number, avg: number, dates: [string, string, string]): Fill[] {
  const s1 = Math.round((shares * 0.5) / 100) * 100, s2 = Math.round((shares * 0.3) / 100) * 100, s3 = shares - s1 - s2
  const p1 = +(avg - 0.02).toFixed(3), p2 = +(avg + 0.01).toFixed(3)
  const p3 = +((avg * shares - p1 * s1 - p2 * s2) / s3).toFixed(6)
  return [[dates[0], s1, p1], [dates[1], s2, p2], [dates[2], s3, p3]].map(([date, sh, px]) => ({ date: date as string, shares: sh as number, price: px as number, fee: fee(p, (sh as number) * (px as number)) }))
}

const OPEN_POSITIONS: OpenPosition[] = [
  { id: 'fedk', market: 'Fed cuts rates at Dec 2026 FOMC', eventId: 'fed', category: 'Economics', platform: 'ks', accountId: 'ks-main', marketId: 'ks-fed-dec-cut', feeSchedule: sampleFeeSchedule('ks', 'Economics'), side: 'YES', mark: 0.64, markAtLastVisit: 0.62, resolves: '2026-12-16', fills: fills('ks', 4200, 0.58, ['2026-09-21', '2026-10-12', '2026-11-02']) },
  { id: 'fedp', market: 'Fed rate cut in December?', eventId: 'fed', category: 'Economics', platform: 'pm', accountId: 'pm-main', marketId: 'pm-fed-dec-cut', feeSchedule: sampleFeeSchedule('pm', 'Economics'), side: 'YES', mark: 0.64, markAtLastVisit: 0.62, resolves: '2026-12-16', fills: fills('pm', 3000, 0.61, ['2026-10-05', '2026-10-26', '2026-11-09']) },
  { id: 'cpi', market: 'Nov CPI YoY above 3.0%', eventId: 'cpi', category: 'Economics', platform: 'ks', accountId: 'ks-main', marketId: 'ks-cpi-nov-3', feeSchedule: sampleFeeSchedule('ks', 'Economics'), side: 'NO', mark: 0.66, markAtLastVisit: 0.69, resolves: '2026-12-10', fills: fills('ks', 3000, 0.71, ['2026-10-19', '2026-10-28', '2026-11-04']) },
  { id: 'rec', market: 'US recession declared in 2027', eventId: 'rec', category: 'Economics', platform: 'pm', accountId: 'pm-main', marketId: 'pm-recession-2027', feeSchedule: sampleFeeSchedule('pm', 'Economics'), side: 'NO', mark: 0.82, markAtLastVisit: 0.81, resolves: '2027-12-31', fills: fills('pm', 5000, 0.79, ['2026-06-08', '2026-08-03', '2026-09-14']) },
  { id: 'hot', market: '2026 hottest year on record', eventId: 'hot', category: 'Climate', platform: 'ks', accountId: 'ks-main', marketId: 'ks-hottest-2026', feeSchedule: sampleFeeSchedule('ks', 'Climate'), side: 'YES', mark: 0.93, markAtLastVisit: 0.92, resolves: '2027-01-14', fills: fills('ks', 9000, 0.88, ['2026-07-06', '2026-08-17', '2026-09-28']) },
  { id: 'shut', market: 'Government shutdown before Feb 1', eventId: 'shut', category: 'Politics', platform: 'pm', accountId: 'pm-main', marketId: 'pm-shutdown-feb1', feeSchedule: sampleFeeSchedule('pm', 'Politics'), side: 'YES', mark: 0.47, markAtLastVisit: 0.41, resolves: '2027-02-01', fills: fills('pm', 7000, 0.38, ['2026-10-05', '2026-11-02', '2026-11-21']) },
  { id: 'btc', market: 'Bitcoin above $150k on Dec 31', eventId: 'btc', category: 'Crypto', platform: 'pm', accountId: 'pm-main', marketId: 'pm-btc-150k', feeSchedule: sampleFeeSchedule('pm', 'Crypto'), side: 'YES', mark: 0.29, markAtLastVisit: 0.31, resolves: '2026-12-31', fills: fills('pm', 8000, 0.34, ['2026-08-24', '2026-09-28', '2026-10-19']) },
  { id: 'eth', market: 'ETH ETFs net inflows > $1B in Nov', eventId: 'eth', category: 'Crypto', platform: 'ks', accountId: 'ks-main', marketId: 'ks-eth-etf-nov', feeSchedule: sampleFeeSchedule('ks', 'Crypto'), side: 'YES', mark: 0.52, markAtLastVisit: 0.5, resolves: '2026-12-02', fills: fills('ks', 3500, 0.45, ['2026-10-26', '2026-11-02', '2026-11-09']) },
  { id: 'cel', market: 'Celtics win 2027 NBA Finals', eventId: 'cel', category: 'Sports', platform: 'pm', accountId: 'pm-main', marketId: 'pm-celtics-2027', feeSchedule: sampleFeeSchedule('pm', 'Sports'), side: 'YES', mark: 0.26, markAtLastVisit: 0.25, resolves: '2027-06-20', fills: fills('pm', 6500, 0.21, ['2026-07-13', '2026-09-07', '2026-10-12']) },
  { id: 'chf', market: 'Chiefs win Super Bowl LXI', eventId: 'chf', category: 'Sports', platform: 'pm', accountId: 'pm-main', marketId: 'pm-chiefs-lxi', feeSchedule: sampleFeeSchedule('pm', 'Sports'), side: 'YES', mark: 0.12, markAtLastVisit: 0.13, resolves: '2027-02-14', fills: fills('pm', 4000, 0.17, ['2026-08-31', '2026-09-21', '2026-10-05']) },
]

/* ── Events: positions are grouped by the event that decides the payoff ── */
const EVENTS: RiskEvent[] = [
  { id: 'hot', name: '2026 hottest year on record', short: 'Hottest year', category: 'Climate' },
  { id: 'fed', name: 'Dec 2026 FOMC decision', short: 'Fed cut', category: 'Economics' },
  { id: 'rec', name: 'US recession in 2027', short: 'Recession', category: 'Economics' },
  { id: 'btc', name: 'Bitcoin above $150k, Dec 31', short: 'BTC > $150k', category: 'Crypto' },
  { id: 'shut', name: 'Shutdown before Feb 1', short: 'Shutdown', category: 'Politics' },
  { id: 'cpi', name: 'Nov CPI above 3.0%', short: 'CPI > 3%', category: 'Economics' },
  { id: 'eth', name: 'ETH ETF inflows > $1B (Nov)', short: 'ETH flows', category: 'Crypto' },
  { id: 'cel', name: 'Celtics win 2027 Finals', short: 'Celtics', category: 'Sports' },
  { id: 'chf', name: 'Chiefs win Super Bowl LXI', short: 'Chiefs', category: 'Sports' },
]

/* ── Closed trades (resolved or sold early), generated deterministically ── */

const TEMPLATES: Record<Category, string[]> = {
  Economics: ['Fed holds at {m} FOMC', '{m} CPI YoY above 3%', '{m} jobs report above 150k', 'Unemployment above 4.3% in {m}', 'GDP growth above 2% (Q ending {m})'],
  Climate: ['{m} hottest on record (global)', 'Atlantic hurricane makes landfall in {m}', 'Arctic sea ice record low in {m}'],
  Crypto: ['BTC above $120k on last day of {m}', 'ETH above $5k at end of {m}', 'SOL ETF approved by {m}'],
  Politics: ['Stopgap funding passes by end of {m}', 'Senate confirms nominee in {m}', 'Approval rating above 45% in {m}'],
  Sports: ['Lakers win season opener ({m})', 'Underdog wins {m} title fight', 'Chiefs win {m} division game', 'Dodgers sweep series in {m}'],
}
const EDGE: Record<Category, number> = { Economics: 0.07, Climate: 0.04, Politics: 0.01, Crypto: -0.03, Sports: -0.06 }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const addDays = (iso: string, d: number) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10) }

function generateClosedTrades(): ClosedTrade[] {
  const r = rng(20260), out: ClosedTrade[] = []
  const weights: [Category, number][] = [['Economics', 0.32], ['Sports', 0.22], ['Crypto', 0.18], ['Politics', 0.15], ['Climate', 0.13]]
  const pickCat = () => { let x = r(); for (const [c, w] of weights) { if ((x -= w) <= 0) return c } return 'Economics' as Category }
  let opened = '2025-01-13', n = 0
  while (true) {
    opened = addDays(opened, 4 + Math.floor(r() * 6))
    const hold = 5 + Math.floor(r() * 40)
    const closed = addDays(opened, hold)
    if (closed > '2026-11-20') break
    const category = pickCat()
    const platform: Platform = r() < 0.6 ? 'pm' : 'ks'
    const side: Side = r() < 0.75 ? 'YES' : 'NO'
    const bucket = r()
    const entry = +(bucket < 0.33 ? 0.08 + r() * 0.16 : bucket < 0.5 ? 0.25 + r() * 0.15 : bucket < 0.66 ? 0.42 + r() * 0.17 : bucket < 0.88 ? 0.6 + r() * 0.19 : 0.8 + r() * 0.16).toFixed(2)
    const shares = (5 + Math.floor(r() * 20)) * 100
    const tpl = TEMPLATES[category][Math.floor(r() * TEMPLATES[category].length)]
    const month = MONTHS[Number(closed.slice(5, 7)) - 1] + ` ’${closed.slice(2, 4)}`
    const winP = Math.min(0.97, Math.max(0.02, entry + EDGE[category] - (entry < 0.25 ? 0.04 : 0)))
    const early = r() < 0.18
    const wouldWin = r() < winP
    let exit: number, outcome: ClosedOutcome
    if (early) { exit = +Math.min(0.97, Math.max(0.03, entry + (r() - 0.42) * 0.28)).toFixed(2); outcome = 'Closed early' }
    else { exit = wouldWin ? 1 : 0; outcome = wouldWin ? 'Won' : 'Lost' }
    const fees = fee(platform, shares * entry) + (early ? fee(platform, shares * exit) : 0)
    n += 1
    out.push({ id: `t${n}`, market: tpl.replace('{m}', month), category, platform, side, opened, closed, shares, entry, exit, fees, feeKnown: true, outcome, heldWouldWin: early ? wouldWin : undefined })
  }
  // Two recent Kalshi settlements arrive without fee detail (shows the "estimated" state).
  out.filter((t) => t.platform === 'ks' && t.closed >= '2026-08-01' && t.outcome !== 'Closed early').slice(0, 2).forEach((t) => { t.feeKnown = false })
  return out
}
const CLOSED_TRADES: ClosedTrade[] = generateClosedTrades()

/** The bundled sample portfolio: a deterministic fixture for tests and for exploring Scevia without an account. */
export const SAMPLE_PORTFOLIO: PortfolioData = {
  asOf: TODAY, historyStart: HISTORY_START, lastVisit: LAST_VISIT, isSample: true,
  accounts: [
    { id: 'pm-main', venue: 'pm', label: 'Wallet 0x7a…c2', kind: 'connected', sources: ['api'] },
    { id: 'ks-main', venue: 'ks', label: 'Main account', kind: 'connected', sources: ['api'] },
  ],
  cashFlows: CASH_FLOWS, openPositions: OPEN_POSITIONS, closedTrades: CLOSED_TRADES, events: EVENTS,
  relations: [
    { a: 'fed', b: 'cpi', cls: 'related', provenance: 'annotation', note: 'US macro outlook (sample annotation)' },
    { a: 'fed', b: 'rec', cls: 'related', provenance: 'annotation', note: 'US macro outlook (sample annotation)' },
    { a: 'cpi', b: 'rec', cls: 'related', provenance: 'annotation', note: 'US macro outlook (sample annotation)' },
  ],
  sources: {
    pm: { label: 'Polymarket', asOf: TODAY, stale: false },
    ks: { label: 'Kalshi', asOf: '2026-11-22', stale: true },
  },
}

/* Historical Replay: a retrospective hypothetical portfolio built from markets as they were in a past period.

   A replay is NOT the user's actual history and NOT a point-in-time strategy backtest. The user picks markets
   knowing what happened since, so results are hindsight analysis and say so. The model enforces the market
   lifecycle (no entry before listing or after trading closed), settles at the recorded resolution time, applies
   only the execution prices and fees the user states, and values open holdings from recorded observations with
   LOCF (lib/history.ts). Where no observation exists the value is unavailable; nothing is interpolated.
   The backend replay service is authoritative for integrated results; this module validates inputs and presents
   what can be derived exactly from the stated assumptions and the recorded evidence. */
import type { Denomination, Platform } from '../data/types'
import { addDays, daysBetween, floorQty, type Outcome } from './finance'
import { estimateFee, readFeeAssumption, type FeeAssumption, type FeeSchedule } from './fees'
import { maxDrawdown, priceAt, seriesQuality, valueSeries, type InstrumentHistory, type PriceObs, type ValuedPoint } from './history'
import type { CatalogEvent, CatalogMarket } from './markets'

export interface ReplayMarket {
  provider: Platform; marketId: string; title: string; eventTitle: string; category: string
  listedAt: string | null; closesAt: string | null
  resolution: { outcome: Outcome; at: string } | null
  fee: FeeSchedule | null
  /** Recorded price observations per outcome. Empty when the source has none for this market. */
  observations: Record<Outcome, PriceObs[]>
}
export type ReplaySize = { mode: 'shares' | 'amount' | 'weight'; value: number | null }
export type ReplayExit = { kind: 'settle' } | { kind: 'date'; date: string; price: number | null }
export interface ReplayPosition {
  id: string; market: ReplayMarket; outcome: Outcome; accountId: string
  entryDate: string; entryPrice: number | null; size: ReplaySize; exit: ReplayExit
}
export interface ReplayAccount { id: string; venue: Platform; label: string; denomination: Denomination }
export interface Replay {
  key: string; name: string; color: string
  start: string; end: string
  /** Starting capital per account, in that account's native denomination. */
  capital: Record<string, number>
  fees: FeeAssumption
  positions: ReplayPosition[]
  /** Only retrospective (hindsight) selection is supported. */
  basis: 'retrospective'
  createdAt: string
}

export const MAX_REPLAY_POSITIONS = 20

/** Market metadata a replay stores (a snapshot of the catalog entry; observations as recorded). */
export function replayMarketFrom(ev: CatalogEvent, m: CatalogMarket): ReplayMarket {
  const obs = (o: Outcome): PriceObs[] => { const p = m.outcomes.find((x) => x.outcome === o)?.refPrice; return p != null && m.refAsOf ? [{ at: m.refAsOf, price: p }] : [] }
  return {
    provider: m.provider, marketId: m.marketId, title: m.marketTitle, eventTitle: ev.eventTitle, category: m.category,
    listedAt: m.listedAt ?? null, closesAt: m.closesAt ?? null, resolution: m.resolution ?? null, fee: m.fee, observations: { YES: obs('YES'), NO: obs('NO') },
  }
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s))
const validPrice = (p: number | null) => p != null && p > 0 && p < 1

export interface ReplayIssues { period: string | null; capital: string | null; positions: Record<string, string> }

/** Validate a replay against the period, the market lifecycle and the funding accounts. */
export function validateReplay(r: Replay, today: string, accounts: ReplayAccount[]): ReplayIssues {
  let period: string | null = null
  if (!isDate(r.start) || !isDate(r.end)) period = 'Enter a start and an end date.'
  else if (r.start >= r.end) period = 'The end date must be after the start date.'
  else if (r.end > today) period = `A replay ends on or before today (${today}).`
  const funded = Object.entries(r.capital).filter(([, v]) => v > 0)
  const capital = funded.length ? null : 'Add starting capital to at least one account.'
  const positions: Record<string, string> = {}
  for (const p of r.positions) {
    const m = p.market, acct = accounts.find((a) => a.id === p.accountId), closes = m.resolution?.at ?? m.closesAt
    const e = !acct ? 'Choose a funding account.'
      : acct.venue !== m.provider ? 'This market trades on another venue than the funding account.'
      : !(r.capital[acct.id] > 0) ? `${acct.label} has no starting capital.`
      : !isDate(p.entryDate) ? 'Enter an entry date.'
      : !period && (p.entryDate < r.start || p.entryDate > r.end) ? 'The entry date must fall inside the replay period.'
      : m.listedAt && p.entryDate < m.listedAt ? `This market wasn’t listed until ${m.listedAt}.`
      : closes && p.entryDate >= closes ? `Trading closed on ${closes}.`
      : !validPrice(p.entryPrice) ? 'Enter the execution price you assume, between 0 and 1.'
      : p.size.value == null || !(p.size.value > 0) ? 'Enter a size greater than zero.'
      : p.size.mode === 'weight' && p.size.value > 100 ? 'A weight is at most 100% of the account’s starting capital.'
      : p.exit.kind === 'date' && !isDate(p.exit.date) ? 'Enter an exit date.'
      : p.exit.kind === 'date' && p.exit.date <= p.entryDate ? 'The exit date must be after the entry date.'
      : p.exit.kind === 'date' && p.exit.date > r.end ? 'The exit date must fall inside the replay period.'
      : p.exit.kind === 'date' && closes && p.exit.date >= closes ? `Trading closed on ${closes}; hold to settlement instead.`
      : p.exit.kind === 'date' && !validPrice(p.exit.price) ? 'Enter the exit price you assume, between 0 and 1.'
      : null
    if (e) positions[p.id] = e
  }
  return { period, capital, positions }
}
export const replayValid = (i: ReplayIssues) => !i.period && !i.capital && Object.keys(i.positions).length === 0

export interface ReplayCashEvent { date: string; accountId: string; positionId: string | null; kind: 'capital' | 'buy' | 'sell' | 'settlement'; amount: number | null; fee: number | null; note: string }
export interface ReplayLine {
  position: ReplayPosition; shares: number; cost: number; entryFee: number | null
  /** How the position ended within the period. */
  end: 'settled' | 'sold' | 'open'
  endDate: string
  /** Cash received on settlement or sale (after the exit fee), or null when unknown. */
  proceeds: number | null
  /** Open at the end: value at the end date from recorded prices (LOCF), or null when there is no eligible price. */
  endValue: number | null
  endBasis: ReturnType<typeof priceAt>['basis'] | null
  /** Net P&L = proceeds or end value − cost − fees; null when any part is unknown. */
  pnl: number | null
  realized: boolean
}
export interface ReplayAccountResult {
  account: ReplayAccount; capital: number; endCash: number | null; openValue: number | null; endValue: number | null
  /** Largest amount by which purchases exceeded the cash available at the time (0 = funded). */
  shortfall: number
  fees: number | null
}
export interface ReplayResult {
  replay: Replay
  lines: ReplayLine[]
  cash: ReplayCashEvent[]
  accounts: ReplayAccountResult[]
  /** Native totals per denomination. */
  byDenomination: { denomination: Denomination; capital: number; endValue: number | null; netPnl: number | null; ret: number | null }[]
  /** Combined indicative total; only when every denomination's value is known (1 USDC = 1 PUSD = 1 USD assumed). */
  combined: { capital: number; endValue: number; netPnl: number; ret: number | null; assumed: boolean } | null
  realizedPnl: number | null
  fees: number | null
  series: ValuedPoint[]
  quality: ReturnType<typeof seriesQuality>
  drawdown: ReturnType<typeof maxDrawdown>
  /** True when any selected market resolved before today: the selection used knowledge of the outcome. */
  hindsight: boolean
  /** Per market: whether listing and resolution are recorded, and on how many distinct times prices were recorded in the period. */
  evidence: { marketId: string; title: string; listed: boolean; resolution: boolean; observationsInPeriod: number }[]
}

function sharesOf(p: ReplayPosition, capital: number): number {
  const v = p.size.value ?? 0, price = p.entryPrice ?? 0
  if (!(price > 0)) return 0
  return floorQty(p.size.mode === 'shares' ? v : p.size.mode === 'amount' ? v / price : (capital * v) / 100 / price)
}

/** Weekly dates from start to end (end included). */
export function replayDates(start: string, end: string): string[] {
  const d: string[] = []
  const step = Math.max(1, Math.ceil(daysBetween(start, end) / 120))
  for (let x = start; x < end; x = addDays(x, step)) d.push(x)
  d.push(end)
  return d
}

/** Evaluate a valid replay. Results are exact for the stated assumptions; anything without evidence is null. */
export function runReplay(r: Replay, accounts: ReplayAccount[], today: string): ReplayResult {
  const lines: ReplayLine[] = []
  const cash: ReplayCashEvent[] = accounts.filter((a) => r.capital[a.id] > 0).map((a) => ({ date: r.start, accountId: a.id, positionId: null, kind: 'capital' as const, amount: r.capital[a.id], fee: 0, note: 'Starting capital' }))
  for (const p of r.positions) {
    const capital = r.capital[p.accountId] ?? 0
    const shares = sharesOf(p, capital), price = p.entryPrice ?? 0, cost = shares * price
    const entryFee = estimateFee(shares, price, p.market.fee, r.fees).amount
    cash.push({ date: p.entryDate, accountId: p.accountId, positionId: p.id, kind: 'buy', amount: -cost, fee: entryFee, note: `Buy ${p.outcome} at ${price}` })
    const res = p.market.resolution
    let line: ReplayLine
    if (p.exit.kind === 'date') {
      const exitPrice = p.exit.price ?? 0, fee = estimateFee(shares, exitPrice, p.market.fee, r.fees).amount
      const proceeds = fee == null ? null : shares * exitPrice - fee
      cash.push({ date: p.exit.date, accountId: p.accountId, positionId: p.id, kind: 'sell', amount: shares * exitPrice, fee, note: `Sell at ${exitPrice}` })
      line = { position: p, shares, cost, entryFee, end: 'sold', endDate: p.exit.date, proceeds, endValue: null, endBasis: null, realized: true, pnl: proceeds == null || entryFee == null ? null : proceeds - cost - entryFee }
    } else if (res && res.at <= r.end) {
      const proceeds = res.outcome === p.outcome ? shares : 0
      cash.push({ date: res.at, accountId: p.accountId, positionId: p.id, kind: 'settlement', amount: proceeds, fee: 0, note: `Resolved ${res.outcome}` })
      line = { position: p, shares, cost, entryFee, end: 'settled', endDate: res.at, proceeds, endValue: null, endBasis: null, realized: true, pnl: entryFee == null ? null : proceeds - cost - entryFee }
    } else {
      const pa = priceAt(hist(p), r.end)
      const endValue = pa.price == null ? null : shares * pa.price
      line = { position: p, shares, cost, entryFee, end: 'open', endDate: r.end, proceeds: null, endValue, endBasis: pa.basis, realized: false, pnl: endValue == null || entryFee == null ? null : endValue - cost - entryFee }
    }
    lines.push(line)
  }
  cash.sort((a, b) => (a.date === b.date ? order(a.kind) - order(b.kind) : a.date < b.date ? -1 : 1))

  const acctResults: ReplayAccountResult[] = accounts.filter((a) => r.capital[a.id] > 0 || r.positions.some((p) => p.accountId === a.id)).map((a) => {
    const evs = cash.filter((c) => c.accountId === a.id)
    let bal = 0, low = 0, known = true, fees = 0
    for (const c of evs) {
      if (c.amount == null || c.fee == null) { known = false; continue }
      bal += c.amount - c.fee; fees += c.fee
      if (bal < low) low = bal
    }
    const ls = lines.filter((l) => l.position.accountId === a.id && l.end === 'open')
    const openValue = ls.some((l) => l.endValue == null) ? null : ls.reduce((s, l) => s + (l.endValue ?? 0), 0)
    const endCash = known ? bal : null
    return { account: a, capital: r.capital[a.id] ?? 0, endCash, openValue, endValue: endCash == null || openValue == null ? null : endCash + openValue, shortfall: low < 0 ? -low : 0, fees: known ? fees : null }
  })

  const denoms = [...new Set(acctResults.map((a) => a.account.denomination))]
  const byDenomination = denoms.map((d) => {
    const as = acctResults.filter((a) => a.account.denomination === d), capital = as.reduce((s, a) => s + a.capital, 0)
    const endValue = as.some((a) => a.endValue == null) ? null : as.reduce((s, a) => s + (a.endValue ?? 0), 0)
    const netPnl = endValue == null ? null : endValue - capital
    return { denomination: d, capital, endValue, netPnl, ret: netPnl != null && capital > 0 ? netPnl / capital : null }
  })
  const allKnown = byDenomination.length > 0 && byDenomination.every((d) => d.endValue != null)
  const cCap = byDenomination.reduce((s, d) => s + d.capital, 0), cEnd = byDenomination.reduce((s, d) => s + (d.endValue ?? 0), 0)
  const combined = allKnown ? { capital: cCap, endValue: cEnd, netPnl: cEnd - cCap, ret: cCap > 0 ? (cEnd - cCap) / cCap : null, assumed: byDenomination.length > 1 } : null

  const realizedLines = lines.filter((l) => l.realized)
  const realizedPnl = realizedLines.some((l) => l.pnl == null) ? null : realizedLines.reduce((s, l) => s + (l.pnl ?? 0), 0)
  const fees = acctResults.some((a) => a.fees == null) ? null : acctResults.reduce((s, a) => s + (a.fees ?? 0), 0)

  // Value over time from recorded observations (LOCF). Points before an open holding's first observation are partial.
  const dates = replayDates(r.start, r.end)
  const instruments = r.positions.map(hist)
  const qtyAt = (key: string, date: string) => lines.filter((l) => hist(l.position).key === key && l.position.entryDate <= date && !(l.end !== 'open' && l.endDate <= date)).reduce((s, l) => s + l.shares, 0)
  const cashAt = (date: string) => cash.filter((c) => c.date <= date && c.amount != null).reduce((s, c) => s + (c.amount ?? 0) - (c.fee ?? 0), 0)
  const series = valueSeries(dates, instruments, qtyAt, cashAt)
  const quality = seriesQuality(series)

  return {
    replay: r, lines, cash, accounts: acctResults, byDenomination, combined, realizedPnl, fees, series, quality,
    drawdown: quality.complete ? maxDrawdown(series) : null,
    hindsight: r.positions.some((p) => !!p.market.resolution && p.market.resolution.at <= today),
    evidence: uniq(r.positions.map((p) => p.market)).map((m) => ({
      marketId: m.marketId, title: m.title, listed: !!m.listedAt, resolution: !!m.resolution,
      observationsInPeriod: new Set([...m.observations.YES, ...m.observations.NO].map((o) => o.at).filter((at) => at.slice(0, 10) >= r.start && at.slice(0, 10) <= r.end)).size,
    })),
  }
}
const order = (k: ReplayCashEvent['kind']) => ({ capital: 0, settlement: 1, sell: 2, buy: 3 })[k]
const hist = (p: ReplayPosition): InstrumentHistory => ({ key: `${p.market.provider}:${p.market.marketId}:${p.outcome}`, observations: p.market.observations[p.outcome], settledAt: p.market.resolution?.at ?? null, settlementValue: p.market.resolution ? (p.market.resolution.outcome === p.outcome ? 1 : 0) : null })
const uniq = (ms: ReplayMarket[]) => ms.filter((m, i) => ms.findIndex((x) => x.provider === m.provider && x.marketId === m.marketId) === i)

/* ───────────── Compare ─────────────
   Replays compare on a common basis only: absolute P&L when capital and denominations match, return when both are
   complete. Each difference in setup is listed so a reader can see what differs. */
export interface ReplayComparison {
  differences: { key: string; label: string; differs: boolean }[]
  /** Absolute net P&L is comparable (same capital per denomination). */
  pnlComparable: boolean
  /** Return is comparable (every replay complete). */
  returnComparable: boolean
}
export function compareReplays(rs: ReplayResult[]): ReplayComparison {
  const same = <T,>(f: (r: ReplayResult) => T) => new Set(rs.map((r) => JSON.stringify(f(r)))).size <= 1
  const capitalKey = (r: ReplayResult) => r.byDenomination.map((d) => [d.denomination, d.capital]).sort()
  const differences = [
    { key: 'period', label: 'Replay period', differs: !same((r) => [r.replay.start, r.replay.end]) },
    { key: 'markets', label: 'Selected markets', differs: !same((r) => r.replay.positions.map((p) => `${p.market.marketId}:${p.outcome}`).sort()) },
    { key: 'dates', label: 'Entry and exit dates', differs: !same((r) => r.replay.positions.map((p) => [p.market.marketId, p.entryDate, p.exit.kind === 'date' ? p.exit.date : 'settle']).sort()) },
    { key: 'sizing', label: 'Position sizes', differs: !same((r) => r.replay.positions.map((p) => [p.market.marketId, p.size.mode, p.size.value]).sort()) },
    { key: 'capital', label: 'Starting capital', differs: !same(capitalKey) },
    { key: 'execution', label: 'Execution prices', differs: !same((r) => r.replay.positions.map((p) => [p.market.marketId, p.entryPrice, p.exit.kind === 'date' ? p.exit.price : null]).sort()) },
    { key: 'fees', label: 'Fee assumption', differs: !same((r) => r.replay.fees) },
    { key: 'evidence', label: 'Evidence coverage', differs: !same((r) => r.quality.complete) },
  ]
  return { differences, pnlComparable: same(capitalKey), returnComparable: rs.every((r) => r.combined?.ret != null) }
}

/* ───────────── Storage ───────────── */
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const outcome = (v: unknown): Outcome | null => (v === 'YES' || v === 'NO' ? v : null)
function readObs(v: unknown): PriceObs[] { return Array.isArray(v) ? v.flatMap((o) => (isObj(o) && typeof o.at === 'string' && num(o.price) != null ? [{ at: o.at, price: o.price as number }] : [])) : [] }
function readMarket(v: unknown): ReplayMarket | null {
  if (!isObj(v) || (v.provider !== 'pm' && v.provider !== 'ks') || typeof v.marketId !== 'string' || typeof v.title !== 'string') return null
  const res = isObj(v.resolution) && outcome(v.resolution.outcome) && isDate(v.resolution.at) ? { outcome: v.resolution.outcome as Outcome, at: v.resolution.at as string } : null
  const obs = isObj(v.observations) ? v.observations : {}
  return {
    provider: v.provider, marketId: v.marketId, title: v.title, eventTitle: typeof v.eventTitle === 'string' ? v.eventTitle : v.title, category: typeof v.category === 'string' ? v.category : '',
    listedAt: isDate(v.listedAt) ? v.listedAt : null, closesAt: isDate(v.closesAt) ? v.closesAt : null, resolution: res,
    fee: isObj(v.fee) ? (v.fee as unknown as FeeSchedule) : null, observations: { YES: readObs(obs.YES), NO: readObs(obs.NO) },
  }
}
function readPosition(v: unknown): ReplayPosition | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.accountId !== 'string' || typeof v.entryDate !== 'string') return null
  const m = readMarket(v.market), o = outcome(v.outcome)
  const size = isObj(v.size) && (v.size.mode === 'shares' || v.size.mode === 'amount' || v.size.mode === 'weight') ? { mode: v.size.mode, value: num(v.size.value) } as ReplaySize : null
  const exit: ReplayExit | null = isObj(v.exit) ? (v.exit.kind === 'settle' ? { kind: 'settle' } : v.exit.kind === 'date' && typeof v.exit.date === 'string' ? { kind: 'date', date: v.exit.date, price: num(v.exit.price) } : null) : null
  if (!m || !o || !size || !exit) return null
  return { id: v.id, market: m, outcome: o, accountId: v.accountId, entryDate: v.entryDate, entryPrice: num(v.entryPrice), size, exit }
}
/** Validate stored replays. Invalid replays are dropped; invalid positions inside a replay are dropped. */
export function sanitizeReplays(raw: unknown): Replay[] | null {
  if (!Array.isArray(raw)) return null
  return raw.flatMap((v): Replay[] => {
    if (!isObj(v) || typeof v.key !== 'string' || typeof v.name !== 'string' || typeof v.start !== 'string' || typeof v.end !== 'string') return []
    const capital = isObj(v.capital) ? Object.fromEntries(Object.entries(v.capital).flatMap(([k, x]) => (num(x) != null && (x as number) >= 0 ? [[k, x as number]] : []))) : {}
    const positions = Array.isArray(v.positions) ? v.positions.map(readPosition).filter((p): p is ReplayPosition => !!p).slice(0, MAX_REPLAY_POSITIONS) : []
    return [{ key: v.key, name: v.name.slice(0, 80), color: typeof v.color === 'string' ? v.color : '', start: v.start, end: v.end, capital, fees: readFeeAssumption(v.fees), positions, basis: 'retrospective', createdAt: typeof v.createdAt === 'string' ? v.createdAt : '' }]
  })
}

/**
 * Shared, pure calculation layer. Every number on every page comes from here so pages can't disagree.
 *
 * Definitions (also shown in the UI's ⓘ tips):
 *  - Cost basis        Σ (shares × fill price + fill fee) of open positions: weighted-average cost with acquisition
 *                      fees capitalized, the same convention as the backend accounting replay (backend/docs/ACCOUNTING.md).
 *  - Unrealized P&L    Σ shares × mark − cost basis of open positions (after acquisition fees).
 *  - Realized P&L      Σ over closed trades of shares × (exit − entry) − that trade's fees.
 *  - Fees paid         closed-trade fees + fees on fills of still-open positions (the latter are inside cost basis).
 *  - Net P&L           realized P&L + unrealized P&L  (each fee counted once).
 *  - Net deposits      deposits − withdrawals. Never counted as performance.
 *  - Cash              net deposits + realized P&L − cost basis of open positions.
 *  These are sample-portfolio calculations. For actual portfolios the backend replay is the accounting authority;
 *  this module will consume its results rather than keep a second ledger (docs/DEVELOPMENT.md).
 *  - Portfolio value   cash + Σ shares × mark.   Identity: value − net deposits = net P&L.
 *  - Settlement payoff a contract pays $1 per share if its side wins, $0 otherwise.
 */
import { DEFAULT_FEES, estimateFee, type FeeAssumption, type FeeSchedule, type FeeStatus } from './fees'
import type { Denomination, PortfolioData, AccountRef, Category, ClosedTrade, DataSource, OpenPosition, Platform, RelClass, Relation, RiskEvent, Side } from '../data/types'
export type { RelClass, Relation }
export type { RelProvenance } from '../data/types'

export type PlatformFilter = 'all' | Platform
const inPlatform = (f: PlatformFilter, p: Platform) => f === 'all' || f === p
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)
export const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
export const daysBetween = (a: string, b: string) => Math.round((dayMs(b) - dayMs(a)) / 86400000)
export const addDays = (iso: string, d: number) => new Date(dayMs(iso) + d * 86400000).toISOString().slice(0, 10)
export const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
  new Date(dayMs(iso)).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })

/* ───────────── Positions ───────────── */
export interface Position extends OpenPosition {
  shares: number; avg: number; cost: number; fees: number; value: number; upl: number
  ifWin: number; ifLose: number; days: number; opened: string
}
/* ───────────── Closed trades ───────────── */
export const tradeGross = (t: ClosedTrade) => t.shares * (t.exit - t.entry)
export const tradeNet = (t: ClosedTrade) => tradeGross(t) - t.fees
export const isResolved = (t: ClosedTrade) => t.outcome !== 'Closed early'
// note: `start` is exclusive so consecutive periods never double count a trade.

/* ───────────── Account at a date ───────────── */
export interface Account {
  netDeposits: number; cash: number; positionsValue: number; totalValue: number; committed: number
  unrealized: number; openFees: number; realized: number; closedFees: number; fees: number; netPnl: number
  wins: number; resolved: number; closedCount: number; openCount: number; feeEstimates: number
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
export interface SeriesPoint { date: string; deposits: number; netPnl: number; value: number }
/* ───────────── Periods ───────────── */
export const PERIODS = ['1W', '1M', '3M', '6M', 'YTD', '1Y', 'All'] as const
export type Period = (typeof PERIODS)[number]
export interface Range { start: string; end: string }
const DAYS: Partial<Record<Period, number>> = { '1W': 7, '1M': 30, '3M': 91, '6M': 182, '1Y': 365 }
const fmtLong = (d: string) => fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' })
export interface PeriodStats {
  /** netPnl = realized + unrealizedChange. Fees on fills of open positions are inside unrealizedChange (they are part
   *  of cost basis); openFillFees reports how much of it they are.
   *  realized counts each trade closed in the period in full, including P&L that built up before the period
   *  started; that earlier part reappears as a negative unrealizedChange, so the sum stays correct. */
  netPnl: number; realized: number; unrealizedChange: number; openFillFees: number; fees: number; trades: ClosedTrade[]
  wins: number; losses: number; resolved: number; winRate: number | null; avgWin: number | null; avgLoss: number | null
  profitFactor: number | null; months: { month: string; realized: number }[]
  drawdown: { amount: number; from: string; to: string; recoveredOn: string | null } | null
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
/** Only verified facts and a scenario's own hypothetical assumptions can remove joint outcomes. Annotations never do. */
export const constrains = (r: Relation) => (r.cls === 'mutex' || r.cls === 'equivalent') && r.provenance !== 'annotation'
const samePair = (r: { a: string; b: string }, a: string, b: string) => (r.a === a && r.b === b) || (r.a === b && r.b === a)
export function pairRelation(a: string, b: string, rels: Relation[]): RelClass | null {
  if (a === b) return 'equivalent'
  return findRelation(a, b, rels)?.cls ?? null
}
/** The relationship that applies to a pair: a verified fact wins over anything else; then a hypothetical constraint. */
export function findRelation(a: string, b: string, rels: Relation[]): Relation | null {
  const all = rels.filter((r) => samePair(r, a, b))
  return all.find((r) => r.provenance === 'verified') ?? all.find((r) => r.provenance === 'hypothetical') ?? all[0] ?? null
}
/** A scenario's hypothetical constraint (never a fact; never used by Risk). */
export interface Constraint { a: string; b: string; cls: 'mutex' | 'equivalent' }
/** Source relationships plus a scenario's hypothetical constraints. A pair with a verified relationship keeps it:
 *  a hypothetical constraint can't override a fact. Duplicates for the same pair keep the first. */
export function withConstraints(base: Relation[], cs: Constraint[] = []): Relation[] {
  const out = [...base]
  for (const c of cs) {
    if (c.a === c.b || out.some((r) => samePair(r, c.a, c.b) && (r.provenance === 'verified' || r.provenance === 'hypothetical'))) continue
    out.push({ a: c.a, b: c.b, cls: c.cls, provenance: 'hypothetical' })
  }
  return out
}
/** A joint outcome is feasible unless it breaks a constraint that applies (see `constrains`):
 *  mutually exclusive → both can't resolve YES; equivalent → must resolve the same way.
 *  Related, unknown and unclassified pairs impose no constraint. This is logical feasibility, not probability:
 *  excluding a combination changes the deterministic settlement range, never how likely anything is. */
export function isFeasible(o: Record<string, Outcome>, rels: Relation[]) {
  return rels.every((r) => {
    if (!constrains(r)) return true
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
export type RangeIssue = 'too-many-events' | 'no-feasible-outcome'
/** Why a range is unavailable, or null when it can be computed. */
export function rangeIssue(ids: string[], rels: Relation[]): RangeIssue | null {
  if (ids.length > MAX_JOINT_EVENTS) return 'too-many-events'
  for (const o of jointOutcomes(ids)) if (isFeasible(o, rels)) return null
  return ids.length ? 'no-feasible-outcome' : null
}
/** Min/max of `fn` over feasible joint outcomes only. Impossible combinations are excluded, never patched afterwards.
 *  Returns null when there are too many events to enumerate exactly, or when the constraints leave no feasible
 *  outcome (an inconsistent constraint set): never Infinity or a fabricated range. */
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
  if (feasible === 0) return null
  return { min, max, argmin, argmax, feasible, excluded }
}

/** Constraining relations in the connected component of `seed` events (relations linked through other events). */
export function constraintComponent(seed: string[], eventIds: string[], rels: Relation[]) {
  const active = rels.filter((r) => constrains(r) && eventIds.includes(r.a) && eventIds.includes(r.b))
  const comp = new Set(seed)
  for (let grew = true; grew;) {
    grew = false
    for (const r of active) if (comp.has(r.a) !== comp.has(r.b)) { comp.add(r.a); comp.add(r.b); grew = true }
  }
  return { events: [...comp], relations: active.filter((r) => comp.has(r.a) && comp.has(r.b)) }
}
/** Is a partial outcome (e.g. two events of a matrix) possible given every constraint in the portfolio, including
 *  implications through other events (A ≡ B and B × C exclusive ⇒ A and C can't both be YES)? Returns null when the
 *  linked component is too large to check exactly. */
export function partialFeasible(o: Record<string, Outcome>, eventIds: string[], rels: Relation[]): boolean | null {
  const { events, relations } = constraintComponent(Object.keys(o), eventIds, rels)
  const free = events.filter((e) => !(e in o))
  if (free.length > MAX_JOINT_EVENTS) return null
  for (const rest of jointOutcomes(free)) if (isFeasible({ ...rest, ...o }, relations)) return true
  return false
}

/* ───────────── Holdings (base portfolio or a scenario) ───────────── */
/** One holding in a portfolio being evaluated (the actual portfolio or a hypothetical one).
 *  `mark` is the valuation price; null when no reference price is available (value is then unavailable, never 0). */
export interface Holding {
  id: string; eventId: string; platform: Platform; side: Side; shares: number; cost: number; mark: number | null
  category: Category; title: string; eventTitle: string
  /** Provider-native market id (identity of the contract, independent of account or position id). */
  marketId: string
  /** Resolution date of the market (when known). Not a confirmed cash-redemption date. */
  resolves: string
  /** Account holding it; null for a hypothetical new instrument (funded from the scenario's cash on its venue). */
  accountId: string | null
  /** Fee parameters for hypothetical trades in this market; null/undefined = unavailable. */
  fee?: FeeSchedule | null
  /** True for an instrument that isn't in the starting portfolio (a hypothetical new position). */
  isNew?: boolean
}
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
/** How to name an outcome for an exposure: relative to the user's side when single-sided, plain YES/NO when mixed. */
export const outcomeLabel = (e: Pick<EventExposure, 'side'>, o: Outcome) => (e.side === 'Mixed' ? `If ${o}` : `If ${o} (${o === e.side ? 'for you' : 'against you'})`)

/** Settlement range over feasible joint outcomes (P&L vs. cost basis) for the given holdings. */
export function settlementRange(hs: Holding[], rels: Relation[]): OutcomeRange | null {
  const ids = [...new Set(hs.filter((h) => h.shares > 0).map((h) => h.eventId))]
  return outcomeRange(ids, rels, (o) => sum(ids, (id) => eventPnl(hs, id, o[id])))
}

/* ───────────── Scenario simulation ───────────── */
/** Provider-native reference to one outcome of a binary market. Mirrors the backend's canonical identity
 *  (provider + external event / market / outcome ids) without copying its schema. Reference prices are
 *  snapshots with a timestamp; they are never quotes. */
export interface InstrumentRef {
  provider: Platform; eventId: string; eventTitle: string; marketId: string; marketTitle: string
  outcome: Outcome; category: Category; resolves: string
  refPrice: number | null; refAsOf: string | null
  /** Where the market data came from: the bundled sample catalog, or (later) a live provider lookup. */
  source: 'sample' | 'provider'
  /** The market's fee parameters as known when the instrument was selected (null = unavailable). */
  fee?: FeeSchedule | null
  /** Provider-native outcome/instrument id when known (null for fixture data); identity is provider + marketId +
   *  outcome, and this id binds it to the backend's canonical instrument at integration. */
  nativeOutcomeId?: string | null
  /** Native settlement asset when established (null = not established). */
  denomination?: Denomination | null
}
export const instrumentKey = (i: Pick<InstrumentRef, 'provider' | 'marketId' | 'outcome'>) => `${i.provider}:${i.marketId}:${i.outcome}`
/** A hypothetical change: hold `to` shares of an instrument, trading at the assumed `price`.
 *  `id` is the actual position id when the instrument is held, otherwise its instrument key.
 *  null `to` / `price` mean "not entered yet": the row is excluded from results and blocks Save. */
export interface Adjustment {
  id: string; to: number | null; price: number | null; instrument?: InstrumentRef
  /** When set, the target is a capital amount instead of a share count: `amount` = target position value at the
   *  assumed price; `weight` = % of the scenario's starting value at reference marks (cash and added capital included).
   *  Shares are derived from it at the assumed price (rounded down to the quantity step), so the intended
   *  investment is what the user typed. `to` is then ignored. */
  size?: { by: 'amount' | 'weight'; value: number }
}
/** Where a scenario starts: the user's current portfolio (holdings + cash from sources), or an empty portfolio. */
export type Baseline = 'portfolio' | 'scratch'
export interface SimOptions {
  /** How fees on the scenario's hypothetical trades are treated (default: provider estimate, taker). */
  fees?: FeeAssumption
  baseline?: Baseline
  /** Hypothetical capital added per platform. Contributed capital, never profit; cash isn't moved between platforms. */
  funding?: Partial<Record<Platform, number>>
}
/** Safety limits for hypothetical inputs (calculation reliability, not provider rules). */
export const MAX_SHARES = 10_000_000, MAX_FUNDING = 100_000_000
/** Hypothetical quantity step: 0.01 share. Venue lot sizes aren't enforced (no provider metadata yet); a real
 *  increment will come from instrument data. */
export const QTY_DECIMALS = 2
const onStep = (v: number) => Math.abs(v * 10 ** QTY_DECIMALS - Math.round(v * 10 ** QTY_DECIMALS)) < 1e-6
export const floorQty = (v: number) => Math.floor(v * 10 ** QTY_DECIMALS + 1e-9) / 10 ** QTY_DECIMALS
export function validateQty(v: number | null) {
  if (v == null || !Number.isFinite(v)) return 'Enter a target quantity'
  if (v < 0 || v > MAX_SHARES) return `Quantity must be between 0 and ${MAX_SHARES.toLocaleString('en-US')}`
  if (!onStep(v)) return `Use at most ${QTY_DECIMALS} decimals`
  return null
}
export const MAX_WEIGHT_PCT = 100
/** Target shares of an adjustment: typed shares, or derived from an amount or weight at the assumed price. */
export function targetShares(a: Adjustment, startValue: number | null): { to: number | null; error: string | null } {
  if (!a.size) return { to: a.to, error: null }
  const { by, value } = a.size
  if (!Number.isFinite(value)) return { to: null, error: by === 'amount' ? 'Enter a target amount' : 'Enter a percentage' }
  if (by === 'amount' && (value < 0 || value > MAX_FUNDING)) return { to: null, error: `Amount must be between $0 and $${MAX_FUNDING.toLocaleString('en-US')}` }
  if (by === 'weight' && (value < 0 || value > MAX_WEIGHT_PCT)) return { to: null, error: `Use 0–${MAX_WEIGHT_PCT}% of the starting value` }
  if (a.price == null || !Number.isFinite(a.price) || a.price <= 0) return { to: null, error: 'Enter an assumed price' }
  const amount = by === 'amount' ? value : startValue == null ? null : (value / 100) * startValue
  if (amount == null) return { to: null, error: 'Starting value is unavailable, so a % target can’t be converted' }
  return { to: Math.min(MAX_SHARES, floorQty(amount / a.price)), error: null }
}
export const validFunding = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_FUNDING
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
  /** Per traded position: how its fee was determined. 'unavailable' fees are not in the totals. */
  feeStatusBy: Record<string, FeeStatus>
  /** Positions whose fee couldn't be estimated (no fee parameters). Their cash and P&L are before fees. */
  feesUnavailable: string[]
  /** Resolved target shares per adjustment (typed, or derived from an amount / weight). */
  targets: Record<string, number>
  /** Executed hypothetical trades: signed quantity (+ buy, − sell) at the assumed price. */
  trades: Record<string, { qty: number; price: number }>
  /** Starting value at reference marks (the denominator of % targets); null when a mark is missing. */
  startValue: number | null
}
export const MIN_PRICE = 0.01, MAX_PRICE = 0.99
export function validatePrice(v: number) {
  if (!Number.isFinite(v)) return 'Enter a number'
  if (v < MIN_PRICE || v > MAX_PRICE) return 'Price must be between $0.01 and $0.99'
  return null
}
export interface ScenarioMetrics {
  /** positionsValue / totalValue are null when a held instrument has no reference price. */
  cash: number; positionsValue: number | null; totalValue: number | null; committed: number; realized: number; fees: number
  /** null when the joint-outcome range can't be computed (see rangeIssue). */
  worstValue: number | null; bestValue: number | null; worst: Record<string, Outcome>; best: Record<string, Outcome>; excluded: number
  /** Largest settlement loss of a single event, with opposing holdings netted. */
  largestEventLoss: number
  /** No invalid inputs. */
  valid: boolean
  /** Total extra cash needed across platforms (0 when the scenario fits current balances). */
  shortfall: number
  /** Why best/worst are unavailable, if they are. */
  rangeIssue: RangeIssue | null
  /** Number of trades whose fee couldn't be estimated; cash, value and fees then exclude those fees. */
  feesUnavailable: number
}
/** Everything is expressed as portfolio value (cash + holdings) so a purchase can never look like profit:
 *  buying moves cash into contracts; at mark it costs the spread and fees; only settlement changes the range. */
export function scenarioMetrics(sim: Simulation, rels: Relation[]): ScenarioMetrics {
  const hs = Object.values(sim.holdings).filter((h) => h.shares > 0)
  const cash = sim.cash.pm + sim.cash.ks
  const positionsValue = hs.some((h) => h.mark == null) ? null : sum(hs, (h) => h.shares * h.mark!)
  const committed = sum(hs, (h) => h.cost)
  const ids = [...new Set(hs.map((h) => h.eventId))]
  const range = ids.length ? outcomeRange(ids, rels, (o) => sum(hs, (h) => payout(h, o[h.eventId]))) : { min: 0, max: 0, argmin: {}, argmax: {}, feasible: 1, excluded: 0 }
  const issue = range ? null : rangeIssue(ids, rels)
  // Worst settlement of each event on its own, using each holding's side (opposing holdings offset).
  const largestEventLoss = Math.max(0, ...ids.map((id) => -Math.min(eventPnl(hs, id, 'YES'), eventPnl(hs, id, 'NO'))))
  return {
    cash, positionsValue, totalValue: positionsValue == null ? null : cash + positionsValue, committed, realized: sim.realized, fees: sim.fees,
    worstValue: range ? cash + range.min : null, bestValue: range ? cash + range.max : null, worst: range?.argmin ?? {}, best: range?.argmax ?? {},
    excluded: range?.excluded ?? 0, largestEventLoss, valid: Object.keys(sim.errors).length === 0, shortfall: sim.shortfall.pm + sim.shortfall.ks, rangeIssue: issue, feesUnavailable: sim.feesUnavailable.length,
  }
}

/** P&L of the positions in `eventIds` for a joint outcome, including realized P&L and fees from the scenario's own trades.
 *  Buy fees are inside cost basis; sale fees are inside realizedBy. */
export function groupPnl(sim: Simulation, eventIds: string[], o: Record<string, Outcome>) {
  const hs = Object.values(sim.holdings).filter((h) => eventIds.includes(h.eventId))
  let v = 0
  for (const h of hs) {
    v += (h.shares > 0 ? payout(h, o[h.eventId]) - h.cost : 0)
    v += sim.realizedBy[h.id] ?? 0
  }
  return v
}

/* ───────────── Allocation of any holdings (actual or hypothetical) ───────────── */
export type AllocationBy = 'category' | 'platform' | 'event'
export interface HoldingsAllocation {
  /** Open-position market value (cash excluded); null when a held instrument has no reference price. */
  total: number | null
  segments: { key: string; label: string; value: number; share: number | null; ids: string[] }[]
}
/** Market-value allocation of holdings with shares, grouped by category, platform or event. Denominator: open-position
 *  market value of these holdings (cash excluded). Different from capital committed and from settlement loss. */
export function holdingsAllocation(hs: Holding[], by: AllocationBy): HoldingsAllocation {
  const live = hs.filter((h) => h.shares > 0)
  if (live.some((h) => h.mark == null)) return { total: null, segments: [] }
  const total = sum(live, (h) => h.shares * h.mark!)
  const groups = new Map<string, { label: string; value: number; ids: string[] }>()
  for (const h of live) {
    const key = by === 'category' ? h.category : by === 'platform' ? h.platform : h.eventId
    const label = by === 'category' ? h.category : by === 'platform' ? (h.platform === 'pm' ? 'Polymarket' : 'Kalshi') : h.eventTitle
    const g = groups.get(key) ?? { label, value: 0, ids: [] }
    g.value += h.shares * h.mark!; g.ids.push(h.id); groups.set(key, g)
  }
  return { total, segments: [...groups.entries()].map(([key, g]) => ({ key, ...g, share: total > 0 ? g.value / total : null })).sort((a, b) => b.value - a.value) }
}

/* ───────────── Allocation ───────────── */
export interface AllocationSegment {
  key: string; value: number
  /** Share of open-position market value in scope (cash excluded). */
  share: number
  positions: { p: Position; shareOfSegment: number; shareOfOpen: number }[]
}
/* ───────────── Scenario analysis (Scenario Lab › Analyze) ───────────── */
/** How the value at reference marks moves from the start to the scenario. Purchases and sales move value between
 *  cash and holdings, so only the gap between the assumed price and the mark, and fees, change it. Added capital is
 *  contributed capital, never a gain. Null when a mark is missing (value unavailable). */
export interface ValueBridge { before: number; added: number; execution: number; fees: number; after: number; feesUnavailable: number }
/** Per event: capital committed, value at mark and settlement P&L in each outcome (opposing holdings netted). */
export interface EventProfile { id: string; title: string; resolves: string; cost: number; value: number | null; pnl: Record<Outcome, number>; worst: number; mixed: boolean; ids: string[] }
/** Display name of a settlement group: its event title, or the market title when another group in the same
 *  portfolio shares that event title (e.g. two markets of one multi-market event). */
export function groupTitles(hs: Holding[]): Record<string, string> {
  const byTitle = new Map<string, Set<string>>()
  for (const h of hs) byTitle.set(h.eventTitle, (byTitle.get(h.eventTitle) ?? new Set()).add(h.eventId))
  const out: Record<string, string> = {}
  for (const h of hs) if (!(h.eventId in out)) out[h.eventId] = (byTitle.get(h.eventTitle)?.size ?? 1) > 1 ? h.title : h.eventTitle
  return out
}
export function eventProfiles(sim: Simulation): EventProfile[] {
  const hs = Object.values(sim.holdings).filter((h) => h.shares > 0)
  const ids = [...new Set(hs.map((h) => h.eventId))], names = groupTitles(hs)
  return ids.map((id) => {
    const g = hs.filter((h) => h.eventId === id)
    const pnl = { YES: eventPnl(g, id, 'YES'), NO: eventPnl(g, id, 'NO') }
    return {
      id, title: names[id], resolves: g.map((h) => h.resolves).sort()[0] ?? '', cost: sum(g, (h) => h.cost),
      value: g.some((h) => h.mark == null) ? null : sum(g, (h) => h.shares * h.mark!), pnl, worst: Math.min(pnl.YES, pnl.NO),
      mixed: new Set(g.map((h) => h.side)).size > 1, ids: g.map((h) => h.id),
    }
  })
}

/* ───────────── Portfolio-bound calculations ─────────────
   Everything that reads a portfolio is created per portfolio by `createFinance(data)`. Pages get the instance for the
   selected workspace through `useFinance()` (lib/financeContext.tsx); nothing reads a global portfolio. The bundled
   fixture instance lives in lib/fixtureFinance.ts and is used only by the fixture workspace service and tests. */
export function createFinance(P: PortfolioData) {
  const PORTFOLIO = P, TODAY = P.asOf, HISTORY_START = P.historyStart, LAST_VISIT = P.lastVisit
  const CASH_FLOWS = P.cashFlows, OPEN_POSITIONS = P.openPositions, CLOSED_TRADES = P.closedTrades, EVENTS = P.events
  /* ───────────── Sources & coverage ───────────── */
  const sourceOf = (p: Platform): DataSource => PORTFOLIO.sources[p] ?? { label: p === 'pm' ? 'Polymarket' : 'Kalshi', asOf: TODAY, stale: false }
  /** What a source's numbers are based on: open positions, fills, settlements, and how many fees are estimates. */
  function coverage(p: Platform) {
    const open = OPEN_POSITIONS.filter((x) => x.platform === p), closed = CLOSED_TRADES.filter((t) => t.platform === p)
    return {
      open: open.length,
      fills: open.reduce((a, x) => a + x.fills.length, 0) + closed.reduce((a, t) => a + (t.outcome === 'Closed early' ? 2 : 1), 0),
      settlements: closed.filter((t) => t.outcome !== 'Closed early').length,
      feeEstimates: closed.filter((t) => !t.feeKnown).length,
    }
  }

  /* ───────────── Accounts ───────────── */
  /** Financial accounts in the portfolio. An account belongs to one venue and can be fed by several acquisition
   *  sources (API sync, CSV import, manual records). A venue is not an account, and a source is not a venue. */
  const ACCOUNTS: AccountRef[] = PORTFOLIO.accounts
  const accountOf = (id: string) => ACCOUNTS.find((a) => a.id === id)
  const accountsOn = (venue: Platform) => ACCOUNTS.filter((a) => a.venue === venue)

  /** Weighted-average cost with acquisition fees in the basis (backend convention). */
  function derivePosition(p: OpenPosition): Position {
    const shares = sum(p.fills, (f) => f.shares), fees = sum(p.fills, (f) => f.fee), cost = sum(p.fills, (f) => f.shares * f.price) + fees
    const value = shares * p.mark
    return {
      ...p, shares, cost, avg: cost / shares, fees, value, upl: value - cost,
      ifWin: shares - cost, ifLose: -cost, days: daysBetween(TODAY, p.resolves), opened: p.fills[0].date,
    }
  }
  const POSITIONS: Position[] = OPEN_POSITIONS.map(derivePosition)
  const POS_BY_ID: Record<string, Position> = Object.fromEntries(POSITIONS.map((p) => [p.id, p]))
  const positionsFor = (f: PlatformFilter) => POSITIONS.filter((p) => inPlatform(f, p.platform))

  const tradesIn = (f: PlatformFilter, start = HISTORY_START, end = TODAY) =>
    CLOSED_TRADES.filter((t) => inPlatform(f, t.platform) && t.closed > start && t.closed <= end)
  function account(f: PlatformFilter = 'all'): Account {
    const flows = CASH_FLOWS.filter((c) => inPlatform(f, c.platform) && c.date <= TODAY)
    const closed = CLOSED_TRADES.filter((t) => inPlatform(f, t.platform) && t.closed <= TODAY)
    const pos = positionsFor(f)
    const netDeposits = sum(flows, (c) => c.amount)
    const realized = sum(closed, tradeNet), closedFees = sum(closed, (t) => t.fees)
    const committed = sum(pos, (p) => p.cost), openFees = sum(pos, (p) => p.fees)
    const positionsValue = sum(pos, (p) => p.value), unrealized = positionsValue - committed
    // committed already includes fees on open fills (cost basis), so they are subtracted once.
    const cash = netDeposits + realized - committed
    const resolved = closed.filter(isResolved)
    return {
      netDeposits, cash, positionsValue, totalValue: cash + positionsValue, committed, unrealized, openFees, realized, closedFees,
      fees: closedFees + openFees, netPnl: realized + unrealized, wins: resolved.filter((t) => t.outcome === 'Won').length,
      resolved: resolved.length, closedCount: closed.length, openCount: pos.length, feeEstimates: closed.filter((t) => !t.feeKnown).length,
    }
  }

  function markAt(p: OpenPosition, date: string) {
    if (date >= TODAY) return p.mark
    if (date >= LAST_VISIT) return pathPrice(`${p.id}b`, LAST_VISIT, p.markAtLastVisit, TODAY, p.mark, date)
    return pathPrice(p.id, p.fills[0].date, p.fills[0].price, LAST_VISIT, p.markAtLastVisit, date)
  }

  /** Cumulative net P&L up to and including `date` (same formula as `account` at TODAY). */
  function netPnlAt(f: PlatformFilter, date: string) {
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
  const depositsAt = (f: PlatformFilter, date: string) => sum(CASH_FLOWS.filter((c) => inPlatform(f, c.platform) && c.date <= date), (c) => c.amount)

  function series(f: PlatformFilter, start = HISTORY_START, end = TODAY): SeriesPoint[] {
    const dates: string[] = []
    for (let d = start; d < end; d = addDays(d, 7)) dates.push(d)
    dates.push(end)
    return dates.map((date) => { const deposits = depositsAt(f, date), netPnl = netPnlAt(f, date); return { date, deposits, netPnl, value: deposits + netPnl } })
  }

  const startOf = (p: Period, end: string) => p === 'YTD' ? `${Number(end.slice(0, 4)) - 1}-12-31` : p === 'All' ? HISTORY_START : addDays(end, -(DAYS[p] ?? 0))
  /** A preset period is available only when the history covers its whole span ("All" always is). */
  const periodAvailable = (p: Period) => p === 'All' || startOf(p, TODAY) >= addDays(HISTORY_START, -1)
  /** A preset period, or a custom range (dates are period boundaries: changes after `start`, up to and including `end`). */
  function periodRange(p: Period | Range): Range & { label: string; prior: Range | null } {
    if (typeof p !== 'string') {
      const len = daysBetween(p.start, p.end), prior0 = { start: addDays(p.start, -len), end: p.start }
      return { ...p, label: `${fmtLong(addDays(p.start, 1))} – ${fmtLong(p.end)}`, prior: prior0.start < addDays(HISTORY_START, -1) ? null : prior0 }
    }
    const end = TODAY
    const start = startOf(p, end)
    // Prior period: the same calendar span one year earlier for YTD, otherwise the window of equal length just before.
    const prior0 = p === 'YTD' ? { start: `${Number(end.slice(0, 4)) - 2}-12-31`, end: `${Number(end.slice(0, 4)) - 1}${end.slice(4)}` } : { start: addDays(start, -daysBetween(start, end)), end: start }
    const prior = p === 'All' || prior0.start < addDays(HISTORY_START, -1) ? null : prior0
    return { start, end, label: `${fmtLong(addDays(start, 1))} – ${fmtLong(end)}`, prior }
  }
  /** Validate a custom range against the history: start before end, both inside [history start, data date]. */
  function customRangeIssue(r: Range): string | null {
    const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d))
    if (!ok(r.start) || !ok(r.end)) return 'Enter both dates.'
    if (r.start >= r.end) return 'The end date must be after the start date.'
    if (r.start < HISTORY_START) return `History starts on ${fmtLong(HISTORY_START)}.`
    if (r.end > TODAY) return `Data runs to ${fmtLong(TODAY)}.`
    return null
  }

  function periodStats(f: PlatformFilter, r: Range): PeriodStats {
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
      netPnl, realized, unrealizedChange: netPnl - realized, openFillFees, fees: sum(trades, (t) => t.fees) + openFillFees, trades,
      wins: wins.length, losses: res.length - wins.length, resolved: res.length, winRate: res.length ? wins.length / res.length : null,
      avgWin: posNet.length ? grossWin / posNet.length : null, avgLoss: negNet.length ? grossLoss / negNet.length : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null, months, drawdown: dd,
    }
  }

  /** Relationships from the portfolio's sources: verified facts and descriptive annotations. Risk uses these only;
   *  scenarios may add their own hypothetical constraints on top (see `withConstraints`). */
  const sourceRelations = (): Relation[] => PORTFOLIO.relations
  const eventName = (id: string) => EVENTS.find((e) => e.id === id)?.name ?? id
  const baseHoldings = (): Record<string, Holding> =>
    Object.fromEntries(POSITIONS.map((p) => [p.id, { id: p.id, eventId: p.eventId, platform: p.platform, side: p.side, shares: p.shares, cost: p.cost, mark: p.mark, category: p.category, title: p.market, eventTitle: eventName(p.eventId), marketId: p.marketId, resolves: p.resolves, accountId: p.accountId, fee: p.feeSchedule }]))
  function exposures(f: PlatformFilter = 'all'): EventExposure[] {
    const pos = positionsFor(f), total = sum(pos, (p) => p.cost)
    return EVENTS.map((event) => {
      const ps = pos.filter((p) => p.eventId === event.id)
      return ps.length ? eventExposureOf(event, ps, total) : null
    }).filter((x): x is EventExposure => x !== null).sort((a, b) => b.cost - a.cost)
  }
  /** Settlement range for a subset of events (e.g. a table filter), or null when the subset is empty.
   *  Relationships still apply inside the subset. Portfolio-level figures must use `settlementRange` on all holdings. */
  function settlementRangeFor(eventIds: string[], rels: Relation[]) {
    const ids = new Set(eventIds)
    const hs = Object.values(baseHoldings()).filter((h) => ids.has(h.eventId))
    return hs.length ? settlementRange(hs, rels) : null
  }

  /** Instrument reference for a position the user actually holds (so it can also be used from scratch). */
  const instrumentOfPosition = (p: Position): InstrumentRef => ({
    provider: p.platform, eventId: p.eventId, eventTitle: eventName(p.eventId), marketId: p.marketId, marketTitle: p.market, outcome: p.side,
    category: p.category, resolves: p.resolves, refPrice: p.mark, refAsOf: sourceOf(p.platform).asOf, source: 'sample', fee: p.feeSchedule,
  })
  /** Every actual holding of exactly this instrument (same provider, market and outcome), one per account. Sharing an
   *  event and a side is not enough: different markets are different contracts. */
  const holdingsOfInstrument = (i: Pick<InstrumentRef, 'provider' | 'marketId' | 'outcome'>, ps: Position[] = POSITIONS) =>
    ps.filter((p) => p.platform === i.provider && p.marketId === i.marketId && p.side === i.outcome)
  /** The single actual holding of an instrument, or undefined when none or several accounts hold it. With several,
   *  the caller must ask which account is meant; it never silently picks the first. */
  const positionFor = (i: Pick<InstrumentRef, 'provider' | 'marketId' | 'outcome'>, ps: Position[] = POSITIONS) => {
    const hs = holdingsOfInstrument(i, ps)
    return hs.length === 1 ? hs[0] : undefined
  }
  /** Starting value at reference marks (cash + positions), or null when a mark is missing. Denominator of `weight`. */
  function startingValue(baseline: Baseline = 'portfolio', funding: Partial<Record<Platform, number>> = {}) {
    const { holdings, cash } = startingPoint(baseline, funding)
    const hs = Object.values(holdings)
    return hs.some((h) => h.mark == null) ? null : cash.pm + cash.ks + sum(hs, (h) => h.shares * h.mark!)
  }
  /** Starting holdings and cash for a baseline, plus any added capital. */
  function startingPoint(baseline: Baseline = 'portfolio', funding: Partial<Record<Platform, number>> = {}) {
    const holdings: Record<string, Holding> = baseline === 'scratch' ? {} : baseHoldings()
    const cash: Record<Platform, number> = baseline === 'scratch' ? { pm: 0, ks: 0 } : { pm: account('pm').cash, ks: account('ks').cash }
    for (const p of ['pm', 'ks'] as Platform[]) if (validFunding(funding[p])) cash[p] += funding[p]!
    return { holdings, cash }
  }
  function simulate(adjs: Adjustment[], opts: SimOptions): Simulation {
    const { holdings, cash } = startingPoint(opts.baseline, opts.funding)
    const startValue = startingValue(opts.baseline, opts.funding)
    const targets: Record<string, number> = {}, trades: Record<string, { qty: number; price: number }> = {}
    let realized = 0, fees = 0
    const feeMode = opts.fees ?? DEFAULT_FEES
    const errors: Record<string, string> = {}, realizedBy: Record<string, number> = {}, feesBy: Record<string, number> = {}
    const feeStatusBy: Record<string, FeeStatus> = {}, feesUnavailable: string[] = []
    for (const a of adjs) {
      const t = targetShares(a, startValue)
      if (t.error) { errors[a.id] = t.error; continue }
      const qtyErr = validateQty(t.to)
      if (qtyErr) { errors[a.id] = qtyErr; continue }
      if (a.price == null) { errors[a.id] = 'Enter an assumed price'; continue }
      const priceErr = validatePrice(a.price)
      if (priceErr) { errors[a.id] = priceErr; continue }
      let h = holdings[a.id]
      if (!h) {
        // Not in the starting portfolio: a hypothetical new holding from zero, valued at its reference price.
        const i = a.instrument
        if (!i) { errors[a.id] = 'Not in this starting portfolio'; continue }
        h = holdings[a.id] = { id: a.id, eventId: i.eventId, platform: i.provider, side: i.outcome, shares: 0, cost: 0, mark: i.refPrice, category: i.category, title: i.marketTitle, eventTitle: i.eventTitle, marketId: i.marketId, resolves: i.resolves, accountId: null, fee: i.fee ?? null, isNew: true }
      }
      const to = t.to!
      targets[a.id] = to
      const d = to - h.shares
      if (Math.abs(d) < 1e-9) continue
      trades[a.id] = { qty: d, price: a.price }
      const notional = Math.abs(d) * a.price
      const est = estimateFee(d, a.price, h.fee, feeMode)
      // An unavailable fee is never treated as zero silently: it is flagged, and affected figures are labelled pre-fee.
      const fee = est.amount ?? 0
      feeStatusBy[a.id] = est.status
      if (est.amount == null) feesUnavailable.push(a.id)
      fees += fee; feesBy[a.id] = fee
      // Buy fees enter cost basis (weighted average incl. acquisition fees); sale fees reduce proceeds.
      if (d > 0) { h.cost += notional + fee; cash[h.platform] -= notional + fee }
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
    return { holdings, cash, realized, fees, errors, shortfall, realizedBy, feesBy, feeStatusBy, feesUnavailable, targets, trades, startValue }
  }

  /** Open-position market value grouped by category or platform. Basis: shares × mark; cash is not included. */
  function allocation(f: PlatformFilter, by: 'category' | 'platform') {
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
  function eventRelations(id: string, rels: Relation[]) {
    return rels.filter((r) => r.a === id || r.b === id).map((r) => ({ other: EVENTS.find((e) => e.id === (r.a === id ? r.b : r.a))!, cls: r.cls, provenance: r.provenance, note: r.note })).filter((x) => x.other)
  }

  function valueBridge(start: Simulation, sim: Simulation, added: number): ValueBridge | null {
    const before = scenarioMetrics(start, []).totalValue, after = scenarioMetrics(sim, []).totalValue
    if (before == null || after == null) return null
    let execution = 0
    for (const [id, t] of Object.entries(sim.trades)) {
      const m = sim.holdings[id]?.mark
      if (m == null) return null
      execution += t.qty * (m - t.price)
    }
    return { before: before - added, added, execution, fees: sim.fees, after, feesUnavailable: sim.feesUnavailable.length }
  }

  return { PORTFOLIO, TODAY, HISTORY_START, LAST_VISIT, CASH_FLOWS, OPEN_POSITIONS, CLOSED_TRADES, EVENTS, sourceOf, coverage, ACCOUNTS, accountOf, accountsOn, derivePosition, POSITIONS, POS_BY_ID, positionsFor, tradesIn, account, markAt, netPnlAt, depositsAt, series, periodAvailable, periodRange, customRangeIssue, periodStats, sourceRelations, baseHoldings, exposures, settlementRangeFor, instrumentOfPosition, holdingsOfInstrument, positionFor, startingValue, startingPoint, simulate, allocation, eventRelations, valueBridge }
}
export type Finance = ReturnType<typeof createFinance>

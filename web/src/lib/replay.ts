/* Historical Replay: a retrospective hypothetical portfolio built from markets as they were in a past period.

   A replay is NOT the user's actual history and NOT a point-in-time strategy backtest. The user picks markets
   knowing what happened since, so results are hindsight analysis and say so, whether the markets resolved or not.
   This module validates inputs and presents what follows exactly from the stated assumptions and recorded evidence;
   the backend replay service is authoritative for integrated results (docs/DEVELOPMENT.md, Phase 8 handoff).

   - Trading window: a position can be opened or sold only between trading open (`listedAt`) and trading close
     (`closesAt`). A later (expected or verified) resolution never extends it. An unrecorded close is reported as a
     caveat, never replaced by the expected resolution date.
   - Settlement happens at the verified resolution time; the payout is hypothetical cash in the funding bucket.
   - Funding: virtual capital per bucket (venue + native asset), freely editable, independent of any real account.
     Funds never move between buckets. A replay is funded, an unfunded what-if (a purchase needed more simulated cash
     than the bucket had at that time), or its funding can't be assessed (an unknown fee before a purchase).
   - Unknown fees are never zero: cash after them is unknown, so dependent values are partial. An explicitly
     excluded fee is a valid assumption (zero).
   - Valuation of open holdings uses recorded observations with LOCF (lib/history.ts); none → unavailable.
   - Reporting: native results first. A combined USD figure needs a frozen USD rate for each non-USD asset. */
import type { Denomination, Platform } from '../data/types'
import { addDays, daysBetween, floorQty, type Outcome } from './finance'
import { estimateFee, readFeeAssumption, type FeeAssumption, type FeeSchedule } from './fees'
import { maxDrawdown, priceAt, seriesQuality, valueSeries, type InstrumentHistory, type PriceObs, type ValuedPoint } from './history'
import type { CatalogEvent, CatalogMarket } from './markets'

export interface ReplayMarket {
  provider: Platform; marketId: string; title: string; eventTitle: string; category: string
  /** Trading opened / closed (UTC date or timestamp); null = not recorded. */
  listedAt: string | null; closesAt: string | null
  /** Expected resolution (a schedule hint, not evidence). */
  expectedResolution: string | null
  /** Verified resolution; its time is also the (hypothetical) payout time. */
  resolution: { outcome: Outcome; at: string } | null
  fee: FeeSchedule | null
  /** Recorded price observations per outcome. Empty when the source has none for this market. */
  observations: Record<Outcome, PriceObs[]>
}
export type ReplaySize = { mode: 'shares' | 'amount' | 'weight'; value: number | null }
export type ReplayExit = { kind: 'settle' } | { kind: 'date'; date: string; price: number | null }
/** One hypothetical position. Several may refer to the same market (YES and NO, different dates or buckets). */
export interface ReplayPosition {
  id: string; market: ReplayMarket; outcome: Outcome; bucketId: string
  entryDate: string; entryPrice: number | null; size: ReplaySize; exit: ReplayExit
}
/** Virtual funding: simulated starting capital in one native asset at one venue. Not a real account. */
export interface FundingBucket { id: string; venue: Platform; denomination: Denomination; capital: number }
/** Reporting-only USD rates, frozen with the replay. They never move funds between buckets. */
export interface ReportingRates { USDC: number | null; PUSD: number | null }
export interface Replay {
  key: string; name: string; color: string
  start: string; end: string
  buckets: FundingBucket[]
  fees: FeeAssumption
  rates: ReportingRates
  positions: ReplayPosition[]
  /** Only retrospective (hindsight) selection is supported. */
  basis: 'retrospective'
  createdAt: string
}

export const MAX_REPLAY_POSITIONS = 20
export const MAX_BUCKET_CAPITAL = 100_000_000
/** The native asset a new virtual bucket uses on each venue (editable per bucket). */
export const DEFAULT_ASSET: Record<Platform, Denomination> = { pm: 'USDC', ks: 'USD' }
export const bucketId = (venue: Platform, d: Denomination) => `virtual:${venue}:${d}`
export const instrumentKeyOf = (p: Pick<ReplayPosition, 'market' | 'outcome'>) => `${p.market.provider}:${p.market.marketId}:${p.outcome}`

/** Market metadata a replay stores (a snapshot of the catalog entry; observations as recorded). */
export function replayMarketFrom(ev: CatalogEvent, m: CatalogMarket): ReplayMarket {
  const obs = (o: Outcome): PriceObs[] => { const p = m.outcomes.find((x) => x.outcome === o)?.refPrice; return p != null && m.refAsOf ? [{ at: m.refAsOf, price: p }] : [] }
  return {
    provider: m.provider, marketId: m.marketId, title: m.marketTitle, eventTitle: ev.eventTitle, category: m.category,
    listedAt: m.listedAt ?? null, closesAt: m.closesAt ?? null, expectedResolution: m.resolves || null, resolution: m.resolution ?? null, fee: m.fee, observations: { YES: obs('YES'), NO: obs('NO') },
  }
}

/* ───────────── Chronology (UTC) ───────────── */
const t = (s: string) => Date.parse(/T/.test(s) ? s : `${s}T00:00:00Z`)
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(t(s))
/** A date-only trade happens during that UTC day: it is after a close only if the close was before that day began. */
const tradesAfterClose = (date: string, close: string) => (/T/.test(close) ? t(date) >= t(close) : date > close.slice(0, 10))
const day = (s: string) => s.slice(0, 10)

/** Whether a market could be traded on a date, given its recorded trading window. */
export function tradingWindow(m: ReplayMarket, date: string): { ok: true; closeUnknown: boolean } | { ok: false; reason: string } {
  if (m.listedAt && date < day(m.listedAt)) return { ok: false, reason: `This market wasn’t listed until ${day(m.listedAt)}.` }
  if (m.closesAt && tradesAfterClose(date, m.closesAt)) return { ok: false, reason: `Trading closed on ${day(m.closesAt)}${m.resolution && day(m.resolution.at) > day(m.closesAt) ? `; it resolved later, on ${day(m.resolution.at)}` : ''}.` }
  if (!m.closesAt && m.resolution && date >= day(m.resolution.at)) return { ok: false, reason: `This market resolved on ${day(m.resolution.at)}.` }
  return { ok: true, closeUnknown: !m.closesAt }
}

export interface ReplayIssues { period: string | null; capital: string | null; positions: Record<string, string>; caveats: Record<string, string> }

/** Validate a replay against the period, each market's trading window and the virtual funding buckets. */
export function validateReplay(r: Replay, today: string): ReplayIssues {
  let period: string | null = null
  if (!isDate(r.start) || !isDate(r.end)) period = 'Enter a start and an end date.'
  else if (r.start >= r.end) period = 'The end date must be after the start date.'
  else if (r.end > today) period = `A replay ends on or before today (${today}).`
  const badBucket = r.buckets.find((b) => !(b.capital >= 0 && b.capital <= MAX_BUCKET_CAPITAL))
  const capital = badBucket ? 'Starting capital must be between 0 and 100,000,000.' : null
  const positions: Record<string, string> = {}, caveats: Record<string, string> = {}
  for (const p of r.positions) {
    const m = p.market, b = r.buckets.find((x) => x.id === p.bucketId)
    const entry = isDate(p.entryDate) ? tradingWindow(m, p.entryDate) : null
    const exit = p.exit.kind === 'date' && isDate(p.exit.date) ? tradingWindow(m, p.exit.date) : null
    const e = !b ? 'Choose virtual funding for this position.'
      : b.venue !== m.provider ? 'This market trades on another venue than this funding.'
      : !isDate(p.entryDate) ? 'Enter an entry date.'
      : !period && (p.entryDate < r.start || p.entryDate > r.end) ? 'The entry date must fall inside the replay period.'
      : entry && !entry.ok ? entry.reason
      : !(p.entryPrice != null && p.entryPrice > 0 && p.entryPrice < 1) ? 'Enter the execution price you assume, between 0 and 1.'
      : p.size.value == null || !(p.size.value > 0) ? 'Enter a size greater than zero.'
      : p.size.mode === 'weight' && p.size.value > 100 ? 'A weight is at most 100% of the funding’s starting capital.'
      : p.size.mode === 'weight' && !(b.capital > 0) ? 'Add starting capital to this funding to size by weight.'
      : p.exit.kind === 'date' && !isDate(p.exit.date) ? 'Enter an exit date.'
      : p.exit.kind === 'date' && p.exit.date <= p.entryDate ? 'The exit date must be after the entry date.'
      : p.exit.kind === 'date' && p.exit.date > r.end ? 'The exit date must fall inside the replay period.'
      : exit && !exit.ok ? `${exit.reason} Hold to settlement instead.`
      : p.exit.kind === 'date' && !(p.exit.price != null && p.exit.price > 0 && p.exit.price < 1) ? 'Enter the exit price you assume, between 0 and 1.'
      : null
    if (e) positions[p.id] = e
    else if (!m.closesAt) caveats[p.id] = 'Trading close isn’t recorded for this market; the replay assumes it was still trading on these dates.'
  }
  return { period, capital, positions, caveats }
}
export const replayValid = (i: ReplayIssues) => !i.period && !i.capital && Object.keys(i.positions).length === 0

export interface ReplayCashEvent { date: string; bucketId: string; positionId: string | null; kind: 'capital' | 'buy' | 'sell' | 'settlement'; amount: number; fee: number | null; note: string }
export interface ReplayLine {
  position: ReplayPosition; shares: number; cost: number; entryFee: number | null
  end: 'settled' | 'sold' | 'open'; endDate: string
  /** Cash from settlement or sale after the exit fee; null when that fee is unknown. */
  proceeds: number | null
  endValue: number | null
  endBasis: ReturnType<typeof priceAt>['basis'] | null
  pnl: number | null
  realized: boolean
}
export type FundingStatus = 'funded' | 'unfunded' | 'unavailable'
export interface ReplayBucketResult {
  bucket: FundingBucket
  /** Cash at the end from known amounts only, and whether every cash effect is known. */
  knownCash: number; cashComplete: boolean
  openValue: number | null; endValue: number | null
  /** Largest amount by which purchases exceeded the simulated cash available at that time (0 = funded). */
  shortfall: number
  funding: FundingStatus
  fees: number | null
  realizedPnl: number | null
}
export interface DenomResult { denomination: Denomination; capital: number; endValue: number | null; netGain: number | null; ret: number | null; realizedPnl: number | null; fees: number | null; funding: FundingStatus }
export interface ReplayResult {
  replay: Replay
  lines: ReplayLine[]
  cash: ReplayCashEvent[]
  buckets: ReplayBucketResult[]
  /** Native results per denomination (USD, USDC and PUSD are separate assets). */
  byDenomination: DenomResult[]
  /** Indicative USD total using the replay's frozen reporting rates; null when a rate or a value is missing. */
  combined: { capital: number; endValue: number; netGain: number; ret: number | null; rates: Partial<ReportingRates> } | null
  combinedMissing: 'rate' | 'value' | null
  funding: FundingStatus
  series: ValuedPoint[]
  quality: ReturnType<typeof seriesQuality>
  /** First date from which every later date can be valued (the supported segment), or null. */
  supportedFrom: string | null
  drawdown: ReturnType<typeof maxDrawdown>
  /** Always true: markets are selected retrospectively. `resolvedSelected` says whether outcomes were already known. */
  hindsight: true
  resolvedSelected: boolean
  evidence: { marketId: string; provider: Platform; title: string; listed: boolean; closeRecorded: boolean; resolution: boolean; observationsInPeriod: number }[]
}

function sharesOf(p: ReplayPosition, capital: number): number {
  const v = p.size.value ?? 0, price = p.entryPrice ?? 0
  if (!(price > 0)) return 0
  return floorQty(p.size.mode === 'shares' ? v : p.size.mode === 'amount' ? v / price : (capital * v) / 100 / price)
}

/** Dates from start to end (end included), at most ~120 points. */
export function replayDates(start: string, end: string): string[] {
  const d: string[] = []
  const step = Math.max(1, Math.ceil(daysBetween(start, end) / 120))
  for (let x = start; x < end; x = addDays(x, step)) d.push(x)
  d.push(end)
  return d
}
const order = (k: ReplayCashEvent['kind']) => ({ capital: 0, settlement: 1, sell: 2, buy: 3 })[k]
const hist = (p: ReplayPosition): InstrumentHistory => ({ key: instrumentKeyOf(p), observations: p.market.observations[p.outcome], settledAt: p.market.resolution?.at ?? null, settlementValue: p.market.resolution ? (p.market.resolution.outcome === p.outcome ? 1 : 0) : null })
const worst = (xs: FundingStatus[]): FundingStatus => (xs.includes('unavailable') ? 'unavailable' : xs.includes('unfunded') ? 'unfunded' : 'funded')

/** Evaluate a valid replay. Results are exact for the stated assumptions; anything without evidence is null. */
export function runReplay(r: Replay, today: string): ReplayResult {
  const lines: ReplayLine[] = []
  const cash: ReplayCashEvent[] = r.buckets.filter((b) => b.capital > 0).map((b) => ({ date: r.start, bucketId: b.id, positionId: null, kind: 'capital' as const, amount: b.capital, fee: 0, note: 'Starting capital' }))
  for (const p of r.positions) {
    const capital = r.buckets.find((b) => b.id === p.bucketId)?.capital ?? 0
    const shares = sharesOf(p, capital), price = p.entryPrice ?? 0, cost = shares * price
    const entryFee = estimateFee(shares, price, p.market.fee, r.fees).amount
    cash.push({ date: p.entryDate, bucketId: p.bucketId, positionId: p.id, kind: 'buy', amount: -cost, fee: entryFee, note: `Buy ${p.outcome} at ${price}` })
    const res = p.market.resolution
    if (p.exit.kind === 'date') {
      const exitPrice = p.exit.price ?? 0, fee = estimateFee(shares, exitPrice, p.market.fee, r.fees).amount
      cash.push({ date: p.exit.date, bucketId: p.bucketId, positionId: p.id, kind: 'sell', amount: shares * exitPrice, fee, note: `Sell at ${exitPrice}` })
      const proceeds = fee == null ? null : shares * exitPrice - fee
      lines.push({ position: p, shares, cost, entryFee, end: 'sold', endDate: p.exit.date, proceeds, endValue: null, endBasis: null, realized: true, pnl: proceeds == null || entryFee == null ? null : proceeds - cost - entryFee })
    } else if (res && day(res.at) <= r.end) {
      const proceeds = res.outcome === p.outcome ? shares : 0
      cash.push({ date: day(res.at), bucketId: p.bucketId, positionId: p.id, kind: 'settlement', amount: proceeds, fee: 0, note: `Resolved ${res.outcome} (hypothetical payout)` })
      lines.push({ position: p, shares, cost, entryFee, end: 'settled', endDate: day(res.at), proceeds, endValue: null, endBasis: null, realized: true, pnl: entryFee == null ? null : proceeds - cost - entryFee })
    } else {
      const pa = priceAt(hist(p), r.end)
      const endValue = pa.price == null ? null : shares * pa.price
      lines.push({ position: p, shares, cost, entryFee, end: 'open', endDate: r.end, proceeds: null, endValue, endBasis: pa.basis, realized: false, pnl: endValue == null || entryFee == null ? null : endValue - cost - entryFee })
    }
  }
  cash.sort((a, b) => (a.date === b.date ? order(a.kind) - order(b.kind) : a.date < b.date ? -1 : 1))

  const bucketResults: ReplayBucketResult[] = r.buckets.filter((b) => b.capital > 0 || r.positions.some((p) => p.bucketId === b.id)).map((b) => {
    let known = 0, complete = true, low = 0, assessable = true, fees = 0
    for (const c of cash.filter((x) => x.bucketId === b.id)) {
      known += c.amount - (c.fee ?? 0)
      if (c.fee == null) complete = false
      else fees += c.fee
      // Funding is judged at each purchase from complete cash only; an unknown fee before a purchase hides it.
      if (c.kind === 'buy') { if (!complete) assessable = false; else if (known < low) low = known }
    }
    const ls = lines.filter((l) => l.position.bucketId === b.id)
    const open = ls.filter((l) => l.end === 'open')
    const openValue = open.some((l) => l.endValue == null) ? null : open.reduce((s, l) => s + (l.endValue ?? 0), 0)
    const realized = ls.filter((l) => l.realized)
    const shortfall = low < 0 ? -low : 0
    return {
      bucket: b, knownCash: known, cashComplete: complete, openValue,
      endValue: complete && openValue != null ? known + openValue : null,
      shortfall, funding: shortfall > 0.005 ? 'unfunded' : assessable ? 'funded' : 'unavailable',
      fees: complete ? fees : null, realizedPnl: realized.some((l) => l.pnl == null) ? null : realized.reduce((s, l) => s + (l.pnl ?? 0), 0),
    }
  })

  const denoms = [...new Set(bucketResults.map((x) => x.bucket.denomination))]
  const byDenomination: DenomResult[] = denoms.map((d) => {
    const bs = bucketResults.filter((x) => x.bucket.denomination === d), capital = bs.reduce((s, x) => s + x.bucket.capital, 0)
    const endValue = bs.some((x) => x.endValue == null) ? null : bs.reduce((s, x) => s + (x.endValue ?? 0), 0)
    const netGain = endValue == null ? null : endValue - capital
    const funding = worst(bs.map((x) => x.funding))
    return {
      denomination: d, capital, endValue, netGain, funding,
      // A return needs a funded, fully valued result on positive capital.
      ret: netGain != null && capital > 0 && funding === 'funded' ? netGain / capital : null,
      realizedPnl: bs.some((x) => x.realizedPnl == null) ? null : bs.reduce((s, x) => s + (x.realizedPnl ?? 0), 0),
      fees: bs.some((x) => x.fees == null) ? null : bs.reduce((s, x) => s + (x.fees ?? 0), 0),
    }
  })
  const rateOf = (d: Denomination) => (d === 'USD' ? 1 : r.rates[d])
  const missingRate = denoms.some((d) => rateOf(d) == null)
  const missingValue = byDenomination.some((d) => d.endValue == null)
  let combined: ReplayResult['combined'] = null
  if (byDenomination.length && !missingRate && !missingValue) {
    const capital = byDenomination.reduce((s, d) => s + d.capital * rateOf(d.denomination)!, 0)
    const endValue = byDenomination.reduce((s, d) => s + d.endValue! * rateOf(d.denomination)!, 0)
    const funded = byDenomination.every((d) => d.funding === 'funded')
    combined = { capital, endValue, netGain: endValue - capital, ret: capital > 0 && funded ? (endValue - capital) / capital : null, rates: Object.fromEntries(denoms.filter((d) => d !== 'USD').map((d) => [d, r.rates[d as 'USDC' | 'PUSD']])) }
  }

  // Value over time from recorded observations (LOCF), once per instrument (positions in the same instrument are
  // aggregated, so a repeated position is never valued twice). Cash uses known amounts and is incomplete after an
  // unknown fee, which makes those points partial.
  const dates = replayDates(r.start, r.end)
  const instruments = [...new Map(r.positions.map((p) => [instrumentKeyOf(p), hist(p)])).values()]
  const qtyAt = (key: string, date: string) => lines.filter((l) => instrumentKeyOf(l.position) === key && l.position.entryDate <= date && !(l.end !== 'open' && l.endDate <= date)).reduce((s, l) => s + l.shares, 0)
  const cashAt = (date: string) => { const cs = cash.filter((c) => c.date <= date); return { amount: cs.reduce((s, c) => s + c.amount - (c.fee ?? 0), 0), complete: cs.every((c) => c.fee != null) } }
  const series = valueSeries(dates, instruments, qtyAt, cashAt)
  const quality = seriesQuality(series)
  let k = series.length
  while (k > 0 && series[k - 1].value != null) k--
  const supportedFrom = k < series.length ? series[k].date : null

  const funding = worst(bucketResults.map((x) => x.funding))
  return {
    replay: r, lines, cash, buckets: bucketResults, byDenomination, combined, combinedMissing: combined ? null : missingRate ? 'rate' : 'value', funding,
    series, quality, supportedFrom, drawdown: quality.complete ? maxDrawdown(series) : null,
    hindsight: true, resolvedSelected: r.positions.some((p) => !!p.market.resolution && day(p.market.resolution.at) <= today),
    evidence: [...new Map(r.positions.map((p) => [`${p.market.provider}:${p.market.marketId}`, p.market])).values()].map((m) => ({
      marketId: m.marketId, provider: m.provider, title: m.title, listed: !!m.listedAt, closeRecorded: !!m.closesAt, resolution: !!m.resolution,
      observationsInPeriod: new Set([...m.observations.YES, ...m.observations.NO].map((o) => o.at).filter((at) => day(at) >= r.start && day(at) <= r.end)).size,
    })),
  }
}

/** Raise a bucket's capital to cover its shortfall (rounded up to a whole unit). Never borrows; it's simulated cash. */
export function coverShortfall(r: Replay, bucketIdToCover: string, shortfall: number): Replay {
  return { ...r, buckets: r.buckets.map((b) => (b.id === bucketIdToCover ? { ...b, capital: Math.ceil(b.capital + shortfall) } : b)) }
}

/* ───────────── Compare ─────────────
   Replays compare on a common basis only. Each difference is listed; a figure is marked "not comparable" when its
   basis differs (period, native assets and rates, capital, funding, fee methodology, evidence). */
export interface ReplayComparison {
  differences: { key: string; label: string; differs: boolean }[]
  /** Absolute amounts (ending value, net gain, realized P&L, fees) are comparable. */
  amountsComparable: boolean
  /** Returns are comparable. */
  returnComparable: boolean
  /** Why not, in plain words. */
  reasons: string[]
}
export function compareReplays(rs: ReplayResult[]): ReplayComparison {
  const same = <T,>(f: (r: ReplayResult) => T) => new Set(rs.map((r) => JSON.stringify(f(r)))).size <= 1
  const capitalKey = (r: ReplayResult) => r.byDenomination.map((d) => [d.denomination, d.capital]).sort()
  const assets = (r: ReplayResult) => [r.byDenomination.map((d) => d.denomination).sort(), r.replay.rates]
  const differences = [
    { key: 'period', label: 'Replay period', differs: !same((r) => [r.replay.start, r.replay.end]) },
    { key: 'markets', label: 'Selected markets', differs: !same((r) => r.replay.positions.map(instrumentKeyOf).sort()) },
    { key: 'dates', label: 'Entry and exit dates', differs: !same((r) => r.replay.positions.map((p) => [instrumentKeyOf(p), p.entryDate, p.exit.kind === 'date' ? p.exit.date : 'settle']).sort()) },
    { key: 'sizing', label: 'Position sizes', differs: !same((r) => r.replay.positions.map((p) => [instrumentKeyOf(p), p.size.mode, p.size.value]).sort()) },
    { key: 'capital', label: 'Starting capital', differs: !same(capitalKey) },
    { key: 'assets', label: 'Native assets and reporting rates', differs: !same(assets) },
    { key: 'execution', label: 'Execution prices', differs: !same((r) => r.replay.positions.map((p) => [instrumentKeyOf(p), p.entryPrice, p.exit.kind === 'date' ? p.exit.price : null]).sort()) },
    { key: 'fees', label: 'Fee assumption', differs: !same((r) => r.replay.fees) },
    { key: 'funding', label: 'Funding status', differs: !same((r) => r.funding) },
    { key: 'evidence', label: 'Evidence coverage', differs: !same((r) => r.quality.complete) },
  ]
  const reasons: string[] = []
  const d = (k: string) => differences.find((x) => x.key === k)!.differs
  if (d('period')) reasons.push('the periods differ')
  if (d('assets')) reasons.push('native assets or reporting rates differ')
  if (rs.some((r) => r.funding !== 'funded')) reasons.push('at least one replay is not funded')
  if (d('fees')) reasons.push('fee methodologies differ')
  if (rs.some((r) => r.combined?.ret == null)) reasons.push('at least one replay has no complete, funded return')
  const returnComparable = !d('period') && !d('assets') && !d('fees') && rs.every((r) => r.funding === 'funded' && r.combined?.ret != null)
  const amountsComparable = returnComparable && !d('capital')
  if (returnComparable && !amountsComparable) reasons.push('starting capital differs, so amounts aren’t compared (returns are)')
  return { differences, amountsComparable, returnComparable, reasons }
}

/* ───────────── Storage ───────────── */
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const outcome = (v: unknown): Outcome | null => (v === 'YES' || v === 'NO' ? v : null)
const isDenom = (v: unknown): v is Denomination => v === 'USD' || v === 'USDC' || v === 'PUSD'
const isVenue = (v: unknown): v is Platform => v === 'pm' || v === 'ks'
function readObs(v: unknown): PriceObs[] { return Array.isArray(v) ? v.flatMap((o) => (isObj(o) && isDate(o.at) && num(o.price) != null ? [{ at: o.at, price: o.price as number }] : [])) : [] }
function readMarket(v: unknown): ReplayMarket | null {
  if (!isObj(v) || !isVenue(v.provider) || typeof v.marketId !== 'string' || typeof v.title !== 'string') return null
  const res = isObj(v.resolution) && outcome(v.resolution.outcome) && isDate(v.resolution.at) ? { outcome: v.resolution.outcome as Outcome, at: v.resolution.at as string } : null
  const obs = isObj(v.observations) ? v.observations : {}
  // Replays saved before trading close and resolution were separated stored `closesAt` = the resolution or the
  // expected resolution. That value is not a recorded close, so it is dropped (unknown) unless it precedes the resolution.
  const close = !isDate(v.closesAt) ? null : 'expectedResolution' in v ? v.closesAt : res && v.closesAt < res.at ? v.closesAt : null
  return {
    provider: v.provider, marketId: v.marketId, title: v.title, eventTitle: typeof v.eventTitle === 'string' ? v.eventTitle : v.title, category: typeof v.category === 'string' ? v.category : '',
    listedAt: isDate(v.listedAt) ? v.listedAt : null, closesAt: close, expectedResolution: isDate(v.expectedResolution) ? v.expectedResolution : null, resolution: res,
    fee: isObj(v.fee) ? (v.fee as unknown as FeeSchedule) : null, observations: { YES: readObs(obs.YES), NO: readObs(obs.NO) },
  }
}
function readPosition(v: unknown): ReplayPosition | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.entryDate !== 'string') return null
  const m = readMarket(v.market), o = outcome(v.outcome)
  const size = isObj(v.size) && (v.size.mode === 'shares' || v.size.mode === 'amount' || v.size.mode === 'weight') ? { mode: v.size.mode, value: num(v.size.value) } as ReplaySize : null
  const exit: ReplayExit | null = isObj(v.exit) ? (v.exit.kind === 'settle' ? { kind: 'settle' } : v.exit.kind === 'date' && typeof v.exit.date === 'string' ? { kind: 'date', date: v.exit.date, price: num(v.exit.price) } : null) : null
  if (!m || !o || !size || !exit) return null
  // Older replays referred to an account; they now use the virtual bucket of that venue's default asset.
  const bucket = typeof v.bucketId === 'string' ? v.bucketId : bucketId(m.provider, DEFAULT_ASSET[m.provider])
  return { id: v.id, market: m, outcome: o, bucketId: bucket, entryDate: v.entryDate, entryPrice: num(v.entryPrice), size, exit }
}
function readBuckets(v: Record<string, unknown>, positions: ReplayPosition[]): FundingBucket[] {
  if (Array.isArray(v.buckets)) return v.buckets.flatMap((b) => (isObj(b) && typeof b.id === 'string' && isVenue(b.venue) && isDenom(b.denomination) && num(b.capital) != null && (b.capital as number) >= 0 ? [{ id: b.id, venue: b.venue, denomination: b.denomination, capital: Math.min(b.capital as number, MAX_BUCKET_CAPITAL) }] : []))
  // Legacy: capital keyed by account id → one virtual bucket per venue in use, holding that capital.
  const legacy = isObj(v.capital) ? v.capital : {}
  const venues = new Set<Platform>([...positions.map((p) => p.market.provider), ...Object.keys(legacy).flatMap((k) => (k.startsWith('pm') ? ['pm' as const] : k.startsWith('ks') ? ['ks' as const] : []))])
  return [...venues].map((venue) => ({ id: bucketId(venue, DEFAULT_ASSET[venue]), venue, denomination: DEFAULT_ASSET[venue], capital: Object.entries(legacy).filter(([k]) => k.startsWith(venue)).reduce((s, [, x]) => s + (num(x) ?? 0), 0) }))
}
const readRates = (v: unknown): ReportingRates => { const o = isObj(v) ? v : {}; const ok = (x: unknown) => { const n = num(x); return n != null && n > 0 && n < 10 ? n : null }; return { USDC: ok(o.USDC), PUSD: ok(o.PUSD) } }
/** Validate stored replays. Invalid replays are dropped; invalid positions inside a replay are dropped. */
export function sanitizeReplays(raw: unknown): Replay[] | null {
  if (!Array.isArray(raw)) return null
  return raw.flatMap((v): Replay[] => {
    if (!isObj(v) || typeof v.key !== 'string' || typeof v.name !== 'string' || typeof v.start !== 'string' || typeof v.end !== 'string') return []
    const positions = Array.isArray(v.positions) ? v.positions.map(readPosition).filter((p): p is ReplayPosition => !!p).slice(0, MAX_REPLAY_POSITIONS) : []
    const buckets = readBuckets(v, positions)
    return [{ key: v.key, name: v.name.slice(0, 80), color: typeof v.color === 'string' ? v.color : '', start: v.start, end: v.end, buckets, fees: readFeeAssumption(v.fees), rates: readRates(v.rates), positions, basis: 'retrospective', createdAt: typeof v.createdAt === 'string' ? v.createdAt : '' }]
  })
}

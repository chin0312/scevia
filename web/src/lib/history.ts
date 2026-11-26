/* Historical valuation presentation: last observation carried forward (LOCF).

   Each instrument's eligible price is carried forward from its last observation until a newer one arrives, and the
   portfolio is valued from those instrument prices (never by copying the previous portfolio total). Rules:
   - No backward fill: before an instrument's first observation its price is unavailable.
   - No carry across settlement: from the settlement time on, the contract is worth its settlement value.
   - Each carried price keeps its original observation time; after `staleDays` it is labelled stale (still shown).
   - A point whose held instrument has no eligible price is partial: the known subtotal is kept, the total is null.
   - Cash movements, trades, fees and settlements apply at their own times, whether or not prices changed.
   The backend is authoritative for historical valuation; this module presents its results and values hypothetical
   replays from recorded observations. It never generates prices. */
import { daysBetween } from './finance'

export interface PriceObs { at: string; price: number }
export interface InstrumentHistory {
  key: string
  /** Observations, any order. Only prices in [0, 1] are eligible. */
  observations: PriceObs[]
  /** Settlement date and value (1 = paid out, 0 = expired worthless); null while unresolved. */
  settledAt?: string | null
  settlementValue?: 0 | 1 | null
}
export type PriceBasis = 'observed' | 'carried' | 'stale' | 'settled' | 'unavailable'
export interface PricedAt { price: number | null; basis: PriceBasis; observedAt: string | null; ageDays: number | null }

export const STALE_DAYS = 7
const day = (iso: string) => iso.slice(0, 10)

/** Price of one instrument on `date` (YYYY-MM-DD) under LOCF. */
export function priceAt(h: InstrumentHistory, date: string, staleDays = STALE_DAYS): PricedAt {
  if (h.settledAt && h.settlementValue != null && day(h.settledAt) <= date) return { price: h.settlementValue, basis: 'settled', observedAt: h.settledAt, ageDays: 0 }
  let last: PriceObs | null = null
  for (const o of h.observations) {
    if (!(o.price >= 0 && o.price <= 1) || day(o.at) > date) continue
    if (!last || o.at > last.at) last = o
  }
  if (!last) return { price: null, basis: 'unavailable', observedAt: null, ageDays: null }
  const age = daysBetween(day(last.at), date)
  return { price: last.price, basis: age === 0 ? 'observed' : age > staleDays ? 'stale' : 'carried', observedAt: last.at, ageDays: age }
}

export interface ValuedPoint {
  date: string
  /** Complete value (cash + all holdings), or null when any held instrument has no eligible price. */
  value: number | null
  /** Cash plus the holdings that could be valued. */
  known: number
  cash: number
  observed: number; carried: number; stale: number; missing: number
}

/** Value a hypothetical or reconstructed portfolio on each date from per-instrument LOCF prices.
 *  `qtyAt(key, date)` and `cashAt(date)` reflect trades, fees, cash flows and settlements up to and including `date`. */
export function valueSeries(dates: string[], instruments: InstrumentHistory[], qtyAt: (key: string, date: string) => number, cashAt: (date: string) => number, staleDays = STALE_DAYS): ValuedPoint[] {
  return dates.map((date) => {
    const cash = cashAt(date)
    let known = cash, observed = 0, carried = 0, stale = 0, missing = 0
    for (const h of instruments) {
      const q = qtyAt(h.key, date)
      if (!q) continue
      const p = priceAt(h, date, staleDays)
      if (p.price == null) { missing++; continue }
      known += q * p.price
      if (p.basis === 'observed' || p.basis === 'settled') observed++
      else if (p.basis === 'carried') carried++
      else stale++
    }
    return { date, value: missing ? null : known, known, cash, observed, carried, stale, missing }
  })
}

/** Whether return and drawdown over a series need a qualification: any missing point, or stale prices on more than
 *  `share` of the valued points. */
export function seriesQuality(points: ValuedPoint[], share = 0.25): { complete: boolean; staleShare: number; qualified: boolean } {
  const valued = points.filter((p) => p.value != null)
  const staleShare = valued.length ? valued.filter((p) => p.stale > 0).length / valued.length : 0
  const complete = points.length > 0 && valued.length === points.length
  return { complete, staleShare, qualified: !complete || staleShare > share }
}

/** Largest peak-to-trough fall of the complete points, or null when fewer than two points are valued. */
export function maxDrawdown(points: ValuedPoint[]): { amount: number; from: string; to: string } | null {
  const v = points.filter((p): p is ValuedPoint & { value: number } => p.value != null)
  if (v.length < 2) return null
  let peak = v[0], best: { amount: number; from: string; to: string } = { amount: 0, from: v[0].date, to: v[0].date }
  for (const p of v) {
    if (p.value > peak.value) peak = p
    if (peak.value - p.value > best.amount) best = { amount: peak.value - p.value, from: peak.date, to: p.date }
  }
  return best
}

export const BASIS_LABEL: Record<PriceBasis, string> = { observed: 'Observed', carried: 'Carried forward', stale: 'Carried forward · stale', settled: 'Settled', unavailable: 'No price yet' }

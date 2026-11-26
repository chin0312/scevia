/* Trading-fee estimation for HYPOTHETICAL trades (Scenario Lab). One function, used by the simulation engine; the UI
   only displays what the engine computed, so previews and results can't disagree.

   Historical fees are a different thing: they come from source records (reported / estimated / unavailable) and are
   never recalculated with today's schedules.

   Published structure (verified 2026-11-25):
   - Polymarket: fee = C × feeRate × p × (1 − p), takers only (makers pay 0), rate set per market/category,
     rounded to 5 decimals (smallest fee 0.00001 USDC). https://docs.polymarket.com/trading/fees
   - Kalshi: taker = round up(0.07 × C × P × (1 − P)) to the next cent; maker fees (0.0175 ×) apply only to
     non-standard series; series multipliers can differ. https://kalshi.com/fee-schedule (schedule effective 2026-07-07;
     the official page couldn't be opened from our network, so these figures are from secondary summaries of it).
   Market-specific parameters must come from provider data (Phase 2: Polymarket `feeRateBps` per market). */

export type FeeRole = 'taker' | 'maker'

/** Fee parameters of one market. A provider fact; in this build it comes from labelled sample metadata. */
export interface FeeSchedule {
  /** fee = quantity × rate × price × (1 − price) */
  formula: 'price-variance'
  /** Rate per role; null when the provider doesn't publish it for this market (fee is then unavailable, not 0). */
  taker: number | null
  maker: number | null
  rounding: 'up-to-cent' | 'nearest-5dp'
  /** 'sample' = illustrative parameters based on the published formula; 'provider' = retrieved for this market. */
  source: 'sample' | 'provider'
  /** Human-readable provenance, e.g. "Polymarket fee docs · Crypto category". */
  reference: string
  /** Date the schedule took effect, when known. */
  effective: string | null
}

/** How a scenario treats fees on its hypothetical trades. */
export type FeeAssumption =
  | { mode: 'provider'; role: FeeRole }
  | { mode: 'custom'; pct: number }
  | { mode: 'excluded' }
export const DEFAULT_FEES: FeeAssumption = { mode: 'provider', role: 'taker' }
export const MAX_CUSTOM_FEE_PCT = 10

export type FeeStatus = 'estimated' | 'custom' | 'excluded' | 'unavailable'
export interface FeeEstimate {
  /** null only when status is 'unavailable'. A real zero is 0. */
  amount: number | null
  status: FeeStatus
}

const roundUpCent = (v: number) => Math.ceil(v * 100 - 1e-9) / 100
const round5 = (v: number) => Math.round(v * 1e5) / 1e5

/** Estimated fee for one hypothetical trade of `qty` shares at `price`. */
export function estimateFee(qty: number, price: number, schedule: FeeSchedule | null | undefined, a: FeeAssumption): FeeEstimate {
  const q = Math.abs(qty)
  if (a.mode === 'excluded') return { amount: 0, status: 'excluded' }
  if (a.mode === 'custom') {
    if (!validFeePct(a.pct)) return { amount: null, status: 'unavailable' }
    return { amount: q === 0 ? 0 : roundUpCent(q * price * (a.pct / 100)), status: 'custom' }
  }
  const rate = schedule ? schedule[a.role] : null
  if (rate == null) return { amount: null, status: 'unavailable' }
  if (q === 0 || rate === 0) return { amount: 0, status: 'estimated' }
  const raw = q * rate * price * (1 - price)
  return { amount: schedule!.rounding === 'up-to-cent' ? roundUpCent(raw) : round5(raw), status: 'estimated' }
}

export const validFeePct = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_CUSTOM_FEE_PCT

/** Read a stored fee assumption (including the older boolean `includeFees`). */
export function readFeeAssumption(v: unknown, legacyInclude?: unknown): FeeAssumption {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.mode === 'excluded') return { mode: 'excluded' }
    if (o.mode === 'custom' && validFeePct(o.pct)) return { mode: 'custom', pct: o.pct }
    if (o.mode === 'provider') return { mode: 'provider', role: o.role === 'maker' ? 'maker' : 'taker' }
  }
  return legacyInclude === false ? { mode: 'excluded' } : DEFAULT_FEES
}

export const feeLabel = (a: FeeAssumption) => a.mode === 'excluded' ? 'Excluded' : a.mode === 'custom' ? `Custom ${a.pct}% of notional` : `Provider estimate, ${a.role}`

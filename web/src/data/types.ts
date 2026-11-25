import type { FeeSchedule } from '../lib/fees'
/**
 * Domain model for a portfolio. Any data source (the bundled sample, or a future Polymarket/Kalshi
 * import) must produce a `PortfolioData`; every calculation in lib/finance.ts reads only this shape.
 * Dates are ISO `YYYY-MM-DD` (UTC). Prices are per-share in dollars (0–1). Amounts are USD.
 */
export type Platform = 'pm' | 'ks'
export type Side = 'YES' | 'NO'
export type Category = 'Economics' | 'Climate' | 'Crypto' | 'Politics' | 'Sports'

/** Deposits > 0, withdrawals < 0. Never counted as performance. */
export interface CashFlow { date: string; platform: Platform; amount: number }

export interface Fill { date: string; shares: number; price: number; fee: number }

/** How records reach an account. An acquisition method, never a trading venue. */
export type AcquisitionKind = 'api' | 'csv' | 'manual'
/** A financial account at one venue (e.g. one Polymarket wallet). Several accounts can share a venue, and one account
 *  can be fed by several acquisition sources (an API connection supplemented by a CSV file). */
export interface AccountRef {
  id: string; venue: Platform; label: string
  /** How the account was added: connected (API / address tracking), imported (CSV only) or manual. */
  kind: 'connected' | 'imported' | 'manual'
  sources: AcquisitionKind[]
}

export interface OpenPosition {
  id: string; market: string; eventId: string; category: Category; platform: Platform; side: Side
  /** The financial account holding this position. Two accounts can hold the same instrument. */
  accountId: string
  /** Provider-native market id. A position id is account-specific; the market id identifies the contract. */
  marketId: string
  /** Fee parameters of this market for hypothetical trades (null = not published / unknown). Not used for history. */
  feeSchedule: FeeSchedule | null
  /** Last traded price on the source platform ("mark"). */
  mark: number
  /** Mark at the user's previous visit, for "What changed". */
  markAtLastVisit: number
  resolves: string
  fills: Fill[]
}

/** Positions are grouped by the event that decides their payoff. */
export interface RiskEvent { id: string; name: string; short: string; category: Category }

export type ClosedOutcome = 'Won' | 'Lost' | 'Closed early'
export interface ClosedTrade {
  id: string; market: string; category: Category; platform: Platform; side: Side
  opened: string; closed: string; shares: number; entry: number; exit: number
  /** Total fees for the round trip. */
  fees: number
  /** false when the source didn't report fees and the value is an estimate. */
  feeKnown: boolean
  outcome: ClosedOutcome
  /** For trades closed early: would holding to resolution have paid out? */
  heldWouldWin?: boolean
}

export interface DataSource { label: string; asOf: string; stale: boolean }

export type RelClass = 'equivalent' | 'mutex' | 'related' | 'unknown'
/** Where a relationship comes from. Only 'verified' (source facts, e.g. settlement rules) and 'hypothetical' (a scenario's
 *  own assumption) constrain feasible outcomes; 'annotation' is a descriptive note and never removes an outcome. */
export type RelProvenance = 'verified' | 'annotation' | 'hypothetical'
export interface Relation { a: string; b: string; cls: RelClass; provenance: RelProvenance; note?: string }

export interface PortfolioData {
  /** Date the data describes ("today"). */
  asOf: string
  /** First date with data; periods before it are reported as unavailable. */
  historyStart: string
  /** Previous visit, for "since your last visit" summaries. */
  lastVisit: string
  /** True for the bundled sample portfolio. The UI labels sample data as such. */
  isSample: boolean
  /** Financial accounts that contribute to this portfolio. */
  accounts: AccountRef[]
  cashFlows: CashFlow[]
  openPositions: OpenPosition[]
  closedTrades: ClosedTrade[]
  events: RiskEvent[]
  /** Confirmed or default relationships between events. User overrides are applied on top. */
  relations: Relation[]
  sources: Partial<Record<Platform, DataSource>>
}

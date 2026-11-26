/* Frozen starting portfolios for current-portfolio scenarios, and the Scenario Lab collection's storage.

   A scenario that starts from a tracked portfolio keeps a minimal frozen snapshot of that starting point (holdings,
   cash per venue, events, relationships and source dates). It is evaluated against the snapshot, never the latest
   portfolio, so a market refresh, a records change, another selected portfolio or a reporting preference can't change
   its results. Rebasing onto the latest portfolio is an explicit, previewed action. This is a development stand-in
   for the backend's frozen baseline tokens and revisioned saves (`/scenarios/baseline`, PATCH with revision, rebase
   preview); it is not a second persistence engine.

   Scratch scenarios and historical replays belong to the Scenario Lab collection (one per user, not per tracked
   portfolio), so switching or removing a tracked portfolio never hides or deletes them. */
import type { PortfolioData, Platform } from '../../data/types'
import type { Finance } from '../../lib/finance'

/** A minimal snapshot that reproduces the starting holdings and cash: open positions as held, and one funding
 *  record per venue equal to cash + cost basis (so cash = deposits − cost basis). Closed history isn't needed. */
export function freezeBaseline(F: Finance): PortfolioData {
  const venues: Platform[] = ['pm', 'ks']
  return {
    asOf: F.TODAY, historyStart: F.HISTORY_START, lastVisit: F.TODAY, isSample: F.PORTFOLIO.isSample,
    accounts: F.PORTFOLIO.accounts.map((a) => ({ ...a, sources: [...a.sources] })),
    cashFlows: venues.flatMap((p) => { const a = F.account(p), amount = a.cash + a.committed; return Math.abs(amount) > 1e-9 ? [{ date: F.HISTORY_START, platform: p, amount }] : [] }),
    openPositions: F.OPEN_POSITIONS.map((p) => ({ ...p, fills: p.fills.map((f) => ({ ...f })) })),
    closedTrades: [],
    events: F.EVENTS.map((e) => ({ ...e })),
    relations: F.PORTFOLIO.relations.map((r) => ({ ...r })),
    sources: Object.fromEntries(Object.entries(F.PORTFOLIO.sources).map(([k, v]) => [k, v ? { ...v } : v])),
  }
}

export interface BaselineDiff {
  same: boolean
  asOf: { frozen: string; latest: string }
  cash: { venue: Platform; frozen: number; latest: number }[]
  added: { id: string; market: string }[]
  removed: { id: string; market: string }[]
  resized: { id: string; market: string; frozen: number; latest: number }[]
  marksMoved: number
}
const shares = (p: PortfolioData['openPositions'][number]) => p.fills.reduce((s, f) => s + f.shares, 0)
/** What rebasing would change: cash per venue, holdings added / removed / resized, and how many marks moved. */
export function baselineDiff(frozen: Finance, latest: Finance): BaselineDiff {
  const fp = frozen.OPEN_POSITIONS, lp = latest.OPEN_POSITIONS
  const cash = (['pm', 'ks'] as Platform[]).map((venue) => ({ venue, frozen: frozen.account(venue).cash, latest: latest.account(venue).cash })).filter((c) => Math.abs(c.frozen - c.latest) > 0.005)
  const added = lp.filter((p) => !fp.some((q) => q.id === p.id)).map((p) => ({ id: p.id, market: p.market }))
  const removed = fp.filter((p) => !lp.some((q) => q.id === p.id)).map((p) => ({ id: p.id, market: p.market }))
  const resized = lp.flatMap((p) => { const q = fp.find((x) => x.id === p.id); return q && Math.abs(shares(q) - shares(p)) > 1e-9 ? [{ id: p.id, market: p.market, frozen: shares(q), latest: shares(p) }] : [] })
  const marksMoved = lp.filter((p) => { const q = fp.find((x) => x.id === p.id); return q && Math.abs(q.mark - p.mark) > 1e-9 }).length
  return { same: !cash.length && !added.length && !removed.length && !resized.length && !marksMoved && frozen.TODAY === latest.TODAY, asOf: { frozen: frozen.TODAY, latest: latest.TODAY }, cash, added, removed, resized, marksMoved }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Validate a stored snapshot's shape; anything malformed is treated as missing (the scenario then says so). */
export function readFrozen(v: unknown): PortfolioData | null {
  if (!isObj(v) || typeof v.asOf !== 'string' || typeof v.historyStart !== 'string' || !Array.isArray(v.accounts) || !Array.isArray(v.cashFlows) || !Array.isArray(v.openPositions) || !Array.isArray(v.events) || !Array.isArray(v.relations)) return null
  const okPos = v.openPositions.every((p) => isObj(p) && typeof p.id === 'string' && typeof p.mark === 'number' && Array.isArray(p.fills) && p.fills.length > 0 && (p.fills as unknown[]).every((f) => isObj(f) && typeof f.shares === 'number' && typeof f.price === 'number'))
  const okCash = v.cashFlows.every((c) => isObj(c) && typeof c.amount === 'number' && (c.platform === 'pm' || c.platform === 'ks'))
  if (!okPos || !okCash) return null
  return { ...(v as unknown as PortfolioData), closedTrades: [], lastVisit: v.asOf as string, sources: isObj(v.sources) ? (v.sources as PortfolioData['sources']) : {} }
}

/* Collection storage: one Scenario Lab collection per user (per browser tab until accounts exist). Older,
   per-portfolio keys are merged in once (by scenario key, never duplicated) and then removed. */
export const LAB_SCENARIOS_KEY = 'scevia-scenarios-v5'
export const LAB_ACTIVE_KEY = 'scevia-active-v5'
export const LAB_REPLAYS_KEY = 'scevia-replays-v2'
export function mergeByKey<T extends { key: string }>(into: T[], add: T[]): T[] {
  const have = new Set(into.map((x) => x.key))
  return [...into, ...add.filter((x) => !have.has(x.key))]
}

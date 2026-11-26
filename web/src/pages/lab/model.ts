/* Scenario Lab helpers shared by its sections: examples, metric rows, per-scenario evaluation, null-safe changes. */
import { groupTitles, scenarioMetrics, withConstraints, type Adjustment, type Finance, type Constraint, type Holding, type Outcome, type ScenarioMetrics, type Simulation } from '../../lib/finance'
import { DEFAULT_FEES, type FeeAssumption } from '../../lib/fees'
import type { Relation } from '../../data/types'
import type { Scenario } from '../../lib/scenarios'
import { PLATFORM_NAME } from '../../data/labels'

export const COLORS = ['var(--color-accent-solid)', 'var(--color-data-1)', 'var(--color-data-3)', 'var(--color-data-4)', 'var(--color-data-5)', 'var(--color-data-6)']

/** Optional starting points. Never added to the workspace unless the user picks one. */
/** Examples refer to holdings of the workspace they're opened in; one whose holdings are missing isn't offered. */
const held = (F: Finance, id: string, to: number, price: number): Adjustment | null => (F.POS_BY_ID[id] ? { id, to, price, instrument: F.instrumentOfPosition(F.POS_BY_ID[id]) } : null)
const all = (xs: (Adjustment | null)[]) => (xs.every(Boolean) ? (xs as Adjustment[]) : null)
export const EXAMPLES = [
  { name: 'Trim crypto, add to Fed', adjs: (F: Finance) => all([held(F, 'btc', 4000, 0.29), held(F, 'fedk', 6200, 0.65), held(F, 'chf', 0, 0.12)]) },
  { name: 'Exit sports longshots', adjs: (F: Finance) => all([held(F, 'cel', 0, 0.26), held(F, 'chf', 0, 0.12)]) },
  { name: 'Hedge the shutdown', adjs: (F: Finance) => all([held(F, 'shut', 3500, 0.47)]) },
]

/** Everything Scenario Lab shows for one scenario. */
export interface Evaluation {
  /** The scenario's starting point (baseline + added capital, no trades) and the result after its positions. */
  start: Simulation; sim: Simulation; B: ScenarioMetrics; A: ScenarioMetrics
  /** Source relationships plus this scenario's hypothetical constraints. */
  rels: Relation[]; constraints: Constraint[]; fees: FeeAssumption; funding: number
}
/** Evaluations are cached per scenario object: editing one scenario re-evaluates only that one (scenarios are
 *  immutable values, so an unchanged scenario keeps its object and its cached result). */
const caches = new WeakMap<Finance, WeakMap<Scenario, Evaluation>>()
export function evaluate(s: Scenario, F: Finance): Evaluation {
  const cache = caches.get(F) ?? new WeakMap<Scenario, Evaluation>(); caches.set(F, cache)
  const hit = cache.get(s)
  if (hit) return hit
  const fees = s.assumptions.fees ?? DEFAULT_FEES, constraints = s.assumptions.constraints ?? []
  const rels = withConstraints(F.sourceRelations(), constraints), opts = { fees, baseline: s.baseline, funding: s.funding }
  const start = F.simulate([], opts), sim = F.simulate(s.adjs, opts)
  const e = { start, sim, B: scenarioMetrics(start, rels), A: scenarioMetrics(sim, rels), rels, constraints, fees, funding: (s.funding.pm ?? 0) + (s.funding.ks ?? 0) }
  cache.set(s, e)
  return e
}
const actualCache = new WeakMap<Finance, Evaluation>()
/** The actual portfolio: source facts and source relationships only (no hypothetical constraints). */
export function evaluateActual(F: Finance): Evaluation {
  const hit = actualCache.get(F)
  if (hit) return hit
  const rels = F.sourceRelations(), sim = F.simulate([], {})
  const m = scenarioMetrics(sim, rels)
  const e = { start: sim, sim, A: m, B: m, rels, constraints: [], fees: DEFAULT_FEES, funding: 0 }
  actualCache.set(F, e)
  return e
}

/** a − b, or null when either side is unavailable (never coerced to zero). */
export const diff = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) ? null : a - b)

export type RowKey = keyof ScenarioMetrics | 'events'
/** tone: 'up' = higher is better for the user, 'down' = lower is better, 'neutral' = a transfer or a count, never judged. */
export interface Row { label: string; key: RowKey; tone: 'up' | 'down' | 'neutral'; info: string }
export const ROWS: Row[] = [
  { label: 'Cash', key: 'cash', tone: 'neutral', info: 'Buying spends cash and selling returns it. A transfer, not a gain. Negative means the scenario needs more cash than it has. Includes any added capital.' },
  { label: 'Positions at mark', key: 'positionsValue', tone: 'neutral', info: 'Shares × reference price. Unavailable when a position has no reference price.' },
  { label: 'Value at mark', key: 'totalValue', tone: 'up', info: 'Cash + positions at mark. A trade at your assumed price changes this only by the gap between that price and the mark, plus fees.' },
  { label: 'Capital committed', key: 'committed', tone: 'neutral', info: 'Cost basis of open positions.' },
  { label: 'Events held', key: 'events', tone: 'neutral', info: 'Distinct events (settlement groups) with open positions.' },
  { label: 'Locked-in from sales', key: 'realized', tone: 'up', info: 'Realized P&L of hypothetical sales after their fees. Purchases never create realized P&L.' },
  { label: 'Est. fees on these trades', key: 'fees', tone: 'down', info: 'Fees on this scenario’s hypothetical trades under its fee setting (provider estimate, custom or excluded). Fees already paid on existing positions aren’t included.' },
  { label: 'Funding shortfall', key: 'shortfall', tone: 'down', info: 'Cash the purchases need beyond each platform’s cash (and any added capital). Shown as if funded. This isn’t an input error.' },
  { label: 'Value if worst feasible outcome', key: 'worstValue', tone: 'up', info: 'Cash + $1 per winning share in the worst joint outcome that’s possible given this scenario’s relationships. Unavailable above the event limit.' },
  { label: 'Value if best feasible outcome', key: 'bestValue', tone: 'up', info: 'Cash + $1 per winning share in the best possible joint outcome.' },
  { label: 'Worst single-event outcome', key: 'largestEventLoss', tone: 'up', info: 'The largest settlement loss of any single event, shown as a signed outcome (−$5,000 → −$3,000 is an improvement). Holdings on opposite sides of the same event offset each other.' },
]
export const eventsHeld = (sim: Simulation) => new Set(Object.values(sim.holdings).filter((h) => h.shares > 0).map((h) => h.eventId)).size
/** The number a row compares. The single-event loss is shown as a signed outcome (negative), so its tone is 'up'. */
export function rowValue(r: Row, m: ScenarioMetrics, sim: Simulation): number | null {
  if (r.key === 'events') return eventsHeld(sim)
  if (r.key === 'largestEventLoss') return -m.largestEventLoss
  const v = m[r.key]
  return typeof v === 'number' ? v : null
}

/** Display info for an adjustment, whether it is an actual holding or a new instrument. */
export function describe(a: Adjustment, F: Finance) {
  const p = F.POS_BY_ID[a.id], i = a.instrument
  return {
    title: i?.marketTitle ?? p?.market ?? a.id,
    eventTitle: i?.eventTitle ?? '',
    platform: i?.provider ?? p?.platform ?? 'pm',
    side: (i?.outcome ?? p?.side ?? 'YES') as Outcome,
    refPrice: i?.refPrice ?? p?.mark ?? null,
    refAsOf: i?.refAsOf ?? null,
    resolves: i?.resolves ?? p?.resolves ?? '',
    sample: (i?.source ?? 'sample') === 'sample',
    /** The account holding it, or null for a new instrument (funded from the scenario's cash on its venue). */
    account: p ? F.accountOf(p.accountId) ?? null : null,
  }
}
/** How a position's target is entered. All three describe the same position; see lib/finance.ts `targetShares`. */
export type SizeMode = 'shares' | 'amount' | 'weight'
export const SIZE_LABEL: Record<SizeMode, string> = { shares: 'Shares', amount: '$ Amount', weight: '% of start' }
export const platformLabel = (p: keyof typeof PLATFORM_NAME) => PLATFORM_NAME[p]

/** Events present before or after (with shares), for event pickers and payoff views. */
export function eventsIn(...sims: Simulation[]) {
  const map = new Map<string, { id: string; title: string; sides: Set<Outcome> }>()
  const names = groupTitles(sims.flatMap((s) => (Object.values(s.holdings) as Holding[]).filter((h) => h.shares > 0)))
  for (const s of sims) for (const h of Object.values(s.holdings) as Holding[]) {
    if (h.shares <= 0) continue
    const e = map.get(h.eventId) ?? { id: h.eventId, title: names[h.eventId], sides: new Set<Outcome>() }
    e.sides.add(h.side); map.set(h.eventId, e)
  }
  return [...map.values()]
}
/** Judge a change for display: null when either side is unavailable or the row is neutral. */
export function judge(r: Row, a: number | null, b: number | null): { d: number | null; good: boolean | null } {
  const d = diff(a, b)
  if (d == null || Math.abs(d) < 0.5 || r.tone === 'neutral') return { d, good: null }
  return { d, good: r.tone === 'up' ? d > 0 : d < 0 }
}

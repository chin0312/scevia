/* Scenario Lab helpers shared by its sections: examples, metric rows, per-scenario evaluation, null-safe changes. */
import { POSITIONS, POS_BY_ID, instrumentOfPosition, relationsFor, scenarioMetrics, simulate, type Adjustment, type Holding, type Outcome, type ScenarioMetrics, type Simulation } from '../../lib/finance'
import type { Relation, RelClass } from '../../data/types'
import type { Scenario } from '../../lib/scenarios'
import { PLATFORM_NAME } from '../../data/labels'

export const COLORS = ['var(--color-accent-solid)', 'var(--color-data-1)', 'var(--color-data-3)', 'var(--color-data-4)', 'var(--color-data-5)', 'var(--color-data-6)']

/** Optional starting points. Never added to the workspace unless the user picks one. */
const held = (id: string, to: number, price: number): Adjustment => ({ id, to, price, instrument: instrumentOfPosition(POS_BY_ID[id]) })
export const EXAMPLES = [
  { name: 'Trim crypto, add to Fed', adjs: () => [held('btc', 4000, 0.29), held('fedk', 6200, 0.65), held('chf', 0, 0.12)] },
  { name: 'Exit sports longshots', adjs: () => [held('cel', 0, 0.26), held('chf', 0, 0.12)] },
  { name: 'Hedge the shutdown', adjs: () => [held('shut', 3500, 0.47)] },
]

/** Everything Scenario Lab shows for one scenario, computed once per change. */
export interface Evaluation {
  /** The scenario's starting point (baseline + added capital, no trades) and the result after its positions. */
  start: Simulation; sim: Simulation; B: ScenarioMetrics; A: ScenarioMetrics
  rels: Relation[]; includeFees: boolean; crypto: RelClass; funding: number
}
export function evaluate(s: Scenario, sharedCrypto: RelClass): Evaluation {
  const includeFees = s.assumptions.includeFees ?? true, crypto = s.assumptions.crypto ?? sharedCrypto
  const rels = relationsFor(crypto), opts = { includeFees, baseline: s.baseline, funding: s.funding }
  const start = simulate([], opts), sim = simulate(s.adjs, opts)
  return { start, sim, B: scenarioMetrics(start, rels), A: scenarioMetrics(sim, rels), rels, includeFees, crypto, funding: (s.funding.pm ?? 0) + (s.funding.ks ?? 0) }
}
export function evaluateActual(sharedCrypto: RelClass): Evaluation {
  const rels = relationsFor(sharedCrypto), sim = simulate([], { includeFees: true })
  const m = scenarioMetrics(sim, rels)
  return { start: sim, sim, A: m, B: m, rels, includeFees: true, crypto: sharedCrypto, funding: 0 }
}

/** a − b, or null when either side is unavailable (never coerced to zero). */
export const diff = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) ? null : a - b)

export type RowKey = keyof ScenarioMetrics | 'events'
export interface Row { label: string; key: RowKey; tone: 'up' | 'down' | 'neutral'; info: string }
export const ROWS: Row[] = [
  { label: 'Cash', key: 'cash', tone: 'neutral', info: 'Buying spends cash; selling returns it. A transfer, not a gain. Negative means the scenario needs more cash than it has. Includes any added capital.' },
  { label: 'Positions at mark', key: 'positionsValue', tone: 'neutral', info: 'Shares × reference price. Unavailable when a position has no reference price.' },
  { label: 'Value at mark', key: 'totalValue', tone: 'up', info: 'Cash + positions at mark. A trade at your assumed price changes this only by the gap between that price and the mark, plus fees.' },
  { label: 'Capital committed', key: 'committed', tone: 'neutral', info: 'Cost basis of open positions.' },
  { label: 'Events held', key: 'events', tone: 'neutral', info: 'Distinct events (settlement groups) with open positions.' },
  { label: 'Locked-in from sales', key: 'realized', tone: 'up', info: 'Realized P&L of hypothetical sales after their fees. Purchases never create realized P&L.' },
  { label: 'Est. fees on these trades', key: 'fees', tone: 'down', info: 'Estimated at each platform’s fee rate when fees are estimated for this scenario. Fees already paid on existing positions aren’t included.' },
  { label: 'Value if worst feasible outcome', key: 'worstValue', tone: 'up', info: 'Cash + $1 per winning share in the worst joint outcome that’s possible given this scenario’s relationships. Unavailable above the event limit.' },
  { label: 'Value if best feasible outcome', key: 'bestValue', tone: 'up', info: 'Cash + $1 per winning share in the best possible joint outcome.' },
  { label: 'Largest single-event loss', key: 'largestEventLoss', tone: 'down', info: 'Largest settlement loss of a single event. Holdings on opposite sides of the same event offset each other.' },
]
export const eventsHeld = (sim: Simulation) => new Set(Object.values(sim.holdings).filter((h) => h.shares > 0).map((h) => h.eventId)).size
/** The number a row compares (losses are negated so "higher is better" holds for tone). */
export function rowValue(r: Row, m: ScenarioMetrics, sim: Simulation): number | null {
  if (r.key === 'events') return eventsHeld(sim)
  if (r.key === 'largestEventLoss') return -m.largestEventLoss
  const v = m[r.key]
  return typeof v === 'number' ? v : null
}

/** Display info for an adjustment, whether it is an actual holding or a new instrument. */
export function describe(a: Adjustment) {
  const p = POS_BY_ID[a.id], i = a.instrument
  return {
    title: i?.marketTitle ?? p?.market ?? a.id,
    eventTitle: i?.eventTitle ?? '',
    platform: i?.provider ?? p?.platform ?? 'pm',
    side: (i?.outcome ?? p?.side ?? 'YES') as Outcome,
    refPrice: i?.refPrice ?? p?.mark ?? null,
    refAsOf: i?.refAsOf ?? null,
    resolves: i?.resolves ?? p?.resolves ?? '',
    sample: (i?.source ?? 'sample') === 'sample',
  }
}
export const platformLabel = (p: keyof typeof PLATFORM_NAME) => PLATFORM_NAME[p]

/** Events present before or after (with shares), for event pickers and payoff views. */
export function eventsIn(...sims: Simulation[]) {
  const map = new Map<string, { id: string; title: string; sides: Set<Outcome> }>()
  for (const s of sims) for (const h of Object.values(s.holdings) as Holding[]) {
    if (h.shares <= 0) continue
    const e = map.get(h.eventId) ?? { id: h.eventId, title: h.eventTitle, sides: new Set<Outcome>() }
    e.sides.add(h.side); map.set(h.eventId, e)
  }
  return [...map.values()]
}
export const heldPosition = (provider: string, eventId: string, side: Outcome) => POSITIONS.find((p) => p.platform === provider && p.eventId === eventId && p.side === side)

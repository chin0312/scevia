/**
 * Scenario bookkeeping, kept pure so it can be tested and later persisted per user.
 *
 * A scenario is a hypothetical portfolio: a starting point (the current portfolio or an empty one), optional added
 * capital, scenario-level assumptions, and a list of positions (target shares at an assumed price). Scenarios never
 * change actual holdings or history; they are evaluated by `simulate()` in lib/finance.ts.
 */
import type { Adjustment, Baseline, InstrumentRef } from './finance'
import type { Platform, RelClass } from '../data/types'

/** Assumptions a scenario may set for itself. Absent = inherit the shared setting. */
export interface ScenarioAssumptions {
  /** Estimate trading fees on the scenario's trades (default: estimated). */
  includeFees?: boolean
  /** Hypothetical BTC × ETH relationship for this scenario only; never changes the shared classification. */
  crypto?: RelClass
}
/** Everything that defines a scenario's result; compared to decide saved / unsaved. */
export interface Snapshot { name: string; adjs: Adjustment[]; baseline: Baseline; funding: Partial<Record<Platform, number>>; assumptions: ScenarioAssumptions }
export interface Scenario extends Snapshot {
  key: string; saved: Snapshot | null; savedAt: string | null; color: string
  /** What Reset returns a never-saved scenario to: empty for a new one, the source's state for a duplicate or example. */
  start?: Snapshot
}
export type ScenarioStatus = 'new' | 'saved' | 'modified'

const copyAdjs = (a: Adjustment[]) => a.map((x) => ({ ...x, instrument: x.instrument ? { ...x.instrument } : undefined }))
const snap = (s: Snapshot): Snapshot => ({ name: s.name, adjs: copyAdjs(s.adjs), baseline: s.baseline, funding: { ...s.funding }, assumptions: { ...s.assumptions } })
/** Content equality, ignoring key order and undefined fields. */
const norm = (s: Snapshot) => JSON.stringify({ n: s.name, a: s.adjs.map((x) => [x.id, x.to, x.price]), b: s.baseline, f: [s.funding.pm ?? null, s.funding.ks ?? null], x: [s.assumptions.includeFees ?? null, s.assumptions.crypto ?? null] })
const same = (a: Snapshot, b: Snapshot) => norm(a) === norm(b)

export const status = (s: Scenario): ScenarioStatus => (!s.saved ? 'new' : same(s.saved, s) ? 'saved' : 'modified')
export const isDirty = (s: Scenario) => status(s) !== 'saved'
export const statusLabel = (s: Scenario) => ({ new: 'Not saved', saved: 'Saved', modified: 'Unsaved changes' })[status(s)]

export const create = (key: string, color: string, name = 'Untitled scenario', baseline: Baseline = 'portfolio'): Scenario => {
  const base: Snapshot = { name, adjs: [], baseline, funding: {}, assumptions: {} }
  return { ...base, key, saved: null, savedAt: null, color, start: snap(base) }
}
/** A new, unsaved scenario prefilled from an example (examples are never added to the workspace on their own). */
export const fromExample = (key: string, color: string, ex: Omit<Snapshot, 'funding' | 'assumptions'> & Partial<Snapshot>): Scenario => {
  const base: Snapshot = { name: ex.name, adjs: copyAdjs(ex.adjs), baseline: ex.baseline, funding: { ...(ex.funding ?? {}) }, assumptions: { ...(ex.assumptions ?? {}) } }
  return { ...snap(base), key, saved: null, savedAt: null, color, start: snap(base) }
}
export const rename = (s: Scenario, name: string): Scenario => ({ ...s, name: name.trim() || s.name })
export const save = (s: Scenario, at: string): Scenario => ({ ...s, saved: snap(s), savedAt: at })
/** Back to the saved version; a never-saved scenario returns to where it started (empty, duplicate source, example). */
export const revert = (s: Scenario): Scenario => {
  const to = s.saved ?? s.start
  return to ? { ...s, ...snap(to) } : { ...s, adjs: [] }
}
export const canRevert = (s: Scenario) => (s.saved ? status(s) === 'modified' : !same(s, s.start ?? { name: s.name, adjs: [], baseline: s.baseline, funding: {}, assumptions: {} }))
export const duplicate = (s: Scenario, key: string, color: string): Scenario => {
  const copy = { ...snap(s), name: `${s.name} (copy)` }
  return { ...copy, key, color, saved: null, savedAt: null, start: snap(copy) }
}
/** Change part of a scenario's definition (setup, funding, assumptions) without touching its positions. */
export const configure = (s: Scenario, patch: Partial<Pick<Snapshot, 'baseline' | 'funding' | 'assumptions'>>): Scenario => ({ ...s, ...patch })

/* ── Restore from storage ─────────────────────────────────────────── */
const PLATFORMS: Platform[] = ['pm', 'ks']
const REL: RelClass[] = ['related', 'mutex', 'unknown']
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
function readInstrument(v: unknown): InstrumentRef | undefined | false {
  if (v == null) return undefined
  if (typeof v !== 'object') return false
  const i = v as Record<string, unknown>
  const str = (k: string) => typeof i[k] === 'string'
  if (!PLATFORMS.includes(i.provider as Platform) || !str('eventId') || !str('marketId') || !str('marketTitle') || !str('eventTitle') || !str('category') || !str('resolves')) return false
  if (i.outcome !== 'YES' && i.outcome !== 'NO') return false
  if (!(i.refPrice === null || isNum(i.refPrice))) return false
  return {
    provider: i.provider as Platform, eventId: i.eventId as string, eventTitle: i.eventTitle as string, marketId: i.marketId as string, marketTitle: i.marketTitle as string,
    outcome: i.outcome, category: i.category as InstrumentRef['category'], resolves: i.resolves as string, refPrice: i.refPrice as number | null,
    refAsOf: typeof i.refAsOf === 'string' ? i.refAsOf : null, source: i.source === 'provider' ? 'provider' : 'sample',
  }
}

/** Validate scenarios restored from storage (current or older formats). Malformed entries are dropped; positions that
 *  reference holdings no longer in the portfolio (and carry no instrument reference) are removed and counted.
 *  Older scenarios migrate to "current portfolio" with no added capital and shared assumptions. Returns null if unusable. */
export function sanitize(raw: unknown, knownIds: (id: string) => boolean): { scenarios: Scenario[]; dropped: number } | null {
  if (!Array.isArray(raw)) return null
  let dropped = 0
  const adjs = (v: unknown): Adjustment[] => {
    if (!Array.isArray(v)) return []
    const out: Adjustment[] = []
    for (const a of v) {
      if (!a || typeof a !== 'object' || typeof a.id !== 'string') { dropped++; continue }
      const to = a.to === null ? null : isNum(a.to) ? a.to : undefined
      const price = a.price === null ? null : isNum(a.price) ? a.price : undefined
      const instrument = readInstrument(a.instrument)
      if (to === undefined || price === undefined || instrument === false || (!instrument && !knownIds(a.id))) { dropped++; continue }
      out.push({ id: a.id, to, price, ...(instrument ? { instrument } : {}) })
    }
    return out
  }
  const funding = (v: unknown) => {
    const f: Partial<Record<Platform, number>> = {}
    if (v && typeof v === 'object') for (const p of PLATFORMS) { const n = (v as Record<string, unknown>)[p]; if (isNum(n) && (n as number) >= 0) f[p] = n as number }
    return f
  }
  const assumptions = (v: unknown): ScenarioAssumptions => {
    const a: ScenarioAssumptions = {}
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.includeFees === 'boolean') a.includeFees = o.includeFees
      if (REL.includes(o.crypto as RelClass)) a.crypto = o.crypto as RelClass
    }
    return a
  }
  const snapshot = (x: Record<string, unknown>, name: string): Snapshot => ({
    name, adjs: adjs(x.adjs), baseline: x.baseline === 'scratch' ? 'scratch' : 'portfolio', funding: funding(x.funding), assumptions: assumptions(x.assumptions),
  })
  const scenarios = raw.flatMap((x): Scenario[] => {
    if (!x || typeof x !== 'object' || typeof x.key !== 'string' || typeof x.name !== 'string') return []
    const cur = snapshot(x, x.name)
    const saved = x.saved && typeof x.saved === 'object' && typeof x.saved.name === 'string' ? snapshot({ baseline: cur.baseline, funding: cur.funding, assumptions: cur.assumptions, ...x.saved }, x.saved.name) : null
    // Older formats stored `start` as a list of adjustments.
    const start = Array.isArray(x.start) ? { ...cur, adjs: adjs(x.start) } : x.start && typeof x.start === 'object' ? snapshot(x.start, typeof x.start.name === 'string' ? x.start.name : cur.name) : undefined
    return [{ ...cur, key: x.key, saved, savedAt: typeof x.savedAt === 'string' ? x.savedAt : null, color: typeof x.color === 'string' ? x.color : '', start }]
  })
  const keys = new Set<string>()
  return { scenarios: scenarios.filter((x) => !keys.has(x.key) && keys.add(x.key)), dropped }
}

/** Explicitly add positions to a scenario at their current holding and mark (no hypothetical change yet).
 *  Positions already in the scenario are left exactly as they are. */
export function addPositions(s: Scenario, adds: Adjustment[]) {
  const present = new Set(s.adjs.map((a) => a.id))
  const added = adds.filter((a) => !present.has(a.id))
  return { scenario: { ...s, adjs: [...s.adjs, ...copyAdjs(added)] }, added: added.map((a) => a.id), skipped: adds.filter((a) => present.has(a.id)).map((a) => a.id) }
}

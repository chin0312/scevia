/**
 * Scenario bookkeeping, kept pure so it can be tested and later persisted per user.
 *
 * A scenario is a hypothetical portfolio: a starting point (the current portfolio or an empty one), optional added
 * capital, scenario-level assumptions, and a list of positions (target shares at an assumed price). Scenarios never
 * change actual holdings or history; they are evaluated by `simulate()` in lib/finance.ts.
 */
import type { Adjustment, Baseline, Constraint, InstrumentRef } from './finance'
import { readFeeAssumption, type FeeAssumption, type FeeSchedule } from './fees'
import type { Platform } from '../data/types'

/** Assumptions a scenario may set for itself. Absent = inherit the shared setting. */
export interface ScenarioAssumptions {
  /** Fees on this scenario's hypothetical trades (default: provider estimate as taker). */
  fees?: FeeAssumption
  /** Hypothetical settlement constraints between events, for this scenario only. Never facts; never used by Risk. */
  constraints?: Constraint[]
}
/** Everything that defines a scenario's result; compared to decide saved / unsaved. */
export interface Snapshot { name: string; adjs: Adjustment[]; baseline: Baseline; funding: Partial<Record<Platform, number>>; assumptions: ScenarioAssumptions }
export interface Scenario extends Snapshot {
  key: string; saved: Snapshot | null; savedAt: string | null; color: string
  /** Date of the actual portfolio this scenario was created from (current-portfolio scenarios). When the actual
   *  portfolio has moved on, the scenario says so instead of silently rebasing. null = unknown (older scenarios). */
  baseAsOf?: string | null
  /** What Reset returns a never-saved scenario to: empty for a new one, the source's state for a duplicate or example. */
  start?: Snapshot
}
export type ScenarioStatus = 'new' | 'saved' | 'modified'

const copyAdjs = (a: Adjustment[]) => a.map((x) => ({ ...x, instrument: x.instrument ? { ...x.instrument } : undefined, size: x.size ? { ...x.size } : undefined }))
const copyAssumptions = (a: ScenarioAssumptions): ScenarioAssumptions => ({ ...a, ...(a.fees ? { fees: { ...a.fees } } : {}), ...(a.constraints ? { constraints: a.constraints.map((c) => ({ ...c })) } : {}) })
const snap = (s: Snapshot): Snapshot => ({ name: s.name, adjs: copyAdjs(s.adjs), baseline: s.baseline, funding: { ...s.funding }, assumptions: copyAssumptions(s.assumptions) })
/** Content equality, ignoring key order and undefined fields. */
/** Everything the user controls takes part in saved/unsaved: positions (with instrument identity), starting point,
 *  capital, fee treatment and constraints. Reference prices are market data, not user input: a refreshed price
 *  doesn't make a scenario "unsaved" (results always show the reference time). */
const norm = (s: Snapshot) => JSON.stringify({
  n: s.name, b: s.baseline, f: [s.funding.pm ?? null, s.funding.ks ?? null],
  a: s.adjs.map((x) => [x.id, x.size ? null : x.to, x.price, x.instrument ? `${x.instrument.provider}:${x.instrument.marketId}:${x.instrument.outcome}` : null, x.size ? [x.size.by, x.size.value] : null]),
  fee: s.assumptions.fees ?? null,
  c: (s.assumptions.constraints ?? []).map((c) => [c.a, c.b, c.cls].join()).sort(),
})
const same = (a: Snapshot, b: Snapshot) => norm(a) === norm(b)

export const status = (s: Scenario): ScenarioStatus => (!s.saved ? 'new' : same(s.saved, s) ? 'saved' : 'modified')
export const isDirty = (s: Scenario) => status(s) !== 'saved'
export const statusLabel = (s: Scenario) => ({ new: 'Not saved', saved: 'Saved', modified: 'Unsaved changes' })[status(s)]

export const create = (key: string, color: string, name = 'Untitled scenario', baseline: Baseline = 'portfolio', baseAsOf: string | null = null, funding: Snapshot['funding'] = {}): Scenario => {
  const base: Snapshot = { name, adjs: [], baseline, funding: { ...funding }, assumptions: {} }
  return { ...base, key, saved: null, savedAt: null, color, start: snap({ ...base, funding: {} }), baseAsOf }
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
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
/** A stored fee schedule, or null (unavailable) when missing or malformed. Never invented. */
function readSchedule(v: unknown): FeeSchedule | null {
  if (!v || typeof v !== 'object') return null
  const f = v as Record<string, unknown>
  const rate = (x: unknown) => (x === null ? null : isNum(x) && (x as number) >= 0 ? (x as number) : undefined)
  const taker = rate(f.taker), maker = rate(f.maker)
  if (f.formula !== 'price-variance' || taker === undefined || maker === undefined || (f.rounding !== 'up-to-cent' && f.rounding !== 'nearest-5dp')) return null
  return { formula: 'price-variance', taker, maker, rounding: f.rounding, source: f.source === 'provider' ? 'provider' : 'sample', reference: typeof f.reference === 'string' ? f.reference : '', effective: typeof f.effective === 'string' ? f.effective : null }
}
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
    fee: readSchedule(i.fee),
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
      const size = a.size && typeof a.size === 'object' && (a.size.by === 'amount' || a.size.by === 'weight') && isNum(a.size.value) && a.size.value >= 0 ? { by: a.size.by as 'amount' | 'weight', value: a.size.value as number } : undefined
      if (to === undefined || price === undefined || instrument === false || (!instrument && !knownIds(a.id))) { dropped++; continue }
      out.push({ id: a.id, to, price, ...(instrument ? { instrument } : {}), ...(size ? { size } : {}) })
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
      const fees = readFeeAssumption(o.fees, o.includeFees)
      if (o.fees || o.includeFees === false) a.fees = fees
      const cs: Constraint[] = []
      if (Array.isArray(o.constraints)) for (const c of o.constraints) {
        if (c && typeof c.a === 'string' && typeof c.b === 'string' && c.a !== c.b && (c.cls === 'mutex' || c.cls === 'equivalent') && !cs.some((x) => (x.a === c.a && x.b === c.b) || (x.a === c.b && x.b === c.a))) cs.push({ a: c.a, b: c.b, cls: c.cls })
      }
      // Older scenarios could override the sample BTC × ETH pair; only a constraining override carries meaning.
      if (o.crypto === 'mutex' && !cs.length) cs.push({ a: 'btc', b: 'eth', cls: 'mutex' })
      if (cs.length) a.constraints = cs
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
    return [{ ...cur, key: x.key, saved, savedAt: typeof x.savedAt === 'string' ? x.savedAt : null, color: typeof x.color === 'string' ? x.color : '', start, baseAsOf: typeof x.baseAsOf === 'string' ? x.baseAsOf : null }]
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

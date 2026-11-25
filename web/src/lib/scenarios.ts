/**
 * Scenario bookkeeping, kept pure so it can be tested and later persisted server-side.
 *
 * A saved scenario is a name plus a list of adjustments (target shares at an assumed fill price).
 * It is always evaluated under the current global assumptions (fee estimate on/off, event relationships),
 * so every scenario in a comparison uses the same assumptions.
 */
import type { Adjustment } from './finance'

export interface Snapshot { name: string; adjs: Adjustment[] }
export interface Scenario {
  key: string; name: string; adjs: Adjustment[]; saved: Snapshot | null; savedAt: string | null; color: string
  /** What Reset returns a never-saved scenario to: empty for a new one, the source's adjustments for a duplicate. */
  start?: Adjustment[]
}
export type ScenarioStatus = 'new' | 'saved' | 'modified'

const copy = (a: Adjustment[]) => a.map((x) => ({ ...x }))
const sameAdjs = (a: Adjustment[], b: Adjustment[]) => JSON.stringify(a) === JSON.stringify(b)

export const status = (s: Scenario): ScenarioStatus => (!s.saved ? 'new' : s.saved.name === s.name && sameAdjs(s.saved.adjs, s.adjs) ? 'saved' : 'modified')
export const isDirty = (s: Scenario) => status(s) !== 'saved'
export const statusLabel = (s: Scenario) => ({ new: 'Not saved', saved: 'Saved', modified: 'Unsaved changes' })[status(s)]

export const create = (key: string, color: string, name = 'Untitled scenario'): Scenario => ({ key, name, adjs: [], saved: null, savedAt: null, color, start: [] })
export const rename = (s: Scenario, name: string): Scenario => ({ ...s, name: name.trim() || s.name })
export const save = (s: Scenario, at: string): Scenario => ({ ...s, saved: { name: s.name, adjs: copy(s.adjs) }, savedAt: at })
/** Back to the saved version (name and adjustments); a never-saved scenario returns to its starting adjustments. */
export const revert = (s: Scenario, starting: Adjustment[] = s.start ?? []): Scenario =>
  s.saved ? { ...s, name: s.saved.name, adjs: copy(s.saved.adjs) } : { ...s, adjs: copy(starting) }
export const canRevert = (s: Scenario, starting: Adjustment[] = s.start ?? []) => (s.saved ? status(s) === 'modified' : !sameAdjs(s.adjs, starting))
export const duplicate = (s: Scenario, key: string, color: string): Scenario => ({ ...s, key, color, name: `${s.name} (copy)`, adjs: copy(s.adjs), saved: null, savedAt: null, start: copy(s.adjs) })

/** Validate scenarios restored from storage. Malformed entries are dropped; adjustments that reference positions
 *  no longer in the portfolio are removed (and reported), never kept as dangling ids. Returns null if unusable. */
export function sanitize(raw: unknown, knownIds: (id: string) => boolean): { scenarios: Scenario[]; dropped: number } | null {
  if (!Array.isArray(raw)) return null
  const isAdj = (a: unknown): a is Adjustment => !!a && typeof a === 'object' && typeof (a as Adjustment).id === 'string' && Number.isFinite((a as Adjustment).to) && Number.isFinite((a as Adjustment).price)
  const adjs = (v: unknown) => (Array.isArray(v) ? v.filter(isAdj) : [])
  let dropped = 0
  const keep = (list: Adjustment[]) => { const k = list.filter((a) => knownIds(a.id)); dropped += list.length - k.length; return k.map((a) => ({ id: a.id, to: a.to, price: a.price })) }
  const scenarios = raw.flatMap((x): Scenario[] => {
    if (!x || typeof x !== 'object' || typeof x.key !== 'string' || typeof x.name !== 'string') return []
    const saved = x.saved && typeof x.saved === 'object' && typeof x.saved.name === 'string' ? { name: x.saved.name, adjs: keep(adjs(x.saved.adjs)) } : null
    return [{ key: x.key, name: x.name, adjs: keep(adjs(x.adjs)), saved, savedAt: typeof x.savedAt === 'string' ? x.savedAt : null, color: typeof x.color === 'string' ? x.color : '', start: Array.isArray(x.start) ? keep(adjs(x.start)) : undefined }]
  })
  const keys = new Set<string>()
  return { scenarios: scenarios.filter((x) => !keys.has(x.key) && keys.add(x.key)), dropped }
}

/** Explicitly add positions to a scenario at their current holding and mark (no hypothetical change yet).
 *  Positions already in the scenario are left exactly as they are. */
export function addPositions(s: Scenario, adds: Adjustment[]) {
  const present = new Set(s.adjs.map((a) => a.id))
  const added = adds.filter((a) => !present.has(a.id))
  return { scenario: { ...s, adjs: [...s.adjs, ...added.map((a) => ({ ...a }))] }, added: added.map((a) => a.id), skipped: adds.filter((a) => present.has(a.id)).map((a) => a.id) }
}

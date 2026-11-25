/**
 * Scenario bookkeeping, kept pure so it can be tested and later persisted server-side.
 *
 * A saved scenario is a name plus a list of adjustments (target shares at an assumed fill price).
 * It is always evaluated under the current global assumptions (fee estimate on/off, event relationships),
 * so every scenario in a comparison uses the same assumptions.
 */
import type { Adjustment } from './finance'

export interface Snapshot { name: string; adjs: Adjustment[] }
export interface Scenario { key: string; name: string; adjs: Adjustment[]; saved: Snapshot | null; savedAt: string | null; color: string }
export type ScenarioStatus = 'new' | 'saved' | 'modified'

const copy = (a: Adjustment[]) => a.map((x) => ({ ...x }))
const sameAdjs = (a: Adjustment[], b: Adjustment[]) => JSON.stringify(a) === JSON.stringify(b)

export const status = (s: Scenario): ScenarioStatus => (!s.saved ? 'new' : s.saved.name === s.name && sameAdjs(s.saved.adjs, s.adjs) ? 'saved' : 'modified')
export const isDirty = (s: Scenario) => status(s) !== 'saved'
export const statusLabel = (s: Scenario) => ({ new: 'Not saved', saved: 'Saved', modified: 'Unsaved changes' })[status(s)]

export const create = (key: string, color: string, name = 'Untitled scenario'): Scenario => ({ key, name, adjs: [], saved: null, savedAt: null, color })
export const rename = (s: Scenario, name: string): Scenario => ({ ...s, name: name.trim() || s.name })
export const save = (s: Scenario, at: string): Scenario => ({ ...s, saved: { name: s.name, adjs: copy(s.adjs) }, savedAt: at })
/** Back to the saved version (name and adjustments); a never-saved scenario returns to its starting adjustments. */
export const revert = (s: Scenario, starting: Adjustment[] = []): Scenario =>
  s.saved ? { ...s, name: s.saved.name, adjs: copy(s.saved.adjs) } : { ...s, adjs: copy(starting) }
export const canRevert = (s: Scenario, starting: Adjustment[] = []) => (s.saved ? status(s) === 'modified' : !sameAdjs(s.adjs, starting))
export const duplicate = (s: Scenario, key: string, color: string): Scenario => ({ ...s, key, color, name: `${s.name} (copy)`, adjs: copy(s.adjs), saved: null, savedAt: null })

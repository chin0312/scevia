/* Browser-tab storage for Scevia-managed state (scenarios, assumptions, view preferences).
   Every key starts with `scevia-`, so clearing never touches anything else in session storage.
   Reads are validated and fall back to defaults; write failures are reported, never hidden.

   This is deliberately separate from portfolio records (lib/finance.ts via data/portfolio.ts): scenarios and
   assumptions are user work that a future signed-in workspace would persist; portfolio data comes from sources. */

export const STORAGE_PREFIX = 'scevia-'

type Listener = (ok: boolean) => void
let healthy = true
const listeners = new Set<Listener>()
function setHealth(ok: boolean) { if (ok !== healthy) { healthy = ok; listeners.forEach((l) => l(ok)) } }
export const storageHealthy = () => healthy
export function onStorageHealth(l: Listener) { listeners.add(l); return () => { listeners.delete(l) } }

function store(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

/** Read and validate a stored value. Missing, unparsable or invalid data returns `fallback`. */
export function readStored<T>(key: string, fallback: T, sanitize?: (raw: unknown) => T | null): T {
  const s = store()
  if (!s) { setHealth(false); return fallback }
  try {
    const raw = s.getItem(key)
    if (raw == null) return fallback
    const parsed: unknown = JSON.parse(raw)
    return sanitize ? sanitize(parsed) ?? fallback : (parsed as T)
  } catch { return fallback }
}

/** Write a value; returns false (and marks storage unhealthy) when the browser refuses. */
export function writeStored(key: string, value: unknown): boolean {
  const s = store()
  if (!s) { setHealth(false); return false }
  try { s.setItem(key, JSON.stringify(value)); setHealth(true); return true } catch { setHealth(false); return false }
}

/** Remove one Scevia key (used after migrating it). */
export function removeStored(key: string) { try { store()?.removeItem(key) } catch { /* reported by the next write */ } }

/** Keys Scevia currently holds in this tab. */
export function sceviaKeys(): string[] {
  const s = store()
  if (!s) return []
  const keys: string[] = []
  for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(STORAGE_PREFIX)) keys.push(k) }
  return keys
}

/** Remove only Scevia-managed keys. Reports whether every key was actually removed. */
export function clearScevia(): { ok: boolean; removed: number } {
  const s = store()
  if (!s) return { ok: false, removed: 0 }
  const keys = sceviaKeys()
  try { keys.forEach((k) => s.removeItem(k)) } catch { return { ok: false, removed: 0 } }
  const left = sceviaKeys().length
  return { ok: left === 0, removed: keys.length - left }
}

/** Logical groups of local data, so a user can clear one without losing the others. */
export const DATA_GROUPS = {
  preferences: { label: 'Preferences', keys: (k: string) => k === 'scevia-settings' || k === 'scevia-guardrail' || k === 'scevia-workspace' || k.startsWith('scevia-lab-') },
  scenarios: { label: 'Scenarios & replays', keys: (k: string) => k.startsWith('scevia-scenarios') || k.startsWith('scevia-active') || k.startsWith('scevia-handoff') || k.startsWith('scevia-replay') },
  records: { label: 'Sample records & import history', keys: (k: string) => k.startsWith('scevia-records') },
  notifications: { label: 'Notification read state & activity', keys: (k: string) => k.startsWith('scevia-notif') },
} as const
export type DataGroup = keyof typeof DATA_GROUPS
export const groupKeys = (g: DataGroup) => sceviaKeys().filter(DATA_GROUPS[g].keys)
/** Remove one group's keys only. */
export function clearGroup(g: DataGroup): { ok: boolean; removed: number } {
  const s = store()
  if (!s) return { ok: false, removed: 0 }
  const keys = groupKeys(g)
  try { keys.forEach((k) => s.removeItem(k)) } catch { return { ok: false, removed: 0 } }
  return { ok: groupKeys(g).length === 0, removed: keys.length }
}

/** Storage key for data a workspace owns (scenarios, replays, records, notification state): `base@workspaceId`.
 *  The development Sample portfolio keeps the original unsuffixed keys, so its existing tab data stays readable.
 *  Global preferences (settings, view choices) are not scoped. */
export const SAMPLE_WORKSPACE_ID = 'sample'
export const scopedKey = (base: string, workspaceId: string) => (workspaceId === SAMPLE_WORKSPACE_ID ? base : `${base}@${workspaceId}`)

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

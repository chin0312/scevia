import { useCallback, useEffect, useState } from 'react'
import { onStorageHealth, readStored, storageHealthy, writeStored } from './storage'

/** State that survives navigation and reloads within the browser tab. Stored values are validated with
 *  `sanitize` (return null to reject); a failed write is reported through `useStorageHealthy`. */
export function useSessionState<T>(key: string, initial: T, sanitize?: (raw: unknown) => T | null) {
  // When the key changes (another workspace), the value is re-read for the new key: one key's value is never
  // written under another.
  const [state, setState] = useState(() => ({ key, v: readStored(key, initial, sanitize) }))
  let cur = state
  if (state.key !== key) { cur = { key, v: readStored(key, initial, sanitize) }; setState(cur) }
  useEffect(() => { writeStored(cur.key, cur.v) }, [cur.key, cur.v])
  const set = useCallback((u: T | ((prev: T) => T)) => setState((s) => ({ key: s.key, v: typeof u === 'function' ? (u as (p: T) => T)(s.v) : u })), [])
  return [cur.v, set] as const
}

/** False when the browser refused to keep Scevia's data in this tab (private mode limits, quota, disabled storage). */
export function useStorageHealthy() {
  const [ok, setOk] = useState(storageHealthy)
  useEffect(() => onStorageHealth(setOk), [])
  return ok
}

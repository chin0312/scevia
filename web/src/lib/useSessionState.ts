import { useEffect, useState } from 'react'
import { onStorageHealth, readStored, storageHealthy, writeStored } from './storage'

/** State that survives navigation and reloads within the browser tab. Stored values are validated with
 *  `sanitize` (return null to reject); a failed write is reported through `useStorageHealthy`. */
export function useSessionState<T>(key: string, initial: T, sanitize?: (raw: unknown) => T | null) {
  const [v, setV] = useState<T>(() => readStored(key, initial, sanitize))
  useEffect(() => { writeStored(key, v) }, [key, v])
  return [v, setV] as const
}

/** False when the browser refused to keep Scevia's data in this tab (private mode limits, quota, disabled storage). */
export function useStorageHealthy() {
  const [ok, setOk] = useState(storageHealthy)
  useEffect(() => onStorageHealth(setOk), [])
  return ok
}

import { useEffect, useState } from 'react'

/** State that survives navigation within the browser tab (sessionStorage). Used for scenarios and settings
 *  until accounts and server-side persistence exist. */
export function useSessionState<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try { const raw = sessionStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial } catch { return initial }
  })
  useEffect(() => { sessionStorage.setItem(key, JSON.stringify(v)) }, [key, v])
  return [v, setV] as const
}

/* Event relationships (concept doc §5.3): Equivalent contract / Mutually exclusive outcomes /
   Related but non-equivalent / Unknown. Only manually confirmed or near-certain mappings are used.
   Shared by Risk and Scenario Lab; persisted for the browser session (prototype, no backend). */
import { useEffect, useState } from 'react'

export type RelClass = 'equivalent' | 'mutex' | 'related' | 'unknown'
export const REL_TEXT: Record<RelClass, { label: string; short: string; tone: 'yes' | 'info' | 'warn' | 'accent' }> = {
  equivalent: { label: 'Equivalent contract', short: 'Equivalent', tone: 'yes' },
  mutex: { label: 'Mutually exclusive outcomes', short: 'Mutually exclusive', tone: 'accent' },
  related: { label: 'Related but non-equivalent', short: 'Related', tone: 'info' },
  unknown: { label: 'Unknown', short: '? Unknown', tone: 'warn' },
}

const KEY = 'scevia-rel-crypto'
const listeners = new Set<(v: RelClass) => void>()
const read = (): RelClass => (sessionStorage.getItem(KEY) as RelClass | null) ?? 'unknown'

/** The one user-classifiable pair in the sample: BTC year-end × ETH ETF flows. */
export function useCryptoRelation() {
  const [v, setV] = useState<RelClass>(read)
  useEffect(() => { listeners.add(setV); return () => { listeners.delete(setV) } }, [])
  const set = (n: RelClass) => { sessionStorage.setItem(KEY, n); listeners.forEach((l) => l(n)) }
  return [v, set] as const
}

const MACRO = new Set(['fed', 'cpi', 'rec'])
/** Relationship between two events, or null when nobody has classified the pair. */
export function pairRelation(a: string, b: string, crypto: RelClass): RelClass | null {
  if (a === b) return 'equivalent'
  if (MACRO.has(a) && MACRO.has(b)) return 'related'
  if (new Set([a, b]).has('btc') && new Set([a, b]).has('eth')) return crypto
  return null
}

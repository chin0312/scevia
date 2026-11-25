/* Event relationships (Equivalent contract / Mutually exclusive outcomes / Related but non-equivalent / Unknown).
   The rules live in lib/finance.ts; this file only holds the user's choice and its labels, shared by Risk and Scenario Lab.
   The choice is kept in this browser tab (lib/storage.ts). */
import { useEffect, useState } from 'react'
import { relationsFor } from '../lib/finance'
import { readStored, writeStored } from '../lib/storage'
import type { RelClass } from './types'

export type { RelClass }
export const REL_TEXT: Record<RelClass, { label: string; short: string; tone: 'yes' | 'info' | 'warn' | 'accent' }> = {
  equivalent: { label: 'Equivalent contract', short: 'Equivalent', tone: 'yes' },
  mutex: { label: 'Mutually exclusive outcomes', short: 'Mutually exclusive', tone: 'accent' },
  related: { label: 'Related but non-equivalent', short: 'Related', tone: 'info' },
  unknown: { label: 'Unknown', short: '? Unknown', tone: 'warn' },
}

const KEY = 'scevia-rel-crypto'
const listeners = new Set<(v: RelClass) => void>()
const CLASSES: RelClass[] = ['related', 'mutex', 'unknown']
const read = (): RelClass => readStored<RelClass>(KEY, 'unknown', (v) => (CLASSES.includes(v as RelClass) ? (v as RelClass) : null))

/** The one user-classifiable pair in the sample: BTC year-end × ETH ETF flows. Returns the full relation list too. */
export function useRelations() {
  const [crypto, setCrypto] = useState<RelClass>(read)
  useEffect(() => { listeners.add(setCrypto); return () => { listeners.delete(setCrypto) } }, [])
  const set = (n: RelClass) => { writeStored(KEY, n); listeners.forEach((l) => l(n)) }
  return { crypto, setCrypto: set, rels: relationsFor(crypto) }
}

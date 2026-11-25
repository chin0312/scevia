/* Event relationship labels. Relationships describe SETTLEMENT LOGIC between events, not statistical correlation:
   - Equivalent: settle the same way (a verified fact from settlement rules / reviewed source data).
   - Mutually exclusive: can't both resolve YES (a verified fact, or a scenario's hypothetical constraint).
   - Related: share drivers; every combination stays possible; nothing is netted.
   - Unknown / unclassified: no constraint; NOT an assumption of independence.
   The rules live in lib/finance.ts. Source relationships come with the portfolio data; hypothetical constraints
   belong to a single scenario and never change Risk or other scenarios. */
import type { RelClass, RelProvenance } from './types'

export type { RelClass, RelProvenance }
export const REL_TEXT: Record<RelClass, { label: string; short: string; tone: 'yes' | 'info' | 'warn' | 'accent' }> = {
  equivalent: { label: 'Equivalent settlement', short: 'Equivalent', tone: 'yes' },
  mutex: { label: 'Mutually exclusive outcomes', short: 'Mutually exclusive', tone: 'accent' },
  related: { label: 'Related, no constraint', short: 'Related', tone: 'info' },
  unknown: { label: 'Unknown', short: 'Unknown', tone: 'warn' },
}
export const PROVENANCE_TEXT: Record<RelProvenance, string> = {
  verified: 'verified',
  annotation: 'note',
  hypothetical: 'this scenario only',
}

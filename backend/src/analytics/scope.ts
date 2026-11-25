import type { Evidence } from '../accounting/model.js'

export interface AccountIdentity { venue: string; account: string }
export const accountKey = ({ venue, account }: AccountIdentity) => JSON.stringify([venue, account])
export const instrumentKey = (row: AccountIdentity, instrument: string) => JSON.stringify([row.venue, row.account, instrument])

export function coversAccounts(rows: AccountIdentity[], accounts: string[], scopes: AccountIdentity[]) {
  const present = new Set(rows.map(accountKey))
  return rows.length > 0 && accounts.every((account) => rows.some((row) => row.account === account))
    && scopes.every((scope) => present.has(accountKey(scope)))
}

export function canonicalInstrumentKeys(evidence: Evidence[], asOf: string) {
  const candidates = new Set<string>()
  const local = new Set<string>()
  for (const item of evidence) {
    const row = item.observation
    if (row.timestamp > asOf || item.unresolvedReason || !row.instrument || row.type === 'mark') continue
    const key = instrumentKey(row, row.instrument)
    const canonical = row.canonicalInstrumentId === row.instrument
      || (('providerAccountId' in item || item.linkedSourceRecordId) && (item.originalObservation?.instrument ?? row.instrument) === row.instrument
        && item.instrumentMetadata)
    if (canonical) candidates.add(key)
    else local.add(key)
    if (row.completeSet) local.add(instrumentKey(row, row.completeSet.counterInstrument))
  }
  return new Set([...candidates].filter((key) => !local.has(key)))
}

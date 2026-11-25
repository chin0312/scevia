/* User-controlled record management for the sample records workspace (pages/Records.tsx).
   Mirrors the backend Phase 3 contract in miniature: original evidence is kept, owner decisions are separate and
   reversible (include / exclude / restore / distinct / duplicate-of / correct), bulk changes are previewed before
   they are confirmed, and supplemental imports start as overlap candidates unless the owner accepts unmatched rows.
   It is deliberately not a ledger: previews report simple cash and quantity effects of the selected records, and
   nothing here feeds the portfolio figures (the backend replay will be the accounting authority). */
import type { FinRecord, RecordType, SampleFile, WorkspaceAccount } from '../data/sampleRecords'

export type Inclusion = 'included' | 'excluded' | 'review'
export type Decision =
  | { kind: 'exclude' } | { kind: 'include' } | { kind: 'distinct' }
  | { kind: 'duplicate'; of: string }
  | { kind: 'correct'; patch: Partial<Pick<FinRecord, 'quantity' | 'price' | 'amount' | 'fee' | 'time'>> }
export interface ManagedRecord extends FinRecord {
  /** Default state from acquisition: provider and independent-import rows are included; unresolved supplemental
   *  rows start in review. Decisions override it and can be restored. */
  initial: Inclusion
  decision: Decision | null
  /** A correction is kept beside the original values (never overwrites them). */
  correction: Extract<Decision, { kind: 'correct' }>['patch'] | null
}
export const inclusionOf = (r: ManagedRecord): Inclusion =>
  !r.decision ? r.initial : r.decision.kind === 'exclude' || r.decision.kind === 'duplicate' ? 'excluded' : r.decision.kind === 'include' || r.decision.kind === 'distinct' ? 'included' : r.initial
export const effective = (r: ManagedRecord): FinRecord => ({ ...r, ...(r.correction ?? {}) })

/** Same account, type and normalized economic terms. A hint for review, never an automatic merge. */
const terms = (r: FinRecord) => JSON.stringify([r.accountId, r.type, r.time, r.instrument, r.side, r.quantity, r.price, r.amount])
export function duplicateCandidates(rs: ManagedRecord[]): Record<string, string[]> {
  const by = new Map<string, string[]>()
  for (const r of rs) { const k = terms(effective(r)); by.set(k, [...(by.get(k) ?? []), r.key]) }
  const out: Record<string, string[]> = {}
  for (const keys of by.values()) if (keys.length > 1) for (const k of keys) out[k] = keys.filter((x) => x !== k)
  return out
}

/** Signed cash effect of one record (null when a needed amount is unknown, e.g. an unreported fee). Settlements
 *  create an entitlement, not cash: the redemption is the cash movement. */
export function cashEffect(r: FinRecord): number | null {
  const fee = r.fee
  switch (r.type) {
    case 'deposit': return r.amount
    case 'withdrawal': return r.amount == null ? null : -r.amount
    case 'fee': return r.amount == null ? null : -r.amount
    case 'redemption': return r.amount
    case 'settlement': return 0
    case 'buy': return r.quantity == null || r.price == null || fee == null ? null : -(r.quantity * r.price + fee)
    case 'sell': return r.quantity == null || r.price == null || fee == null ? null : r.quantity * r.price - fee
  }
}
const qtyEffect = (r: FinRecord) => (r.type === 'buy' ? r.quantity ?? 0 : r.type === 'sell' || r.type === 'settlement' ? -(r.quantity ?? 0) : 0)

export type Action = 'include' | 'exclude' | 'restore' | 'distinct'
export const ACTION_LABEL: Record<Action, string> = { include: 'Include', exclude: 'Exclude', restore: 'Restore', distinct: 'Accept as distinct' }

/** What a change would do, before it is confirmed: how many records change state, and the change in included cash
 *  and quantities per account / instrument. Unknown amounts are counted, never treated as zero. */
export interface Preview { changed: string[]; unchanged: number; cash: Record<string, number>; qty: Record<string, number>; unknown: number }
export function preview(rs: ManagedRecord[], keys: string[], action: Action): Preview {
  const set = new Set(keys), cash: Record<string, number> = {}, qty: Record<string, number> = {}
  let unknown = 0, unchanged = 0
  const changed: string[] = []
  for (const r of rs) {
    if (!set.has(r.key)) continue
    const before = inclusionOf(r), after = inclusionOf(apply1(r, action))
    if (before === after) { unchanged++; continue }
    changed.push(r.key)
    const sign = after === 'included' ? 1 : before === 'included' ? -1 : 0
    if (!sign) continue
    const e = effective(r), c = cashEffect(e)
    if (c == null) unknown++
    else cash[r.accountId] = (cash[r.accountId] ?? 0) + sign * c
    const q = qtyEffect(e)
    if (q && e.instrument) qty[`${e.instrument} ${e.side ?? ''}`.trim()] = (qty[`${e.instrument} ${e.side ?? ''}`.trim()] ?? 0) + sign * q
  }
  return { changed, unchanged, cash, qty, unknown }
}
function apply1(r: ManagedRecord, action: Action): ManagedRecord {
  if (action === 'restore') return { ...r, decision: null }
  if (action === 'distinct') return inclusionOf(r) === 'review' || r.decision?.kind === 'duplicate' ? { ...r, decision: { kind: 'distinct' } } : r
  return { ...r, decision: { kind: action } }
}
export const apply = (rs: ManagedRecord[], keys: string[], action: Action) => { const set = new Set(keys); return rs.map((r) => (set.has(r.key) ? apply1(r, action) : r)) }
export const markDuplicate = (rs: ManagedRecord[], key: string, of: string) => rs.map((r) => (r.key === key ? { ...r, decision: { kind: 'duplicate' as const, of } } : r))
export const correct = (rs: ManagedRecord[], key: string, patch: NonNullable<ManagedRecord['correction']>) => rs.map((r) => (r.key === key && r.source !== 'api' ? { ...r, correction: { ...(r.correction ?? {}), ...patch } } : r))
export const clearCorrection = (rs: ManagedRecord[], key: string) => rs.map((r) => (r.key === key ? { ...r, correction: null } : r))

/* ── Filtering ─────────────────────────────────────────────── */
export interface RecordFilter { q: string; account: string; venue: string; source: string; type: string; inclusion: string; from: string; to: string; duplicates: boolean }
export const NO_FILTER: RecordFilter = { q: '', account: 'all', venue: 'all', source: 'all', type: 'all', inclusion: 'all', from: '', to: '', duplicates: false }
export function filterRecords(rs: ManagedRecord[], f: RecordFilter, accounts: WorkspaceAccount[]) {
  const dups = duplicateCandidates(rs), q = f.q.trim().toLowerCase()
  return rs.filter((r) => {
    const e = effective(r), venue = accounts.find((a) => a.id === r.accountId)?.venue
    if (f.account !== 'all' && r.accountId !== f.account) return false
    if (f.venue !== 'all' && venue !== f.venue) return false
    if (f.source !== 'all' && r.source !== f.source) return false
    if (f.type !== 'all' && r.type !== f.type) return false
    if (f.inclusion === 'corrected' ? !r.correction : f.inclusion !== 'all' && inclusionOf(r) !== f.inclusion) return false
    if (f.from && e.time.slice(0, 10) < f.from) return false
    if (f.to && e.time.slice(0, 10) > f.to) return false
    if (f.duplicates && !dups[r.key]) return false
    if (q && !`${e.instrument ?? ''} ${e.type} ${r.key} ${r.batch ?? ''}`.toLowerCase().includes(q)) return false
    return true
  }).sort((a, b) => effective(b).time.localeCompare(effective(a).time))
}

/* ── Import (sample files only) ────────────────────────────── */
export type ImportMode = 'independent' | 'supplement'
export interface ImportRow { n: number; rec: FinRecord; match: string | null; warnings: string[] }
/** Normalize a sample file for an account. In a supplement, rows whose economic terms exactly match a record already
 *  in that account are flagged as overlaps; nothing is matched by name across accounts. */
export function previewImport(file: SampleFile, accountId: string, mode: ImportMode, existing: ManagedRecord[]): ImportRow[] {
  return file.rows.map((row, i) => {
    const rec: FinRecord = { ...row, key: `${file.name}#${i + 1}`, accountId, source: 'csv', batch: file.name }
    const match = mode === 'supplement' ? existing.find((x) => x.accountId === accountId && terms(effective(x)) === terms(rec))?.key ?? null : null
    const warnings = [...(row.fee == null && (row.type === 'buy' || row.type === 'sell') ? ['Fee not reported: cash effect unknown'] : []), ...(match ? [`Matches ${match}`] : [])]
    return { n: i + 1, rec, match, warnings }
  })
}
/** Confirm an import. Independent: every row is included in its own account. Supplement: overlaps stay in review
 *  (resolve them as duplicate or distinct); unmatched rows are included only if the owner accepts them. */
export function confirmImport(rs: ManagedRecord[], rows: ImportRow[], mode: ImportMode, acceptUnmatched: boolean): ManagedRecord[] {
  const added = rows.map((x): ManagedRecord => ({ ...x.rec, initial: mode === 'independent' ? 'included' : x.match ? 'review' : acceptUnmatched ? 'included' : 'review', decision: null, correction: null }))
  return [...rs.filter((r) => !added.some((a) => a.key === r.key)), ...added]
}
export const fromRecords = (rs: FinRecord[]): ManagedRecord[] => rs.map((r) => ({ ...r, initial: 'included', decision: null, correction: null }))
export const TYPE_LABEL: Record<RecordType, string> = { deposit: 'Deposit', withdrawal: 'Withdrawal', buy: 'Buy', sell: 'Sell', fee: 'Fee', settlement: 'Settlement', redemption: 'Redemption' }

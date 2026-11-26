/* Record management for the portfolio workspace's sample records (pages/Portfolio.tsx). Mirrors the backend
   accounting contract in miniature (backend/docs/ACCOUNTING.md):
   - Original evidence is kept. A record has independent decision dimensions: membership (include / exclude /
     as delivered), identity (accepted as distinct), duplicate relationship and financial correction. Membership
     changes never erase the others; each dimension has its own reset.
   - A duplicate relationship pins a target; if the target disappears or is no longer included, the record needs review
     instead of silently counting again.
   - Imports have stable batch ids. Importing the same file into another account creates separate records; importing it
     again into the same account is a replacement that carries decisions for rows matched by source reference.
   - Bulk changes are previewed (per account, per account + market + outcome) before they are confirmed.
   It is deliberately not a ledger: previews report simple cash and quantity effects of the selected records, and
   nothing here feeds the portfolio figures (the backend replay is the accounting authority). */
import type { FinRecord, ImportBatch, Outcome, RecordType, SampleFile, WorkspaceAccount } from '../data/sampleRecords'

export type Correction = Partial<Pick<FinRecord, 'quantity' | 'price' | 'amount' | 'fee' | 'time'>>
export interface ManagedRecord extends FinRecord {
  /** How the record arrived: provider, independent-import and manual rows are included; unresolved supplemental
   *  overlaps start in review. */
  initial: 'included' | 'review'
  /** Portfolio membership chosen by the owner (null = as delivered). */
  membership: 'include' | 'exclude' | null
  /** Identity decision: accepted as a separate economic event even though it resembles another. */
  identity: 'distinct' | null
  /** Duplicate relationship: this observation duplicates the named record. */
  duplicateOf: string | null
  /** Fingerprint of the target's effective economic terms when the link was made. If the target is later corrected
   *  or replaced with different terms, the link no longer holds and the record needs review. */
  duplicateFp: string | null
  /** A correction is kept beside the original values (never overwrites them). */
  correction: Correction | null
}
export type Status = 'included' | 'excluded' | 'duplicate' | 'review'
export const STATUS_LABEL: Record<Status, string> = { included: 'Included', excluded: 'Excluded', duplicate: 'Duplicate', review: 'Needs review' }

/** Effective status. Exclusion wins; a duplicate link counts only while its target is included (otherwise the record
 *  needs review); an explicit include or a distinct-identity decision resolves an unresolved overlap. */
export function statusOf(r: ManagedRecord, all: ManagedRecord[]): Status {
  if (r.membership === 'exclude') return 'excluded'
  if (r.duplicateOf) return duplicateHolds(r, all) ? 'duplicate' : 'review'
  if (r.membership === 'include' || r.identity === 'distinct') return 'included'
  return r.initial
}
export const effective = (r: ManagedRecord): FinRecord => ({ ...r, ...(r.correction ?? {}) })
/** Economic terms of a record (what makes two observations the same transaction), independent of its key. */
export const fingerprint = (r: FinRecord) => JSON.stringify([r.accountId, r.type, r.time, r.marketId ?? r.instrument, r.side, r.quantity, r.price, r.amount, r.fee])
/** A duplicate link holds only while its target exists, isn't itself a duplicate, is included (not excluded and not
 *  awaiting review), and still has the economic terms it had when the link was made. */
export function duplicateHolds(r: ManagedRecord, all: ManagedRecord[]): boolean {
  const t = all.find((x) => x.key === r.duplicateOf)
  return !!t && !t.duplicateOf && statusOf(t, all) === 'included' && (r.duplicateFp == null || r.duplicateFp === fingerprint(effective(t)))
}
const isAdjusted = (r: ManagedRecord) => !!(r.membership || r.identity || r.duplicateOf || r.correction)

/** Same account, type and normalized economic terms. A hint for review, never an automatic merge. */
const terms = (r: FinRecord) => JSON.stringify([r.accountId, r.type, r.time, r.marketId ?? r.instrument, r.side, r.quantity, r.price, r.amount])
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
  switch (r.type) {
    case 'deposit': case 'redemption': return r.amount
    case 'withdrawal': case 'fee': return r.amount == null ? null : -r.amount
    case 'settlement': return 0
    case 'buy': return r.quantity == null || r.price == null || r.fee == null ? null : -(r.quantity * r.price + r.fee)
    case 'sell': return r.quantity == null || r.price == null || r.fee == null ? null : r.quantity * r.price - r.fee
  }
}
const qtyEffect = (r: FinRecord) => (r.type === 'buy' ? r.quantity ?? 0 : r.type === 'sell' || r.type === 'settlement' ? -(r.quantity ?? 0) : 0)
/** Holding identity for previews: account + market (catalog id, or the local name) + outcome. Never the label alone. */
export const holdingKey = (r: FinRecord) => `${r.accountId}|${r.marketId ?? `local:${r.instrument}`}|${r.side ?? ''}`

export type Action = 'include' | 'exclude' | 'restore' | 'distinct' | 'reset_identity' | 'reset_duplicate' | 'reset_correction' | 'reset_all'
export const ACTION_LABEL: Record<Action, string> = {
  include: 'Include', exclude: 'Exclude', restore: 'Restore membership', distinct: 'Accept as distinct',
  reset_identity: 'Reset identity decision', reset_duplicate: 'Reset duplicate link', reset_correction: 'Reset correction', reset_all: 'Reset all adjustments',
}
export const ACTION_HELP: Record<Action, string> = {
  include: 'Counts the records in this account. Corrections and duplicate or identity decisions stay as they are.',
  exclude: 'Leaves the records out of this account. The source records aren’t deleted, and other decisions are kept.',
  restore: 'Returns membership to how the source delivered the records. Corrections and duplicate or identity decisions stay.',
  distinct: 'Accepts records that looked like overlaps as separate transactions.',
  reset_identity: 'Removes a “distinct” decision; overlapping records need review again.',
  reset_duplicate: 'Removes the duplicate link; the record counts on its own again (or needs review).',
  reset_correction: 'Returns the records to their original source values.',
  reset_all: 'Removes every decision and correction: the records are as delivered.',
}
function apply1(r: ManagedRecord, a: Action): ManagedRecord {
  switch (a) {
    case 'include': return { ...r, membership: 'include' }
    case 'exclude': return { ...r, membership: 'exclude' }
    case 'restore': return { ...r, membership: null }
    case 'distinct': return { ...r, identity: 'distinct', duplicateOf: null, duplicateFp: null }
    case 'reset_identity': return { ...r, identity: null }
    case 'reset_duplicate': return { ...r, duplicateOf: null, duplicateFp: null }
    case 'reset_correction': return r.source === 'api' ? r : { ...r, correction: null }
    case 'reset_all': return { ...r, membership: null, identity: null, duplicateOf: null, duplicateFp: null, correction: null }
  }
}
export const apply = (rs: ManagedRecord[], keys: string[], a: Action) => { const set = new Set(keys); return rs.map((r) => (set.has(r.key) ? apply1(r, a) : r)) }

/** What a change would do before it is confirmed, computed on the actual resulting sample state:
 *  - direct: selected records whose status or values change;
 *  - indirect: other records whose status changes as a consequence (e.g. a duplicate whose target is excluded or
 *    corrected); no decision is applied to them, they are only reported, and those that end up needing review are
 *    listed separately;
 *  - known cash per account and shares per account + market + outcome over every changed record, with unknown amounts
 *    counted, never treated as 0. */
export interface Preview {
  selected: number; changed: string[]; unchanged: number; indirect: string[]; toReview: string[]; accounts: string[]
  cash: Record<string, number>; qty: Record<string, { label: string; accountId: string; delta: number }>; unknown: number
}
export function preview(rs: ManagedRecord[], keys: string[], a: Action): Preview {
  const set = new Set(keys), after = apply(rs, keys, a)
  const out: Preview = { selected: set.size, changed: [], unchanged: 0, indirect: [], toReview: [], accounts: [], cash: {}, qty: {}, unknown: 0 }
  const accounts = new Set<string>()
  rs.forEach((r, i) => {
    const n = after[i], b = statusOf(r, rs), s = statusOf(n, after)
    const be = effective(r), ae = effective(n), same = b === s && JSON.stringify(be) === JSON.stringify(ae)
    if (set.has(r.key)) {
      accounts.add(r.accountId)
      // Unchanged = same status and values, and the selected decision is already in that state.
      if (same && (a !== 'reset_duplicate' || !r.duplicateOf) && (a !== 'reset_identity' || !r.identity)) { out.unchanged++; return }
      out.changed.push(r.key)
    } else {
      if (same) return
      out.indirect.push(r.key); accounts.add(r.accountId)
    }
    if (s === 'review' && b !== 'review') out.toReview.push(r.key)
    if (same) return
    // Included before / after, with the values that apply on each side.
    for (const [rec, sign] of [[be, b === 'included' ? -1 : 0], [ae, s === 'included' ? 1 : 0]] as const) {
      if (!sign) continue
      const c = cashEffect(rec)
      if (c == null) out.unknown++
      else out.cash[r.accountId] = (out.cash[r.accountId] ?? 0) + sign * c
      const q = qtyEffect(rec)
      if (q && rec.instrument) {
        const k = holdingKey(rec), cur = out.qty[k] ?? { label: `${rec.instrument} ${rec.side ?? ''}`.trim(), accountId: rec.accountId, delta: 0 }
        out.qty[k] = { ...cur, delta: cur.delta + sign * q }
      }
    }
  })
  for (const k of Object.keys(out.cash)) if (Math.abs(out.cash[k]) < 1e-9) delete out.cash[k]
  for (const k of Object.keys(out.qty)) if (Math.abs(out.qty[k].delta) < 1e-9) delete out.qty[k]
  out.accounts = [...accounts]
  return out
}
/** Apply a confirmed preview: the action goes to the directly changed records only. */
export const applyPreview = (rs: ManagedRecord[], p: Preview, a: Action) => apply(rs, p.changed, a)

/** Link a record to the observation it duplicates. Both must be in the same account and of the same type, and the
 *  target can't itself be a duplicate. Returns null when the link isn't allowed. */
export function markDuplicate(rs: ManagedRecord[], key: string, of: string): ManagedRecord[] | null {
  const r = rs.find((x) => x.key === key), t = rs.find((x) => x.key === of)
  if (!r || !t || r.key === t.key || r.accountId !== t.accountId || r.type !== t.type || t.duplicateOf || statusOf(t, rs) !== 'included') return null
  return rs.map((x) => (x.key === key ? { ...x, duplicateOf: of, duplicateFp: fingerprint(effective(t)), identity: null } : x))
}
/** Corrections apply to imported and manual records; provider records are excluded or supplemented instead. */
export const correct = (rs: ManagedRecord[], key: string, patch: Correction) => rs.map((r) => (r.key === key && r.source !== 'api' ? { ...r, correction: { ...(r.correction ?? {}), ...patch } } : r))

/* ── Filtering ─────────────────────────────────────────────── */
export interface RecordFilter { q: string; account: string; venue: string; source: string; type: string; status: string; batch: string; from: string; to: string; duplicates: boolean }
export const NO_FILTER: RecordFilter = { q: '', account: 'all', venue: 'all', source: 'all', type: 'all', status: 'all', batch: 'all', from: '', to: '', duplicates: false }
export function filterRecords(rs: ManagedRecord[], f: RecordFilter, accounts: WorkspaceAccount[]) {
  const dups = duplicateCandidates(rs), q = f.q.trim().toLowerCase()
  return rs.filter((r) => {
    const e = effective(r), venue = accounts.find((a) => a.id === r.accountId)?.venue, st = statusOf(r, rs)
    if (f.account !== 'all' && r.accountId !== f.account) return false
    if (f.venue !== 'all' && venue !== f.venue) return false
    if (f.source !== 'all' && r.source !== f.source) return false
    if (f.type !== 'all' && r.type !== f.type) return false
    if (f.batch !== 'all' && r.batchId !== f.batch) return false
    if (f.status === 'corrected' ? !r.correction : f.status === 'adjusted' ? !isAdjusted(r) : f.status !== 'all' && st !== f.status) return false
    if (f.from && e.time.slice(0, 10) < f.from) return false
    if (f.to && e.time.slice(0, 10) > f.to) return false
    if (f.duplicates && !dups[r.key] && !r.duplicateOf) return false
    if (q && !`${e.instrument ?? ''} ${e.side ?? ''} ${e.type} ${r.key} ${r.sourceRef} ${r.batchId ?? ''}`.toLowerCase().includes(q)) return false
    return true
  }).sort((a, b) => effective(b).time.localeCompare(effective(a).time) || a.key.localeCompare(b.key))
}

/* ── Imports (sample files only) ───────────────────────────── */
export type ImportMode = 'independent' | 'supplement'
/** `carried`: the replaced row with the same source reference. `changed`: its source values differ, so only an exclusion
 *  carries over and the row needs review; corrections, identity and duplicate decisions don't carry. */
export interface ImportRow { n: number; rec: FinRecord; match: string | null; carried: string | null; changed: boolean; warnings: string[] }
export interface ImportPreview { batchId: string; file: string; accountId: string; mode: ImportMode; replaces: ImportBatch | null; rows: ImportRow[] }
/** Normalize a sample file for an account. Rows get keys from a new batch id, so the same file imported into two
 *  accounts never collides. If the file is already active in this account, the import is a replacement: rows are
 *  matched by source reference and their decisions carry over. In a supplement, rows whose economic terms exactly
 *  match another record in the account are flagged as overlaps; nothing is matched across accounts. */
export function previewImport(file: SampleFile, accountId: string, mode: ImportMode, existing: ManagedRecord[], batches: ImportBatch[], batchId: string): ImportPreview {
  const replaces = batches.find((b) => b.status === 'active' && b.file === file.name && b.accountId === accountId) ?? null
  const others = existing.filter((x) => x.accountId === accountId && (!replaces || x.batchId !== replaces.id))
  const rows = file.rows.map((row, i): ImportRow => {
    const sourceRef = `${file.name}#${i + 1}`
    const rec: FinRecord = { ...row, key: `${batchId}#${i + 1}`, accountId, source: 'csv', batchId, sourceRef }
    const prior = replaces ? existing.find((x) => x.batchId === replaces.id && x.sourceRef === sourceRef) : undefined
    const match = mode === 'supplement' ? others.find((x) => terms(effective(x)) === terms(rec))?.key ?? null : null
    const changed = !!prior && fingerprint(prior) !== fingerprint(rec)
    const warnings = [
      ...(row.fee == null && (row.type === 'buy' || row.type === 'sell') ? ['Fee not reported'] : []),
      ...(match ? [`Matches ${match}`] : []),
      ...(changed ? ['Changed since the last import: needs review'] : prior && isAdjusted(prior) ? ['Your decisions carry over'] : []),
    ]
    return { n: i + 1, rec, match, carried: prior?.key ?? null, changed, warnings }
  })
  return { batchId, file: file.name, accountId, mode, replaces, rows }
}
/** Confirm an import. Independent: rows are included in their own account. Supplement: overlaps stay in review;
 *  unmatched rows are included only if the owner accepts them. A replacement supersedes the earlier batch and carries
 *  each matched row's decisions (duplicate links pointing at replaced rows are remapped). */
export function confirmImport(rs: ManagedRecord[], batches: ImportBatch[], p: ImportPreview, acceptUnmatched: boolean, at: string) {
  const old = p.replaces ? rs.filter((r) => r.batchId === p.replaces!.id) : []
  const remap = new Map(p.rows.filter((x) => x.carried).map((x) => [x.carried!, x.rec.key]))
  const added = p.rows.map((x): ManagedRecord => {
    const prior = old.find((o) => o.key === x.carried)
    const initial = x.changed ? 'review' : p.mode === 'independent' ? 'included' : x.match ? 'review' : acceptUnmatched ? 'included' : 'review'
    if (prior && x.changed) return { ...x.rec, initial, membership: prior.membership === 'exclude' ? 'exclude' : null, identity: null, duplicateOf: null, duplicateFp: null, correction: null }
    return { ...x.rec, initial, membership: prior?.membership ?? null, identity: prior?.identity ?? null, duplicateOf: prior?.duplicateOf ? remap.get(prior.duplicateOf) ?? prior.duplicateOf : null, duplicateFp: prior?.duplicateFp ?? null, correction: prior?.correction ?? null }
  })
  const kept = rs.filter((r) => !old.includes(r)).map((r) => (r.duplicateOf && remap.has(r.duplicateOf) ? { ...r, duplicateOf: remap.get(r.duplicateOf)! } : r))
  const batch: ImportBatch = { id: p.batchId, file: p.file, accountId: p.accountId, mode: p.mode, importedAt: at, rows: p.rows.length, status: 'active', replaces: p.replaces?.id ?? null }
  return { records: [...kept, ...added], batches: [...batches.map((b) => (b.id === p.replaces?.id ? { ...b, status: 'superseded' as const } : b)), batch], added }
}
export const fromRecords = (rs: FinRecord[]): ManagedRecord[] => rs.map((r) => ({ ...r, initial: 'included', membership: null, identity: null, duplicateOf: null, duplicateFp: null, correction: null }))
export const TYPE_LABEL: Record<RecordType, string> = { deposit: 'Deposit', withdrawal: 'Withdrawal', buy: 'Buy', sell: 'Sell', fee: 'Fee', settlement: 'Settlement', redemption: 'Redemption' }

/* ── Stored workspace validation ───────────────────────────── */
const TYPES: RecordType[] = ['deposit', 'withdrawal', 'buy', 'sell', 'fee', 'settlement', 'redemption']
const numOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v))
const str = (v: unknown) => typeof v === 'string' && v.length > 0
const iso = (v: unknown) => typeof v === 'string' && v.length >= 10 && !Number.isNaN(Date.parse(v))
const nonNeg = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
/** A stored correction is accepted only with known keys and valid values; anything else is dropped (the record keeps
 *  its original source values). Returns undefined when the correction is invalid. */
export function readCorrection(v: unknown): Correction | null | undefined {
  if (v == null) return null
  if (typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Correction = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'quantity' || k === 'amount' || k === 'fee') { if (!nonNeg(x)) return undefined; out[k] = x as number | null }
    else if (k === 'price') { if (!(x === null || (typeof x === 'number' && x > 0 && x < 1))) return undefined; out.price = x as number | null }
    else if (k === 'time') { if (!iso(x)) return undefined; out.time = x as string }
    else return undefined
  }
  return Object.keys(out).length ? out : null
}
/** Validate a stored workspace record by record: malformed entries and records pointing at unknown accounts are
 *  dropped; invalid corrections, unknown batch references and malformed links are repaired (counted in `repaired`)
 *  without discarding the record. A duplicate link to a missing record is kept and shows as needing review. */
export function readWorkspace(raw: unknown): { accounts: WorkspaceAccount[]; records: ManagedRecord[]; batches: ImportBatch[]; dropped: number; repaired: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.v !== 2 || !Array.isArray(o.accounts) || !Array.isArray(o.records) || !Array.isArray(o.batches)) return null
  const accountIds = new Set<string>()
  const accounts = (o.accounts as WorkspaceAccount[]).filter((a) => a && str(a.id) && !accountIds.has(a.id) && (a.venue === 'pm' || a.venue === 'ks') && typeof a.label === 'string' && ['connected', 'imported', 'manual'].includes(a.kind) && Array.isArray(a.sources) && accountIds.add(a.id))
  if (!accounts.length) return null
  const batches = (o.batches as ImportBatch[]).filter((b) => b && str(b.id) && str(b.file) && accountIds.has(b.accountId) && (b.status === 'active' || b.status === 'superseded'))
  const batchIds = new Set(batches.map((b) => b.id)), keys = new Set<string>()
  let dropped = 0, repaired = 0
  const records: ManagedRecord[] = []
  for (const r of o.records as ManagedRecord[]) {
    const ok = r && str(r.key) && !keys.has(r.key) && accountIds.has(r.accountId) && ['api', 'csv', 'manual'].includes(r.source) && TYPES.includes(r.type) && iso(r.time)
      && numOrNull(r.quantity) && numOrNull(r.price) && numOrNull(r.amount) && numOrNull(r.fee) && (r.side === null || r.side === 'YES' || r.side === 'NO')
      && (r.initial === 'included' || r.initial === 'review') && [null, 'include', 'exclude'].includes(r.membership) && [null, 'distinct'].includes(r.identity)
    if (!ok) { dropped++; continue }
    keys.add(r.key)
    const correction = readCorrection(r.correction)
    const batchId = typeof r.batchId === 'string' && batchIds.has(r.batchId) ? r.batchId : null
    const duplicateOf = typeof r.duplicateOf === 'string' && r.duplicateOf !== r.key ? r.duplicateOf : null
    if (correction === undefined || (r.batchId != null && batchId == null) || (r.duplicateOf != null && duplicateOf == null)) repaired++
    records.push({ ...r, sourceRef: str(r.sourceRef) ? r.sourceRef : r.key, marketId: typeof r.marketId === 'string' ? r.marketId : null, batchId, duplicateOf, duplicateFp: typeof r.duplicateFp === 'string' ? r.duplicateFp : null, correction: correction ?? null })
  }
  return { accounts, records, batches, dropped, repaired }
}
export type { Outcome }

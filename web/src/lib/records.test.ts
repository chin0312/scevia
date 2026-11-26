import { describe, expect, it } from 'vitest'
import { SAMPLE_ACCOUNTS, SAMPLE_BATCHES, SAMPLE_FILES, SAMPLE_RECORDS } from '../data/sampleRecords'
import * as R from './records'

const base = () => R.fromRecords(SAMPLE_RECORDS)
const st = (rs: R.ManagedRecord[], key: string) => R.statusOf(rs.find((r) => r.key === key)!, rs)

describe('records workspace (sample)', () => {
  it('two accounts on the same venue stay separate; a source is not a venue', () => {
    expect(SAMPLE_ACCOUNTS.filter((a) => a.venue === 'pm').map((a) => a.id)).toEqual(['pm-main', 'pm-wallet-b'])
    const f = R.filterRecords(base(), { ...R.NO_FILTER, venue: 'pm' }, SAMPLE_ACCOUNTS)
    expect(new Set(f.map((r) => r.accountId))).toEqual(new Set(['pm-main', 'pm-wallet-b']))
    expect(R.filterRecords(base(), { ...R.NO_FILTER, source: 'csv' }, SAMPLE_ACCOUNTS).every((r) => r.accountId === 'pm-wallet-b')).toBe(true)
  })
  it('unknown fees make the cash effect unknown, never zero; settlements create no cash', () => {
    expect(R.cashEffect(base().find((r) => r.key === 'batch-1#2')!)).toBeNull()
    expect(R.cashEffect(base().find((r) => r.key === 'a-008')!)).toBe(0)
    expect(R.cashEffect(base().find((r) => r.key === 'a-009')!)).toBe(1500)
  })
  it('identical records in one account are duplicate candidates (a hint, not a merge)', () => {
    expect(R.duplicateCandidates(base())['a-006']).toEqual(['a-007'])
    expect(st(base(), 'a-007')).toBe('included')
  })
})

describe('decision dimensions are independent (backend Phase 3 semantics)', () => {
  it('a correction survives exclude, include and restore; only reset_correction removes it', () => {
    let rs = R.correct(base(), 'batch-1#2', { fee: 3.5 })
    for (const a of ['exclude', 'include', 'restore'] as const) rs = R.apply(rs, ['batch-1#2'], a)
    const r = rs.find((x) => x.key === 'batch-1#2')!
    expect(r.correction).toEqual({ fee: 3.5 }); expect(r.fee).toBeNull(); expect(R.effective(r).fee).toBe(3.5)
    expect(R.apply(rs, ['batch-1#2'], 'reset_correction').find((x) => x.key === 'batch-1#2')!.correction).toBeNull()
    expect(R.correct(base(), 'a-002', { price: 0.1 }).find((r) => r.key === 'a-002')!.correction).toBeNull() // provider rows can't be edited
  })
  it('a duplicate link is distinct from exclusion; restoring membership keeps it; a broken link needs review', () => {
    let rs = R.markDuplicate(base(), 'a-007', 'a-006')!
    expect(st(rs, 'a-007')).toBe('duplicate')
    rs = R.apply(rs, ['a-007'], 'restore')
    expect(st(rs, 'a-007')).toBe('duplicate') // membership reset doesn't touch the duplicate relationship
    rs = R.apply(rs, ['a-006'], 'exclude')
    expect(st(rs, 'a-007')).toBe('review') // the target is gone: never silently counts again
    rs = R.apply(rs, ['a-007'], 'reset_duplicate')
    expect(st(rs, 'a-007')).toBe('included')
    expect(R.markDuplicate(base(), 'a-007', 'k-002')).toBeNull() // different account
  })
  it('reset_all removes every decision; identity decisions reset separately', () => {
    let rs = R.apply(R.correct(base(), 'batch-1#2', { fee: 1 }), ['batch-1#2'], 'exclude')
    rs = R.apply(rs, ['batch-1#2'], 'distinct')
    const one = R.apply(rs, ['batch-1#2'], 'reset_identity').find((r) => r.key === 'batch-1#2')!
    expect(one.identity).toBeNull(); expect(one.membership).toBe('exclude'); expect(one.correction).toEqual({ fee: 1 })
    const all = R.apply(rs, ['batch-1#2'], 'reset_all').find((r) => r.key === 'batch-1#2')!
    expect([all.membership, all.identity, all.duplicateOf, all.correction]).toEqual([null, null, null, null])
  })
})

describe('bulk previews', () => {
  it('report changes per account and per account + market + outcome, never by name alone', () => {
    // Same market name in two accounts: Bitcoin YES in pm-main (a-002) and Wallet B (batch-1#2).
    const p = R.preview(base(), ['a-002', 'batch-1#2', 'a-006'], 'exclude')
    expect(p.changed).toEqual(['a-002', 'a-006', 'batch-1#2'].filter((k) => p.changed.includes(k)))
    expect(p.selected).toBe(3); expect(p.accounts.sort()).toEqual(['pm-main', 'pm-wallet-b'])
    const btc = Object.values(p.qty).filter((x) => x.label === 'Bitcoin above $150k on Dec 31 YES')
    expect(btc.map((x) => [x.accountId, x.delta]).sort()).toEqual([['pm-main', -4000], ['pm-wallet-b', -3000]])
    expect(p.unknown).toBe(1) // batch-1#2's fee isn't reported
    expect(p.cash['pm-main']).toBeCloseTo(4000 * 0.32 + 2000 * 0.58)
  })
  it('records already in the target state are counted as unchanged', () => {
    const rs = R.apply(base(), ['a-006'], 'exclude')
    expect(R.preview(rs, ['a-006', 'a-005'], 'exclude')).toMatchObject({ changed: ['a-005'], unchanged: 1 })
  })
})

describe('imports keep account and batch identity', () => {
  const file = SAMPLE_FILES[1]
  it('the same file imported into two accounts creates separate records; neither overwrites the other', () => {
    const p1 = R.previewImport(file, 'acc-x', 'independent', base(), SAMPLE_BATCHES, 'batch-x')
    const c1 = R.confirmImport(base(), SAMPLE_BATCHES, p1, true, '2026-11-25T00:00:00Z')
    const p2 = R.previewImport(file, 'acc-y', 'independent', c1.records, c1.batches, 'batch-y')
    expect(p2.replaces).toBeNull()
    const c2 = R.confirmImport(c1.records, c1.batches, p2, true, '2026-11-25T00:00:00Z')
    expect(c2.records.filter((r) => r.accountId === 'acc-x')).toHaveLength(3)
    expect(c2.records.filter((r) => r.accountId === 'acc-y')).toHaveLength(3)
    expect(new Set(c2.records.map((r) => r.key)).size).toBe(c2.records.length)
  })
  it('importing the same file into the same account again is a replacement that keeps decisions', () => {
    const p1 = R.previewImport(file, 'acc-x', 'independent', base(), SAMPLE_BATCHES, 'batch-x')
    let c = R.confirmImport(base(), SAMPLE_BATCHES, p1, true, 'now')
    const rs = R.correct(R.apply(c.records, ['batch-x#2'], 'exclude'), 'batch-x#3', { fee: 2 })
    const p2 = R.previewImport(file, 'acc-x', 'independent', rs, c.batches, 'batch-x2')
    expect(p2.replaces?.id).toBe('batch-x'); expect(p2.rows.filter((r) => r.carried)).toHaveLength(3)
    c = R.confirmImport(rs, c.batches, p2, true, 'later')
    expect(c.records.filter((r) => r.accountId === 'acc-x').map((r) => r.key)).toEqual(['batch-x2#1', 'batch-x2#2', 'batch-x2#3'])
    expect(st(c.records, 'batch-x2#2')).toBe('excluded')
    expect(c.records.find((r) => r.key === 'batch-x2#3')!.correction).toEqual({ fee: 2 })
    expect(c.batches.find((b) => b.id === 'batch-x')!.status).toBe('superseded')
  })
  it('a supplement flags exact overlaps in its own account for review; unmatched rows only when accepted', () => {
    const p = R.previewImport(SAMPLE_FILES[0], 'pm-main', 'supplement', base(), SAMPLE_BATCHES, 'b2')
    expect(p.rows.filter((r) => r.match).map((r) => r.match)).toEqual(['a-001', 'a-002'])
    expect(R.confirmImport(base(), SAMPLE_BATCHES, p, true, 'now').added.map((r) => r.initial)).toEqual(['review', 'review', 'included', 'included', 'included'])
    expect(R.confirmImport(base(), SAMPLE_BATCHES, p, false, 'now').added.every((r) => r.initial === 'review')).toBe(true)
    expect(R.previewImport(SAMPLE_FILES[0], 'pm-wallet-b', 'supplement', base(), SAMPLE_BATCHES, 'b3').rows.every((r) => r.match == null)).toBe(true) // no cross-account matching
  })
})

describe('stored workspace validation', () => {
  it('drops malformed records and unknown accounts, keeps the rest, rejects old or broken shapes', () => {
    const good = R.fromRecords(SAMPLE_RECORDS)
    const w = R.readWorkspace({ v: 2, accounts: SAMPLE_ACCOUNTS, batches: SAMPLE_BATCHES, records: [...good, { ...good[0], key: 'x1', accountId: 'nope' }, { ...good[1], key: 'x2', quantity: 'many' }, good[2]] })!
    expect(w.records).toHaveLength(good.length); expect(w.dropped).toBe(3)
    expect(R.readWorkspace({ accounts: [], records: [] })).toBeNull()
    expect(R.readWorkspace({ v: 2, accounts: [], records: [], batches: [] })).toBeNull()
  })
})

describe('duplicate links hold only against an included, unchanged original', () => {
  it('an original that still needs review can’t be linked, and a link to one doesn’t count as a duplicate', () => {
    const p = R.previewImport(SAMPLE_FILES[0], 'pm-main', 'supplement', base(), SAMPLE_BATCHES, 'b2')
    const rs = R.confirmImport(base(), SAMPLE_BATCHES, p, false, 'now').records // all imported rows in review
    expect(R.markDuplicate(rs, 'a-002', 'b2#4')).toBeNull()
    const forced = rs.map((r) => (r.key === 'a-007' ? { ...r, duplicateOf: 'b2#4', duplicateFp: null } : r))
    expect(st(forced, 'a-007')).toBe('review') // never silently excluded as a duplicate of an unresolved record
  })
  it('a material correction of the original sends the duplicate back to review', () => {
    // Both are Wallet B buys; the user may link them (an included original is required).
    let rs = R.markDuplicate(base(), 'batch-1#3', 'batch-1#2')!
    expect(st(rs, 'batch-1#3')).toBe('duplicate')
    rs = R.correct(rs, 'batch-1#2', { quantity: 2500 })
    expect(st(rs, 'batch-1#3')).toBe('review')
    rs = R.apply(rs, ['batch-1#2'], 'reset_correction')
    expect(st(rs, 'batch-1#3')).toBe('duplicate') // back to the terms it was linked against
  })
  it('a replaced original with different source values breaks the link; changed rows don’t inherit corrections or links', () => {
    const file = { ...SAMPLE_FILES[1], rows: SAMPLE_FILES[1].rows.map((r) => ({ ...r })) }
    let c = R.confirmImport(base(), SAMPLE_BATCHES, R.previewImport(file, 'acc-x', 'independent', base(), SAMPLE_BATCHES, 'x1'), true, 'now')
    let rs = R.markDuplicate(R.apply(c.records, ['x1#3'], 'exclude'), 'x1#2', 'x1#1') // a buy can't duplicate a deposit
    expect(rs).toBeNull()
    rs = R.correct(R.apply(c.records, ['x1#3'], 'exclude'), 'x1#2', { fee: 1 })
    const changed = { ...file, rows: file.rows.map((r, i) => (i === 1 ? { ...r, quantity: 2100 } : r)) }
    const p = R.previewImport(changed, 'acc-x', 'independent', rs, c.batches, 'x2')
    expect(p.rows.map((r) => r.changed)).toEqual([false, true, false])
    c = R.confirmImport(rs, c.batches, p, true, 'later')
    const r2 = c.records.find((r) => r.key === 'x2#2')!
    expect([r2.correction, r2.initial]).toEqual([null, 'review']) // changed evidence: no inherited correction, review
    expect(st(c.records, 'x2#3')).toBe('excluded') // unchanged row keeps its exclusion
  })
})

describe('bulk preview includes indirect effects', () => {
  it('excluding an original reports the linked duplicate as indirectly affected, without deciding for it', () => {
    const rs = R.markDuplicate(base(), 'a-007', 'a-006')!
    const p = R.preview(rs, ['a-006'], 'exclude')
    expect(p.changed).toEqual(['a-006']); expect(p.indirect).toEqual(['a-007']); expect(p.toReview).toEqual(['a-007'])
    const after = R.applyPreview(rs, p, 'exclude')
    expect(after.find((r) => r.key === 'a-007')!.membership).toBeNull() // no decision applied to it
    expect(st(after, 'a-007')).toBe('review')
    expect(p.cash['pm-main']).toBeCloseTo(2000 * 0.58) // the excluded purchase only; the duplicate wasn't counted before or after
  })
})

describe('stored corrections are validated', () => {
  it('malformed corrections are dropped without losing the record; unknown batch references are repaired', () => {
    const good = R.fromRecords(SAMPLE_RECORDS)
    const bad = [{ ...good[1], correction: { quantity: -5 } }, { ...good[2], correction: { evil: 1 } }, { ...good[3], correction: { price: 0.4, time: 'not a date' } }, { ...good[4], correction: { fee: 2 } }, { ...good[10], batchId: 'missing' }]
    const w = R.readWorkspace({ v: 2, accounts: SAMPLE_ACCOUNTS, batches: SAMPLE_BATCHES, records: [...bad, ...good.filter((r) => !bad.some((b) => b.key === r.key))] })!
    const by = (k: string) => w.records.find((r) => r.key === k)!
    expect([by(good[1].key).correction, by(good[2].key).correction, by(good[3].key).correction]).toEqual([null, null, null])
    expect(by(good[4].key).correction).toEqual({ fee: 2 })
    expect(by(good[10].key).batchId).toBeNull()
    expect(w.records).toHaveLength(good.length); expect(w.repaired).toBe(4); expect(w.dropped).toBe(0)
  })
})

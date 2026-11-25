import { describe, expect, it } from 'vitest'
import { SAMPLE_ACCOUNTS, SAMPLE_FILES, SAMPLE_RECORDS } from '../data/sampleRecords'
import * as R from './records'

const base = () => R.fromRecords(SAMPLE_RECORDS)

describe('records workspace (sample)', () => {
  it('two accounts on the same venue stay separate; a source is not a venue', () => {
    const pm = SAMPLE_ACCOUNTS.filter((a) => a.venue === 'pm')
    expect(pm.map((a) => a.id)).toEqual(['acc-pm-a', 'acc-pm-b'])
    const f = R.filterRecords(base(), { ...R.NO_FILTER, venue: 'pm' }, SAMPLE_ACCOUNTS)
    expect(new Set(f.map((r) => r.accountId))).toEqual(new Set(['acc-pm-a', 'acc-pm-b']))
    expect(R.filterRecords(base(), { ...R.NO_FILTER, source: 'csv' }, SAMPLE_ACCOUNTS).every((r) => r.accountId === 'acc-pm-b')).toBe(true)
  })
  it('unknown fees make the cash effect unknown, never zero; settlements create no cash', () => {
    const b2 = base().find((r) => r.key === 'b-002')!
    expect(R.cashEffect(b2)).toBeNull()
    expect(R.cashEffect(base().find((r) => r.key === 'a-008')!)).toBe(0)
    expect(R.cashEffect(base().find((r) => r.key === 'a-009')!)).toBe(1500)
  })
  it('identical records in one account are duplicate candidates (a hint, not a merge)', () => {
    const d = R.duplicateCandidates(base())
    expect(d['a-006']).toEqual(['a-007'])
    expect(R.inclusionOf(base().find((r) => r.key === 'a-007')!)).toBe('included')
  })
  it('bulk exclude previews its effect, is reversible with restore, and never removes the record', () => {
    const keys = ['a-006', 'a-007', 'b-002']
    const p = R.preview(base(), keys, 'exclude')
    expect(p.changed).toEqual(keys)
    expect(p.unknown).toBe(1) // b-002's fee isn't reported
    expect(p.cash['acc-pm-a']).toBeCloseTo(2 * 2000 * 0.58)
    expect(p.qty['Fed rate cut in December? YES']).toBe(-4000)
    const ex = R.apply(base(), keys, 'exclude')
    expect(ex).toHaveLength(SAMPLE_RECORDS.length)
    expect(keys.map((k) => R.inclusionOf(ex.find((r) => r.key === k)!))).toEqual(['excluded', 'excluded', 'excluded'])
    expect(R.preview(ex, keys, 'exclude').changed).toEqual([]) // already excluded: nothing changes
    const back = R.apply(ex, keys, 'restore')
    expect(back.every((r) => R.inclusionOf(r) === 'included')).toBe(true)
  })
  it('duplicate resolution and corrections keep the original evidence', () => {
    let rs = R.markDuplicate(base(), 'a-007', 'a-006')
    expect(R.inclusionOf(rs.find((r) => r.key === 'a-007')!)).toBe('excluded')
    rs = R.correct(rs, 'b-002', { fee: 3.5 })
    const b2 = rs.find((r) => r.key === 'b-002')!
    expect(b2.fee).toBeNull(); expect(R.effective(b2).fee).toBe(3.5)
    expect(R.correct(rs, 'a-002', { price: 0.1 }).find((r) => r.key === 'a-002')!.correction).toBeNull() // provider rows can't be edited
  })
  it('a supplemental import flags exact overlaps for review and includes unmatched rows only when accepted', () => {
    const file = SAMPLE_FILES[0]
    const rows = R.previewImport(file, 'acc-pm-a', 'supplement', base())
    expect(rows.filter((r) => r.match).map((r) => r.match)).toEqual(['a-001', 'a-002'])
    const accepted = R.confirmImport(base(), rows, 'supplement', true).filter((r) => r.batch === file.name)
    expect(accepted.map(R.inclusionOf)).toEqual(['review', 'review', 'included', 'included', 'included'])
    const held = R.confirmImport(base(), rows, 'supplement', false).filter((r) => r.batch === file.name)
    expect(held.every((r) => R.inclusionOf(r) === 'review')).toBe(true)
  })
  it('an independent import is never matched against another account, even on the same venue', () => {
    const rows = R.previewImport(SAMPLE_FILES[0], 'acc-new', 'independent', base())
    expect(rows.every((r) => r.match == null)).toBe(true)
    expect(R.confirmImport(base(), rows, 'independent', false).filter((r) => r.accountId === 'acc-new').every((r) => R.inclusionOf(r) === 'included')).toBe(true)
  })
})

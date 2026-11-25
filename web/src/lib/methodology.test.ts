import { describe, expect, it } from 'vitest'
import { sampleFeeSchedule } from '../data/sampleFees'
import { POSITIONS, POS_BY_ID, account, constrains, findRelation, instrumentKey, isFeasible, jointOutcomes, MAX_JOINT_EVENTS, outcomeRange, positionFor, rangeIssue, scenarioMetrics, simulate, sourceRelations, withConstraints, type Relation } from './finance'
import { DEFAULT_FEES, estimateFee, readFeeAssumption } from './fees'
import { fmtPrice, parseMoney, parsePct, parsePrice, parseShares } from './inputs'
import { ROWS, judge } from '../pages/lab/model'

const close = (a: number | null | undefined, b: number, eps = 1e-6) => { expect(a).toEqual(expect.any(Number)); expect(Math.abs((a as number) - b)).toBeLessThan(eps) }
const PM = (cat: Parameters<typeof sampleFeeSchedule>[1], election = false) => sampleFeeSchedule('pm', cat, { election })
const KS = sampleFeeSchedule('ks', 'Economics')

describe('fee estimation (published formulas)', () => {
  it('Polymarket: C × rate × p × (1 − p), takers only, rounded to 5 decimals', () => {
    const sports = { ...PM('Sports') }, econ = PM('Economics')
    close(estimateFee(100, 0.5, sports, DEFAULT_FEES).amount, 1.25) // docs example, rate 0.05
    close(estimateFee(100, 0.5, econ, DEFAULT_FEES).amount, 0.25)   // rate 0.01
    close(estimateFee(100, 0.3, sports, DEFAULT_FEES).amount, 1.05)
    close(estimateFee(100, 0.7, sports, DEFAULT_FEES).amount, 1.05) // symmetric around 50%
    expect(estimateFee(100, 0.5, sports, { mode: 'provider', role: 'maker' })).toEqual({ amount: 0, status: 'estimated' })
    close(estimateFee(1, 0.5, econ, DEFAULT_FEES).amount, 0.0025)
  })
  it('Kalshi: taker 0.07 × C × P × (1 − P), rounded up to the next cent; no maker fee on standard series', () => {
    close(estimateFee(1, 0.5, KS, DEFAULT_FEES).amount, 0.02)   // 0.0175 → 0.02
    close(estimateFee(100, 0.05, KS, DEFAULT_FEES).amount, 0.34) // 0.3325 → 0.34
    close(estimateFee(100, 0.5, KS, DEFAULT_FEES).amount, 1.75)
    expect(estimateFee(100, 0.5, KS, { mode: 'provider', role: 'maker' }).amount).toBe(0)
  })
  it('missing fee parameters are unavailable, never zero; zero is a real zero', () => {
    expect(estimateFee(100, 0.5, null, DEFAULT_FEES)).toEqual({ amount: null, status: 'unavailable' })
    expect(estimateFee(100, 0.5, { ...KS, taker: null }, DEFAULT_FEES).status).toBe('unavailable')
    expect(estimateFee(100, 0.5, { ...KS, taker: 0 }, DEFAULT_FEES)).toEqual({ amount: 0, status: 'estimated' })
  })
  it('custom and excluded assumptions', () => {
    expect(estimateFee(1000, 0.4, KS, { mode: 'custom', pct: 1.5 })).toEqual({ amount: 6, status: 'custom' })
    expect(estimateFee(1000, 0.4, null, { mode: 'custom', pct: 1 }).amount).toBe(4) // custom doesn't need provider data
    expect(estimateFee(1000, 0.4, KS, { mode: 'custom', pct: Number.NaN }).status).toBe('unavailable')
    expect(estimateFee(1000, 0.4, KS, { mode: 'excluded' })).toEqual({ amount: 0, status: 'excluded' })
  })
  it('older stored settings migrate', () => {
    expect(readFeeAssumption(undefined, false)).toEqual({ mode: 'excluded' })
    expect(readFeeAssumption(undefined, true)).toEqual(DEFAULT_FEES)
    expect(readFeeAssumption({ mode: 'custom', pct: 99 })).toEqual(DEFAULT_FEES) // out of range → default, not applied silently
  })
  it('the simulation uses the same estimate the UI shows, and flags unavailable fees', () => {
    const p = POS_BY_ID.fedk, d = 1000, px = 0.66
    const sim = simulate([{ id: 'fedk', to: p.shares + d, price: px }], { fees: DEFAULT_FEES })
    close(sim.feesBy.fedk, estimateFee(d, px, p.feeSchedule, DEFAULT_FEES).amount!)
    expect(sim.feeStatusBy.fedk).toBe('estimated')
    const unknown = { provider: 'ks' as const, eventId: 'u', eventTitle: 'U', marketId: 'u', marketTitle: 'U', outcome: 'YES' as const, category: 'Economics' as const, resolves: '2027-01-01', refPrice: 0.2, refAsOf: null, source: 'sample' as const, fee: null }
    const s2 = simulate([{ id: instrumentKey(unknown), to: 100, price: 0.2, instrument: unknown }], { fees: DEFAULT_FEES })
    expect(s2.feesUnavailable).toEqual([instrumentKey(unknown)])
    expect(s2.fees).toBe(0)
    expect(scenarioMetrics(s2, sourceRelations()).feesUnavailable).toBe(1)
  })
  it('hypothetical fee settings never touch historical fees', () => {
    const before = account('all').fees
    simulate([{ id: 'hot', to: 0, price: 0.9 }], { fees: { mode: 'custom', pct: 5 } })
    simulate([{ id: 'hot', to: 0, price: 0.9 }], { fees: { mode: 'excluded' } })
    expect(account('all').fees).toBe(before)
  })
})

describe('event relationships: logical constraints, provenance and scope', () => {
  const rel = (cls: Relation['cls'], provenance: Relation['provenance']): Relation => ({ a: 'a', b: 'b', cls, provenance })
  it('only verified facts and scenario hypotheticals constrain; annotations, related and unknown never do', () => {
    const both = { a: 'YES', b: 'YES' } as const
    expect(isFeasible(both, [rel('mutex', 'verified')])).toBe(false)
    expect(isFeasible(both, [rel('mutex', 'hypothetical')])).toBe(false)
    expect(isFeasible(both, [rel('mutex', 'annotation')])).toBe(true) // a note can't remove a possible loss
    for (const c of ['related', 'unknown'] as const) for (const p of ['verified', 'annotation', 'hypothetical'] as const) expect(isFeasible(both, [rel(c, p)])).toBe(true)
    expect(constrains(rel('equivalent', 'verified'))).toBe(true)
  })
  it('Risk’s factual relationships contain no hypothetical constraint and no sample BTC × ETH setting', () => {
    expect(sourceRelations().some((r) => r.provenance === 'hypothetical')).toBe(false)
    expect(sourceRelations().some((r) => [r.a, r.b].sort().join() === 'btc,eth')).toBe(false)
    expect(sourceRelations().filter(constrains)).toEqual([])
  })
  it('a scenario constraint is added on top without changing the source list; verified facts win; duplicates are ignored', () => {
    const base = [rel('equivalent', 'verified')]
    const out = withConstraints(base, [{ a: 'a', b: 'b', cls: 'mutex' }, { a: 'c', b: 'd', cls: 'mutex' }, { a: 'd', b: 'c', cls: 'equivalent' }, { a: 'e', b: 'e', cls: 'mutex' }])
    expect(base).toHaveLength(1)
    expect(findRelation('a', 'b', out)).toMatchObject({ cls: 'equivalent', provenance: 'verified' })
    expect(out.filter((r) => [r.a, r.b].sort().join() === 'c,d')).toEqual([{ a: 'c', b: 'd', cls: 'mutex', provenance: 'hypothetical' }])
    expect(out).toHaveLength(2)
  })
  it('a hypothetical constraint narrows that scenario’s range only', () => {
    const opts = { fees: DEFAULT_FEES }, sim = simulate([], opts)
    const factual = scenarioMetrics(sim, sourceRelations()), hypo = scenarioMetrics(sim, withConstraints(sourceRelations(), [{ a: 'btc', b: 'eth', cls: 'mutex' }]))
    expect(hypo.excluded).toBeGreaterThan(0); expect(factual.excluded).toBe(0)
    expect(hypo.bestValue!).toBeLessThan(factual.bestValue!) // both-YES is no longer possible in that scenario
    close(hypo.worstValue!, factual.worstValue!, 0.01)       // the all-against outcome stays possible
  })
  it('ranges are unavailable (null with a reason), never Infinity, when they can’t be computed', () => {
    const ids = Array.from({ length: MAX_JOINT_EVENTS + 1 }, (_, i) => `e${i}`)
    expect(rangeIssue(ids, [])).toBe('too-many-events')
    expect(outcomeRange(ids, [], () => 1)).toBeNull()
    // With binary mutex/equivalent constraints "everything NO" is always feasible, so a range always exists.
    const r = outcomeRange(['a', 'b'], [rel('mutex', 'hypothetical'), rel('equivalent', 'hypothetical')], (o) => (o.a === 'YES' ? 1 : 0))
    expect(r).not.toBeNull(); expect(Number.isFinite(r!.min)).toBe(true); expect(r!.feasible).toBe(1)
    expect([...jointOutcomes(['a', 'b'])].filter((o) => isFeasible(o, [rel('mutex', 'hypothetical'), rel('equivalent', 'hypothetical')]))).toEqual([{ a: 'NO', b: 'NO' }])
  })
})

describe('direction of comparisons', () => {
  const row = (key: string) => ROWS.find((r) => r.key === key)!
  it('a smaller single-event loss is an improvement (signed outcome, higher is better)', () => {
    expect(judge(row('largestEventLoss'), -3000, -5000)).toEqual({ d: 2000, good: true })
    expect(judge(row('largestEventLoss'), -5000, -3000)).toEqual({ d: -2000, good: false })
  })
  it('higher fees and shortfalls are worse; cash, capital and counts are never judged', () => {
    expect(judge(row('fees'), 10, 5).good).toBe(false)
    expect(judge(row('shortfall'), 0, 100).good).toBe(true)
    for (const k of ['cash', 'committed', 'positionsValue', 'events']) expect(judge(row(k), 10, 5).good).toBeNull()
  })
  it('an unavailable side makes the change unavailable', () => {
    expect(judge(row('worstValue'), null, 5)).toEqual({ d: null, good: null })
  })
  it('the simulated single-event loss gets smaller when an opposing position is added', () => {
    const btc = POS_BY_ID.btc
    const noLeg = { provider: 'pm' as const, eventId: 'btc', eventTitle: 'BTC', marketId: btc.marketId, marketTitle: btc.market, outcome: 'NO' as const, category: 'Crypto' as const, resolves: btc.resolves, refPrice: 0.72, refAsOf: null, source: 'sample' as const, fee: btc.feeSchedule }
    const rels = sourceRelations()
    const before = scenarioMetrics(simulate([], { fees: { mode: 'excluded' } }), rels).largestEventLoss
    const after = scenarioMetrics(simulate([{ id: instrumentKey(noLeg), to: btc.shares, price: 0.72, instrument: noLeg }], { fees: { mode: 'excluded' } }), rels).largestEventLoss
    expect(after).toBeLessThanOrEqual(before)
  })
})

describe('numeric inputs', () => {
  it('shares: up to 2 decimals (hypothetical step); no scientific notation, signs or units', () => {
    expect(parseShares('2,500')).toEqual({ state: 'ok', value: 2500 })
    expect(parseShares('12.5')).toEqual({ state: 'ok', value: 12.5 })
    expect(parseShares('12.')).toEqual({ state: 'partial', message: 'Finish entering a quantity' })
    expect(parseShares('')).toEqual({ state: 'empty' })
    for (const t of ['1e5', '-10', '12.555', '10 shares', '0x10']) expect(parseShares(t).state).toBe('invalid')
  })
  it('prices: partial typing is not a value; at most 3 decimals; no silent reuse of a previous value', () => {
    for (const t of ['0', '0.', '.', '0.0', '0.00']) expect(parsePrice(t).state).toBe('partial')
    expect(parsePrice('0.45')).toEqual({ state: 'ok', value: 0.45 })
    expect(parsePrice('$.5')).toEqual({ state: 'ok', value: 0.5 })
    expect(parsePrice('0.4567').state).toBe('invalid')
    for (const t of ['4.5e-1', 'abc', '-0.4', '0.4.5']) expect(parsePrice(t).state).toBe('invalid')
    expect(fmtPrice(0.29)).toBe('0.29'); expect(fmtPrice(0.125)).toBe('0.125')
  })
  it('money and percentages', () => {
    expect(parseMoney('5,000.50')).toEqual({ state: 'ok', value: 5000.5 })
    expect(parseMoney('5e3').state).toBe('invalid')
    expect(parsePct('1.5%')).toEqual({ state: 'ok', value: 1.5 })
    expect(parsePct('1.').state).toBe('partial')
  })
  it('the engine excludes missing and malformed values instead of trading them', () => {
    const s = simulate([{ id: 'btc', to: 4000, price: Number.NaN }, { id: 'hot', to: null, price: 0.9 }, { id: 'cel', to: 100, price: null }], { fees: DEFAULT_FEES })
    expect(Object.keys(s.errors).sort()).toEqual(['btc', 'cel', 'hot'])
    expect(s.holdings.btc.shares).toBe(POS_BY_ID.btc.shares)
  })
})

describe('instrument identity', () => {
  it('a held position is matched by provider + market + outcome, not by event and side', () => {
    const btc = POS_BY_ID.btc
    expect(positionFor({ provider: 'pm', marketId: btc.marketId, outcome: 'YES' })?.id).toBe('btc')
    expect(positionFor({ provider: 'pm', marketId: 'some-other-btc-market', outcome: 'YES' })).toBeUndefined()
    expect(positionFor({ provider: 'pm', marketId: btc.marketId, outcome: 'NO' })).toBeUndefined()
    expect(new Set(POSITIONS.map((p) => `${p.platform}:${p.marketId}:${p.side}`)).size).toBe(POSITIONS.length)
  })
})

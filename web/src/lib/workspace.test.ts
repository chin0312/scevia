/* Scenario Lab workspace semantics: sizing modes, value bridge, constraint implications, account identity. */
import { describe, expect, it } from 'vitest'
import { SAMPLE_MARKET_EVENTS } from '../data/sampleMarkets'
import {
  POSITIONS, POS_BY_ID, eventProfiles, holdingsOfInstrument, instrumentOfPosition, partialFeasible, positionFor, scenarioMetrics,
  simulate, startingValue, targetShares, valueBridge, type Adjustment, type InstrumentRef, type Position,
} from './finance'
import { instrumentFrom } from './markets'
import * as SC from './scenarios'
import type { Relation } from '../data/types'

const close = (a: number | null | undefined, b: number, eps = 0.01) => { expect(a).toEqual(expect.any(Number)); expect(Math.abs((a as number) - b)).toBeLessThan(eps) }
const inst = (marketId: string, o: 'YES' | 'NO' = 'YES'): InstrumentRef => {
  const e = SAMPLE_MARKET_EVENTS.find((x) => x.markets.some((m) => m.marketId === marketId))!, m = e.markets.find((x) => x.marketId === marketId)!
  return instrumentFrom(e, m, m.outcomes.find((x) => x.outcome === o)!, 'sample')
}
const key = (i: InstrumentRef) => `${i.provider}:${i.marketId}:${i.outcome}`
const NOFEES = { fees: { mode: 'excluded' as const } }

describe('position sizing: shares, amount and % of starting value describe the same position', () => {
  it('an amount converts to shares at the assumed price, rounded down to the 0.01 step (never spends more)', () => {
    const i = inst('pm-eth-5k'), a: Adjustment = { id: key(i), to: null, price: 0.18, instrument: i, size: { by: 'amount', value: 1000 } }
    expect(targetShares(a, null)).toEqual({ to: 5555.55, error: null })
    const s = simulate([a], { ...NOFEES, baseline: 'scratch', funding: { pm: 1000 } })
    close(s.targets[a.id], 5555.55); close(s.cash.pm, 1000 - 5555.55 * 0.18)
    expect(s.cash.pm).toBeGreaterThanOrEqual(0)
  })
  it('a weight is a % of the scenario’s starting value (cash and added capital included), not of open-position value', () => {
    const opts = { ...NOFEES, baseline: 'scratch' as const, funding: { pm: 8000, ks: 2000 } }
    expect(startingValue('scratch', opts.funding)).toBe(10000)
    const i = inst('pm-eth-5k'), a: Adjustment = { id: key(i), to: null, price: 0.2, instrument: i, size: { by: 'weight', value: 20 } }
    const s = simulate([a], opts)
    close(s.targets[a.id], 10000) // 20% × $10,000 ÷ 0.20
    // 20% of starting capital at the assumed price is not a 20% market-value weight when the mark differs.
    const m = scenarioMetrics(s, []), mark = s.holdings[a.id].mark!
    close((10000 * mark) / m.totalValue!, (10000 * mark) / (10000 - 2000 + 10000 * mark))
  })
  it('the same target expressed as shares or as an amount gives identical results', () => {
    const i = inst('pm-eth-5k'), opts = { ...NOFEES, baseline: 'scratch' as const, funding: { pm: 5000 } }
    const bySize = simulate([{ id: key(i), to: null, price: 0.25, instrument: i, size: { by: 'amount', value: 500 } }], opts)
    const byShares = simulate([{ id: key(i), to: 2000, price: 0.25, instrument: i }], opts)
    expect(bySize.cash).toEqual(byShares.cash); expect(bySize.holdings[key(i)].shares).toBe(2000)
  })
  it('missing price, out-of-range amount or unavailable denominator is an error, not zero', () => {
    const i = inst('pm-eth-5k')
    expect(targetShares({ id: 'x', to: null, price: null, size: { by: 'amount', value: 100 } }, 1).error).toMatch(/price/)
    expect(targetShares({ id: 'x', to: null, price: 0.5, size: { by: 'weight', value: 150 } }, 1).error).toMatch(/0–100%/)
    expect(targetShares({ id: 'x', to: null, price: 0.5, size: { by: 'weight', value: 10 } }, null).error).toMatch(/unavailable/)
    expect(simulate([{ id: key(i), to: null, price: 0.5, instrument: i, size: { by: 'amount', value: Number.NaN } }], NOFEES).errors[key(i)]).toBeTruthy()
  })
  it('the sizing mode is part of the saved state', () => {
    const s = SC.save({ ...SC.create('k', 'c'), adjs: [{ id: 'btc', to: 100, price: 0.3 }] }, 'now')
    expect(SC.isDirty({ ...s, adjs: [{ id: 'btc', to: 100, price: 0.3, size: { by: 'amount', value: 30 } }] })).toBe(true)
    const back = SC.sanitize([{ ...s, adjs: [{ id: 'btc', to: null, price: 0.3, size: { by: 'amount', value: 30 } }] }], () => true)!
    expect(back.scenarios[0].adjs[0].size).toEqual({ by: 'amount', value: 30 })
  })
})

describe('value bridge', () => {
  it('reconciles: start + added capital + execution vs. mark − fees = scenario value; a trade at the mark changes nothing', () => {
    const opts = { fees: { mode: 'provider' as const, role: 'taker' as const }, funding: { pm: 2500 } }
    const adjs: Adjustment[] = [{ id: 'btc', to: 4000, price: 0.27 }, { id: 'fedk', to: 5000, price: 0.66 }]
    const start = simulate([], opts), sim = simulate(adjs, opts), b = valueBridge(start, sim, 2500)!
    close(b.before + b.added + b.execution - b.fees, b.after)
    close(b.added, 2500)
    close(b.execution, -4000 * (0.29 - 0.27) + (5000 - POS_BY_ID.fedk.shares) * (0.64 - 0.66))
    const atMark = valueBridge(simulate([], NOFEES), simulate([{ id: 'cel', to: 7000, price: 0.26 }], NOFEES), 0)!
    close(atMark.execution, 0); close(atMark.after - atMark.before, 0)
  })
  it('is unavailable when a traded instrument has no reference price', () => {
    const i = inst('ks-wti-90')
    expect(valueBridge(simulate([], NOFEES), simulate([{ id: key(i), to: 100, price: 0.4, instrument: i }], NOFEES), 0)).toBeNull()
  })
})

describe('outcome feasibility follows constraints through other events', () => {
  const rels: Relation[] = [
    { a: 'a', b: 'b', cls: 'equivalent', provenance: 'verified' },
    { a: 'b', b: 'c', cls: 'mutex', provenance: 'hypothetical' },
    { a: 'c', b: 'd', cls: 'related', provenance: 'annotation' },
  ]
  it('a and c can’t both be YES although no relation links them directly', () => {
    expect(partialFeasible({ a: 'YES', c: 'YES' }, ['a', 'b', 'c', 'd'], rels)).toBe(false)
    expect(partialFeasible({ a: 'YES', c: 'NO' }, ['a', 'b', 'c', 'd'], rels)).toBe(true)
  })
  it('annotations never constrain, and events outside the scenario don’t either', () => {
    expect(partialFeasible({ c: 'YES', d: 'YES' }, ['a', 'b', 'c', 'd'], rels)).toBe(true)
    expect(partialFeasible({ a: 'YES', c: 'YES' }, ['a', 'c'], rels)).toBe(true) // b isn't in this portfolio
  })
})

describe('account identity', () => {
  const p = POSITIONS[0]
  const twin: Position = { ...p, id: `${p.id}-b`, accountId: 'pm-wallet-b' }
  it('an instrument held in two accounts is ambiguous: never silently mapped to the first account', () => {
    const i = instrumentOfPosition(p)
    expect(holdingsOfInstrument(i, [p, twin])).toHaveLength(2)
    expect(positionFor(i, [p, twin])).toBeUndefined()
    expect(positionFor(i, [p])?.id).toBe(p.id)
  })
  it('every sample position belongs to an account on its own venue', () => {
    for (const x of POSITIONS) expect(x.accountId.startsWith(x.platform)).toBe(true)
  })
})

describe('event profiles', () => {
  it('report committed capital, value and the worst settlement per event, netting opposing sides', () => {
    const i = inst('pm-btc-150k', 'NO')
    const sim = simulate([{ id: key(i), to: 1000, price: 0.7, instrument: i }], NOFEES)
    const e = eventProfiles(sim).find((x) => x.id === 'btc')!
    expect(e.mixed).toBe(true)
    close(e.cost, POS_BY_ID.btc.cost + 700)
    close(e.worst, Math.min(POS_BY_ID.btc.shares, 1000) - e.cost)
  })
})

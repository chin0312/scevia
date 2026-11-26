/* Frozen starting portfolios: scenario results don't move with the latest portfolio, another workspace, a market
   revision or the reporting currency; rebasing is explicit and previewed. */
import { describe, expect, it } from 'vitest'
import { FIXTURE_B } from '../data/devWorkspaces'
import { baselineDiff, freezeBaseline, mergeByKey, readFrozen } from '../pages/lab/baseline'
import { evaluate } from '../pages/lab/model'
import { createFinance } from './finance'
import { FIXTURE } from './fixtureFinance'
import { setReportingFormat } from './format'
import * as SC from './scenarios'

describe('frozen scenario baseline', () => {
  const frozen = freezeBaseline(FIXTURE)
  const FF = createFinance(frozen)
  it('reproduces the starting cash, holdings and value of the portfolio it was taken from', () => {
    for (const p of ['pm', 'ks'] as const) {
      expect(FF.account(p).cash).toBeCloseTo(FIXTURE.account(p).cash, 6)
      expect(FF.account(p).positionsValue).toBeCloseTo(FIXTURE.account(p).positionsValue, 6)
    }
    expect(FF.POSITIONS.map((p) => p.id)).toEqual(FIXTURE.POSITIONS.map((p) => p.id))
    expect(readFrozen(JSON.parse(JSON.stringify(frozen)))).not.toBeNull()
    expect(readFrozen({ asOf: 'x' })).toBeNull()
  })
  it('keeps saved results stable across another workspace, a market revision and the reporting currency', () => {
    const s = { ...SC.create('k', '', 'Test', 'portfolio', FIXTURE.TODAY), frozen, adjs: [{ id: FIXTURE.POSITIONS[0].id, to: 0, price: FIXTURE.POSITIONS[0].mark }] }
    const before = evaluate(s, FF).A.totalValue
    // A different "latest" portfolio (another workspace, or new marks) doesn't take part in the evaluation.
    const moved = { ...FIXTURE.PORTFOLIO, openPositions: FIXTURE.OPEN_POSITIONS.map((p) => ({ ...p, mark: Math.min(0.99, p.mark + 0.1) })) }
    expect(baselineDiff(FF, createFinance(moved)).marksMoved).toBe(FIXTURE.POSITIONS.length)
    setReportingFormat({ code: 'EUR', symbol: '€', rate: 0.92 })
    const after = evaluate({ ...s }, createFinance(readFrozen(JSON.parse(JSON.stringify(frozen)))!)).A.totalValue
    setReportingFormat({ code: 'USD', symbol: '$', rate: 1 })
    expect(after).toBeCloseTo(before!, 6)
  })
  it('previews a rebase: same portfolio → no change; another portfolio → listed differences', () => {
    expect(baselineDiff(FF, FIXTURE).same).toBe(true)
    const d = baselineDiff(FF, createFinance(FIXTURE_B))
    expect(d.same).toBe(false)
    expect(d.removed.length).toBe(FIXTURE.POSITIONS.length)
    expect(d.added.length).toBe(3)
  })
  it('restores held rows against the scenario’s own frozen portfolio, not the selected one', () => {
    const raw = [{ ...SC.create('k', '', 'T', 'portfolio', FIXTURE.TODAY), frozen, adjs: [{ id: FIXTURE.POSITIONS[0].id, to: 1, price: 0.5 }] }]
    const known = (id: string, f: unknown) => !!(f as typeof frozen | null)?.openPositions.some((p) => p.id === id)
    const r = SC.sanitize(JSON.parse(JSON.stringify(raw)), known)!
    expect(r.scenarios[0].adjs).toHaveLength(1)
    expect(r.scenarios[0].frozen).not.toBeNull()
  })
  it('merges older per-portfolio collections by key without duplicating', () => {
    expect(mergeByKey([{ key: 'a' }, { key: 'b' }], [{ key: 'b' }, { key: 'c' }]).map((x) => x.key)).toEqual(['a', 'b', 'c'])
  })
})

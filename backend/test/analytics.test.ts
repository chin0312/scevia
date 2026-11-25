import { describe, expect, it } from 'vitest'
import { annualizedMoneyWeightedReturn, concentration, drawdowns, linkedReturn } from '../src/analytics/performance.js'
import { settlementRisk } from '../src/analytics/settlement.js'

describe('independent analytics examples', () => {
  it('links returns around external flows and measures drawdown from its running peak', () => {
    expect(linkedReturn([{ opening: '1000', closing: '1100' }, { opening: '2100', closing: '2205' }])?.toFixed()).toBe('0.155')
    expect(linkedReturn([{ opening: '0', closing: '20' }])).toBeNull()
    expect(drawdowns(['100', '120', '90', '108', '125'])).toEqual({
      maximum: '-0.25', series: ['0', '0', '-0.25', '-0.1', '0'],
    })
    expect(annualizedMoneyWeightedReturn([{ timestamp: '2025-01-01T00:00:00Z', amount: '-100' },
      { timestamp: '2026-01-01T00:00:00Z', amount: '110' }])?.toFixed()).toBe('0.1')
  })

  it('uses the selected denominator for concentration', () => {
    expect(concentration(['50', '30', '20'])).toMatchObject({ denominator: '100', weights: ['0.5', '0.3', '0.2'], hhi: '0.38' })
    expect(concentration(['0'])).toBeNull()
  })

  it('enumerates jointly feasible outcomes without combining opposing losses', () => {
    const binary = { id: 'a', yes: 'yes', no: 'no', legs: [
      { instrument: 'yes', quantity: '100', mark: '0.60' }, { instrument: 'no', quantity: '80', mark: '0.4' },
    ] }
    expect(settlementRisk([binary], [])).toMatchObject({
      status: 'exact', reference: '92', feasible: 2, worst: { payout: '80', changeFromReference: '-12' },
      best: { payout: '100', changeFromReference: '8' },
    })
    const other = { id: 'b', yes: 'b-yes', no: 'b-no', legs: [{ instrument: 'b-yes', quantity: '20', mark: '0.5' }] }
    expect(settlementRisk([binary, other], [{ left: 'a', right: 'b', kind: 'exclusive' }]))
      .toMatchObject({ feasible: 3, worst: { payout: '80' }, best: { payout: '100' } })
    expect(settlementRisk([binary, other], [{ left: 'a', right: 'b', kind: 'equivalent' }]))
      .toMatchObject({ feasible: 2, best: { payout: '120' } })
    const connector = { id: 'connector', yes: 'c-yes', no: 'c-no', legs: [] }
    expect(settlementRisk([binary, connector, other], [
      { left: 'a', right: 'connector', kind: 'implies' },
      { left: 'connector', right: 'b', kind: 'implies' },
    ])).toMatchObject({ status: 'exact', feasible: 4 })
    expect(settlementRisk([{ ...binary, fixed: 'yes' }, { ...other, fixed: 'no' }], [
      { left: 'a', right: 'b', kind: 'equivalent' },
    ])).toEqual({ status: 'unavailable', reason: 'no_feasible_outcomes' })
    expect(settlementRisk(Array.from({ length: 13 }, (_, index) => ({ ...binary, id: String(index) })), []))
      .toEqual({ status: 'unavailable', reason: 'joint_enumeration_limit' })
  })
})

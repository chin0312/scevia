import { consolidatePerformance } from '../src/fx/consolidated.js'
import { selectRate } from '../src/fx/reference.js'
import { describe, expect, it } from 'vitest'
import { analyzePerformance } from '../src/analytics/performance.js'
import type { Evidence } from '../src/accounting/model.js'
import { reportingPerformance } from '../src/fx/performance.js'

describe('reporting performance', () => {
  it('converts external flows at their own boundaries without substituting missing FX', () => {
    const from = '2026-01-01T00:00:00.000Z'
    const contribution = '2026-01-02T00:00:00.000Z'
    const through = '2026-01-03T00:00:00.000Z'
    const base = { account: 'fixture', venue: 'fixture', asset: 'USD', instrument: null, price: null,
      quantity: null, fee: null, feeAsset: null, sequence: null }
    const evidence: Evidence[] = [
      { id: 'cash', type: 'opening_cash', timestamp: from, amount: '100' },
      { id: 'inventory', type: 'opening_inventory', timestamp: from, amount: null },
      { id: 'coverage', type: 'history_complete', timestamp: from, amount: null, coveredThrough: through },
      { id: 'flow', type: 'deposit', timestamp: contribution, amount: '20', fee: '0' },
    ].map((row, index) => ({ batchId: 'fixture', row: index, observation: { ...base, ...row,
      type: row.type as Evidence['observation']['type'] } }))
    const native = analyzePerformance(evidence, ['fixture'], 'USD', from, through)
    expect(native.returns.twr.value).toBe('0')
    const rates = [
      { at: from, rate: '1.2' },
      { at: '2026-01-02T12:00:00.000Z', rate: '1.5' },
    ].map(({ at, rate }) => ({
      revision: at, observedAt: new Date(at), retrievedAt: new Date(at), source: 'fixture', methodology: 'fiat_reference',
      base: 'USD', quote: 'SGD', rate,
    }))
    const reporting = reportingPerformance(rates, native, 'USD', 'SGD')
    expect(reporting).toMatchObject({ twr: '0.25', netInvestmentGain: '36',
      cashFlowBoundaries: [{ flow: { value: '24' }, eligible: true }] })
    const missing = reportingPerformance(rates.slice(1), native, 'USD', 'SGD')
    expect(missing.twr).toBeNull()
    expect(missing.netInvestmentGain).toBeNull()
  })
  it('distinguishes late archival FX from knowledge-time publication', () => {
    const archived = { revision: 'one', source: 'bank', methodology: 'fiat_reference', rate: '1.25', base: 'EUR', quote: 'USD',
      observedAt: new Date('2026-01-02T00:00:00Z'), retrievedAt: new Date('2026-11-26T00:00:00Z') }
    const cutoff = '2026-01-03T00:00:00.000Z'
    expect(selectRate([archived], 'EUR', 'USD', cutoff).rate).toBeNull()
    expect(selectRate([archived], 'EUR', 'USD', cutoff, { mode: 'retrospective' })).toMatchObject({
      rate: '1.25', legs: [{ retrievedAt: '2026-11-26T00:00:00.000Z' }],
    })
    expect(selectRate([{ ...archived, publishedAt: new Date('2026-01-02T15:00:00Z') }], 'EUR', 'USD', cutoff).rate).toBe('1.25')
    expect(selectRate([archived], 'EUR', 'USD', '2026-01-01T00:00:00.000Z', { mode: 'retrospective' }).rate).toBeNull()
  })

  it('calculates consolidated return and drawdown from converted external-flow boundaries', () => {
    const opened = '2026-01-01T00:00:00.000Z'
    const deposited = '2026-01-02T00:00:00.000Z'
    const through = '2026-01-03T00:00:00.000Z'
    const evidence: Evidence[] = ['USD', 'USDC'].flatMap((asset) => [
      { type: 'opening_cash' as const, amount: '100', timestamp: opened },
      { type: 'opening_inventory' as const, amount: null, timestamp: opened },
      { type: 'history_complete' as const, amount: null, timestamp: opened, coveredThrough: through },
      ...(asset === 'USD' ? [{ type: 'deposit' as const, amount: '20', timestamp: deposited }] : []),
    ].map((row, index) => ({ batchId: asset, row: index, observation: { venue: asset, account: asset, asset, id: asset + index,
      instrument: null, price: null, quantity: null, sequence: null, feeAsset: asset, fee: '0', ...row } })))
    const rates = [{ at: opened, rate: '1' }, { at: '2026-01-02T12:00:00.000Z', rate: '0.8' }].map(({ at, rate }) => ({
      revision: at, source: 'fixture', methodology: 'stablecoin_market_reference', base: 'USDC', quote: 'USD',
      rate, observedAt: new Date(at), retrievedAt: new Date('2026-11-26T00:00:00Z'),
    }))
    const result = consolidatePerformance(evidence, rates, ['USD', 'USDC'], 'USD', opened, through, 'retrospective')
    expect(result.opening.completeValue).toBe('200')
    expect(result.cashFlowBoundaries[0]).toMatchObject({ valid: true, converted: { completeValue: '20' } })
    expect(result.ending?.completeValue).toBe('200')
    expect(Number(result.twr)).toBeCloseTo(-1 / 11)
    expect(Math.abs(Number(result.maximumDrawdown))).toBeCloseTo(1 / 11)
    expect(consolidatePerformance(evidence, rates, ['USD', 'USDC'], 'USD', opened, through, 'knowledge').twr).toBeNull()

    const initiallyEmpty = evidence.map((item) => item.observation.asset === 'USDC' && item.observation.type === 'opening_cash'
      ? { ...item, observation: { ...item.observation, amount: '0' } } : item)
    const deposit = initiallyEmpty.find((item) => item.observation.type === 'deposit')!
    const stablecoinDeposit = { ...deposit, observation: { ...deposit.observation, id: 'stablecoin deposit', account: 'USDC',
      venue: 'USDC', asset: 'USDC', feeAsset: 'USDC' } }
    const funded = [...initiallyEmpty, stablecoinDeposit]
    const consolidated = consolidatePerformance(funded, rates, ['USD', 'USDC'], 'USD', opened, through, 'retrospective')
    expect(consolidated.native.find((row) => row.asset === 'USDC')?.returns.twr.value).toBeNull()
    expect(consolidated.opening.completeValue).toBe('100')
    expect(consolidated.ending?.completeValue).toBe('136')
    expect(Number(consolidated.twr)).toBeCloseTo(-4 / 140)
    const incomplete = funded.filter((row) => row.observation.asset !== 'USDC' || row.observation.type !== 'opening_inventory')
    expect(consolidatePerformance(incomplete, rates, ['USD', 'USDC'], 'USD', opened, through, 'retrospective').twr).toBeNull()
  })

})

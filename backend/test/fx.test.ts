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
})

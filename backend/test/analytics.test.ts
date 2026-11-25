import { describe, expect, it } from 'vitest'
import { analyzePerformance, annualizedMoneyWeightedReturn, concentration, drawdowns, linkedReturn } from '../src/analytics/performance.js'
import type { Evidence, FinancialObservation } from '../src/accounting/model.js'
import { analyzeExposure, analyzeReportedExposure } from '../src/analytics/exposure.js'
import { replayAccounting } from '../src/accounting/ledger.js'
import { settlementRisk } from '../src/analytics/settlement.js'

describe('independent analytics examples', () => {
  it('links returns around external flows and measures drawdown from its running peak', () => {
    expect(linkedReturn([{ opening: '1000', closing: '1100' }, { opening: '2100', closing: '2205' }])?.toFixed()).toBe('0.155')
    expect(linkedReturn([{ opening: '0', closing: '20' }])).toBeNull()
    expect(drawdowns(['100', '120', '90', '108', '125'])).toMatchObject({
      maximum: '-0.25', series: ['0', '0', '-0.25', '-0.1', '0'],
      episode: { peakIndex: 1, troughIndex: 2, recoveryIndex: 4 },
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
    const independent = Array.from({ length: 30 }, (_, index) => ({ ...binary, id: String(index) }))
    expect(settlementRisk(independent, [])).toMatchObject({
      status: 'exact', feasibleCountExact: '1073741824', reference: '2760', downside: '360',
      worst: { payout: '2400' }, best: { payout: '3000', changeFromReference: '240' },
    })
    expect(settlementRisk(independent.slice(0, 13), independent.slice(1, 13).map(({ id }) =>
      ({ left: '0', right: id, kind: 'equivalent' as const }))))
      .toEqual({ status: 'unavailable', reason: 'joint_enumeration_limit' })
  })

  it('preserves exact counts for disconnected components and reports reviewed observed payoff separately', () => {
    const groups = Array.from({ length: 20 }, (_, index) => ({
      id: String(index), yes: 'yes-' + index, no: 'no-' + index,
      legs: [{ instrument: 'yes-' + index, quantity: '100', mark: '0.6' }, { instrument: 'no-' + index, quantity: '80', mark: '0.4' }],
    }))
    const edges = groups.flatMap((group, i) => i % 4 === 0 ? [] :
      [{ left: String(i - 1), right: group.id, kind: 'equivalent' as const }])
    expect(settlementRisk(groups, edges)).toMatchObject({ componentSizes: [4, 4, 4, 4, 4], feasibleCountExact: '32',
      worst: { payout: '1600' }, best: { payout: '2000' } })
    const observedAt = new Date('2026-11-24T22:00:00Z')
    const asOf = '2026-11-25T00:00:00.000Z'
    const metadata = ['yes', 'no'].map((instrument) => ({
      instrument, market: 'm', event: 'e', lifecycle: 'open', resolvesAt: null, title: 'Binary', outcome: instrument,
    }))
    const observed = analyzeReportedExposure([
      { account: 'a', venue: 'v', instrument: 'yes', asset: 'USD', sourceRecordId: 's', syncRunId: 'refresh',
        observedAt, quantity: '100', mark: '0.6', markAt: observedAt },
    ], [{ account: 'a', entity: 'positions', status: 'partial', lastSuccessfulRunId: 'refresh',
      lastAttemptStatus: 'complete', lastAttemptAt: observedAt, lastSuccessfulSyncAt: observedAt }],
    asOf, 'USD', metadata, [{ market: 'm', event: 'e', yes: 'yes', no: 'no', asset: 'USD', evidence: 'fixture', reviewedAt: observedAt }], [], false)
    expect(observed).toMatchObject({ effectivePortfolioReplacement: false,
      rows: [{ observedMarketValue: '60', providerCoverage: 'partial' }],
      settlement: { result: { worst: { payout: '0', changeFromReference: '-60' }, best: { payout: '100', changeFromReference: '40' } } },
    })
  })

  it('isolates local instrument attribution and counts cross-asset posted fees', () => {
    const row = (n: number, account: string, observation: Partial<FinancialObservation>): Evidence => ({
      batchId: account, row: n, observation: {
        venue: 'local', account, id: String(n), timestamp: '2026-01-02T00:00:00.000Z', sequence: null,
        type: 'buy', instrument: 'yes', asset: 'USD', quantity: '10', price: '0.4', amount: null, fee: '0', feeAsset: null,
        ...observation,
      },
    })
    const evidence = [
      row(1, 'a', {}), row(1, 'b', { price: '0.6' }),
      row(2, 'a', { type: 'sell', price: '0.7', timestamp: '2026-01-03T00:00:00.000Z' }),
      row(2, 'b', { type: 'sell', price: '0.7', timestamp: '2026-01-03T00:00:00.000Z' }),
      row(3, 'a', { fee: '0.05', feeAsset: 'ETH', timestamp: '2026-01-04T00:00:00.000Z' }),
    ]
    const from = '2026-01-01T00:00:00.000Z'
    const through = '2026-01-05T00:00:00.000Z'
    const usd = analyzePerformance(evidence, ['a', 'b'], 'USD', from, through)
    expect(usd.attribution.instruments.filter((item) => item.knownRealized !== null)).toMatchObject([
      { account: 'a', instrument: 'yes', knownRealized: '3' }, { account: 'b', instrument: 'yes', knownRealized: '1' },
    ])
    expect(usd.returns.twr.value).toBeNull()
    const eth = analyzePerformance(evidence, ['a', 'b'], 'ETH', from, through)
    expect(eth.fees).toMatchObject({ asset: 'ETH', grossExecutionCharges: '0.05', netExecutionFees: '0.05' })
    expect(eth.trading.fills).toBe(0)
  })


  it('matches direct replay at daily boundaries including mark expiry and a later execution fee', () => {
    const item = (row: number, values: Partial<FinancialObservation>): Evidence => ({
      batchId: 'one', row, observation: {
        venue: 'v', account: 'a', asset: 'USD', id: String(row), timestamp: '2026-01-01T00:00:00.000Z',
        sequence: null, instrument: null, quantity: null, price: null, amount: null, fee: null, feeAsset: null,
        type: 'opening_cash', ...values,
      },
    })
    const evidence = [
      item(1, { amount: '100' }), item(2, { type: 'opening_inventory' }),
      item(3, { type: 'history_complete', coveredThrough: '2026-01-08T00:00:00.000Z' }),
      item(4, { type: 'buy', instrument: 'yes', quantity: '10', price: '0.5', timestamp: '2026-01-01T01:00:00.000Z' }),
      item(5, { type: 'mark', instrument: 'yes', price: '0.7', timestamp: '2026-01-02T00:00:00.000Z' }),
      item(6, { type: 'fee', relatedEventId: '4', feeTiming: 'execution_evidence', amount: '0.2', timestamp: '2026-01-03T00:00:00.000Z' }),
      item(7, { type: 'mark', instrument: 'yes', price: '0.6', timestamp: '2026-01-04T00:00:00.000Z' }),
    ]
    const result = analyzePerformance(evidence, ['a'], 'USD', '2026-01-01T00:00:00.000Z', '2026-01-05T01:00:00.000Z')
    for (const point of result.history) expect(point.value).toBe(replayAccounting(evidence, point.asOf).cash[0]?.portfolioValue)
    expect(result.history.some((point) => point.value === '100.8')).toBe(true)
    expect(result.ending.value).toBeNull()
  })

  it('includes cash and pending entitlement exactly once in selected allocation', () => {
    const row = (n: number, values: Partial<FinancialObservation>): Evidence => ({
      batchId: 'a', row: n, observation: {
        venue: 'v', account: 'a', id: String(n), timestamp: '2026-01-01T00:00:00.000Z', sequence: null,
        type: 'opening_cash', instrument: null, asset: 'USD', quantity: null, price: null, amount: null, fee: null, feeAsset: null,
        ...values,
      },
    })
    const asOf = '2026-01-02T00:00:00.000Z'
    const state = replayAccounting([
      row(1, { amount: '5000' }), row(2, { type: 'opening_inventory' }),
      row(3, { type: 'opening_position', instrument: 'crypto', quantity: '5000', amount: '1000' }),
      row(4, { type: 'opening_position', instrument: 'politics', quantity: '2000', amount: '500' }),
      row(5, { type: 'opening_position', instrument: 'settled', quantity: '1000', amount: '400' }),
      row(6, { type: 'mark', instrument: 'crypto', price: '0.6', timestamp: asOf }),
      row(7, { type: 'mark', instrument: 'politics', price: '0.5', timestamp: asOf }),
      row(8, { type: 'settlement', instrument: 'settled', quantity: '1000', price: '1', timestamp: asOf }),
    ], asOf)
    const identities = ['crypto', 'politics'].map((instrument) => ({
      instrument, market: instrument, event: instrument, title: instrument, outcome: instrument, resolvesAt: null, lifecycle: 'open',
    }))
    const result = analyzeExposure(state, 'USD', ['a'], identities, [], [], new Set(), false)
    expect(result.allocation.byEvent.rows).toMatchObject([{ id: 'crypto', weight: '0.75' }, { id: 'politics', weight: '0.25' }])
    expect(result.allocationBases.cashInclusive).toMatchObject({ denominator: '10000', rows: [
      { id: 'crypto', weight: '0.3' }, { id: 'politics', weight: '0.1' }, { id: 'cash', weight: '0.5' }, { id: 'pending', weight: '0.1' },
    ] })
  })


  it('keeps eligible earlier returns and stops the index at an unclassified provider flow', () => {
    const frame: FinancialObservation = { venue: 'v', account: 'a', asset: 'USD', id: 'opening',
      type: 'opening_cash', timestamp: '2026-01-01T00:00:00.000Z', sequence: null, instrument: null,
      quantity: null, price: null, amount: '100', fee: null, feeAsset: null }
    const evidence: Evidence[] = [
      { batchId: 'b', row: 1, observation: frame },
      { batchId: 'b', row: 2, observation: { ...frame, id: 'inventory', type: 'opening_inventory', amount: null } },
      { batchId: 'b', row: 3, observation: { ...frame, id: 'history', type: 'history_complete', amount: null, coveredThrough: '2026-01-10T00:00:00.000Z' } },
      { batchId: 'b', row: 4, observation: { ...frame, id: 'gain', type: 'reward', amount: '10', timestamp: '2026-01-02T00:00:00.000Z' } },
      { providerAccountId: 'a', sourceRecordId: 's', payloadSha256: 'sha',
        observation: { ...frame, id: 'unknown-flow', type: 'deposit', fee: '0', timestamp: '2026-01-03T00:00:00.000Z' } },
    ]
    const result = analyzePerformance(evidence, ['a'], 'USD', frame.timestamp, '2026-01-05T00:00:00.000Z')
    expect(result.history).toContainEqual(expect.objectContaining({ asOf: '2026-01-02T23:59:59.999Z', returnIndex: '110' }))
    expect(result.history.filter((point) => point.asOf >= '2026-01-03T00:00:00.000Z').every((point) => point.returnIndex === null)).toBe(true)
    expect(result.returns).toMatchObject({ twr: { value: null }, indexCoverage: 'gapped_sample_grid',
      maximumDrawdown: { value: null }, annualizedVolatility: { value: null } })
  })

})

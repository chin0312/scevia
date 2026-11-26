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
    ])).toMatchObject({ status: 'unavailable', reason: 'no_feasible_outcomes', supportedSubset: null })
    const independent = Array.from({ length: 30 }, (_, index) => ({ ...binary, id: String(index), yes: 'yes-' + index, no: 'no-' + index,
      legs: binary.legs.map((leg) => ({ ...leg, instrument: leg.instrument + '-' + index })) }))
    expect(settlementRisk(independent, [])).toMatchObject({
      status: 'exact', feasibleCountExact: '1073741824', reference: '2760', downside: '360',
      worst: { payout: '2400' }, best: { payout: '3000', changeFromReference: '240' },
    })
    expect(settlementRisk(independent.slice(0, 13), independent.slice(1, 13).map(({ id }) =>
      ({ left: '0', right: id, kind: 'equivalent' as const }))))
      .toMatchObject({ status: 'unavailable', reason: 'joint_enumeration_limit', supportedSubset: null })
    expect(settlementRisk(independent.slice(0, 14), independent.slice(1, 13).map(({ id }) =>
      ({ left: '0', right: id, kind: 'equivalent' as const }))))
      .toMatchObject({ status: 'unavailable', components: [{ status: 'unavailable' }, { status: 'exact' }],
        supportedSubset: { feasibleCountExact: '2', worst: { payout: '80' } } })
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
    ], [{ account: 'a', venue: 'v', entity: 'positions', status: 'partial', lastSuccessfulRunId: 'refresh',
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


  it('uses only execution fees posted for the trades in the notional denominator', () => {
    const base: FinancialObservation = { venue: 'local', account: 'a', id: 'eth', timestamp: '2026-01-02T00:00:00.000Z',
      sequence: null, type: 'buy', instrument: 'yes', asset: 'ETH', quantity: '100', price: '1',
      amount: null, fee: null, feeAsset: null }
    const evidence = (values: Partial<FinancialObservation>[]) => values.map((value, index): Evidence =>
      ({ batchId: 'b', row: index + 2, observation: { ...base, ...value } }))
    const result = (values: Partial<FinancialObservation>[]) => analyzePerformance(evidence(values), ['a'], 'ETH',
      '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z')
    const usd = { id: 'usd', asset: 'USD', quantity: '1000', fee: '0.05', feeAsset: 'ETH' }
    const linked = { id: 'fee', timestamp: '2026-01-03T00:00:00.000Z', type: 'fee', instrument: null, quantity: null,
      price: null, amount: '1', relatedEventId: 'eth', feeTiming: 'execution_evidence' } as const
    for (const rows of [[{ fee: '1' }, usd, linked], [{}, usd, linked]]) {
      expect(result(rows)).toMatchObject({ fees: { netExecutionFees: '1.05' },
        trading: { grossNotional: '100', netExecutionFeeToNotional: { value: '0.01' } } })
    }
    expect(result([{}, usd]).trading.netExecutionFeeToNotional.value).toBeNull()
    expect(result([{ fee: '-1' }, usd]).trading.netExecutionFeeToNotional.value).toBe('-0.01')
    expect(result([{ fee: '0' }, usd]).trading.netExecutionFeeToNotional.value).toBe('0')
  })

  it('rejects unsuitable financial data at the settlement boundary', () => {
    const leg = { instrument: 'yes', quantity: '100', mark: '0.5', account: 'a', venue: 'v' }
    const group = { id: 'a', yes: 'yes', no: 'no', asset: 'USD', legs: [leg] }
    for (const quantity of ['-1', 'Infinity', 'NaN', 'abc', '1\n']) {
      expect(settlementRisk([{ ...group, legs: [{ ...leg, quantity }] }], [])).toMatchObject({ status: 'unavailable', reason: 'invalid_quantity' })
    }
    for (const unitPayout of ['0', '-1', 'Infinity', 'NaN']) {
      expect(settlementRisk([{ ...group, unitPayout }], [])).toMatchObject({ status: 'unavailable', reason: 'invalid_payout_unit' })
    }
    for (const mark of ['1.01', '-0.1', 'Infinity', 'NaN']) {
      expect(settlementRisk([{ ...group, legs: [{ ...leg, mark }] }], [])).toMatchObject({ status: 'unavailable', reason: 'invalid_reference_mark' })
    }
    expect(settlementRisk([group, { ...group, id: 'other' }], [])).toMatchObject({ reason: 'conflicting_instrument_assignment' })
    expect(settlementRisk([group, group], [])).toMatchObject({ reason: 'invalid_group_identity' })
    expect(settlementRisk([group, { ...group, id: 'b', yes: 'b-yes', no: 'b-no', asset: 'ETH', legs: [] }], []))
      .toMatchObject({ reason: 'incompatible_settlement_assets' })
    expect(settlementRisk([group], [])).toMatchObject({ status: 'exact', basis: 'mathematical_model',
      best: { contributions: [{ market: 'a', instrument: 'yes', account: 'a', venue: 'v', payout: '100' }] } })
  })

  it('matches direct replay at daily boundaries including carried marks and a later execution fee', () => {
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
    for (const point of result.history) expect(point.value).toBe(replayAccounting(evidence, point.asOf).cash[0]?.referencePortfolioValue)
    expect(result.history.some((point) => point.value === '100.8')).toBe(true)
    expect(result.ending).toMatchObject({ value: '100.8', valuationQuality: 'carry_forward_reference_estimate', staleReferenceCount: 1 })
    expect(replayAccounting(evidence, result.ending.asOf).cash[0]?.portfolioValue).toBeNull()
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
    const cashOnly = replayAccounting([row(1, { amount: '5000' })], asOf)
    expect(analyzeExposure(cashOnly, 'USD', ['a'], [], [], [], new Set(), false).allocationBases.cashInclusive)
      .toMatchObject({ denominator: null, reason: 'opening_inventory_unknown', rows: [{ id: 'cash', value: '5000', weight: null },
        { id: 'pending', weight: null }] })
    const result = analyzeExposure(state, 'USD', ['a'], identities, [], [], new Set(), false)
    expect(result.allocation.byEvent.rows).toMatchObject([{ id: 'crypto', weight: '0.75' }, { id: 'politics', weight: '0.25' }])
    expect(result.allocationBases.cashInclusive).toMatchObject({ denominator: '10000', rows: [
      { id: 'crypto', weight: '0.3' }, { id: 'politics', weight: '0.1' }, { id: 'cash', weight: '0.5' }, { id: 'pending', weight: '0.1' },
    ] })
  })


  it('does not infer market or event concentration from four unmapped holdings', () => {
    const asOf = '2026-01-02T00:00:00.000Z'
    const base: FinancialObservation = { venue: 'v', account: 'a', asset: 'USD', id: null,
      type: 'opening_position', timestamp: '2026-01-01T00:00:00.000Z', sequence: null, instrument: null,
      quantity: '500', price: null, amount: '250', fee: null, feeAsset: null }
    const rows: FinancialObservation[] = Array.from({ length: 4 }, (_, index) => {
      const instrument = 'local:' + index
      return [{ ...base, instrument, id: 'opening:' + index }, { ...base, instrument, id: 'mark:' + index,
        type: 'mark' as const, timestamp: asOf, quantity: null, amount: null, price: '0.5' }]
    }).flat()
    const state = replayAccounting([
      { batchId: 'b', row: 2, observation: { ...base, id: 'inventory', type: 'opening_inventory', quantity: null, amount: null } },
      ...rows.map((observation, index) => ({ batchId: 'b', row: index + 3, observation })),
    ], asOf)
    const { allocation } = analyzeExposure(state, 'USD', ['a'], [], [], [], new Set(), false)
    expect(allocation.byInstrument).toMatchObject({ denominator: '1000', concentration: { hhi: '0.25' } })
    for (const dimension of [allocation.byMarket, allocation.byEvent]) {
      expect(dimension).toMatchObject({ denominator: null, concentration: null, availability: 'unavailable',
        mappingCoverage: { unmappedKnownValue: '1000', unmappedHoldings: 4 } })
    }
  })

  it('allocates known cash against explicitly empty inventory', () => {
    const asOf = '2026-01-01T00:00:00.000Z'
    const cash: FinancialObservation = { venue: 'v', account: 'a', asset: 'USD', id: 'cash',
      type: 'opening_cash', timestamp: asOf, sequence: null, instrument: null,
      quantity: null, price: null, amount: '5000', fee: null, feeAsset: null }
    const state = replayAccounting([
      { batchId: 'b', row: 1, observation: cash },
      { batchId: 'b', row: 2, observation: { ...cash, id: 'inventory', type: 'opening_inventory', amount: null } },
    ], asOf)
    expect(analyzeExposure(state, 'USD', ['a'], [], [], [], new Set(), false).allocationBases.cashInclusive)
      .toMatchObject({ denominator: '5000', rows: [{ id: 'cash', value: '5000', weight: '1' },
        { id: 'pending', value: '0', weight: '0' }] })
  })

  it('retains supported outcomes when another component has a missing connector rule', () => {
    const group = { id: 'supported', yes: 'yes', no: 'no', legs: [{ instrument: 'yes', quantity: '10', mark: '0.6' }] }
    const linked = { ...group, id: 'linked', yes: 'linked-yes', no: 'linked-no', legs: [] }
    expect(settlementRisk([group, linked], [{ left: 'linked', right: 'missing', kind: 'exclusive' }], ['missing']))
      .toMatchObject({ status: 'unavailable', reason: 'connected_rule_unavailable', supportedSubset: {
        reference: '6', worst: { payout: '0' }, best: { payout: '10' },
      } })
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
    expect(result.periodicReturns.daily).toContainEqual(expect.objectContaining({
      through: '2026-01-02T23:59:59.999Z', partial: false, twr: { value: '0.1', availability: 'calculated',
        quality: 'reconstructed_selected_value', reason: null },
      trading: expect.objectContaining({ fills: 0, buys: 0, sells: 0, grossNotional: '0' }),
    }))
    expect(result.periodicReturns.monthly).toMatchObject([{ partial: true, twr: { value: null, quality: 'unavailable' } }])
    expect(result.history).toContainEqual(expect.objectContaining({ asOf: '2026-01-02T23:59:59.999Z', returnIndex: '110' }))
    expect(result.history.filter((point) => point.asOf >= '2026-01-03T00:00:00.000Z').every((point) => point.returnIndex === null)).toBe(true)
    expect(result.returns).toMatchObject({ twr: { value: null }, indexCoverage: 'gapped_sample_grid',
      maximumDrawdown: { value: null }, annualizedVolatility: { value: null } })
  })

})

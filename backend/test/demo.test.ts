import { describe, expect, it } from 'vitest'
import { demoMarketAt, parseDemoDataset } from '../src/demo/dataset.js'
import { captureDemo } from '../src/demo/capture.js'
import { KalshiClient } from '../src/providers/kalshi/client.js'
import { KalshiMarketDataService } from '../src/providers/kalshi/market-data.js'
import { replayAccounting, type Evidence } from '../src/accounting/ledger.js'
import type { FinancialObservation } from '../src/accounting/model.js'

describe('demo capture and derived financial evidence', () => {
  it('builds a version from authorized-source contracts and requires an exact prior quote', async () => {
    const observedAt = '2026-01-02T01:00:00.000Z'
    const kalshi = new KalshiMarketDataService(new KalshiClient(async (url) => {
      if (url.pathname.endsWith('/candlesticks')) return Response.json({ ticker: 'CAPTURE',
        candlesticks: [{ end_period_ts: Date.parse(observedAt) / 1000, price: { close: '0.4' } }] })
      return Response.json({ market: { ticker: 'CAPTURE', event_ticker: 'EVENT', title: 'Fixture title',
        market_type: 'binary', status: 'finalized', notional_value_dollars: '1', result: 'yes',
        settlement_value_dollars: '1', settlement_ts: '2026-01-02T02:00:00Z' } })
    }))
    const plan = { markets: [{ provider: 'kalshi', ticker: 'CAPTURE' }],
      capital: [{ provider: 'kalshi', asset: 'USD', openedAt: '2026-01-01T00:00:00Z', amount: '100' }],
      trades: [{ id: 'entry', marketIndex: 0, side: 'YES', observedAt, quantity: '5', direction: 'buy', assumedFee: null }] }
    const result = await captureDemo(plan, { kalshi })
    expect(result.manifest.markets[0]).toMatchObject({ title: 'Fixture title', lifecycle: 'resolved',
      resolution: { winningInstrument: 'CAPTURE:yes', knownAt: '2026-01-02T02:00:00.000Z' } })
    expect(result.manifest.quotes[result.manifest.trades[0]!.quoteIndex]).toMatchObject({ observedAt, price: '0.4', method: 'historical_close' })
    await expect(captureDemo({ ...plan, trades: [{ ...plan.trades[0], observedAt: '2026-01-02T01:01:00Z' }] }, { kalshi }))
      .rejects.toThrow('demo_trade_observation_unavailable')
    await expect(captureDemo(plan, {})).rejects.toThrow('kalshi_demo_capture_not_authorized')
  })

  it('imports prior historical observations and reviewed Polymarket resolution with exact native scope', async () => {
    const observedAt = '2026-01-02T01:00:00.000Z'
    const executionAt = '2026-01-02T02:00:00.000Z'
    const knownAt = '2026-02-01T00:00:00.000Z'
    const retrievedAt = '2026-03-01T00:00:00.000Z'
    const conditionId = 'condition'
    const resolution = { knownAt, winningInstrument: 'token-yes', unitPayout: '1',
      evidence: { source: 'reviewed_provider_evidence', reference: 'approval:fixture-proof', verifiedAt: retrievedAt } }
    const selection = { provider: 'polymarket', conditionId, link: 'https://polymarket.com/event/fixture', asset: 'PUSD',
      tradingOpensAt: '2026-01-01T00:00:00.000Z', tradingClosesAt: '2026-01-04T00:00:00.000Z', resolution }
    const trade = { id: 'entry', marketIndex: 0, side: 'YES', executionAt, priorObservationMaxAgeSeconds: 3600,
      quantity: '5', direction: 'buy', assumedFee: '0' }
    const plan = { markets: [selection], trades: [trade],
      capital: [{ provider: 'polymarket', asset: 'PUSD', openedAt: '2026-01-01T00:00:00.000Z', amount: '100' }],
      capturedHistory: [{ provider: 'polymarket', nativeMarket: conditionId, instrument: 'token-yes', price: '0.42',
        method: 'historical_close', source: 'authorized_capture', observedAt, retrievedAt }] }
    const polymarket = {
      resolve: async () => ({ retrievedAt, item: { eventId: 'event', title: 'Fixture title',
        markets: [{ conditionId, title: 'Fixture market', lifecycle: 'resolved', endDate: knownAt,
          outcomes: [{ assetId: 'token-yes', name: 'YES' }, { assetId: 'token-no', name: 'NO' }] }] } }),
      priceHistory: async () => { throw new Error('unexpected_remote_history_request') },
    }
    const result = await captureDemo(plan, { polymarket }, () => retrievedAt)
    expect(result.manifest.markets[0]).toMatchObject({ asset: 'PUSD', resolution })
    expect(result.manifest.trades[0]).toMatchObject({ executionAt, quoteIndex: 0 })
    expect(result.manifest.quotes[0]).toMatchObject({ observedAt, price: '0.42' })
    await expect(captureDemo({ ...plan, trades: [{ ...trade, priorObservationMaxAgeSeconds: 3599 }] }, { polymarket }, () => retrievedAt))
      .rejects.toThrow('unexpected_remote_history_request')
    expect(() => parseDemoDataset({ ...result.manifest, trades: [{ ...result.manifest.trades[0], executionAt: selection.tradingClosesAt }] }))
      .toThrow('invalid_demo_execution_reference')
    expect(() => parseDemoDataset({ ...result.manifest, markets: [{ ...result.manifest.markets[0], resolution: { ...resolution, evidence: undefined } }] }))
      .toThrow('invalid_demo_market_scope')
    const initial = { ...result.manifest.markets[0]!, resolution: undefined, lifecycle: 'open' as const, retrievedAt: observedAt }
    const capture = { ...result, dataset: result.manifest, priorMarkets: [initial] }
    expect(demoMarketAt(capture, 'polymarket', 'simulation:' + result.revision + ':' + conditionId, selection.tradingClosesAt))
      .toMatchObject({ lifecycle: 'closed', tradingAvailability: 'closed' })
  })

  it('settles the remainder after a partial exit and preserves unknown losing-side fees', () => {
    const times = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-08T00:00:00.000Z']
    const evidence = (fee: string | null, unit: string): Evidence[] => {
      const rows: Array<Partial<FinancialObservation>> = [
        { id: 'cash', type: 'opening_cash', instrument: null, amount: '100', timestamp: times[0]! },
        { id: 'inventory', type: 'opening_inventory', instrument: null, timestamp: times[0]! },
        { id: 'buy', type: 'buy', quantity: '10', price: '0.4', fee, timestamp: times[1]! },
        { id: 'mark', type: 'mark', price: '0.5', timestamp: times[1]! },
        { id: 'sell', type: 'sell', quantity: '4', price: '0.5', fee: '0', timestamp: times[2]! },
        { id: 'ex', type: 'settlement', price: unit, timestamp: times[3]!, sequence: 1,
          simulatedResolution: { effect: 'entitlement', timing: 'at_resolution_evidence' } },
        { id: 'receipt', type: 'redemption', entitlementId: 'ex', timestamp: times[3]!, sequence: 2,
          simulatedResolution: { effect: 'payout', timing: 'at_resolution_evidence' } },
      ]
      return rows.map((row, index) => ({ batchId: 'test-demo', row: index, observation: { venue: 'kalshi', account: 'demo',
        asset: 'USD', instrument: 'leg', id: null, timestamp: times[0]!, sequence: null,
        type: 'mark', price: null, quantity: null, amount: null, fee: null, feeAsset: null, ...row } }))
    }
    const winner = replayAccounting(evidence('0', '1'), times[3]!)
    expect(winner.holdings[0]).toMatchObject({ quantity: '0', pending: '0', mark: null, valuationQualification: 'settled_no_open_quantity' })
    expect(winner.cash[0]).toMatchObject({ balance: '104', knownRealized: '4' })
    expect(winner.events.find((row) => row.id === 'receipt')).toMatchObject({ quantity: '6', amount: '6' })
    const loser = replayAccounting(evidence(null, '0'), times[3]!)
    expect(loser.holdings[0]).toMatchObject({ quantity: '0', pending: '0', mark: null })
    expect(loser.cash[0]).toMatchObject({ balance: null, knownDelta: '-2', realized: null })
    expect(loser.events.find((row) => row.id === 'receipt')).toMatchObject({ quantity: '6', amount: '0' })
  })
})

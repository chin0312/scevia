import { describe, expect, it } from 'vitest'
import { replayConfig } from '../src/replay/contracts.js'
import { evaluateReplay, validateReplay } from '../src/replay/engine.js'
import type { ReplayEvidence, ReplayLifecycle } from '../src/replay/evidence.js'

const at = (day: number) => '2025-02-' + String(day).padStart(2, '0') + 'T12:00:00.000Z'
const first = '00000000-0000-4000-8000-000000004001'
const second = '00000000-0000-4000-8000-000000004002'
const last = '00000000-0000-4000-8000-000000004003'
const catalog = (instrumentId: string, nativeMarket: string): ReplayEvidence['catalog'][number] => ({
  instrumentId, nativeMarket, nativeInstrument: nativeMarket + ':yes', nativeOutcomes: [nativeMarket + ':yes', nativeMarket + ':no'],
  marketId: nativeMarket, eventId: nativeMarket + '-event', title: nativeMarket, eventTitle: nativeMarket + '-event',
  provider: 'kalshi', outcome: 'yes', asset: 'USD', marketAsset: 'USD', generation: null, mappedAsset: null,
})
const journal = (marketId: string, opens: number, closes: number, lifecycle = 'open'): ReplayLifecycle => ({
  marketId, revision: marketId, retrievedAt: new Date(at(9)), lifecycle, conflict: false,
  tradingOpensAt: new Date(at(opens)), tradingClosesAt: new Date(at(closes)), resolution: null, expectedResolutionAt: null,
})
const mark = (instrumentId: string, day: number, price: string): ReplayEvidence['quotes'][number] => ({
  instrumentId, price, revision: instrumentId + day, id: instrumentId + day, source: 'fixture', asset: 'USD',
  effectiveAt: new Date(at(day)), observedAt: new Date(at(day)), retrievedAt: new Date(at(9)), method: 'historical_close',
})
const operation = (day: number, price: string) => ({ at: at(day), execution: { mode: 'assumed', price }, fee: { mode: 'zero' } })
const base = { version: 1, from: at(1), through: at(8), currency: 'USD',
  buckets: [{ id: 'usd', venue: 'kalshi', asset: 'USD', capital: '100' }] }
const config = (value: unknown) => {
  const parsed = replayConfig.parse(value)
  return { ...parsed, currency: parsed.currency ?? 'USD' as const }
}

describe('historical hypothetical replay', () => {
  it('aggregates multiple entries and partial exits, and distinguishes pending entitlement from cash', () => {
    const resolution = { ...journal('ALPHA', 1, 5, 'resolved'), resolution: { knownAt: at(6), settlementTime: at(6),
      unitPayout: '1' as const, winningInstrument: 'ALPHA:yes', source: 'kalshi_trade_api' as const } }
    const data: ReplayEvidence = { catalog: [catalog(first, 'ALPHA'), catalog(second, 'BETA')],
      lifecycle: new Map([['ALPHA', [resolution]], ['BETA', [journal('BETA', 4, 11)]]]),
      quotes: [mark(first, 2, '0.4'), mark(first, 3, '0.5'), mark(second, 7, '0.3')] }
    const values = config({ ...base, positions: [
      { id: 'alpha-1', bucket: 'usd', instrumentId: first, entry: { ...operation(2, '0.4'), size: { mode: 'quantity', value: '50' } },
        exits: [{ ...operation(4, '0.6'), quantity: '10' }], remainder: 'settle' },
      { id: 'alpha-2', bucket: 'usd', instrumentId: first, entry: { ...operation(3, '0.5'), size: { mode: 'amount', value: '10' } } },
      { id: 'beta', bucket: 'usd', instrumentId: second, entry: { ...operation(7, '0.2'), size: { mode: 'weight', value: '0.02' } } },
    ] })
    validateReplay(values, at(10))
    const result = evaluateReplay(values, data, [], at(10))
    expect(result.summary).toMatchObject({ ending: '137', investmentGain: '37', cash: [{ balance: '114' }] })
    expect(result.history.at(-1)?.positions).toEqual(expect.arrayContaining([
      expect.objectContaining({ instrument: first, quantity: '0', value: '20' }),
      expect.objectContaining({ instrument: second, quantity: '10', value: '3' }),
    ]))
    expect(result.schedule.filter((row) => row.type === 'redemption')).toMatchObject([{ amount: '40', at: at(6) }])
    expect(result.discrepancies).toHaveLength(0)
    const unsupported = evaluateReplay(values, { ...data, lifecycle: new Map(data.lifecycle).set('ALPHA', [
      { ...resolution, retrievedAt: new Date(at(6)), resolution: null },
    ]) }, [], at(10))
    expect(unsupported.summary.ending).toBeNull()
    expect(unsupported.schedule.some((row) => row.type === 'redemption')).toBe(false)
    expect(unsupported.positions[0]?.status).toBe('unsupported_payout')
  })

  it('uses separate native funding, historical non-parity rates and exact cash-flow boundaries', () => {
    const values = config({ ...base, currency: 'SGD', buckets: [...base.buckets,
      { id: 'pusd', venue: 'polymarket', asset: 'PUSD', capital: '100' }],
    cashFlows: [{ id: 'added', bucket: 'usd', at: at(4), kind: 'deposit', amount: '20' }], positions: [] })
    const rates = Array.from({ length: 8 }, (_, index) => index + 1).flatMap((day) => [
      { base: 'PUSD', quote: 'USD', rate: day < 6 ? '0.8' : '0.9', methodology: 'stablecoin_market_reference' },
      { base: 'USD', quote: 'SGD', rate: '1.25', methodology: 'fiat_reference' },
    ].map((row) => ({ ...row, revision: row.base + day, source: 'fixture', observedAt: new Date(at(day)), retrievedAt: new Date(at(9)) })))
    const data: ReplayEvidence = { catalog: [], lifecycle: new Map(), quotes: [] }
    const result = evaluateReplay(values, data, rates, at(10))
    expect(result.summary).toMatchObject({ starting: '225', ending: '262.5', investmentGain: '12.5', totalReturn: null,
      cash: [{ asset: 'USD', balance: '120' }, { asset: 'PUSD', balance: '100' }] })
    expect(Number(result.summary.twr)).toBeCloseTo(0.05)
    expect(evaluateReplay(values, data, rates.filter((row) => row.base !== 'PUSD'), at(10))).toMatchObject({
      status: 'partial', summary: { ending: null, twr: null },
    })
  })

  it('qualifies unknown fee funding and refuses post-close orders even with assumed prices', () => {
    const data: ReplayEvidence = { catalog: [catalog(last, 'GAMMA')], lifecycle: new Map([['GAMMA', [journal('GAMMA', 1, 4)]]]),
      quotes: [mark(last, 2, '0.5')] }
    const position = { id: 'p', instrumentId: last, bucket: 'usd',
      entry: { ...operation(2, '0.5'), size: { mode: 'quantity', value: '10' }, fee: { mode: 'unknown' } } }
    const unknown = evaluateReplay(config({ ...base, positions: [position] }), data, [], at(10))
    expect(unknown).toMatchObject({ funding: { status: 'unknown' }, summary: { ending: null, twr: null, fees: { reportingValue: null } } })
    expect(() => evaluateReplay(config({ ...base, positions: [{ ...position, entry: { ...position.entry, at: at(4) } }] }), data, [], at(10)))
      .toThrow('replay_operation_outside_trading_window')
    const unfunded = evaluateReplay(config({ ...base, buckets: [{ ...base.buckets[0], capital: '4' }],
      positions: [{ ...position, entry: { ...position.entry, fee: { mode: 'zero' } } }] }), data, [], at(10))
    expect(unfunded).toMatchObject({ status: 'unfunded', funding: { buckets: [{ knownAdditionalCapital: '1' }] },
      summary: { totalReturn: null } })
  })
})

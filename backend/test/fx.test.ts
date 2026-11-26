import { consolidatePerformance } from '../src/fx/consolidated.js'
import { reportAmounts, selectRate } from '../src/fx/reference.js'
import { polygonPusd } from '../src/providers/polymarket/collateral.js'
import { nextEcbRefresh, refreshEcbAnnual } from '../src/fx/ecb.js'
import type { Database } from '../src/db/client.js'
import { describe, expect, it, vi } from 'vitest'
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

  it('uses the previous ECB business-day reference over a weekend without backdating retrieval', () => {
    const weekend = '2026-11-22T00:00:00.000Z'
    const friday = { revision: 'friday', base: 'EUR', quote: 'GBP', rate: '0.83735', source: 'ecb_euro_reference',
      methodology: 'fiat_reference', observedAt: new Date('2026-11-20T00:00:00.000Z'),
      retrievedAt: new Date('2026-11-26T03:00:00.000Z') }
    const monday = { ...friday, revision: 'monday', rate: '0.84', observedAt: new Date('2026-11-23T00:00:00.000Z') }
    expect(selectRate([monday, friday], 'EUR', 'GBP', weekend, { mode: 'retrospective' })).toMatchObject({
      rate: '0.83735', legs: [{ revision: 'friday', retrievedAt: '2026-11-26T03:00:00.000Z' }],
    })
    expect(selectRate([monday, friday], 'EUR', 'GBP', weekend, { mode: 'knowledge' }).rate).toBeNull()
  })

  it('prefers an eligible daily pUSD reference over a newer stale current observation', () => {
    const asOf = '2026-01-02T12:00:00.000Z'
    const common = { base: 'PUSD', quote: 'USD', methodology: 'stablecoin_market_reference',
      tokenIdentity: { chain: 'polygon-pos', contract: polygonPusd, quoteBasis: 'vendor_aggregated_fiat_usd' } }
    const daily = { ...common, revision: 'daily', source: 'coingecko_polygon_pusd_usd_daily', rate: '0.98',
      observedAt: new Date('2026-01-02T00:00:00Z'), retrievedAt: new Date('2026-01-02T01:00:00Z') }
    const current = { ...common, revision: 'current', source: 'coingecko_polygon_pusd_usd', rate: '0.99',
      observedAt: new Date('2026-01-02T04:00:00Z'), retrievedAt: new Date('2026-01-02T04:05:00Z') }
    expect(selectRate([current, daily], 'PUSD', 'USD', asOf, { stablecoinSource: current.source })).toMatchObject({
      rate: '0.98', fallback: false, legs: [{ source: daily.source }],
      lastKnown: { rate: '0.99', source: current.source, qualification: 'stale_reference_only' },
    })
    expect(selectRate([current, daily], 'PUSD', 'USD', asOf, { stablecoinSource: 'kraken_usdc_usd_ohlc' })).toMatchObject({
      rate: '0.98', fallback: true,
    })
    expect(selectRate([current, daily, { ...current, rate: '1.1', revision: 'conflict' }], 'PUSD', 'USD', asOf)).toMatchObject({
      availability: 'conflict', rate: null,
    })
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
    const withoutOpeningFx = consolidatePerformance(funded, [
      { ...rates[0]!, observedAt: new Date(deposited) }, rates[1]!,
    ], ['USD', 'USDC'], 'USD', opened, through, 'retrospective')
    expect(withoutOpeningFx.opening).toMatchObject({ completeValue: '100', fxCoverage: 'eligible' })
    expect(Number(withoutOpeningFx.twr)).toBeCloseTo(-4 / 140)

    const exit = { ...stablecoinDeposit, observation: { ...stablecoinDeposit.observation, id: 'stablecoin withdrawal',
      type: 'withdrawal' as const, amount: '100' } }
    const exited = consolidatePerformance([...evidence, exit], rates.slice(0, 1), ['USD', 'USDC'], 'USD', opened, through, 'retrospective')
    expect(exited.ending).toMatchObject({ completeValue: '120', twr: '0',
      components: expect.arrayContaining([{ asset: 'USDC', value: '0', reportingValue: '0',
        reference: expect.objectContaining({ rate: null }) }]) })
    const unknown = reportAmounts([], [{ asset: 'USD', value: '100' }, { asset: 'USDC', value: null }, { asset: 'PUSD', value: '0' }], 'USD', opened)
    expect(unknown).toMatchObject({ completeValue: null, knownSubtotal: '100', components: [
      { reportingValue: '100' }, { reportingValue: null }, { reportingValue: '0' },
    ] })
    const incomplete = funded.filter((row) => row.observation.asset !== 'USDC' || row.observation.type !== 'opening_inventory')
    expect(consolidatePerformance(incomplete, rates, ['USD', 'USDC'], 'USD', opened, through, 'retrospective').twr).toBeNull()
  })

})

describe('ECB acquisition', () => {
  it('stores bounded annual exact-series rates and rejects a mismatched series', async () => {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const header = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE'
    const observation = 'EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,' + day + ',0.83'
    const values = vi.fn(() => ({ onConflictDoNothing: vi.fn() }))
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Pick<Database, 'insert'>
    const transport = vi.fn(async () => new Response(header + '\r\n' + observation))
    await refreshEcbAnnual(db, new AbortController().signal, transport)
    expect(transport).toHaveBeenCalledWith(expect.stringContaining('D.USD+GBP.EUR.SP00.A?startPeriod='), expect.anything())
    expect(values).toHaveBeenCalledWith([expect.objectContaining({ base: 'EUR', quote: 'GBP', rate: '0.83',
      observedAt: new Date(day), source: 'ecb_euro_reference' })])
    await expect(refreshEcbAnnual(db, new AbortController().signal,
      async () => new Response(header + '\n' + observation.replace(',GBP,', ',USD,')))).rejects.toThrow('ecb_annual_observation')
    expect(values).toHaveBeenCalledTimes(1)
  })

  it('schedules the next post-publication weekday check', () => {
    expect(nextEcbRefresh(new Date('2026-11-20T15:30:00Z'))).toBe(Date.parse('2026-11-20T16:00:00Z'))
    expect(nextEcbRefresh(new Date('2026-11-20T16:30:00Z'))).toBe(Date.parse('2026-11-23T16:00:00Z'))
  })
})

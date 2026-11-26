import { describe, expect, it } from 'vitest'
import { comparisonEvidenceQualifications, freezeReplay, presentReplay, replaySnapshot } from '../src/replay/result.js'
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

  it('separates delayed cash, pending and zero payouts, and reviews acquired disputes retrospectively', () => {
    const known = { ...journal('ALPHA', 1, 5), retrievedAt: new Date(at(1)) }
    const resolution = { ...journal('ALPHA', 1, 5, 'resolved'), retrievedAt: new Date(at(5)), resolution: {
      knownAt: at(5), settlementTime: at(5), unitPayout: '1' as const, winningInstrument: 'ALPHA:yes', source: 'kalshi_trade_api' as const,
    } }
    const data: ReplayEvidence = { catalog: [catalog(first, 'ALPHA'), catalog(second, 'BETA')],
      lifecycle: new Map([['ALPHA', [known, resolution]], ['BETA', [journal('BETA', 1, 12)]]]),
      quotes: [mark(first, 2, '0.4'), mark(second, 6, '0.5')] }
    const firstTrade = { id: 'alpha', bucket: 'usd', instrumentId: first,
      entry: { ...operation(2, '0.4'), size: { mode: 'quantity', value: '50' } }, remainder: 'settle' }
    const secondTrade = { id: 'beta', bucket: 'usd', instrumentId: second,
      entry: { ...operation(6, '0.5'), size: { mode: 'quantity', value: '30' } } }
    const small = { ...base, buckets: [{ ...base.buckets[0], capital: '30' }] }
    const delayed = evaluateReplay(config({ ...small, positions: [secondTrade,
      { ...firstTrade, redemption: { mode: 'delay', seconds: 172800 } },
    ] }), data, [], at(10))
    expect(delayed.funding).toMatchObject({ status: 'unfunded', buckets: [{ closingCash: '45',
      shortfalls: [{ at: at(6), required: '5' }] }] })
    expect(delayed.history.find((row) => row.asOf === at(5))?.positions).toMatchObject([{ value: '50', quantity: '0' }])
    expect(delayed.schedule.find((row) => row.type === 'redemption')).toMatchObject({ at: at(7), amount: '50' })
    const immediate = evaluateReplay(config({ ...small, positions: [firstTrade, secondTrade] }), data, [], at(10))
    expect(immediate.funding.status).toBe('funded')
    const pending = evaluateReplay(config({ ...small, positions: [{ ...firstTrade, redemption: { mode: 'at', at: at(9) } }] }), data, [], at(10))
    expect(pending.summary).toMatchObject({ ending: '60', cash: [{ balance: '10' }] })
    expect(pending.positions[0]).toMatchObject({ redemption: { hypotheticalRedemptionAt: at(9), hypotheticalCashAvailableAt: null } })
    const lost = evaluateReplay(config({ ...small, positions: [firstTrade] }), { ...data, lifecycle: new Map([
      ['ALPHA', [known, { ...resolution, resolution: { ...resolution.resolution, winningInstrument: 'ALPHA:no' } }]],
    ]) }, [], at(10))
    expect(lost.summary.ending).toBe('10')
    expect(lost.schedule.find((row) => row.type === 'redemption')?.amount).toBe('0')

    const dispute = { ...journal('ALPHA', 1, 5, 'disputed'), revision: 'dispute', retrievedAt: new Date(at(9)) }
    const disputed = { ...data, lifecycle: new Map(data.lifecycle).set('ALPHA', [known, resolution, dispute]) }
    const retrospective = evaluateReplay(config({ ...small, positions: [firstTrade] }), disputed, [], at(10))
    expect(retrospective.positions[0]?.status).toBe('conflicting_payout_evidence')
    expect(retrospective.summary.ending).toBeNull()
    expect(retrospective.schedule.some((row) => row.type === 'settlement')).toBe(false)
    const knowledge = evaluateReplay(config({ ...small, mode: 'knowledge', through: at(10), positions: [firstTrade] }), disputed, [], at(11))
    expect(knowledge.history.find((row) => row.asOf === at(5))?.completeValue).toBe('60')
    expect(knowledge.history.find((row) => row.asOf === at(9))?.completeValue).toBeNull()
  })

  it('preserves earlier window bounds, labels first-day dates and makes same-time funding independent of input order', () => {
    const market = catalog(first, 'ALPHA')
    const known = { ...journal('ALPHA', 1, 5), tradingOpensAt: new Date('2025-02-01T00:00:00Z') }
    const later = { ...known, revision: 'later', retrievedAt: new Date(at(10)), tradingOpensAt: null, tradingClosesAt: null }
    const data: ReplayEvidence = { catalog: [market], lifecycle: new Map([['ALPHA', [known, later]]]),
      quotes: [mark(first, 1, '0.5'), mark(first, 2, '0.5')] }
    const early = { id: 'a', bucket: 'usd', instrumentId: first, entry: { ...operation(1, '0.5'), at: '2025-02-01',
      execution: { mode: 'reference', maxAgeSeconds: 43200 }, size: { mode: 'quantity', value: '10' } },
      exits: [{ ...operation(2, '0.5'), quantity: '10' }] }
    const next = { id: 'b', bucket: 'usd', instrumentId: first, entry: { ...operation(2, '0.5'), size: { mode: 'quantity', value: '10' } } }
    const small = { ...base, from: '2025-02-01T00:00:00Z', buckets: [{ ...base.buckets[0], capital: '5' }] }
    const values = config({ ...small, positions: [next, early] })
    validateReplay(values, at(11))
    const result = evaluateReplay(values, data, [], at(11))
    expect(result.positions.find((row) => row.id === 'a')).toMatchObject({ operations: [{
      timing: 'hypothetical_utc_day_end', basis: 'prior_historical_reference', window: { status: 'verified' },
    }, { type: 'sell' }] })
    expect(result.funding.status).toBe('funded')
    expect(result.schedule.filter((row) => row.at === at(2)).map((row) => row.type)).toEqual(['sell', 'buy'])
    expect(evaluateReplay(config({ ...small, positions: [early, next] }), data, [], at(11)).schedule).toEqual(result.schedule)
  })

  it('marks missing requested entries and partial exits throughout the portfolio contract', () => {
    const data: ReplayEvidence = { catalog: [catalog(first, 'ALPHA'), catalog(second, 'BETA')],
      lifecycle: new Map([['ALPHA', [journal('ALPHA', 1, 10)]], ['BETA', [journal('BETA', 1, 10)]]]),
      quotes: [mark(first, 2, '0.5')] }
    const position = { id: 'good', bucket: 'usd', instrumentId: first, entry: { ...operation(2, '0.5'), size: { mode: 'quantity', value: '10' } } }
    const missing = { ...position, id: 'unknown', bucket: 'other', instrumentId: second,
      entry: { ...position.entry, execution: { mode: 'reference' } } }
    const partial = evaluateReplay(config({ ...base, buckets: [...base.buckets, { ...base.buckets[0], id: 'other' }],
      positions: [position, missing] }), data, [], at(11))
    expect(partial).toMatchObject({ status: 'partial', summary: { starting: '200', ending: null, knownSubtotal: '100',
      realized: expect.arrayContaining([expect.objectContaining({ bucket: 'other', value: null })]) },
      native: [{ ending: { value: null, knownValue: '100' }, returns: null }], risk: { coverage: 'known_components_only' },
      completeness: { requestedOperationsComplete: false, missingOperations: [{ operation: 'entry:unknown' }] } })
    const incompleteExit = evaluateReplay(config({ ...base, positions: [{ ...position,
      exits: [{ ...operation(4, '0.6'), quantity: '5', execution: { mode: 'reference' } }],
    }] }), data, [], at(11))
    expect(incompleteExit).toMatchObject({ positions: [{ status: 'missing_exit_evidence' }],
      attribution: [{ remainingInventory: null, acquisitionCost: { known: '5', value: null } }],
      summary: { ending: null, fees: { reportingValue: null } } })
    const zero = evaluateReplay(config({ ...base, buckets: [...base.buckets, { id: 'zero', venue: 'polymarket', asset: 'PUSD', capital: '0' }],
      positions: [] }), data, [], at(11))
    expect(zero.summary).toMatchObject({ ending: '100', twr: '0' })
    const ambiguous = { ...data, quotes: [...data.quotes, { ...mark(first, 2, '0.6'), revision: 'conflicting-mark' }] }
    const conflicted = evaluateReplay(config({ ...base, positions: [position] }), ambiguous, [], at(11))
    expect(conflicted.discrepancies.some((row) => row.reason === 'same_time_marks_conflict')).toBe(true)
    expect(conflicted.summary).toMatchObject({ ending: null, twr: null })
    expect(() => evaluateReplay(config({ ...base, buckets: [{ id: 'usd', venue: 'polymarket', asset: 'PUSD', capital: '100' }],
      positions: [position] }), data, [], at(11))).toThrow('incompatible_replay_instrument')

  })

  it('retains source age and market coverage in compact, frozen and compared valuations', () => {
    const listing = { ...journal('ALPHA', 1, 11), retrievedAt: new Date(at(1)) }
    const data: ReplayEvidence = { catalog: [catalog(first, 'ALPHA')], lifecycle: new Map([['ALPHA', [listing]]]),
      quotes: [{ ...mark(first, 2, '0.6'), retrievedAt: new Date(at(5)) }] }
    const configuration = config({ ...base, mode: 'knowledge', positions: [{ id: 'a', bucket: 'usd', instrumentId: first,
      entry: { ...operation(5, '0.5'), size: { mode: 'quantity', value: '20' } },
    }] })
    const frozen = freezeReplay(evaluateReplay(configuration, data, [], at(11)))
    const summary = presentReplay(frozen, false).summary
    expect(summary).toMatchObject({ ending: '102', twr: '0.02', performanceQuality: {
      twr: 'stale_reference_estimate', sampledDrawdown: 'stale_reference_estimate',
    } })
    const compact = presentReplay(frozen, false).history.find((row) => row.asOf === at(5))!
    expect(compact.referenceQuality).toMatchObject({ valuationQuality: 'stale_reference_estimate', oldestObservationAt: at(2),
      staleReferenceCount: 1, observedReferenceCount: 0, marketPriceCoverage: 'covered' })
    expect(presentReplay(frozen, true).history.find((row) => row.asOf === at(5))).toMatchObject(compact)
    expect(replaySnapshot(frozen, at(5))).toMatchObject(compact)
    const another = freezeReplay(evaluateReplay(configuration, { ...data, quotes: [{ ...data.quotes[0]!,
      source: 'another', method: 'historical_sample', revision: 'different-method' }] }, [], at(11)))
    expect(comparisonEvidenceQualifications([frozen, another], [at(5)])).toMatchObject({ marketSourcePoints: 1, coveragePoints: 0 })
    const sample = frozen.history.find(({ asOf }) => asOf === at(5))!
    const qualified = { ...frozen, history: [{ ...sample, referenceQuality: { ...sample.referenceQuality!,
      staleReferenceCount: 0, carriedForwardReferenceCount: 1, unknownObservationAgeCount: 1,
    } }] }
    const { referenceQuality: _omitted, ...legacyPoint } = sample
    expect(comparisonEvidenceQualifications([frozen, qualified, { ...frozen, history: [legacyPoint] }], [at(5)])).toMatchObject({
      carriedForwardDifferencePoints: 1, staleDifferencePoints: 1, unknownAgeDifferencePoints: 1, missingReferenceQualityPoints: 1,
    })
    expect(presentReplay({ ...frozen, history: [legacyPoint] }, false).history[0]?.referenceQuality).toBeNull()


    const retrospective = { ...configuration, mode: 'retrospective' as const, positions: configuration.positions.map((row) => ({
      ...row, entry: { ...row.entry, at: at(2) },
    })) }
    const recent = freezeReplay(evaluateReplay(retrospective, data, [], at(11)))
    expect(recent.history.find((row) => row.asOf === at(2))?.referenceQuality?.valuationQuality).toBe('observed_references')
    expect(recent.history.find((row) => row.asOf === '2025-02-02T23:59:59.999Z')?.referenceQuality?.valuationQuality).toBe('carry_forward_reference_estimate')
    const missing = freezeReplay(evaluateReplay(retrospective, { ...data, quotes: [] }, [], at(11)))
    expect(missing.history.at(-1)).toMatchObject({ completeValue: null, knownComponentsSubtotal: '90',
      referenceQuality: { marketPriceCoverage: 'missing', missingReferenceCount: 1 } })
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
      cash: expect.arrayContaining([expect.objectContaining({ asset: 'USD', balance: '120' }),
        expect.objectContaining({ asset: 'PUSD', balance: '100' })]) })
    expect(Number(result.summary.twr)).toBeCloseTo(0.05)
    const frozen = freezeReplay(result)
    const roundTrip = JSON.parse(JSON.stringify(frozen)) as typeof frozen
    const chart = presentReplay(roundTrip, false).history.at(-1)!
    expect(chart.completeValue).toBe('262.5')
    expect(presentReplay(roundTrip, true).history.at(-1)).toMatchObject(chart)
    expect(replaySnapshot(roundTrip, at(8))).toMatchObject({ ...chart, fx: expect.arrayContaining([
      expect.objectContaining({ asset: 'PUSD', rate: '1.125', legs: [
        expect.objectContaining({ revision: 'PUSD8', rate: '0.9' }),
        expect.objectContaining({ revision: 'USD8', rate: '1.25' }),
      ] }),
    ]) })
    const replacement = rates.map((row) => row.base === 'USD' ? { ...row, source: 'alternative',
      revision: row.revision + '-fallback' } : row)
    const preferred = freezeReplay(evaluateReplay(values, data, rates.map((row) => row.base === 'USD' ? { ...row, source: 'ecb_euro_reference' } : row),
      at(10), { fiatSource: 'ecb_euro_reference' }))
    const alternate = freezeReplay(evaluateReplay(values, data, replacement, at(10), { fiatSource: 'ecb_euro_reference' }))
    expect(comparisonEvidenceQualifications([preferred, alternate], [at(8)])).toMatchObject({ fxSourcePoints: 1, fallbackPoints: 1 })
    expect(comparisonEvidenceQualifications([alternate, freezeReplay(evaluateReplay(values, data, [], at(10)))], [at(8)]).coveragePoints).toBe(1)
    const legacy = { ...roundTrip, history: roundTrip.history.map(({ referenceQuality: _quality, ...row }) => row) }
    expect(presentReplay(legacy, false).history.at(-1)).toMatchObject({ completeValue: '262.5', referenceQuality: null })

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

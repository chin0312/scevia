import { selectPublicOutcome } from '../src/scenarios/public-market.js'
import { describe, expect, it } from 'vitest'
import { evaluate, methodology, scopedReference, type ScenarioBaseline, type ScenarioInput } from '../src/scenarios/engine.js'

const starting = (cash = '100'): ScenarioBaseline => ({
  methodology, asset: 'USD', mode: 'scratch', asOf: '2026-01-01T00:00:00.000Z',
  buckets: [{ id: 'a', venue: 'fixture', account: 'a', cash, pending: '0' }],
  instruments: [{ id: 'yes', mark: '0.6' }, { id: 'no', mark: '0.4' }, { id: 'new', mark: '0.3' }],
  holdings: [], rules: [], constraints: [], revisions: {},
})
const empty: ScenarioInput = { operations: [], funding: [], marks: [], rules: [], constraints: [], outcomes: [] }

describe('scenario financial references', () => {
  it('rounds one supported fractional Kalshi execution to a centicent', () => {
    const baseline = starting()
    baseline.instruments[0]!.feeSchedule = { version: 'kalshi-centicent-quadratic-v1', rate: '0.07', makerRate: '0.0175',
      source: 'kalshi_event_override', retrievedAt: baseline.asOf, denomination: 'USD' }
    const operation = { instrument: 'yes', bucket: 'a', kind: 'buy' as const, amount: '2.75', price: '0.43' }
    expect(evaluate(baseline, { ...empty, operations: [{ ...operation, fee: { mode: 'provider', role: 'taker' } }] }).operations[0]?.feeAmount).toBe('0.0472')
    expect(evaluate(baseline, { ...empty, operations: [{ ...operation, fee: { mode: 'provider', role: 'maker' } }] }).operations[0]?.feeAmount).toBe('0.0118')
  })

  it('reconciles the 98.30 value bridge using weighted average basis', () => {
    const baseline = starting('40')
    baseline.mode = 'actual'
    baseline.holdings = [{ instrument: 'yes', bucket: 'a', quantity: '100', basis: '40' }]
    const result = evaluate(baseline, { ...empty, operations: [
      { instrument: 'yes', bucket: 'a', kind: 'sell', amount: '40', price: '0.55', fee: { mode: 'fixed', value: '0.5' } },
      { instrument: 'new', bucket: 'a', kind: 'buy', amount: '20', price: '0.25', fee: { mode: 'fixed', value: '0.2' } },
    ] })
    expect(result.bridge).toMatchObject({ startingValue: '100', endingValue: '98.3', executionEffect: '-1', fees: '-0.7', unexplained: '0' })
    expect(result.funding[0]).toMatchObject({ endingCash: '56.3' })
    expect(result.operations).toMatchObject([{ remainingBasis: '24', netProceeds: '21.5', realized: '5.5' }, { remainingBasis: '5.2' }])
    expect(result.positions).toMatchObject([{ initialBasis: '40', initialValue: '60', quantity: '60', value: '36' }, { initialBasis: '0', initialValue: '0', quantity: '20', value: '6' }])
    expect(baseline.holdings[0]!.quantity).toBe('100')
  })

  it('shows scratch construction fees and separate account shortfalls', () => {
    const buy = { instrument: 'yes', bucket: 'a', kind: 'buy' as const, amount: '100', price: '0.6', fee: { mode: 'fixed' as const, value: '1' } }
    const scratch = evaluate(starting(), { ...empty, operations: [buy] })
    expect(scratch).toMatchObject({ bridge: { endingValue: '99' }, funding: [{ endingCash: '39' }], positions: [{ basis: '61', value: '60' }] })
    const short = evaluate(starting(), { ...empty, operations: [{ ...buy, amount: '200', fee: { mode: 'fixed', value: '2' } }] })
    expect(short).toMatchObject({ status: 'underfunded', additionalCapitalRequired: '22', bridge: { normalizedChange: null } })
    const baseline = starting()
    baseline.buckets.push({ id: 'b', venue: 'fixture', account: 'b', cash: '10', pending: '0' })
    const separate = evaluate(baseline, { ...empty, operations: [{ ...buy, amount: '50', bucket: 'b', fee: { mode: 'excluded' } }] })
    expect(separate.funding).toMatchObject([{ endingCash: '100', shortfall: '0' }, { endingCash: '-20', shortfall: '20' }])
  })

  it('models existing local holdings conditionally without overriding reviewed rules', () => {
    const baseline = starting('40')
    baseline.mode = 'actual'
    baseline.instruments = [{ id: 'holding:yes', mark: '0.6' }, { id: 'holding:no', mark: '0.4' }]
    baseline.holdings = [{ bucket: 'a', instrument: 'holding:yes', quantity: '100', basis: '40' }]
    const rules = [{ id: 'declared', yes: 'holding:yes', no: 'holding:no', asset: 'USD', unitPayout: '1' }]
    const result = evaluate(baseline, { ...empty, rules })
    expect(result.settlement.verified).toMatchObject({ result: { status: 'unavailable' }, unsupported: [expect.any(String)] })
    expect(result.settlement.conditional).toMatchObject({ authority: 'scenario_assumptions', result: { best: { payout: '100' }, worst: { payout: '0' } } })
    baseline.rules = [{ ...rules[0]!, id: 'verified' }]
    expect(() => evaluate(baseline, { ...empty, rules })).toThrow('reviewed_payout_cannot_be_overridden')
    expect(baseline.rules[0]?.id).toBe('verified')
  })

  it('keeps known funding requirements when another account has unknown inventory and cash', () => {
    const baseline = starting('500')
    baseline.mode = 'actual'
    baseline.buckets.push({ id: 'unknown', venue: 'fixture', account: 'unknown', cash: null, pending: null, inventoryComplete: false })
    const operation = { bucket: 'hypothetical:b', instrument: 'yes', kind: 'buy' as const, amount: '1700',
      price: '0.6', fee: { mode: 'excluded' as const } }
    const result = evaluate(baseline, { ...empty, operations: [operation],
      hypotheticalBuckets: [{ id: 'hypothetical:b', venue: 'fixture', asset: 'USD', account: 'b', startingCapital: '1000' }] })
    expect(result).toMatchObject({ knownAdditionalCapitalRequired: '20', additionalCapitalRequired: null,
      availability: { funding: 'partial', underfunded: true, quantities: 'partial', valuation: 'partial' },
      funding: [{ endingCash: '500' }, { endingCash: null }, { hypotheticalStartingCapital: '1000', additionalCapital: '0', shortfall: '20' }] })
    expect(() => evaluate(baseline, { ...empty, operations: [{ ...operation, bucket: 'unknown' }] })).toThrow('inventory_unavailable')
    expect(baseline.buckets).toHaveLength(2)
  })

  it('withholds cross-account reference marks when eligible observations differ', () => {
    const observations = [{ scope: 'a', price: '0.6', asOf: '2026-01-01T01:00:00Z' },
      { scope: 'b', price: '0.7', asOf: '2026-01-01T02:00:00Z' }]
    expect(scopedReference(observations)).toBeNull()
    expect(scopedReference([{ ...observations[0]! }, { ...observations[1]!, price: '0.60' }]))
      .toMatchObject({ mark: '0.6', referenceScopes: ['a', 'b'], markAt: '2026-01-01T01:00:00Z' })
  })

  it('validates provider venue, closed execution, payout bounds and allocation identities', () => {
    const baseline = starting()
    baseline.instruments[0] = { id: 'yes', mark: '0.6', provider: 'polymarket', venue: 'polymarket', lifecycle: 'closed',
      market: 'market', event: 'event', resolvesAt: '2026-01-05T00:00:00Z' }
    const op = { bucket: 'a', instrument: 'yes', kind: 'buy' as const, amount: '100', price: '0.6', fee: { mode: 'excluded' as const } }
    expect(() => evaluate(baseline, { ...empty, operations: [op] })).toThrow('instrument_venue_mismatch')
    baseline.buckets[0]!.venue = 'polymarket'
    expect(() => evaluate(baseline, { ...empty, operations: [op] })).toThrow('instrument_not_open')
    expect(() => evaluate(baseline, { ...empty, operations: [{ ...op, abstract: true, price: '1.01' }] })).toThrow('execution_price_exceeds_payout')
    const result = evaluate(baseline, { ...empty, operations: [{ ...op, abstract: true }] })
    expect(result.operations[0]).toMatchObject({ executionApplicability: 'abstract' })
    expect(result.allocation.after).toMatchObject({
      cashInclusiveEvent: { denominator: '100', rows: expect.arrayContaining([{ id: 'event', kind: 'identified', value: '60', weight: '0.6' }]) },
      acquisitionBasisRows: { denominator: '60', rows: [{ id: '["a","yes"]', value: '60', weight: '1' }] },
      resolutionExposure: [{ id: 'next_7_days', positions: 1, knownValue: '60' }],
    })
  })

  it('reports confirmed cash-only exposure and preserves incomplete inventory', () => {
    const baseline = starting('40')
    baseline.mode = 'actual'
    baseline.buckets[0]!.inventoryComplete = true
    baseline.buckets[0]!.pending = '5'
    baseline.holdings = [{ bucket: 'a', instrument: 'yes', quantity: '100', basis: '40' }]
    const input = { ...empty, operations: [{ bucket: 'a', instrument: 'yes', kind: 'exit' as const,
      price: '0.55', fee: { mode: 'excluded' as const } }] }
    expect(evaluate(baseline, input).settlement.verified).toMatchObject({ coverage: 'confirmed_no_open_exposure',
      result: { status: 'no_open_exposure', grossPayout: '0' }, cashInclusive: { best: '100', worst: '100' } })
    baseline.buckets[0]!.inventoryComplete = false
    expect(evaluate(baseline, input).settlement.verified).toMatchObject({ result: { status: 'unavailable' }, cashInclusive: null })
  })

  it('preserves established units and labels abstract payouts and incompatible marks', () => {
    const baseline = starting()
    const declaration = { id: 'scenario:opposing', yes: 'yes', no: 'no', unitPayout: '2' }
    baseline.instruments[0]!.provider = 'polymarket'
    baseline.instruments[1]!.provider = 'polymarket'
    expect(() => evaluate(baseline, { ...empty, rules: [declaration] })).toThrow('conditional_payout_unit_mismatch')
    expect(evaluate(baseline, { ...empty, rules: [{ ...declaration, unitPayout: '1' }] }).settlement.conditional.declaredPayouts)
      .toMatchObject([{ authority: 'conditional_established_unit', unitPayout: '1' }])
    baseline.instruments = [{ id: 'yes', mark: '0.6' }, { id: 'no', mark: '0.4' }]
    baseline.holdings = [{ instrument: 'yes', bucket: 'a', quantity: '10', basis: '6' }]
    expect(evaluate(baseline, { ...empty, rules: [declaration] }).settlement.conditional)
      .toMatchObject({ declaredPayouts: [{ authority: 'conditional_abstract_unit' }], result: { best: { payout: '20' } } })
    expect(() => evaluate(baseline, { ...empty, rules: [{ ...declaration, unitPayout: '0.5' }] }))
      .toThrow('reference_price_exceeds_payout')
  })

  it('uses a common sizing budget and preserves unknown fees', () => {
    const result = evaluate(starting(), { ...empty, operations: [
      { instrument: 'yes', bucket: 'a', kind: 'target_weight', amount: '0.3', price: '0.6', fee: { mode: 'excluded' } },
      { instrument: 'no', bucket: 'a', kind: 'target_weight', amount: '0.2', price: '0.4', fee: { mode: 'unavailable' } },
    ] })
    expect(result).toMatchObject({ weightBudget: '100', status: 'partial', operations: [{ proposedQuantity: '50' }, { proposedQuantity: '50' }],
      funding: [{ endingCash: null, purchases: '50', fees: null }] })
  })

  it('reports added and withdrawn capital separately from investment effects', () => {
    const result = evaluate(starting(), { ...empty, funding: [{ bucket: 'a', added: '20', withdrawn: '30' }] })
    expect(result).toMatchObject({ funding: [{ endingCash: '90' }], bridge: { startingValue: '100', endingValue: '90',
      addedCapital: '20', withdrawnCapital: '30', unexplained: '0', normalizedChange: '0' } })
  })

  it('freezes the explicit provider outcome and rounds supported taker fees', () => {
    const asOf = '2026-01-04T00:00:00.000Z'
    const quoted = selectPublicOutcome({ item: { eventId: 'event', markets: [{
      providerMarketId: 'fixture', conditionId: 'm', lifecycle: 'open', endDate: null,
      feeMetadata: { status: 'known', source: 'gamma_market', retrievedAt: asOf,
        rate: '0.05', exponent: 1, takerOnly: true, amountUnit: 'USDC' },
      outcomes: [{ assetId: '101', assetIdType: 'clob_token_id', name: 'Yes',
        referencePrice: { value: '0.6', retrievedAt: asOf, freshness: 'retrieved_now_source_time_unavailable' } },
      { assetId: '102', assetIdType: 'clob_token_id', name: 'No' }],
    }] } }, { url: 'https://polymarket.com/market/fixture', assetIdType: 'clob_token_id', assetId: '101' }, 'USDC', asOf)
    const baseline = { ...starting(), asset: 'USDC', buckets: [{ ...starting().buckets[0]!, venue: 'polymarket' }],
      instruments: [quoted] }
    const operations = [{ instrument: quoted.id, bucket: 'a', kind: 'buy' as const, amount: '1.2345', price: '0.6',
      fee: { mode: 'provider' as const, role: 'taker' as const } }]
    const preview = evaluate(baseline, { ...empty, operations })
    expect(preview.operations[0]).toMatchObject({ feeAmount: '0.01481', feeStatus: 'provider' })
    expect(evaluate(baseline, { ...empty, operations: [{ ...operations[0]!, fee: { mode: 'provider', role: 'maker' } }] })
      .operations[0]).toMatchObject({ feeAmount: '0' })
  })

  it('uses reviewed binary outcomes and keeps fixed selections conditional', () => {
    const baseline = starting()
    baseline.holdings = [{ instrument: 'yes', bucket: 'a', quantity: '100', basis: '60' }, { instrument: 'no', bucket: 'a', quantity: '80', basis: '32' }]
    baseline.rules = [{ id: 'market', yes: 'yes', no: 'no', asset: 'USD' }]
    const result = evaluate(baseline, { ...empty, operations: [
      { instrument: 'no', bucket: 'a', kind: 'buy', amount: '20', price: '0.4', fee: { mode: 'excluded' } },
    ], outcomes: [{ group: 'market', winner: 'no' }] })
    expect(result.settlement.before.result).toMatchObject({ reference: '92', worst: { payout: '80' }, best: { payout: '100' }, downside: '12' })
    expect(result.settlement.verified.result).toMatchObject({ feasibleCountExact: '2', best: { payout: '100' }, worst: { payout: '100' } })
    expect(result.settlement.conditional.result).toMatchObject({ feasibleCountExact: '1' })
  })
})

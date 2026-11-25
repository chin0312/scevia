import { selectPublicOutcome } from '../src/scenarios/public-market.js'
import { describe, expect, it } from 'vitest'
import { evaluate, methodology, type ScenarioBaseline, type ScenarioInput } from '../src/scenarios/engine.js'

const starting = (cash = '100'): ScenarioBaseline => ({
  methodology, asset: 'USD', mode: 'scratch', asOf: '2026-01-01T00:00:00.000Z',
  buckets: [{ id: 'a', venue: 'fixture', account: 'a', cash, pending: '0' }],
  instruments: [{ id: 'yes', mark: '0.6' }, { id: 'no', mark: '0.4' }, { id: 'new', mark: '0.3' }],
  holdings: [], rules: [], constraints: [], revisions: {},
})
const empty: ScenarioInput = { operations: [], funding: [], marks: [], rules: [], constraints: [], outcomes: [] }

describe('scenario financial references', () => {
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
    expect(result.positions).toMatchObject([{ quantity: '60', value: '36' }, { quantity: '20', value: '6' }])
    expect(baseline.holdings[0]!.quantity).toBe('100')
  })

  it('shows scratch construction fees and separate account shortfalls', () => {
    const buy = { instrument: 'yes', bucket: 'a', kind: 'buy' as const, amount: '100', price: '0.6', fee: { mode: 'fixed' as const, value: '1' } }
    const scratch = evaluate(starting(), { ...empty, operations: [buy] })
    expect(scratch).toMatchObject({ bridge: { endingValue: '99' }, funding: [{ endingCash: '39' }], positions: [{ basis: '61', value: '60' }] })
    const short = evaluate(starting(), { ...empty, operations: [{ ...buy, amount: '200', fee: { mode: 'fixed', value: '2' } }] })
    expect(short).toMatchObject({ status: 'underfunded', additionalCapitalRequired: '22' })
    const baseline = starting()
    baseline.buckets.push({ id: 'b', venue: 'fixture', account: 'b', cash: '10', pending: '0' })
    const separate = evaluate(baseline, { ...empty, operations: [{ ...buy, amount: '50', bucket: 'b', fee: { mode: 'excluded' } }] })
    expect(separate.funding).toMatchObject([{ endingCash: '100', shortfall: '0' }, { endingCash: '-20', shortfall: '20' }])
  })

  it('uses a common sizing budget and preserves unknown fees', () => {
    const result = evaluate(starting(), { ...empty, operations: [
      { instrument: 'yes', bucket: 'a', kind: 'target_weight', amount: '0.3', price: '0.6', fee: { mode: 'excluded' } },
      { instrument: 'no', bucket: 'a', kind: 'target_weight', amount: '0.2', price: '0.4', fee: { mode: 'unavailable' } },
    ] })
    expect(result).toMatchObject({ weightBudget: '100', status: 'partial', operations: [{ proposedQuantity: '50' }, { proposedQuantity: '50' }],
      funding: [{ endingCash: null, purchases: '50', fees: null }] })
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

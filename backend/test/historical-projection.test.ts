import { describe, expect, it } from 'vitest'
import { prepareHistoricalProjection } from '../src/accounting/historical-projection.js'
import { replayAccounting } from '../src/accounting/ledger.js'
import type { Evidence, FinancialObservation } from '../src/accounting/model.js'

const at = (day: number) => '2025-03-' + String(day).padStart(2, '0') + 'T12:00:00.000Z'
function fixture() {
  const evidence: Evidence[] = []
  const add = (day: number, id: string, type: FinancialObservation['type'],
    fields: Partial<FinancialObservation> = {}, account = 'usd') => {
    const row = evidence.length + 1
    evidence.push({ batchId: 'synthetic', row, observation: {
      id, type, timestamp: at(day), sequence: row, account, venue: account === 'usd' ? 'kalshi' : 'polymarket',
      asset: account === 'usd' ? 'USD' : 'PUSD', instrument: null, amount: null, quantity: null,
      price: null, fee: null, feeAsset: null, ...fields,
    }, ...(type === 'mark' && !fields.terminalMarketReference ? { marketReference: {
      observedAt: at(day), retrievedAt: at(day + 1), revision: id, source: 'fixture', method: 'historical_close',
    } } : {}) })
  }
  const open = (account: string, capital: string) => {
    add(1, 'cash', 'opening_cash', { amount: capital }, account)
    add(1, 'inventory', 'opening_inventory', {}, account)
    add(1, 'history', 'history_complete', { coveredThrough: at(10) }, account)
  }
  const position = (instrument: string, quantity: string, price: string, fee: string | null = '0') =>
    ({ instrument, price, quantity, fee })
  open('usd', '100')
  open('pusd', '200')
  add(2, 'a-buy', 'buy', position('a', '20', '0.4', '1'))
  add(2, 'b-buy', 'buy', position('b', '20', '0.3'), 'pusd')
  add(2, 'c-buy', 'buy', position('c', '10', '0.5'))
  add(3, 'a-mark', 'mark', { instrument: 'a', price: '0.44' })
  add(3, 'a-same-mark', 'mark', { instrument: 'a', price: '0.44', sequence: -1 })
  add(3, 'b-mark', 'mark', { instrument: 'b', price: '0.33' }, 'pusd')
  add(3, 'c-mark', 'mark', { instrument: 'c', price: '0.5' })
  add(3, 'a-buy-more', 'buy', position('a', '10', '0.5'))
  add(4, 'a-partial', 'sell', position('a', '10', '0.6', '0.2'))
  add(4, 'c-exit', 'sell', position('c', '10', '0.7', '0.5'))
  add(4, 'b-unknown-fee', 'buy', position('b', '2', '0.33', null), 'pusd')
  add(6, 'a-terminal', 'mark', { instrument: 'a', terminalMarketReference: true })
  add(6, 'a-entitlement', 'settlement', position('a', '20', '1'))
  add(6, 'b-terminal', 'mark', { instrument: 'b', terminalMarketReference: true }, 'pusd')
  add(6, 'b-entitlement', 'settlement', position('b', '22', '0'), 'pusd')
  add(6, 'b-immediate', 'redemption', { instrument: 'b', quantity: '22', amount: '0', entitlementId: 'b-entitlement' }, 'pusd')
  add(7, 'a-ineligible-later-mark', 'mark', { instrument: 'a', price: '0.2' })
  add(8, 'a-delayed', 'redemption', { instrument: 'a', quantity: '20', amount: '20', entitlementId: 'a-entitlement' })
  return { evidence, add }
}

function verify(evidence: Evidence[], days: number[]) {
  const project = prepareHistoricalProjection(evidence)
  for (const day of days) {
    const before = replayAccounting(evidence, at(day))
    const after = project(at(day))
    expect(after, at(day)).toMatchObject({
      status: before.status, cash: before.cash, holdings: before.holdings, ledger: before.ledger, discrepancies: before.discrepancies,
    })
    expect(after.holdings, at(day)).toHaveLength(before.holdings.length)
  }
  return project
}

describe('prepared canonical historical projections', () => {
  it('matches native financial balances and provenance through purchase, sale, settlement and redemption', () => {
    const { evidence } = fixture()
    const project = verify(evidence, [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 3])
    expect(project(at(2)).cash[0]).toMatchObject({ balance: '86', referencePortfolioValue: null })
    expect(project(at(6)).holdings.find((row) => row.instrument === 'a')).toMatchObject({ quantity: '0', basis: '0', pending: '20' })
    expect(project(at(8)).cash[0]).toMatchObject({ balance: '113.3', knownRealized: '13.3' })
    expect(project(at(8)).cash[1]?.balance).toBeNull()
    expect(project(at(11)).cash[0]?.historyCoverage).toBe('outside_declared_interval')
  })

  it('keeps conflicts auditable after a later eligible mark restores valuation', () => {
    const { evidence, add } = fixture()
    add(4, 'a-conflicting-1', 'mark', { instrument: 'a', price: '0.42' })
    add(4, 'a-conflicting-2', 'mark', { instrument: 'a', price: '0.62' })
    add(5, 'a-restored', 'mark', { instrument: 'a', price: '0.52' })
    const project = verify(evidence, [5, 2, 4, 6, 8])
    expect(project(at(4)).holdings.find((row) => row.instrument === 'a')?.referenceMarketValue).toBeNull()
    expect(project(at(5)).holdings.find((row) => row.instrument === 'a')).toMatchObject({
      referenceMarketValue: '10.4', marketReference: { revision: 'a-restored' },
    })
    expect(project(at(5)).discrepancies.filter((row) => row.reason === 'same_time_marks_conflict')).toHaveLength(2)
  })
})

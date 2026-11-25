import { describe, expect, it } from 'vitest'
import { parseFinancialCsv } from '../src/accounting/csv.js'
import { replayAccounting } from '../src/accounting/ledger.js'

const header = 'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset'
const time = (hour: number) => `2026-11-25T${String(hour).padStart(2, '0')}:00:00.000Z`
const row = (id: string, hour: number, type: string, options: {
  instrument?: string; quantity?: string; price?: string; amount?: string; fee?: string; asset?: string
} = {}) => [
  'fixture', 'wallet', id, time(hour), '', type, options.instrument ?? '', options.asset ?? 'USDC',
  options.quantity ?? '', options.price ?? '', options.amount ?? '', options.fee ?? '', '',
].join(',')
const evidence = (rows: string[], batchId = 'batch') => {
  const parsed = parseFinancialCsv([header, ...rows].join('\n'))
  expect(parsed.issues).toEqual([])
  return parsed.rows.map((observation, index) => ({ batchId, row: index + 2, observation }))
}

describe('weighted-average replay', () => {
  it('matches the independent example and excludes future marks', () => {
    const rows = evidence([
      row('opening', 0, 'opening_cash', { amount: '0' }),
      row('funding', 1, 'deposit', { amount: '1000' }),
      row('buy-1', 2, 'buy', { instrument: 'A', quantity: '100', price: '0.40', fee: '0' }),
      row('buy-2', 3, 'buy', { instrument: 'A', quantity: '100', price: '0.60', fee: '0' }),
      row('sale', 4, 'sell', { instrument: 'A', quantity: '80', price: '0.75', fee: '0' }),
      row('mark', 5, 'mark', { instrument: 'A', price: '0.55' }),
    ])
    const result = replayAccounting(rows, time(5))
    expect(result.holdings).toMatchObject([{ quantity: '120', basis: '60', averageCost: '0.5', marketValue: '66', unrealized: '6' }])
    expect(result.cash).toMatchObject([{ balance: '960', realized: '20', portfolioValue: '1026', netContributions: '1000' }])
    expect(replayAccounting(rows, time(4)).holdings).toMatchObject([{ mark: null, unrealized: null }])
    expect(replayAccounting(rows, '2026-11-27T00:00:00Z').holdings).toMatchObject([{ markStatus: 'stale', marketValue: null }])
  })

  it('releases weighted basis at settlement and realizes no second gain at redemption', () => {
    const rows = evidence([
      row('cash', 0, 'opening_cash', { amount: '100' }),
      row('buy', 1, 'buy', { instrument: 'A', quantity: '10', price: '0.4', fee: '0.10' }),
      row('resolve', 2, 'settlement', { instrument: 'A', quantity: '10', price: '0.8' }),
      row('redeem', 3, 'redemption', { instrument: 'A', quantity: '10', amount: '8' }),
      row('reopen', 4, 'buy', { instrument: 'A', quantity: '5', price: '0.1', fee: '0' }),
    ])
    const pending = replayAccounting(rows, time(2))
    expect(pending.holdings).toMatchObject([{ quantity: '0', pending: '8' }])
    expect(pending.cash).toMatchObject([{ balance: '95.9', realized: '3.9', portfolioValue: '103.9' }])
    const after = replayAccounting(rows, time(4))
    expect(after.holdings).toMatchObject([{ quantity: '5', basis: '0.5', pending: '0' }])
    expect(after.cash).toMatchObject([{ balance: '103.4', realized: '3.9', knownFees: '0.1' }])
  })

  it('groups overlaps, excludes conflicting revisions, and preserves unresolved observations', () => {
    const a = row('same', 1, 'deposit', { amount: '12' })
    const conflict = row('same', 1, 'deposit', { amount: '13' })
    const ambiguous = row('', 2, 'withdrawal', { amount: '2' })
    expect(replayAccounting([...evidence([a]), ...evidence([a], 'overlap')], time(3)).events[0]?.sources).toHaveLength(2)
    const result = replayAccounting([...evidence([a, ambiguous]), ...evidence([conflict], 'correction')], time(3))
    expect(result.events).toEqual([])
    expect(result.discrepancies.map((issue) => issue.reason)).toEqual(['economic_id_missing', 'conflicting_observations'])
  })

  it('reports unknown fees and opening cost without inventing balances', () => {
    const rows = evidence([
      row('cash', 0, 'opening_cash', { amount: '100' }),
      row('open', 1, 'opening_position', { instrument: 'A', quantity: '10' }),
      row('buy', 2, 'buy', { instrument: 'A', quantity: '1', price: '0.4' }),
      row('sale', 3, 'sell', { instrument: 'A', quantity: '5', price: '0.8', fee: '0.1' }),
      row('deposit', 4, 'deposit', { amount: '2', asset: 'USDT' }),
    ])
    const result = replayAccounting(rows, time(5))
    expect(result.holdings).toMatchObject([{ quantity: '6', basis: null }])
    expect(result.cash).toMatchObject([{ asset: 'USDC', balance: null, realized: null }, { asset: 'USDT', opening: null, balance: null }])
  })

  it('keeps oversells and conversions unresolved while retaining fees and contributions', () => {
    const rows = evidence([
      row('cash', 0, 'opening_cash', { amount: '100' }),
      row('withdrawal', 1, 'withdrawal', { amount: '3' }),
      row('buy', 2, 'buy', { instrument: 'A', quantity: '2', price: '0.5', fee: '0.1' }),
      row('oversell', 3, 'sell', { instrument: 'A', quantity: '3', price: '0.75', fee: '0' }),
      row('rebate', 4, 'rebate', { amount: '0.05' }),
      row('reward', 5, 'reward', { amount: '1' }),
      row('split', 6, 'split'),
    ])
    const result = replayAccounting(rows, time(7), true)
    expect(result.status).toBe('partial')
    expect(result.holdings).toMatchObject([{ quantity: '2', basis: '1.1' }])
    expect(result.cash).toMatchObject([{ balance: null, knownDelta: '-3.05', netContributions: '-3', knownFees: '0.05' }])
    expect(result.discrepancies.map((issue) => issue.reason)).toEqual(['insufficient_inventory', 'complete_conversion_legs_required'])
  })

  it('rejects malformed and out-of-bounds CSV', () => {
    expect(() => parseFinancialCsv(header + '\n"unterminated')).toThrow('invalid_csv_quote')
    expect(() => parseFinancialCsv(header + '\n' + 'x'.repeat(201))).toThrow('csv_limit_exceeded')
    expect(parseFinancialCsv(header + '\n' + row('x', 1, 'deposit', { amount: '1e100' })).issues).toEqual([{ row: 2, code: 'invalid_decimal' }])
  })
})

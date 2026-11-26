import { consolidatePerformance } from '../src/fx/consolidated.js'
import { analyzePerformance } from '../src/analytics/performance.js'
import { applyDecisions, recordKey } from '../src/accounting/decisions.js'
import type { Evidence, FinancialObservation, PortfolioDecision } from '../src/accounting/model.js'

const horizon = Number(process.argv[2])
if (![30, 90, 180, 364].includes(horizon)) throw new Error('Choose 30, 90, 180 or 364 days')
const date = (day: number, hour = 0) => new Date(Date.UTC(2025, 0, day + 1, hour)).toISOString()
const accounts = ['bench-a', 'bench-b', 'bench-c']
const rows: Evidence[] = []
function add(account: string, day: number, hour: number, values: Pick<FinancialObservation, 'type'> & Partial<FinancialObservation>) {
  const row = rows.length + 2
  rows.push({ batchId: account, row, observation: {
    venue: 'synthetic', account, id: String(row), timestamp: date(day, hour), sequence: null, instrument: null,
    asset: 'USD', quantity: null, price: null, amount: null, fee: null, feeAsset: null, ...values,
  } })
}
const funded = Array.from({ length: 12 }, (_, i) => i * 30 + 15)
const markDays = [...new Set([1, 31, 91, 181, 365, ...funded, 40, 80, 160, 240, 320])]
for (const account of accounts) {
  add(account, 0, 0, { type: 'opening_cash', amount: '10000' })
  add(account, 0, 0, { type: 'opening_inventory' })
  add(account, 0, 0, { type: 'history_complete', coveredThrough: date(366) })
  for (const day of funded) add(account, day, 2, { type: 'deposit', amount: '100' })
  for (let index = 0; index < 60; index += 1) {
    const instrument = 'instrument-' + index
    add(account, 1, 0, { type: 'buy', instrument, quantity: '20', price: '0.4', fee: '0.02' })
    for (const day of markDays) {
      const price = day % 2 ? '0.45' : '0.50'
      add(account, day, 1, { type: 'mark', instrument, price })
    }
  }
  for (let index = 0; index < 20; index += 1) add(account, 10 + index, 0, { type: 'reward', amount: '0.01' })
}
const decisions = new Map<string, PortfolioDecision>(rows.filter((row) => row.observation.type === 'reward')
  .slice(0, 50).map((row) => [recordKey(row), { membership: 'excluded' }]))
const end = date(horizon + 1, 2)
const effective = applyDecisions(rows, decisions).evidence.filter((row) => row.observation.timestamp <= end)
const start = performance.now()
const initialRss = process.memoryUsage().rss
const result = analyzePerformance(effective, accounts, 'USD', date(1, 2), end)
console.log(JSON.stringify({ horizon, sourceRows: rows.length, effectiveRowsThroughCutoff: effective.length, accountCount: accounts.length,
  accountInstrumentCount: 180, valuationPoints: result.history.length, cashFlowBoundaries: result.cashFlowBoundaries.length,
  ...result.work, elapsedMs: Math.round(performance.now() - start), rssDeltaMiB: Math.round((process.memoryUsage().rss - initialRss) / 2 ** 20),
  closingValue: result.ending.value, twrAvailable: result.returns.twr.value !== null }))

if (process.argv.includes('--reporting')) {
  const mixed = effective.concat(effective.map((row) => ({ ...row, observation: { ...row.observation,
    id: 'usdc:' + row.observation.id, account: 'usdc:' + row.observation.account, asset: 'USDC',
    feeAsset: row.observation.feeAsset === 'USD' ? 'USDC' : row.observation.feeAsset } })))
  const rates = Array.from({ length: horizon + 3 }, (_, index) => {
    const time = new Date(date(index))
    return [{ revision: 'usdc-' + index, base: 'USDC', quote: 'USD', rate: index % 2 ? '0.999' : '0.995',
      source: 'fixture', methodology: 'stablecoin_market_reference', observedAt: time, retrievedAt: time },
    { revision: 'sgd-' + index, base: 'USD', quote: 'SGD', rate: '1.3', source: 'fixture',
      methodology: 'fiat_reference', observedAt: time, retrievedAt: time }]
  }).flat()
  const begin = performance.now()
  const reporting = consolidatePerformance(mixed, rates, ['USD', 'USDC'], 'SGD', date(1, 2), end, 'retrospective')
  console.log(JSON.stringify({ horizon, evidenceRows: mixed.length, accountInstrumentCount: 360,
    valuationPoints: reporting.history.length, cashFlowBoundaries: reporting.cashFlowBoundaries.length,
    elapsedMs: Math.round(performance.now() - begin), closingValue: reporting.ending?.completeValue,
    twrAvailable: reporting.twr !== null }))
}

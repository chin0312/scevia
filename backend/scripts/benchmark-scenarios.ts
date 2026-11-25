import { evaluate, methodology, type ScenarioBaseline, type ScenarioInput } from '../src/scenarios/engine.js'

for (const size of [10, 30, 100]) {
  const buckets = Array.from({ length: 4 }, (_, i) => ({ id: 'b' + i, venue: 'fixture', account: 'account' + i, cash: '25000', pending: '0' }))
  const instruments = Array.from({ length: size }, (_, i) => ({ id: 'outcome-' + i, mark: '0.6', market: 'market-' + i }))
  const baseline: ScenarioBaseline = { methodology, mode: 'actual', asset: 'USD', asOf: '2026-01-01T00:00:00.000Z', buckets, instruments,
    holdings: instruments.map((row, i) => ({ bucket: buckets[i % buckets.length]!.id, instrument: row.id, quantity: '100', basis: '40' })),
    rules: instruments.map((row, i) => ({ id: row.market, yes: row.id, no: 'opposite-' + i, asset: 'USD' })),
    constraints: instruments.flatMap((row, i) => i % 5 ? [{ left: instruments[i - 1]!.market, right: row.market, kind: 'implies' }] : []),
    revisions: {} }
  const alternatives: ScenarioInput[] = ['5', '10', '15', '20'].map((quantity) => ({
    operations: baseline.holdings.map((row) => ({ bucket: row.bucket, instrument: row.instrument, kind: 'buy', amount: quantity,
      price: '0.62', fee: { mode: 'fixed', value: '0.01' } })),
    funding: [], marks: [], rules: [], constraints: [], outcomes: [],
  }))
  alternatives.forEach((input) => evaluate(baseline, input))
  const start = performance.now()
  const rounds = 12
  for (let round = 0; round < rounds; round += 1) alternatives.forEach((input) => evaluate(baseline, input))
  console.log(JSON.stringify({ positions: size, accounts: buckets.length, components: Math.ceil(size / 5), alternatives: alternatives.length,
    meanComparisonMs: Number(((performance.now() - start) / rounds).toFixed(2)) }))
}

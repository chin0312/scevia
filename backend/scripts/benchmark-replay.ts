import { Decimal } from 'decimal.js'
import { replayConfig } from '../src/replay/contracts.js'
import { evaluateReplay, validateReplay } from '../src/replay/engine.js'
import type { ReplayEvidence } from '../src/replay/evidence.js'

const dayMs = 86_400_000
const start = Date.parse('2024-01-01T12:00:00.000Z')
const at = (day: number) => new Date(start + day * dayMs).toISOString()
const ranges = process.argv[2] ? [Number(process.argv[2])] : [30, 90, 365]
for (const days of ranges) {
  const before = process.memoryUsage().rss
  const data: ReplayEvidence = { catalog: [], lifecycle: new Map(), quotes: [] }
  const positions = []
  for (let i = 0; i < 8; i++) {
    const symbol = 'FIXTURE-' + i
    const venue = i % 2 ? 'kalshi' : 'polymarket'
    const asset = venue === 'kalshi' ? 'USD' : 'PUSD'
    const instrumentId = '00000000-0000-4000-8000-' + String(i).padStart(12, '0')
    data.catalog.push({ instrumentId, nativeMarket: symbol, nativeInstrument: symbol + ':yes', outcome: 'yes',
      nativeOutcomes: [symbol + ':yes', symbol + ':no'], asset, marketAsset: asset, marketId: symbol, eventId: symbol,
      title: symbol, eventTitle: symbol, provider: venue, generation: venue === 'kalshi' ? null : 'v2', mappedAsset: asset })
    const settlement = i === 1 ? { source: 'kalshi_trade_api' as const, unitPayout: '1' as const, winningInstrument: symbol + ':yes',
      knownAt: at(days - 1), settlementTime: at(days - 1) } : null
    data.lifecycle.set(symbol, [{ marketId: symbol, revision: symbol, retrievedAt: new Date(at(days + 2)),
      lifecycle: settlement ? 'resolved' : 'open', expectedResolutionAt: null, conflict: false, resolution: settlement,
      tradingOpensAt: new Date(at(0)), tradingClosesAt: new Date(at(settlement ? days - 2 : days + 1)) }])
    for (let j = 0; j <= days; j++) data.quotes.push({ id: symbol + j, revision: symbol + j, instrumentId, asset,
      price: new Decimal(j % 11).div(100).plus('0.4').toFixed(), effectiveAt: new Date(at(j)), observedAt: new Date(at(j)),
      retrievedAt: new Date(at(days + 2)), method: 'historical_close', source: 'synthetic_benchmark' })
    for (let entry = 1; entry <= 2; entry++) positions.push({ id: symbol + ':' + entry, instrumentId, bucket: venue,
      entry: { at: at(entry), execution: { mode: 'reference' }, size: { mode: 'quantity', value: '20' }, fee: { mode: 'fixed', amount: '0.1' } },
      exits: [{ at: at(days - 4), execution: { mode: 'reference' }, quantity: '10', fee: { mode: 'fixed', amount: '0.1' } }], remainder: 'settle' })
  }
  const configuration = replayConfig.parse({ version: 1, currency: 'USD', from: at(0), through: at(days), assumedUsdPerUnit: { PUSD: '0.99' },
    positions, buckets: [{ id: 'kalshi', venue: 'kalshi', asset: 'USD', capital: '1000' },
      { id: 'polymarket', venue: 'polymarket', asset: 'PUSD', capital: '1000' }] })
  validateReplay(configuration, at(days + 2))
  const startTime = performance.now()
  const result = evaluateReplay({ ...configuration, currency: 'USD' }, data, [], at(days + 2))
  const encoded = JSON.stringify(result)
  console.log(JSON.stringify({ days, instruments: data.catalog.length, positions: positions.length, marks: data.quotes.length,
    valuationPoints: result.history.length, milliseconds: Math.round(performance.now() - startTime),
    rssDeltaMiB: Math.round((process.memoryUsage().rss - before) / 2 ** 20), bytes: Buffer.byteLength(encoded),
    status: result.status, ending: result.summary.ending }))
}

import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { demoDatasetSchema, parseDemoDataset, readDemoDataset } from '../src/demo/dataset.js'
import { KalshiClient } from '../src/providers/kalshi/client.js'
import { KalshiMarketDataService } from '../src/providers/kalshi/market-data.js'
import { PolymarketMarketDataService } from '../src/providers/polymarket/market-data.js'

const [, , action, path, output] = process.argv
if (action === 'schema') {
  process.stdout.write(JSON.stringify(z.toJSONSchema(demoDatasetSchema, { io: 'input' }), null, 2) + '\n')
} else if (path && (action === 'validate' || action === 'refresh')) {
  await processDataset(action, path, output)
} else {
  throw new Error('Usage: demo:dataset schema | validate INPUT | refresh INPUT OUTPUT')
}

async function processDataset(action: 'validate' | 'refresh', path: string, output?: string) {
  const captured = await readDemoDataset(path)
  if (action === 'validate') {
    process.stdout.write(JSON.stringify({ revision: captured.revision, capturedAt: captured.manifest.capturedAt,
      markets: captured.manifest.markets.length, quotes: captured.manifest.quotes.length }) + '\n')
    return
  }
  if (!output || output === path) throw new Error('Provide a separate output path')
  const config = loadConfig()
  if (!config.demoDataset) throw new Error('Authorize demo capture on the loopback development server before refreshing')
  const kalshi = config.kalshi?.environment === 'production' && config.kalshi.publicAuthorized
    ? new KalshiMarketDataService(new KalshiClient(fetch, 'production'), '', true) : null
  const polymarket = config.polymarketLiveEnabled ? new PolymarketMarketDataService() : null
  if (!kalshi && !polymarket) throw new Error('No authorized public market source is enabled')
  const manifest = captured.manifest
  const markets = [...manifest.markets]
  const quotes = [...manifest.quotes]
  let refreshed = 0
  for (const [index, market] of manifest.markets.slice(0, 12).entries()) {
    if (market.lifecycle !== 'open') continue
    try {
      const signal = AbortSignal.timeout(8000)
      if (market.provider === 'kalshi' && kalshi) {
        const item = await kalshi.lookup(market.nativeMarket, signal)
        if (item.eventTicker !== market.nativeEvent) continue
        const observed = item.outcomes.flatMap(({ quote, id }) => quote && quote.provenance.includes('midpoint')
          && market.outcomes.some((leg) => leg.instrument === id) ? [{ provider: market.provider,
            nativeMarket: market.nativeMarket, instrument: id, price: quote.value, method: 'book_midpoint' as const,
            source: 'kalshi_book' as const, observedAt: null, retrievedAt: quote.retrievedAt }] : [])
        if (!observed.length || item.lifecycle !== 'open') continue
        const { feeSchedule: _priorFees, ...previous } = market
        markets[index] = { ...previous, title: item.title, resolvesAt: item.expectedResolutionAt,
          retrievedAt: observed[0]!.retrievedAt, source: 'kalshi_trade_api',
          ...(item.feeSchedule ? { feeSchedule: item.feeSchedule } : {}) }
        quotes.push(...observed)
        refreshed++
      } else if (market.provider === 'polymarket' && polymarket && market.publicLink) {
        const shape = z.object({ item: z.object({ eventId: z.string(), markets: z.array(z.object({
          conditionId: z.string(), title: z.string().optional(), lifecycle: z.string(), endDate: z.string().nullable(),
          outcomes: z.array(z.object({ assetId: z.string().nullable(), referencePrice: z.object({
            value: z.string().nullable(), retrievedAt: z.string().nullable(),
          }).optional() })),
        })) }) })
        const result = shape.parse(await polymarket.resolve(market.publicLink, signal)).item
        const item = result.markets.find((row) => row.conditionId === market.nativeMarket)
        if (!item || result.eventId !== market.nativeEvent || item.lifecycle !== 'open') continue
        const observed = item.outcomes.flatMap(({ assetId, referencePrice }) => assetId && referencePrice?.value && referencePrice.retrievedAt
          && market.outcomes.some((leg) => leg.instrument === assetId) ? [{ provider: market.provider, nativeMarket: market.nativeMarket,
            instrument: assetId, price: referencePrice.value, method: 'book_midpoint' as const, source: 'polymarket_clob' as const,
            observedAt: null, retrievedAt: referencePrice.retrievedAt }] : [])
        if (!observed.length) continue
        markets[index] = { ...market, title: item.title ?? market.title, resolvesAt: item.endDate, retrievedAt: observed[0]!.retrievedAt,
          source: 'polymarket_gamma' }
        quotes.push(...observed)
        refreshed++
      }
    } catch {
      // Keep the captured evidence and its original time when this provider is unavailable.
      process.stderr.write('One requested market refresh was unavailable.\n')
    }
  }
  if (refreshed === 0) throw new Error('No eligible quotes were available. The prior capture remains unchanged.')
  const next = parseDemoDataset({ ...manifest, markets, quotes, capturedAt: new Date().toISOString() })
  await writeFile(output, JSON.stringify(next.manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  process.stdout.write(JSON.stringify({ revision: next.revision, refreshed }) + '\n')
}

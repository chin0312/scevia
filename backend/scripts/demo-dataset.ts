import { readFile } from 'node:fs/promises'
import { captureDemo, demoCapturePlanSchema } from '../src/demo/capture.js'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { demoDatasetSchema, parseDemoDataset, readDemoDataset } from '../src/demo/dataset.js'
import { KalshiClient } from '../src/providers/kalshi/client.js'
import { KalshiMarketDataService } from '../src/providers/kalshi/market-data.js'
import { PolymarketMarketDataService } from '../src/providers/polymarket/market-data.js'

const [, , action, path, output, offsetArg = '0', limitArg = '12'] = process.argv
if (action === 'schema' || action === 'capture-schema') {
  process.stdout.write(JSON.stringify(z.toJSONSchema(action === 'schema' ? demoDatasetSchema : demoCapturePlanSchema, { io: 'input' }), null, 2) + '\n')
} else if (path && (action === 'validate' || action === 'refresh' || action === 'capture')) {
  await processDataset(action, path, output)
} else {
  throw new Error('Usage: demo:dataset schema | capture-schema | validate INPUT | capture PLAN OUTPUT | refresh INPUT OUTPUT [offset] [limit]')
}

async function processDataset(action: 'validate' | 'refresh' | 'capture', path: string, output?: string) {
  if (action === 'validate') {
    const captured = await readDemoDataset(path)
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
  if (action === 'capture') {
    const plan = await readFile(path, 'utf8')
    if (Buffer.byteLength(plan) > 100_000) throw new Error('demo_capture_plan_too_large')
    const captured = await captureDemo(JSON.parse(plan), { kalshi, polymarket })
    await writeFile(output, JSON.stringify(captured.manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    process.stdout.write(JSON.stringify({ revision: captured.revision, markets: captured.manifest.markets.length }) + '\n')
    return
  }
  const manifest = (await readDemoDataset(path)).manifest
  const offset = z.coerce.number().int().nonnegative().max(manifest.markets.length - 1).parse(offsetArg)
  const limit = z.coerce.number().int().min(1).max(12).parse(limitArg)
  const nextOffset = offset + limit < manifest.markets.length ? offset + limit : null
  const markets = [...manifest.markets]
  const quotes = [...manifest.quotes]
  let refreshed = 0
  for (const [offsetIndex, market] of manifest.markets.slice(offset, offset + limit).entries()) {
    const index = offset + offsetIndex
    if (market.resolution) continue
    try {
      const signal = AbortSignal.timeout(8000)
      if (market.provider === 'kalshi' && kalshi) {
        const item = await kalshi.lookup(market.nativeMarket, signal)
        if (item.eventTicker !== market.nativeEvent) continue
        const observed = item.outcomes.flatMap(({ quote, id }) => quote && quote.provenance.includes('midpoint')
          && market.outcomes.some((leg) => leg.instrument === id) ? [{ provider: market.provider,
            nativeMarket: market.nativeMarket, instrument: id, price: quote.value, method: 'book_midpoint' as const,
            source: 'kalshi_book' as const, observedAt: null, retrievedAt: quote.retrievedAt }] : [])
        if (!['open', 'closed', 'resolved'].includes(item.lifecycle) || item.establishedPayoutUnit !== '1') continue
        const { feeSchedule: _priorFees, ...previous } = market
        markets[index] = { ...previous, title: item.title, resolvesAt: item.expectedResolutionAt, lifecycle: item.lifecycle as typeof market.lifecycle,
          retrievedAt: item.retrievedAt, source: 'kalshi_trade_api',
          ...(item.resolution ? { resolution: item.resolution } : {}), ...(item.feeSchedule ? { feeSchedule: item.feeSchedule } : {}) }
        quotes.push(...observed)
        refreshed++
      } else if (market.provider === 'polymarket' && polymarket && market.publicLink) {
        const shape = z.object({ retrievedAt: z.iso.datetime({ offset: true }), item: z.object({ eventId: z.string(), markets: z.array(z.object({
          conditionId: z.string(), title: z.string().optional(), lifecycle: z.string(), endDate: z.string().nullable(),
          outcomes: z.array(z.object({ assetId: z.string().nullable(), referencePrice: z.object({
            value: z.string().nullable(), retrievedAt: z.string().nullable(),
          }).optional() })),
        })) }) })
        const response = shape.parse(await polymarket.resolve(market.publicLink, signal))
        const item = response.item.markets.find((row) => row.conditionId === market.nativeMarket)
        if (!item || response.item.eventId !== market.nativeEvent || !['open', 'closed', 'resolved'].includes(item.lifecycle)) continue
        const observed = item.outcomes.flatMap(({ assetId, referencePrice }) => assetId && referencePrice?.value && referencePrice.retrievedAt
          && market.outcomes.some((leg) => leg.instrument === assetId) ? [{ provider: market.provider, nativeMarket: market.nativeMarket,
            instrument: assetId, price: referencePrice.value, method: 'book_midpoint' as const, source: 'polymarket_clob' as const,
            observedAt: null, retrievedAt: referencePrice.retrievedAt }] : [])
        markets[index] = { ...market, title: item.title ?? market.title, lifecycle: item.lifecycle as typeof market.lifecycle,
          resolvesAt: item.endDate, retrievedAt: response.retrievedAt, source: 'polymarket_gamma' }
        quotes.push(...observed)
        refreshed++
      }
    } catch {
      // Keep the captured evidence and its original time when this provider is unavailable.
      process.stderr.write('One requested market refresh was unavailable.\n')
    }
  }
  if (refreshed === 0) {
    process.stdout.write(JSON.stringify({ status: 'unchanged', refreshed, nextOffset }) + '\n')
    return
  }
  const next = parseDemoDataset({ ...manifest, markets, quotes, capturedAt: new Date().toISOString() })
  await writeFile(output, JSON.stringify(next.manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  process.stdout.write(JSON.stringify({ revision: next.revision, refreshed, nextOffset }) + '\n')
}

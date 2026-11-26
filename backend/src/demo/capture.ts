import { z } from 'zod'
import { demoDatasetSchema, marketKey, parseDemoDataset, type DemoDataset } from './dataset.js'
import type { KalshiMarketDataService } from '../providers/kalshi/market-data.js'
import type { PolymarketMarketDataService } from '../providers/polymarket/market-data.js'

const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString())
export const demoCapturePlanSchema = z.object({
  markets: z.array(z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('kalshi'), ticker: z.string(), category: z.string().nullable().default(null) }).strict(),
    z.object({ provider: z.literal('polymarket'), conditionId: z.string(), link: z.url(),
      asset: z.enum(['USDC', 'PUSD']), category: z.string().nullable().default(null) }).strict(),
  ])).min(1).max(12),
  capital: demoDatasetSchema.shape.capital,
  trades: z.array(demoDatasetSchema.shape.trades.element.omit({ quoteIndex: true }).extend({
    marketIndex: z.number().int().min(0).max(11), side: z.enum(['YES', 'NO']), observedAt: timestamp,
  })).min(1).max(100),
}).strict()

type Sources = {
  kalshi?: Pick<KalshiMarketDataService, 'lookup' | 'historicalPrices'> | null
  polymarket?: Pick<PolymarketMarketDataService, 'resolve' | 'priceHistory'> | null
}

const pmEnvelope = z.object({ item: z.object({ eventId: z.string(), title: z.string().nullable().optional(), markets: z.array(z.object({
  conditionId: z.string(), title: z.string().optional(), question: z.string().optional(), lifecycle: z.string(),
  endDate: timestamp.nullable(), outcomes: z.array(z.object({ assetId: z.string().nullable(), name: z.string().nullable(),
    referencePrice: z.object({ value: z.string().nullable(), retrievedAt: timestamp.nullable() }).optional(),
  })),
})) }), retrievedAt: timestamp })

export async function captureDemo(value: unknown, sources: Sources, clock = () => new Date().toISOString()) {
  const plan = demoCapturePlanSchema.parse(value)
  const markets: DemoDataset['markets'] = []
  const quotes: DemoDataset['quotes'] = []
  const trades: DemoDataset['trades'] = []
  if (plan.trades.some((trade) => trade.marketIndex >= plan.markets.length)) throw new Error('demo_trade_market_unknown')
  for (const [index, selection] of plan.markets.entries()) {
    const venue = selection.provider
    const signal = () => AbortSignal.timeout(20_000)
    let market: DemoDataset['markets'][number]
    if (venue === 'kalshi') {
      if (!sources.kalshi) throw new Error('kalshi_demo_capture_not_authorized')
      const item = await sources.kalshi.lookup(selection.ticker, signal())
      if (item.marketTicker !== selection.ticker || !['open', 'closed', 'resolved'].includes(item.lifecycle) || item.establishedPayoutUnit !== '1') {
        throw new Error('unsupported_kalshi_demo_market')
      }
      market = { provider: venue, asset: 'USD', nativeMarket: item.marketTicker, nativeEvent: item.eventTicker, title: item.title,
        eventTitle: item.eventTicker, category: selection.category, lifecycle: item.lifecycle as typeof market.lifecycle,
        resolvesAt: item.expectedResolutionAt, retrievedAt: item.retrievedAt, source: 'kalshi_trade_api',
        outcomes: item.outcomes.map((leg) => ({ instrument: leg.id, name: leg.side === 'yes' ? 'YES' : 'NO' })),
        ...(item.resolution ? { resolution: item.resolution } : {}), ...(item.feeSchedule ? { feeSchedule: item.feeSchedule } : {}) }
      for (const leg of item.outcomes) if (leg.quote && leg.quote.provenance.includes('midpoint')) {
        quotes.push({ provider: venue, nativeMarket: market.nativeMarket, instrument: leg.id, price: leg.quote.value,
          method: 'book_midpoint', source: 'kalshi_book', observedAt: null, retrievedAt: leg.quote.retrievedAt })
      }
    } else {
      if (!sources.polymarket) throw new Error('polymarket_demo_capture_not_authorized')
      const response = pmEnvelope.parse(await sources.polymarket.resolve(selection.link, signal()))
      const item = response.item.markets.find((row) => row.conditionId === selection.conditionId)
      if (!item || !['open', 'closed', 'resolved'].includes(item.lifecycle) || item.outcomes.length !== 2
        || !item.outcomes.every((leg) => leg.assetId && leg.name && ['YES', 'NO'].includes(leg.name.toUpperCase()))) {
        throw new Error('unsupported_polymarket_demo_market')
      }
      const title = item.title ?? item.question
      if (!title) throw new Error('demo_market_title_missing')
      market = { provider: venue, asset: selection.asset, nativeMarket: item.conditionId, nativeEvent: response.item.eventId,
        publicLink: selection.link, title, eventTitle: response.item.title ?? title, category: selection.category,
        lifecycle: item.lifecycle as typeof market.lifecycle, resolvesAt: item.endDate, retrievedAt: response.retrievedAt, source: 'polymarket_gamma',
        outcomes: item.outcomes.map((leg) => ({ instrument: leg.assetId!, name: leg.name!.toUpperCase() as 'YES' | 'NO' })) }
      for (const leg of item.outcomes) if (leg.assetId && leg.referencePrice?.value && leg.referencePrice.retrievedAt) {
        quotes.push({ provider: venue, nativeMarket: market.nativeMarket, instrument: leg.assetId, price: leg.referencePrice.value,
          method: 'book_midpoint', source: 'polymarket_clob', observedAt: null, retrievedAt: leg.referencePrice.retrievedAt })
      }
    }
    markets.push(market)
    for (const side of ['YES', 'NO'] as const) {
      const picks = plan.trades.filter((trade) => trade.marketIndex === index && trade.side === side)
      if (!picks.length) continue
      const instrument = market.outcomes.find((row) => row.name === side)!.instrument
      const times = picks.map((row) => Date.parse(row.observedAt)).sort((a, b) => a - b)
      if (times.at(-1)! > Date.parse(clock()) || times.at(-1)! - times[0]! > 7 * 86_400_000) throw new Error('demo_trade_history_window_invalid')
      if (venue === 'kalshi') {
        const result = await sources.kalshi!.historicalPrices({ marketTicker: market.nativeMarket, side: side === 'YES' ? 'yes' : 'no',
          from: Math.floor(times[0]! / 1000) - 3600, through: Math.floor(times.at(-1)! / 1000), minutes: 60 }, signal())
        const retrievedAt = clock()
        for (const row of result.items) if (row.price !== null) quotes.push({ provider: venue, nativeMarket: market.nativeMarket,
          instrument, method: 'historical_close', source: 'kalshi_candlesticks', price: row.price, observedAt: row.timestamp, retrievedAt })
      } else {
        const schema = z.object({ retrievedAt: timestamp, items: z.array(z.object({ observedAt: timestamp, price: z.string() })) })
        const result = schema.parse(await sources.polymarket!.priceHistory({ tokenId: instrument, interval: '1w', bucketSeconds: 3600 }, signal()))
        for (const row of result.items) quotes.push({ provider: venue, nativeMarket: market.nativeMarket, instrument, method: 'historical_close',
          source: 'polymarket_price_history', price: row.price, observedAt: row.observedAt, retrievedAt: result.retrievedAt })
      }
      for (const { id, quantity, direction, assumedFee, observedAt } of picks) {
        const quoteIndex = quotes.findIndex((row) => marketKey(row) === marketKey(market) && row.instrument === instrument
          && row.method === 'historical_close' && row.observedAt === observedAt)
        if (quoteIndex < 0) throw new Error('demo_trade_observation_unavailable')
        trades.push({ id, quantity, direction, assumedFee, quoteIndex })
      }
    }
  }
  const byId = new Map(trades.map((row) => [row.id, row]))
  return parseDemoDataset({ evidenceKind: 'authorized_capture', capturedAt: clock(), markets, quotes,
    capital: plan.capital, trades: plan.trades.map((row) => byId.get(row.id)) })
}

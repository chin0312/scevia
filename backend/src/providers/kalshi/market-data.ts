import { z } from 'zod'
import { Decimal } from 'decimal.js'
import { decimalTextSchema } from '../../domain/model.js'
import { ProviderAdapterError } from '../adapter.js'
import { normalizeKalshiMarket } from './adapter.js'
import { KalshiClient } from './client.js'

const ticker = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,127}$/)
const envelope = z.object({ markets: z.array(z.unknown()).max(100), cursor: z.string().max(4000).optional() })
const quotes = z.object({ last_price_dollars: decimalTextSchema.optional(), close_time: z.iso.datetime({ offset: true }).optional() })

export function parseKalshiLink(input: string) {
  let url: URL
  try { url = new URL(input) } catch { throw new ProviderAdapterError('kalshi_invalid_market_link', false) }
  const match = /^\/(markets|events)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/?$/.exec(url.pathname)
  if (url.protocol !== 'https:' || !['kalshi.com', 'www.kalshi.com'].includes(url.hostname)
    || url.port || url.search || url.hash || url.username || url.password || !match) {
    throw new ProviderAdapterError('kalshi_invalid_market_link', false)
  }
  return { kind: match[1] === 'events' ? 'event' as const : 'market' as const, ticker: match[2]!.toUpperCase() }
}

export function kalshiMarketChoice(raw: unknown, retrievedAt: string) {
  const record = normalizeKalshiMarket(raw)
  if (record.kind !== 'market') throw new ProviderAdapterError('kalshi_invalid_market', false)
  const quote = quotes.parse(raw)
  const yes = quote.last_price_dollars
  const usable = yes !== undefined && new Decimal(yes).gte(0) && new Decimal(yes).lte(1)
  return { provider: 'kalshi' as const, marketTicker: record.externalMarketId, eventTicker: record.externalEventId,
    title: record.marketTitle, lifecycle: record.marketLifecycle, tradingClosesAt: quote.close_time ?? null,
    settlementAsset: 'USD', reviewedPayout: false, feeSchedule: null,
    outcomes: record.outcomes.map((item) => ({ id: item.externalId, side: item.outcomeType, name: item.name,
      quote: usable ? { value: item.outcomeType === 'yes' ? yes : new Decimal(1).minus(yes!).toFixed(),
        retrievedAt, observedAt: null, provenance: item.outcomeType === 'yes' ? 'provider_last_trade' : 'binary_complement_last_trade' } : null })),
  }
}

export class KalshiMarketDataService {
  constructor(private readonly client: KalshiClient, private readonly identityPrefix = '') {}

  private choice(raw: unknown, retrievedAt: string) {
    const item = kalshiMarketChoice(raw, retrievedAt)
    return { ...item, marketTicker: this.identityPrefix + item.marketTicker, eventTicker: this.identityPrefix + item.eventTicker,
      outcomes: item.outcomes.map((outcome) => ({ ...outcome, id: this.identityPrefix + outcome.id })) }
  }
  async lookup(id: string, signal: AbortSignal) {
    const checked = ticker.parse(id)
    const value = z.object({ market: z.unknown() }).parse(await this.client.read('market', new URLSearchParams(), signal, checked))
    const result = this.choice(value.market, new Date().toISOString())
    if (result.marketTicker !== this.identityPrefix + checked) throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
    return result
  }
  async list(event: string | undefined, cursor: string | undefined, signal: AbortSignal) {
    const query = new URLSearchParams({ limit: '50' })
    if (event) query.set('event_ticker', ticker.parse(event))
    if (cursor) query.set('cursor', cursor)
    const page = envelope.parse(await this.client.read('markets', query, signal))
    const captured = new Date().toISOString()
    const items = page.markets.flatMap((row) => {
      try {
        const item = this.choice(row, captured)
        return !event || item.eventTicker === this.identityPrefix + event ? [item] : []
      } catch { return [] }
    })
    return { provider: 'kalshi', items, nextCursor: page.cursor || null, partial: items.length !== page.markets.length }
  }
  async historicalPrices(input: { marketTicker: string; side: 'yes' | 'no'; from: number; through: number; minutes: number }, signal: AbortSignal) {
    const { marketTicker, side, from, through, minutes } = input
    ticker.parse(marketTicker)
    if (![1, 60, 1440].includes(minutes) || !Number.isSafeInteger(from) || !Number.isSafeInteger(through)
      || from < 0 || through > 8_640_000_000_000 || from >= through || (through - from) / (minutes * 60) > 500) {
      throw new ProviderAdapterError('kalshi_history_range_invalid', false)
    }
    const detail = z.object({ market: z.unknown() }).parse(
      await this.client.read('historicalMarket', new URLSearchParams(), signal, marketTicker))
    const market = normalizeKalshiMarket(detail.market)
    if (market.kind !== 'market' || market.externalMarketId !== marketTicker) {
      throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
    }
    const query = new URLSearchParams({ start_ts: String(from), end_ts: String(through), period_interval: String(minutes) })
    const response = z.object({ ticker, candlesticks: z.array(z.object({ end_period_ts: z.number().int().safe(),
      price: z.object({ close: decimalTextSchema.nullable() }) })).max(501) })
      .parse(await this.client.read('historicalCandles', query, signal, marketTicker))
    if (response.ticker !== marketTicker) throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
    const items = response.candlesticks.filter((row) => row.end_period_ts >= from && row.end_period_ts <= through).map((row) => {
      const price = row.price.close == null ? null : new Decimal(row.price.close)
      return { timestamp: new Date(row.end_period_ts * 1000).toISOString(),
        price: !price || price.isNegative() || price.gt(1) ? null : (side === 'yes' ? price : new Decimal(1).minus(price)).toFixed() }
    })
    return { provider: 'kalshi', marketTicker, outcome: side, asset: 'USD', evidence: side === 'yes' ? 'archived_yes_close' : 'archived_yes_close_complement',
      continuousCoverage: 'unverified', items }
  }
  async resolve(link: string, signal: AbortSignal) {
    const reference = parseKalshiLink(link)
    if (reference.kind === 'event') return this.list(reference.ticker, undefined, signal)
    return { provider: 'kalshi', items: [await this.lookup(reference.ticker, signal)], nextCursor: null, partial: false }
  }
}

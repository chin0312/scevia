import type { KalshiScenarioFeeSchedule } from '../../scenarios/engine.js'
import { z } from 'zod'
import { Decimal } from 'decimal.js'
import { decimalTextSchema } from '../../domain/model.js'
import { ProviderAdapterError } from '../adapter.js'
import { kalshiBookMidpoint, normalizeKalshiMarket } from './adapter.js'
import { KalshiClient } from './client.js'

const ticker = z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,127}$/)
const envelope = z.object({ markets: z.array(z.unknown()).max(100), cursor: z.string().max(4000).optional() })
const quotes = z.object({ result: z.string().optional(), settlement_value_dollars: decimalTextSchema.nullable().optional(),
  settlement_ts: z.iso.datetime({ offset: true }).nullable().optional(),  notional_value_dollars: decimalTextSchema.optional(), expected_expiration_time: z.iso.datetime({ offset: true }).nullable().optional(), last_price_dollars: decimalTextSchema.optional(), open_time: z.iso.datetime({ offset: true }).optional(), close_time: z.iso.datetime({ offset: true }).optional() })

export function parseKalshiLink(input: string) {
  let url: URL
  try { url = new URL(input) } catch { throw new ProviderAdapterError('kalshi_invalid_market_link', false) }
  if (url.protocol !== 'https:' || !['kalshi.com', 'www.kalshi.com'].includes(url.hostname)
    || url.port || url.search || url.hash || url.username || url.password) {
    throw new ProviderAdapterError('kalshi_invalid_market_link', false)
  }
  const direct = /^\/(markets|events)\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/?$/.exec(url.pathname)
  if (direct) return { kind: direct[1] === 'events' ? 'event' as const : 'market' as const, ticker: direct[2]!.toUpperCase() }
  const event = /^\/markets\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/?$/.exec(url.pathname)
  if (event) return { kind: 'series_event' as const, series: event[1]!.toUpperCase(), ticker: event[2]!.toUpperCase() }
  throw new ProviderAdapterError('kalshi_invalid_market_link', false)
}

export function kalshiMarketChoice(raw: unknown, retrievedAt: string) {
  const record = normalizeKalshiMarket(raw)
  if (record.kind !== 'market') throw new ProviderAdapterError('kalshi_invalid_market', false)
  const quote = quotes.parse(raw)
  const yes = quote.last_price_dollars
  const standard = quote.notional_value_dollars !== undefined && new Decimal(quote.notional_value_dollars).eq(1)
  const resolution = standard && record.marketLifecycle === 'resolved' && quote.settlement_ts
    && (quote.result === 'yes' || quote.result === 'no') && quote.settlement_value_dollars != null
    && new Decimal(quote.settlement_value_dollars).eq(quote.result === 'yes' ? 1 : 0)
    && Date.parse(quote.settlement_ts) <= Date.parse(retrievedAt)
    ? { knownAt: new Date(quote.settlement_ts).toISOString(), winningInstrument: record.externalMarketId + ':' + quote.result, unitPayout: '1' as const } : null
  const usable = standard && yes !== undefined && new Decimal(yes).gte(0) && new Decimal(yes).lte(1)
  return { provider: 'kalshi' as const, marketTicker: record.externalMarketId, eventTicker: record.externalEventId,
    title: record.marketTitle, lifecycle: record.marketLifecycle, tradingOpensAt: quote.open_time ?? null, tradingClosesAt: quote.close_time ?? null,
    settlementAsset: 'USD', reviewedPayout: false, feeSchedule: null as KalshiScenarioFeeSchedule | null, expectedResolutionAt: quote.expected_expiration_time ?? null,
    establishedPayoutUnit: standard ? '1' : null, retrievedAt, resolution,
    outcomes: record.outcomes.map((item) => {
      const no = item.outcomeType === 'no'
      const midpoint = kalshiBookMidpoint(raw, no)
      return { id: item.externalId, side: item.outcomeType, name: item.name,
        quote: midpoint !== null ? { value: midpoint, retrievedAt, observedAt: null,
          provenance: no ? 'binary_complement_book_midpoint' : 'provider_book_midpoint' }
          : usable ? { value: no ? new Decimal(1).minus(yes!).toFixed() : yes,
            retrievedAt, observedAt: null, provenance: no ? 'binary_complement_last_trade' : 'provider_last_trade' } : null }
    }),
  }
}

export class KalshiMarketDataService {
  constructor(private readonly client: KalshiClient, private readonly identityPrefix = '', private readonly loadFees = false) {}

  private async feeSchedule(eventTicker: string, signal: AbortSignal): Promise<KalshiScenarioFeeSchedule | null> {
    try {
      const event = z.object({ event: z.object({ event_ticker: ticker, series_ticker: ticker,
        fee_type_override: z.string().nullable().optional(), fee_multiplier_override: z.number().nonnegative().nullable().optional() }) })
        .parse(await this.client.read('event', new URLSearchParams(), signal, eventTicker)).event
      if (event.event_ticker !== eventTicker) return null
      let type = event.fee_type_override
      let multiplier = event.fee_multiplier_override
      let source: KalshiScenarioFeeSchedule['source'] = 'kalshi_event_override'
      if (type == null && multiplier == null) {
        const series = z.object({ series: z.object({ ticker, fee_type: z.string(), fee_multiplier: z.number().nonnegative() }) })
          .parse(await this.client.read('series', new URLSearchParams(), signal, event.series_ticker)).series
        if (series.ticker !== event.series_ticker) return null
        type = series.fee_type
        multiplier = series.fee_multiplier
        source = 'kalshi_series'
      }
      if (multiplier == null || multiplier > 100 || !['quadratic', 'quadratic_with_maker_fees', 'quadratic_with_combo_maker_fees'].includes(type ?? '')) return null
      const rate = new Decimal(multiplier).mul('0.07')
      const makerRate = rate.mul(type === 'quadratic_with_maker_fees' ? '0.25' : type === 'quadratic_with_combo_maker_fees' ? '0.5' : '0')
      return { version: 'kalshi-centicent-quadratic-v1', rate: rate.toFixed(), makerRate: makerRate.toFixed(),
        retrievedAt: new Date().toISOString(), source, denomination: 'USD' }
    } catch { return null }
  }

  private choice(raw: unknown, retrievedAt: string) {
    const item = kalshiMarketChoice(raw, retrievedAt)
    return { ...item, marketTicker: this.identityPrefix + item.marketTicker, eventTicker: this.identityPrefix + item.eventTicker,
      resolution: item.resolution ? { ...item.resolution, winningInstrument: this.identityPrefix + item.resolution.winningInstrument } : null,
      outcomes: item.outcomes.map((outcome) => ({ ...outcome, id: this.identityPrefix + outcome.id })) }
  }
  async lookup(id: string, signal: AbortSignal) {
    const checked = ticker.parse(id)
    let response: unknown
    try { response = await this.client.read('market', new URLSearchParams(), signal, checked) }
    catch (error) {
      if (!(error instanceof ProviderAdapterError) || error.code !== 'kalshi_http_404') throw error
      response = await this.client.read('historicalMarket', new URLSearchParams(), signal, checked)
    }
    const value = z.object({ market: z.unknown() }).parse(response)
    const result = this.choice(value.market, new Date().toISOString())
    if (result.marketTicker !== this.identityPrefix + checked) throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
    return this.loadFees && result.lifecycle === 'open' && result.establishedPayoutUnit === '1'
      ? { ...result, feeSchedule: await this.feeSchedule(result.eventTicker.slice(this.identityPrefix.length), signal) } : result
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
    const query = new URLSearchParams({ start_ts: String(from), end_ts: String(through), period_interval: String(minutes) })
    const schema = z.object({ ticker, candlesticks: z.array(z.object({ end_period_ts: z.number().int().safe(),
      price: z.object({ close: decimalTextSchema.nullable() }) })).max(501) })
    const candles = async (archive: boolean) => {
      const detail = z.object({ market: z.unknown() }).parse(await this.client.read(
        archive ? 'historicalMarket' : 'market', new URLSearchParams(), signal, marketTicker))
      const market = normalizeKalshiMarket(detail.market)
      if (market.kind !== 'market' || market.externalMarketId !== marketTicker) {
        throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
      }
      if (side === 'no' && !new Decimal(quotes.parse(detail.market).notional_value_dollars ?? 0).eq(1)) {
        throw new ProviderAdapterError('kalshi_history_complement_unit_unverified', false)
      }
      if (archive) return schema.parse(await this.client.read('historicalCandles', query, signal, marketTicker))
      const event = z.object({ event: z.object({ event_ticker: ticker, series_ticker: ticker }) }).parse(
        await this.client.read('event', new URLSearchParams(), signal, market.externalEventId))
      if (event.event.event_ticker !== market.externalEventId) throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
      return schema.parse(await this.client.read('currentCandles', query, signal, marketTicker, event.event.series_ticker))
    }
    const missing = (error: unknown) => error instanceof ProviderAdapterError && error.code === 'kalshi_http_404'
    let archive = true
    let response: z.infer<typeof schema>
    try { response = await candles(true) }
    catch (error) {
      if (!missing(error)) throw error
      archive = false
      try { response = await candles(false) }
      catch (changed) {
        if (!missing(changed)) throw changed
        archive = true
        response = await candles(true)
      }
    }
    if (response.ticker !== marketTicker) throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
    const items = response.candlesticks.filter((row) => row.end_period_ts >= from && row.end_period_ts <= through).map((row) => {
      const price = row.price.close == null ? null : new Decimal(row.price.close)
      return { timestamp: new Date(row.end_period_ts * 1000).toISOString(),
        price: !price || price.isNegative() || price.gt(1) ? null : (side === 'yes' ? price : new Decimal(1).minus(price)).toFixed() }
    })
    return { provider: 'kalshi', marketTicker: this.identityPrefix + marketTicker, outcome: side, asset: 'USD',
      evidence: (archive ? 'archived' : 'recent') + (side === 'yes' ? '_yes_close' : '_yes_close_complement'),
      continuousCoverage: 'unverified', items }
  }
  async resolve(link: string, signal: AbortSignal, outcomeId?: string) {
    const reference = parseKalshiLink(link)
    if (reference.kind === 'series_event') {
      const parsed = z.object({ event: z.object({ event_ticker: ticker, series_ticker: ticker }) }).parse(
        await this.client.read('event', new URLSearchParams(), signal, reference.ticker))
      if (parsed.event.event_ticker !== reference.ticker || parsed.event.series_ticker !== reference.series) {
        throw new ProviderAdapterError('kalshi_invalid_market_link', false)
      }
    }
    if (outcomeId !== undefined) {
      if (!outcomeId.startsWith(this.identityPrefix)) throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
      const selected = ticker.parse(outcomeId.slice(this.identityPrefix.length).replace(/:(yes|no)$/, ''))
      const item = await this.lookup(selected, signal)
      if (!item.outcomes.some((outcome) => outcome.id === outcomeId) || (reference.kind === 'market'
        ? item.marketTicker !== this.identityPrefix + reference.ticker : item.eventTicker !== this.identityPrefix + reference.ticker)) {
        throw new ProviderAdapterError('kalshi_market_identity_mismatch', false)
      }
      return { provider: 'kalshi', items: [item], nextCursor: null, partial: false }
    }
    if (reference.kind !== 'market') return this.list(reference.ticker, undefined, signal)
    return { provider: 'kalshi', items: [await this.lookup(reference.ticker, signal)], nextCursor: null, partial: false }
  }
}

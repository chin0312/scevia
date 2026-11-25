import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { decimalString, PolymarketHttpClient, PolymarketRequestError, parseProviderJson } from './http.js'

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TOKEN_ID_PATTERN = /^\d{1,100}$/
const MAX_SEARCH_EVENTS = 10
const MAX_MARKETS_PER_RESULT = 50
const MAX_TOTAL_SEARCH_MARKETS = 50
const MAX_MIDPOINT_ASSETS = 500

const recordSchema = z.record(z.string(), z.unknown())

export class PublicMarketError extends Error {
  constructor(readonly code: string, readonly httpStatus: number) {
    super(code)
    this.name = 'PublicMarketError'
  }
}

interface MarketAsset {
  id: string
  name: string | null
  outcomeIndex: number
}

interface MarketCandidate {
  providerCode: 'polymarket'
  eventId: string
  eventSlug: string | null
  eventTitle: string | null
  eventDescription: string | null
  eventLifecycle: string
  markets: Array<Record<string, unknown>>
}

export class PolymarketMarketDataService {
  constructor(private readonly client = new PolymarketHttpClient()) {}

  async search(query: string, limit = 5, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const searchText = query.trim()
    if (searchText.length < 2 || searchText.length > 120) throw new PublicMarketError('invalid_search_query', 400)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_EVENTS) throw new PublicMarketError('invalid_search_limit', 400)
    try {
      const upstream = recordSchema.parse(await this.client.getGamma('public-search', new URLSearchParams({ q: searchText }), signal))
      const events = Array.isArray(upstream.events) ? upstream.events : []
      const selected = dedupeEvents(events).slice(0, limit)
      const details = await mapConcurrent(selected, 3, async (event) => {
        const slug = safeSlug(event.slug)
        if (!slug) return null
        try {
          const detail = await this.client.getGamma(`events/slug/${encodeURIComponent(slug)}`, new URLSearchParams(), signal)
          return mapEventDetail(detail, event)
        } catch (error) {
          if (error instanceof PolymarketRequestError && error.httpStatus === 404) return null
          throw error
        }
      })
      const candidates = capCandidateMarkets(details.filter((candidate): candidate is MarketCandidate => candidate !== null), MAX_TOTAL_SEARCH_MARKETS)
      const priced = await this.addMidpoints(candidates, signal)
      const pagination = recordSchema.safeParse(upstream.pagination)
      return {
        providerCode: 'polymarket',
        query: searchText,
        retrievedAt: new Date().toISOString(),
        items: priced,
        pagination: pagination.success
          ? { hasMore: pagination.data.hasMore === true, totalResults: safeInteger(pagination.data.totalResults) }
          : { hasMore: false, totalResults: null },
      }
    } catch (error) {
      throw toPublicMarketError(error)
    }
  }

  async resolve(urlText: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const parsed = parseSupportedMarketUrl(urlText)
    try {
      if (parsed.kind === 'event') {
        const event = await this.client.getGamma(`events/slug/${encodeURIComponent(parsed.slug)}`, new URLSearchParams(), signal)
        const candidate = mapEventDetail(event, { id: '', slug: parsed.slug, title: null })
        if (!candidate) throw new PublicMarketError('polymarket_event_not_found', 404)
        const markets = await this.addMidpoints([candidate], signal)
        return { providerCode: 'polymarket', resolvedAs: 'event', sourceUrl: parsed.canonicalUrl, retrievedAt: new Date().toISOString(), item: markets[0] }
      }

      const detail = await this.client.getGamma(`markets/slug/${encodeURIComponent(parsed.slug)}`, new URLSearchParams(), signal)
      const market = recordSchema.parse(detail)
      if (safeSlug(market.slug) !== parsed.slug) throw new PublicMarketError('polymarket_market_not_found', 404)
      const eventRecord = firstRecord(market.events)
      const event = {
        id: stringValue(eventRecord?.id) ?? stringValue(market.eventId) ?? stringValue(market.event_id) ?? stringValue(market.eventSlug) ?? parsed.slug,
        slug: stringValue(eventRecord?.slug) ?? stringValue(market.eventSlug) ?? stringValue(market.event_slug),
        title: stringValue(eventRecord?.title) ?? stringValue(market.eventTitle) ?? stringValue(market.event_title),
        description: stringValue(eventRecord?.description),
      }
      const candidate = mapEventAndMarkets(event, [market])
      const markets = await this.addMidpoints([candidate], signal)
      return { providerCode: 'polymarket', resolvedAs: 'market', sourceUrl: parsed.canonicalUrl, retrievedAt: new Date().toISOString(), item: markets[0] }
    } catch (error) {
      throw toPublicMarketError(error)
    }
  }

  async priceHistory(input: {
    tokenId: string
    interval: string
    bucketSeconds?: number
    cursor?: string
  }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!TOKEN_ID_PATTERN.test(input.tokenId)) throw new PublicMarketError('invalid_token_id', 400)
    const intervals = new Set(['max', 'all', '1m', '1w', '1d', '6h', '1h'])
    if (!intervals.has(input.interval)) throw new PublicMarketError('invalid_price_history_interval', 400)
    if (input.bucketSeconds !== undefined && (!Number.isInteger(input.bucketSeconds) || input.bucketSeconds < 60 || input.bucketSeconds > 86_400)) {
      throw new PublicMarketError('invalid_price_history_bucket', 400)
    }
    if (input.cursor !== undefined && (input.cursor.length < 1 || input.cursor.length > 4096)) {
      throw new PublicMarketError('invalid_price_history_cursor', 400)
    }

    const query = new URLSearchParams({ token_id: input.tokenId, interval: input.interval, limit: '500' })
    if (input.bucketSeconds !== undefined) query.set('bucket_seconds', String(input.bucketSeconds))
    if (input.cursor !== undefined) query.set('cursor', input.cursor)
    try {
      const response = recordSchema.parse(await this.client.getData('prices-history', query, signal))
      const points = Array.isArray(response.data) ? response.data : []
      const items = points.flatMap((point) => {
        const parsed = recordSchema.safeParse(point)
        if (!parsed.success) return []
        const timestamp = epochSecondsToIso(parsed.data.timestamp)
        const price = decimalString(parsed.data.price)
        const resolutionSeconds = safeInteger(parsed.data.resolution_seconds)
        if (!timestamp || price === null || resolutionSeconds === null) return []
        return [{
          tokenId: input.tokenId,
          price,
          priceType: 'provider_price_history',
          observedAt: timestamp,
          timestampBasis: 'provider_observation',
          resolutionSeconds,
        }]
      })
      const pagination = recordSchema.safeParse(response.pagination)
      return {
        providerCode: 'polymarket',
        tokenId: input.tokenId,
        interval: input.interval,
        retrievedAt: new Date().toISOString(),
        items,
        nextCursor: pagination.success && typeof pagination.data.next_cursor === 'string' ? pagination.data.next_cursor : null,
      }
    } catch (error) {
      throw toPublicMarketError(error)
    }
  }

  private async addMidpoints(candidates: MarketCandidate[], signal?: AbortSignal): Promise<MarketCandidate[]> {
    const allAssets = Array.from(new Set(candidates.flatMap((candidate) => candidate.markets.flatMap((market) => {
      const outcomes = Array.isArray(market.outcomes) ? market.outcomes : []
      return outcomes.flatMap((outcome) => {
        const parsed = recordSchema.safeParse(outcome)
        const id = parsed.success ? stringValue(parsed.data.assetId) : null
        return id && TOKEN_ID_PATTERN.test(id) ? [id] : []
      })
    }))))
    const assets = allAssets.slice(0, MAX_MIDPOINT_ASSETS)
    const requestedAssets = new Set(assets)
    const retrievedAt = new Date().toISOString()
    let prices: Record<string, unknown> = {}
    let priceStatus: 'returned' | 'unavailable' = 'returned'
    if (assets.length > 0) {
      try {
        const response = recordSchema.parse(await this.client.postClob('midpoints', assets.map((token_id) => ({ token_id })), signal))
        prices = response
      } catch {
        priceStatus = 'unavailable'
      }
    }
    return candidates.map((candidate) => ({
      ...candidate,
      markets: candidate.markets.map((market) => ({
        ...market,
        outcomes: (Array.isArray(market.outcomes) ? market.outcomes : []).map((outcome) => {
          const parsed = recordSchema.safeParse(outcome)
          if (!parsed.success) return outcome
          const assetId = stringValue(parsed.data.assetId)
          const price = assetId ? decimalString(prices[assetId]) : null
          const validPrice = price !== null && new Decimal(price).greaterThanOrEqualTo(0) && new Decimal(price).lessThanOrEqualTo(1)
          const freshness = validPrice
            ? 'retrieved_now_source_time_unavailable'
            : !assetId ? 'instrument_id_unavailable'
              : !requestedAssets.has(assetId) ? 'not_requested_due_to_batch_limit'
                : priceStatus === 'unavailable' ? 'upstream_unavailable' : 'not_returned'
          return {
            ...parsed.data,
            referencePrice: {
              value: validPrice ? price : null,
              priceType: 'clob_midpoint',
              retrievedAt: validPrice ? retrievedAt : null,
              sourceTimestamp: null,
              freshness,
            },
          }
        }),
      })),
    }))
  }
}

function capCandidateMarkets(candidates: MarketCandidate[], maximumMarkets: number): MarketCandidate[] {
  let remaining = maximumMarkets
  return candidates.flatMap((candidate) => {
    if (remaining <= 0) return []
    const markets = candidate.markets.slice(0, remaining)
    remaining -= markets.length
    return [{ ...candidate, markets }]
  })
}

function parseSupportedMarketUrl(value: string): { kind: 'event' | 'market'; slug: string; canonicalUrl: string } {
  if (value.length > 2_048) throw new PublicMarketError('unsupported_market_url', 400)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PublicMarketError('unsupported_market_url', 400)
  }
  if (url.protocol !== 'https:' || !['polymarket.com', 'www.polymarket.com'].includes(url.hostname.toLowerCase())
    || url.port || url.username || url.password || url.search || url.hash) {
    throw new PublicMarketError('unsupported_market_url', 400)
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 2 || (segments[0] !== 'event' && segments[0] !== 'market')) {
    throw new PublicMarketError('unsupported_market_url', 400)
  }
  const slug = safeSlug(segments[1])
  if (!slug) throw new PublicMarketError('unsupported_market_url', 400)
  return {
    kind: segments[0],
    slug,
    canonicalUrl: `https://polymarket.com/${segments[0]}/${slug}`,
  }
}

function mapEventDetail(value: unknown, fallback: Record<string, unknown>): MarketCandidate | null {
  const event = recordSchema.safeParse(value)
  if (!event.success) return null
  const id = stringValue(event.data.id) ?? stringValue(fallback.id) ?? stringValue(event.data.slug) ?? stringValue(fallback.slug)
  if (!id) return null
  return mapEventAndMarkets({
    id,
    slug: stringValue(event.data.slug) ?? stringValue(fallback.slug),
    title: stringValue(event.data.title) ?? stringValue(fallback.title),
    description: stringValue(event.data.description),
    lifecycle: eventLifecycle(event.data),
  }, Array.isArray(event.data.markets) ? event.data.markets.flatMap((market) => {
    const parsed = recordSchema.safeParse(market)
    return parsed.success ? [parsed.data] : []
  }).slice(0, MAX_MARKETS_PER_RESULT) : [])
}

function mapEventAndMarkets(event: Record<string, unknown>, upstreamMarkets: Record<string, unknown>[]): MarketCandidate {
  const eventId = stringValue(event.id) ?? stringValue(event.slug) ?? 'unknown-event'
  const mappedMarkets = upstreamMarkets.flatMap((market) => {
    const id = stringValue(market.id)
    const slug = safeSlug(market.slug)
    const conditionId = stringValue(market.conditionId) ?? stringValue(market.condition_id)
    const title = stringValue(market.question) ?? stringValue(market.title)
    if (!id || !slug || !conditionId || !title) return []
    const labels = parseStringArray(market.outcomes)
    const positionIds = parseStringArray(market.positionIds ?? market.position_ids)
    const clobTokenIds = parseStringArray(market.clobTokenIds ?? market.clob_token_ids)
    const version = stringValue(market.version) ?? (positionIds.length > 0 ? 'v2' : clobTokenIds.length > 0 ? 'v1' : null)
    const assetIds = positionIds.length > 0 ? positionIds : clobTokenIds
    const outcomes: MarketAsset[] = assetIds.map((assetId, outcomeIndex) => ({
      id: assetId,
      name: labels[outcomeIndex] ?? null,
      outcomeIndex,
    })).filter((asset) => TOKEN_ID_PATTERN.test(asset.id))
    const isClosed = market.closed === true
    const isArchived = market.archived === true
    const isResolved = market.resolved === true || market.resolutionStatus === 'resolved' || market.resolution_status === 'resolved'
    const endDate = isoDate(market.endDate ?? market.end_date)
    return [{
      providerMarketId: id,
      conditionId,
      slug,
      url: `https://polymarket.com/market/${slug}`,
      title,
      version,
      lifecycle: isResolved ? 'resolved' : isClosed ? 'closed' : isArchived ? 'archived' : market.active === true ? 'open' : 'unknown',
      description: stringValue(market.description),
      resolutionSource: stringValue(market.resolutionSource) ?? stringValue(market.resolution_source),
      resolutionRules: stringValue(market.description),
      endDate,
      updatedAt: isoDate(market.updatedAt ?? market.updated_at),
      negativeRisk: typeof market.negRisk === 'boolean' ? market.negRisk : typeof market.neg_risk === 'boolean' ? market.neg_risk : null,
      feeRateBps: decimalString(market.takerBaseFee ?? market.taker_base_fee),
      outcomes: outcomes.map((outcome) => ({
        assetId: outcome.id,
        name: outcome.name,
        outcomeIndex: outcome.outcomeIndex,
      })),
    }]
  }).slice(0, MAX_MARKETS_PER_RESULT)
  return {
    providerCode: 'polymarket',
    eventId,
    eventSlug: stringValue(event.slug),
    eventTitle: stringValue(event.title),
    eventDescription: stringValue(event.description),
    eventLifecycle: stringValue(event.lifecycle) ?? 'unknown',
    markets: mappedMarkets,
  }
}

function dedupeEvents(events: unknown[]): Array<Record<string, unknown>> {
  const seen = new Set<string>()
  const result: Array<Record<string, unknown>> = []
  for (const value of events) {
    const parsed = recordSchema.safeParse(value)
    if (!parsed.success) continue
    const slug = safeSlug(parsed.data.slug)
    const id = stringValue(parsed.data.id)
    if (!slug || !id || seen.has(id)) continue
    seen.add(id)
    result.push({ ...parsed.data, slug })
  }
  return result
}

function parseStringArray(value: unknown): string[] {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = parseProviderJson(parsed)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map(stringValue).filter((item): item is string => item !== null)
}

function safeSlug(value: unknown): string | null {
  const slug = stringValue(value)
  return slug !== null && slug.length <= 200 && SLUG_PATTERN.test(slug) ? slug : null
}

function eventLifecycle(event: Record<string, unknown>): string {
  if (event.resolved === true) return 'resolved'
  if (event.closed === true) return 'closed'
  if (event.archived === true) return 'archived'
  if (event.active === true) return 'open'
  return 'unknown'
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return null
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const parsed = recordSchema.safeParse(value[0])
  return parsed.success ? parsed.data : null
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function epochSecondsToIso(value: unknown): string | null {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null
  const date = new Date(seconds * 1_000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = Array.from({ length: items.length })
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      output[index] = await mapper(items[index]!)
    }
  })
  await Promise.all(workers)
  return output
}

function toPublicMarketError(error: unknown): PublicMarketError {
  if (error instanceof PublicMarketError) return error
  if (error instanceof PolymarketRequestError) {
    if (error.httpStatus === 404) return new PublicMarketError('polymarket_resource_not_found', 404)
    if (error.httpStatus === 400) return new PublicMarketError('polymarket_request_rejected', 502)
    return new PublicMarketError(error.code, 502)
  }
  if (error instanceof z.ZodError) return new PublicMarketError('polymarket_response_invalid', 502)
  return new PublicMarketError('polymarket_upstream_unavailable', 502)
}

export const supportedPolymarketUrl = parseSupportedMarketUrl

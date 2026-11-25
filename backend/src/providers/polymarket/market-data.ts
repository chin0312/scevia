import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { decimalString, PolymarketHttpClient, PolymarketRequestError, parseProviderJson } from './http.js'

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TOKEN_ID_PATTERN = /^\d{1,100}$/
const MAX_SEARCH_EVENTS = 10
const MAX_MARKETS_PER_RESULT = 50
const MAX_TOTAL_SEARCH_MARKETS = 50
const MAX_MIDPOINT_ASSETS = 500
const MAX_SEARCH_PAGE = 100
const TRACKING_QUERY_KEYS = new Set(['ref', 'referral', 'via', 'affiliate'])

const recordSchema = z.record(z.string(), z.unknown())

export class PublicMarketError extends Error {
  constructor(readonly code: string, readonly httpStatus: number) {
    super(code)
    this.name = 'PublicMarketError'
  }
}

interface MarketAsset {
  id: string | null
  positionId: string | null
  clobTokenId: string | null
  name: string | null
  outcomeIndex: number
}

interface MarketCandidate {
  providerCode: 'polymarket'
  eventId: string | null
  eventIdentity: { kind: 'provider_event_id' | 'slug_only' | 'unavailable'; value: string | null }
  eventSlug: string | null
  eventTitle: string | null
  eventDescription: string | null
  eventLifecycle: string
  enrichmentStatus: 'complete' | 'partial' | 'unavailable'
  enrichmentErrors: string[]
  marketsTruncated: boolean
  markets: Array<Record<string, unknown>>
}

export class PolymarketMarketDataService {
  constructor(private readonly client = new PolymarketHttpClient()) {}

  async search(query: string, limit = 5, page = 1, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const searchText = query.trim()
    if (searchText.length < 2 || searchText.length > 120) throw new PublicMarketError('invalid_search_query', 400)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_EVENTS) throw new PublicMarketError('invalid_search_limit', 400)
    if (!Number.isInteger(page) || page < 1 || page > MAX_SEARCH_PAGE) throw new PublicMarketError('invalid_search_page', 400)
    try {
      const upstream = recordSchema.parse(await this.client.getGamma('public-search', new URLSearchParams({
        q: searchText,
        page: String(page),
        limit_per_type: String(limit),
        search_profiles: 'false',
        search_tags: 'false',
      }), signal))
      const events = Array.isArray(upstream.events) ? upstream.events : []
      const selected = dedupeEvents(events).slice(0, limit)
      const enriched = await mapConcurrent(selected, 3, async (event) => {
        const slug = safeSlug(event.slug)
        if (!slug) return { candidate: summaryEventCandidate(event, 'event_slug_unavailable'), error: 'event_slug_unavailable' }
        try {
          const detail = await this.client.getGamma(`events/slug/${encodeURIComponent(slug)}`, new URLSearchParams(), signal)
          const candidate = mapEventDetail(detail, event)
          return candidate
            ? { candidate, error: null }
            : { candidate: summaryEventCandidate(event, 'event_detail_invalid'), error: 'event_detail_invalid' }
        } catch (error) {
          const code = error instanceof PolymarketRequestError && error.httpStatus === 404
            ? 'event_detail_not_found'
            : 'event_detail_unavailable'
          return { candidate: summaryEventCandidate(event, code), error: code }
        }
      })
      const capped = capCandidateMarkets(enriched.map(({ candidate }) => candidate), MAX_TOTAL_SEARCH_MARKETS)
      const candidates = capped.candidates
      const priced = await this.addMidpoints(candidates, signal)
      const pagination = recordSchema.safeParse(upstream.pagination)
      const providerHasMore = pagination.success && typeof pagination.data.hasMore === 'boolean'
        ? pagination.data.hasMore
        : null
      const totalResults = pagination.success ? safeInteger(pagination.data.totalResults) : null
      const enrichmentErrors = Array.from(new Set([
        ...enriched.flatMap(({ error, candidate }) => [...(error ? [error] : []), ...candidate.enrichmentErrors]),
        ...(capped.truncated ? ['market_result_truncated'] : []),
      ]))
      return {
        providerCode: 'polymarket',
        query: searchText,
        retrievedAt: new Date().toISOString(),
        items: priced,
        pagination: {
          page,
          pageSize: limit,
          hasMore: providerHasMore === true,
          providerHasMore,
          totalResults,
          nextPage: providerHasMore === true && page < MAX_SEARCH_PAGE ? page + 1 : null,
          continuationAvailable: providerHasMore === true && page < MAX_SEARCH_PAGE,
          truncated: providerHasMore === true || selected.length < dedupeEvents(events).length || capped.truncated,
        },
        enrichment: {
          status: enrichmentErrors.length > 0 || capped.truncated || enriched.some(({ candidate }) => candidate.enrichmentStatus !== 'complete') ? 'partial' : 'complete',
          errors: enrichmentErrors,
          marketsTruncated: capped.truncated,
        },
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
        const candidate = mapEventDetail(event, { slug: parsed.slug, title: null })
        if (!candidate) throw new PublicMarketError('polymarket_event_not_found', 404)
        const markets = await this.addMidpoints([candidate], signal)
        return { providerCode: 'polymarket', resolvedAs: 'event', sourceUrl: parsed.canonicalUrl, retrievedAt: new Date().toISOString(), item: markets[0] }
      }

      const detail = await this.client.getGamma(`markets/slug/${encodeURIComponent(parsed.slug)}`, new URLSearchParams(), signal)
      const market = recordSchema.parse(detail)
      if (safeSlug(market.slug) !== parsed.slug) throw new PublicMarketError('polymarket_market_not_found', 404)
      const eventRecord = firstRecord(market.events)
      const event = {
        id: stringValue(eventRecord?.id) ?? stringValue(market.eventId) ?? stringValue(market.event_id),
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
      let invalidPointCount = 0
      const items = points.flatMap((point) => {
        const parsed = recordSchema.safeParse(point)
        if (!parsed.success) { invalidPointCount += 1; return [] }
        const timestamp = epochSecondsToIso(parsed.data.timestamp)
        const price = decimalString(parsed.data.price)
        const resolutionSeconds = safeInteger(parsed.data.resolution_seconds)
        if (!timestamp || price === null || resolutionSeconds === null
          || new Decimal(price).lessThan(0) || new Decimal(price).greaterThan(1)) {
          invalidPointCount += 1
          return []
        }
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
        invalidPointCount,
        complete: invalidPointCount === 0 && !(pagination.success && typeof pagination.data.next_cursor === 'string'),
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

function capCandidateMarkets(candidates: MarketCandidate[], maximumMarkets: number): { candidates: MarketCandidate[]; truncated: boolean } {
  let remaining = maximumMarkets
  const totalMarketCount = candidates.reduce((total, candidate) => total + candidate.markets.length, 0)
  const capped = candidates.map((candidate) => {
    const markets = candidate.markets.slice(0, remaining)
    remaining -= markets.length
    return { ...candidate, markets, marketsTruncated: candidate.marketsTruncated || markets.length < candidate.markets.length }
  })
  return { candidates: capped, truncated: totalMarketCount > maximumMarkets }
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
    || url.port || url.username || url.password || url.hash) {
    throw new PublicMarketError('unsupported_market_url', 400)
  }
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase()
    if (!TRACKING_QUERY_KEYS.has(normalized) && !normalized.startsWith('utm_')) {
      throw new PublicMarketError('unsupported_market_url', 400)
    }
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
  const id = stringValue(event.data.id) ?? stringValue(fallback.id)
  const slug = stringValue(event.data.slug) ?? stringValue(fallback.slug)
  if (!id && !slug) return null
  const rawMarkets = Array.isArray(event.data.markets) ? event.data.markets : []
  const parsedMarkets = rawMarkets.flatMap((market) => {
    const parsed = recordSchema.safeParse(market)
    return parsed.success ? [parsed.data] : []
  })
  const marketOverflow = parsedMarkets.length > MAX_MARKETS_PER_RESULT
  return mapEventAndMarkets({
    id,
    slug,
    title: stringValue(event.data.title) ?? stringValue(fallback.title),
    description: stringValue(event.data.description),
    lifecycle: eventLifecycle(event.data),
  }, parsedMarkets.slice(0, MAX_MARKETS_PER_RESULT), marketOverflow)
}

function mapEventAndMarkets(
  event: Record<string, unknown>,
  upstreamMarkets: Record<string, unknown>[],
  marketsTruncated = false,
): MarketCandidate {
  const eventId = stringValue(event.id)
  const eventSlug = stringValue(event.slug)
  const eventIdentity = eventId
    ? { kind: 'provider_event_id' as const, value: eventId }
    : eventSlug ? { kind: 'slug_only' as const, value: eventSlug } : { kind: 'unavailable' as const, value: null }
  const mappedMarkets = upstreamMarkets.flatMap((market) => {
    const id = stringValue(market.id)
    const slug = safeSlug(market.slug)
    const conditionId = stringValue(market.conditionId) ?? stringValue(market.condition_id)
    const title = stringValue(market.question) ?? stringValue(market.title)
    if (!id || !slug || !conditionId || !title) return []
    const labels = parseStringArray(market.outcomes)
    const positionIds = parseStringArray(market.positionIds ?? market.position_ids)
    const clobTokenIds = parseStringArray(market.clobTokenIds ?? market.clob_token_ids)
    const versionValue = stringValue(market.version)?.toLowerCase() ?? null
    const version = versionValue === 'v1' || versionValue === 'v2' ? versionValue : null
    const assetCount = Math.max(labels.length, positionIds.length, clobTokenIds.length)
    const outcomes: MarketAsset[] = Array.from({ length: assetCount }, (_, outcomeIndex) => ({
      id: version === 'v2' ? positionIds[outcomeIndex] ?? null : version === 'v1' ? clobTokenIds[outcomeIndex] ?? null : null,
      positionId: positionIds[outcomeIndex] ?? null,
      clobTokenId: clobTokenIds[outcomeIndex] ?? null,
      name: labels[outcomeIndex] ?? null,
      outcomeIndex,
    })).filter((asset) => asset.id === null || TOKEN_ID_PATTERN.test(asset.id))
    const isClosed = market.closed === true
    const isArchived = market.archived === true
    const isResolved = market.resolved === true || market.resolutionStatus === 'resolved' || market.resolution_status === 'resolved'
    const endDate = isoDate(market.endDate ?? market.end_date)
    const feeMetadata = mapFeeMetadata(market)
    return [{
      providerMarketId: id,
      providerMarketSlug: slug,
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
      feeMetadata,
      outcomes: outcomes.map((outcome) => ({
        assetId: outcome.id,
        assetIdType: outcome.id === null ? 'unavailable' : version === 'v2' ? 'position_id' : 'clob_token_id',
        positionId: outcome.positionId,
        clobTokenId: outcome.clobTokenId,
        name: outcome.name,
        outcomeIndex: outcome.outcomeIndex,
      })),
    }]
  }).slice(0, MAX_MARKETS_PER_RESULT)
  const detailComplete = mappedMarkets.length === upstreamMarkets.length && !marketsTruncated
  return {
    providerCode: 'polymarket',
    eventId,
    eventIdentity,
    eventSlug,
    eventTitle: stringValue(event.title),
    eventDescription: stringValue(event.description),
    eventLifecycle: stringValue(event.lifecycle) ?? 'unknown',
    enrichmentStatus: detailComplete ? 'complete' : 'partial',
    enrichmentErrors: [],
    marketsTruncated: marketsTruncated || mappedMarkets.length < upstreamMarkets.length,
    markets: mappedMarkets,
  }
}

function summaryEventCandidate(event: Record<string, unknown>, errorCode: string): MarketCandidate {
  const eventId = stringValue(event.id)
  const eventSlug = stringValue(event.slug)
  return {
    providerCode: 'polymarket',
    eventId,
    eventIdentity: eventId
      ? { kind: 'provider_event_id', value: eventId }
      : eventSlug ? { kind: 'slug_only', value: eventSlug } : { kind: 'unavailable', value: null },
    eventSlug,
    eventTitle: stringValue(event.title),
    eventDescription: stringValue(event.description),
    eventLifecycle: eventLifecycle(event),
    enrichmentStatus: 'unavailable',
    enrichmentErrors: [errorCode],
    marketsTruncated: false,
    markets: [],
  }
}

function mapFeeMetadata(market: Record<string, unknown>): Record<string, unknown> {
  const trading = recordSchema.safeParse(market.trading)
  const feesEnabledValue = market.feesEnabled ?? market.fees_enabled ?? (trading.success ? trading.data.feesEnabled ?? trading.data.fees_enabled : undefined)
  const feesEnabled = typeof feesEnabledValue === 'boolean' ? feesEnabledValue : null
  const scheduleValue = market.feeSchedule ?? market.fee_schedule ?? (trading.success ? trading.data.feeSchedule ?? trading.data.fee_schedule : undefined)
  const schedule = recordSchema.safeParse(scheduleValue)
  const rate = schedule.success ? feeFraction(schedule.data.rate) : null
  const exponent = schedule.success && typeof schedule.data.exponent === 'number'
    && Number.isFinite(schedule.data.exponent) && schedule.data.exponent >= 0 && schedule.data.exponent <= 10
    ? schedule.data.exponent
    : null
  const takerOnlyValue = schedule.success ? schedule.data.takerOnly ?? schedule.data.taker_only : undefined
  const takerOnly = typeof takerOnlyValue === 'boolean' ? takerOnlyValue : null
  const rebateRate = schedule.success ? feeFraction(schedule.data.rebateRate ?? schedule.data.rebate_rate) : null
  const completeSchedule = rate !== null && exponent !== null && takerOnly !== null
  const status = feesEnabled === false ? 'fee_free'
    : feesEnabled === true && completeSchedule ? 'known'
      : feesEnabled === true || schedule.success ? 'incomplete' : 'unknown'
  return {
    status,
    source: 'gamma_market',
    retrievedAt: new Date().toISOString(),
    enabled: feesEnabled,
    rate,
    exponent,
    takerOnly,
    makerFeesCharged: takerOnly === true ? false : null,
    rebateRate,
    rebateRateSemantics: rebateRate === null ? null : 'market_level_fraction',
    amountUnit: 'USDC',
    historicalFeesAvailable: false,
  }
}

function feeFraction(value: unknown): string | null {
  const decimal = decimalString(value)
  if (decimal === null) return null
  const fraction = new Decimal(decimal)
  return fraction.greaterThanOrEqualTo(0) && fraction.lessThanOrEqualTo(1) ? decimal : null
}

function dedupeEvents(events: unknown[]): Array<Record<string, unknown>> {
  const seen = new Set<string>()
  const result: Array<Record<string, unknown>> = []
  for (const value of events) {
    const parsed = recordSchema.safeParse(value)
    if (!parsed.success) continue
    const slug = safeSlug(parsed.data.slug)
    const id = stringValue(parsed.data.id)
    if (!slug || (!id && !slug)) continue
    const identity = id ? `id:${id}` : `slug:${slug}`
    if (seen.has(identity)) continue
    seen.add(identity)
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

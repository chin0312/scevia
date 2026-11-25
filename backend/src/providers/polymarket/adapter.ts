import { createHash } from 'node:crypto'
import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { normalizedRecordSchema, type EntityCoverageReport, type NormalizedRecord, type ProviderCapabilities } from '../../domain/model.js'
import { ProviderAdapterError, type FetchPageRequest, type ProviderAdapter, type ProviderPage } from '../adapter.js'
import { decimalString, PolymarketHttpClient, PolymarketRequestError } from './http.js'

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const TOKEN_ID_PATTERN = /^\d{1,100}$/
const PAGE_SIZE = 100
const HISTORY_OVERLAP_SECONDS = 7 * 24 * 60 * 60

const envelopeSchema = z.object({
  data: z.union([z.array(z.record(z.string(), z.unknown())), z.null()]),
  pagination: z.object({ next_cursor: z.string().max(4096).nullable().optional() }).passthrough().optional(),
}).passthrough()

const tokenEnvelopeSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())).nullable(),
}).passthrough()

interface TimeWindow {
  start: number
  end: number
}

interface PagePayload {
  stream: 'positions' | 'trades' | 'activity'
  rows: Record<string, unknown>[]
  tokenRows: Record<string, unknown>[]
  retrievedAt: string
}

export class PolymarketAdapter implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities = {
    providerCode: 'polymarket',
    displayName: 'Polymarket public wallet',
    adapterKind: 'production',
    accountKinds: ['public_wallet'],
    operations: {
      markets: 'supported',
      fills: 'supported',
      activity: 'supported',
      cash_movements: 'supported',
      settlements: 'unsupported',
      positions: 'supported',
      cash_balances: 'unsupported',
      prices: 'supported',
    },
    streams: [
      {
        name: 'positions',
        entities: ['positions', 'prices'],
        referenceEntities: ['markets'],
        strategy: 'full_refresh',
        snapshotSemantics: { positions: 'incremental' },
      },
      {
        name: 'trades',
        entities: ['markets', 'fills'],
        strategy: 'provider_checkpoint',
        snapshotSemantics: {},
      },
      {
        name: 'activity',
        entities: ['activity', 'cash_movements'],
        strategy: 'provider_checkpoint',
        snapshotSemantics: {},
      },
    ],
    pagination: 'supported',
    incrementalSync: 'supported',
  }

  constructor(private readonly client = new PolymarketHttpClient()) {}

  async fetchPage(request: FetchPageRequest): Promise<ProviderPage> {
    if (!ADDRESS_PATTERN.test(request.externalAccountId)) {
      throw new ProviderAdapterError('invalid_polymarket_wallet_address', false)
    }
    try {
      if (request.streamName === 'positions') return await this.fetchPositions(request)
      if (request.streamName === 'trades') return await this.fetchTrades(request)
      if (request.streamName === 'activity') return await this.fetchActivity(request)
      throw new ProviderAdapterError('unknown_polymarket_stream', false)
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error
      if (error instanceof PolymarketRequestError) {
        throw new ProviderAdapterError(error.code, error.retryable, error.retryAfterMs)
      }
      throw new ProviderAdapterError('polymarket_provider_response_invalid', false)
    }
  }

  normalizePage(page: ProviderPage, streamName: string): NormalizedRecord[] {
    const parsedPayload = z.object({
      stream: z.enum(['positions', 'trades', 'activity']),
      rows: z.array(z.record(z.string(), z.unknown())).max(PAGE_SIZE),
      tokenRows: z.array(z.record(z.string(), z.unknown())).max(PAGE_SIZE * 4),
      retrievedAt: z.string().datetime({ offset: true }),
    }).strict().safeParse(page.payload)
    if (!parsedPayload.success || parsedPayload.data.stream !== streamName) {
      throw new ProviderAdapterError('invalid_provider_payload', false)
    }
    const { rows, tokenRows, retrievedAt } = parsedPayload.data
    const records: unknown[] = []

    if (streamName === 'positions') {
      for (const row of rows) {
        const market = marketFromPosition(row)
        if (market) records.push(market)
        const position = positionFromProviderRow(row, retrievedAt)
        if (position) {
          records.push(position)
          const price = priceFromPosition(row, retrievedAt)
          if (price) records.push(price)
        }
      }
    } else if (streamName === 'trades') {
      const tokensById = new Map(tokenRows.flatMap((token) => {
        const tokenId = nonEmptyString(token.token_id)
        return tokenId ? [[tokenId, token] as const] : []
      }))
      const emittedMarkets = new Set<string>()
      for (const row of rows) {
        const tokenId = nonEmptyString(row.token_id)
        const token = tokenId ? tokensById.get(tokenId) : undefined
        const oppositeId = token ? nonEmptyString(token.opposite_token_id) : null
        const opposite = oppositeId ? tokensById.get(oppositeId) : undefined
        if (!token || !opposite) continue
        const market = marketFromTokenPair(token, opposite, row)
        if (!market) continue
        const externalMarketId = nonEmptyString(market.externalMarketId)
        if (!externalMarketId) continue
        if (!emittedMarkets.has(externalMarketId)) {
          emittedMarkets.add(externalMarketId)
          records.push(market)
        }
        const fill = fillFromProviderRow(row, token)
        if (fill) records.push(fill)
      }
    } else {
      for (const row of rows) {
        const type = nonEmptyString(row.type)?.toUpperCase()
        if (!type) continue
        if (type === 'TRADE' && row.is_combo !== true) continue
        if (type === 'DEPOSIT' || type === 'WITHDRAWAL') {
          const movement = cashMovementFromActivity(row)
          if (movement) records.push(movement)
          continue
        }
        const activityFact = activityFactFromRow(row)
        if (activityFact) records.push(activityFact)
      }
    }

    try {
      return records.map((record) => normalizedRecordSchema.parse(record))
    } catch {
      throw new ProviderAdapterError('invalid_normalized_polymarket_record', false)
    }
  }

  private async fetchPositions(request: FetchPageRequest): Promise<ProviderPage> {
    const query = new URLSearchParams({
      user: request.externalAccountId.toLowerCase(),
      limit: String(PAGE_SIZE),
      status: 'OPEN',
      sort_by: 'TIMESTAMP',
      sort_direction: 'DESC',
      filter_type: 'TOKENS',
      filter_amount: '0',
      include_archived: 'true',
    })
    if (request.cursor) query.set('cursor', request.cursor)
    const envelope = envelopeSchema.parse(await this.client.getData('positions', query, request.signal))
    const rows = envelope.data ?? []
    const nextCursor = envelope.pagination?.next_cursor ?? null
    const retrievedAt = new Date().toISOString()
    return {
      payload: { stream: 'positions', rows, tokenRows: [], retrievedAt } satisfies PagePayload,
      nextCursor,
      checkpoint: null,
      coverage: {
        positions: partialCoverage('provider_position_filter_and_snapshot_order'),
        prices: partialCoverage('provider_mark_timestamp_unavailable'),
      },
    }
  }

  private async fetchTrades(request: FetchPageRequest): Promise<ProviderPage> {
    const window = windowForRequest(request, new Date())
    const query = new URLSearchParams({
      user: request.externalAccountId.toLowerCase(),
      limit: String(PAGE_SIZE),
      taker_only: 'false',
      start: String(window.start),
      end: String(window.end),
    })
    if (request.cursor) query.set('cursor', request.cursor)
    const envelope = envelopeSchema.parse(await this.client.getData('trades', query, request.signal))
    const rows = envelope.data ?? []
    const firstIds = uniqueTokenIds(rows.map((row) => row.token_id))
    const firstTokenRows = await this.fetchTokenRows(firstIds, request.signal)
    const oppositeIds = uniqueTokenIds(firstTokenRows.map((row) => row.opposite_token_id))
    const known = new Set(firstTokenRows.map((row) => nonEmptyString(row.token_id)).filter((id): id is string => id !== null))
    const missingOppositeIds = oppositeIds.filter((id) => !known.has(id))
    const secondTokenRows = missingOppositeIds.length > 0
      ? await this.fetchTokenRows(missingOppositeIds, request.signal)
      : []
    return {
      payload: {
        stream: 'trades', rows, tokenRows: [...firstTokenRows, ...secondTokenRows], retrievedAt: new Date().toISOString(),
      } satisfies PagePayload,
      nextCursor: envelope.pagination?.next_cursor ?? null,
      checkpoint: JSON.stringify(window),
      coverage: {
        fills: partialCoverage('provider_trade_id_not_exposed'),
        markets: partialCoverage('wallet_scoped_market_metadata'),
      },
    }
  }

  private async fetchActivity(request: FetchPageRequest): Promise<ProviderPage> {
    const window = windowForRequest(request, new Date())
    const query = new URLSearchParams({
      user: request.externalAccountId.toLowerCase(),
      limit: String(PAGE_SIZE),
      exclude_deposits_withdrawals: 'false',
      start: String(window.start),
      end: String(window.end),
    })
    if (request.cursor) query.set('cursor', request.cursor)
    const envelope = envelopeSchema.parse(await this.client.getData('activity', query, request.signal))
    return {
      payload: {
        stream: 'activity', rows: envelope.data ?? [], tokenRows: [], retrievedAt: new Date().toISOString(),
      } satisfies PagePayload,
      nextCursor: envelope.pagination?.next_cursor ?? null,
      checkpoint: JSON.stringify(window),
      coverage: {
        activity: partialCoverage('provider_activity_id_not_exposed'),
        cash_movements: partialCoverage('provider_cash_asset_identity_unavailable'),
      },
    }
  }

  private async fetchTokenRows(tokenIds: string[], signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    for (let index = 0; index < tokenIds.length; index += 50) {
      const query = new URLSearchParams({ token_id: tokenIds.slice(index, index + 50).join(',') })
      const envelope = tokenEnvelopeSchema.parse(await this.client.getData('tokens', query, signal))
      rows.push(...(envelope.data ?? []))
    }
    return rows
  }
}

function windowForRequest(request: FetchPageRequest, now: Date): TimeWindow {
  const saved = request.checkpoint === null ? null : parseWindow(request.checkpoint)
  if (request.cursor !== null) {
    if (!saved) throw new ProviderAdapterError('polymarket_sync_window_missing', false)
    return saved
  }
  const end = Math.floor(now.getTime() / 1_000)
  return saved
    ? { start: Math.max(1, saved.end - HISTORY_OVERLAP_SECONDS), end }
    : { start: 1, end }
}

function parseWindow(value: string): TimeWindow | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (typeof parsed.start !== 'number' || typeof parsed.end !== 'number' || parsed.start < 1 || parsed.end < parsed.start) return null
    return { start: parsed.start, end: parsed.end }
  } catch {
    return null
  }
}

function partialCoverage(reasonCode: string): EntityCoverageReport {
  return { status: 'partial', coverageStart: null, coverageEnd: null, sourceAsOf: null, reasonCode }
}

function marketFromPosition(row: Record<string, unknown>): Record<string, unknown> | null {
  const conditionId = nonEmptyString(row.condition_id)
  const tokenId = nonEmptyString(row.token_id)
  const oppositeTokenId = nonEmptyString(row.opposite_token_id)
  const title = nonEmptyString(row.title)
  if (!conditionId || !tokenId || !oppositeTokenId || !title) return null
  const outcome = nonEmptyString(row.outcome) ?? 'Outcome 0'
  const oppositeOutcome = nonEmptyString(row.opposite_outcome) ?? 'Outcome 1'
  const resolved = row.redeemable === true || row.status === 'REDEEMABLE' || row.status === 'REDEEMABLE_LOST'
  const eventId = nonEmptyString(row.event_id) ?? nonEmptyString(row.event_slug) ?? conditionId
  const eventName = nonEmptyString(row.event_slug) ?? title
  return {
    kind: 'market',
    externalEventId: eventId,
    eventName,
    eventDescription: null,
    resolutionRules: null,
    eventLifecycle: resolved ? 'resolved' : row.archived === true ? 'archived' : 'open',
    eventResolvesAt: null,
    externalMarketId: conditionId,
    marketTitle: title,
    marketLifecycle: resolved ? 'resolved' : row.archived === true ? 'archived' : 'open',
    settlementRules: null,
    settlementAssetCode: null,
    eventSourceUpdatedAt: null,
    sourceUpdatedAt: null,
    outcomes: [
      { externalId: tokenId, name: outcome, outcomeType: 'provider_outcome', payoutAmount: null, settlementAssetCode: null },
      { externalId: oppositeTokenId, name: oppositeOutcome, outcomeType: 'provider_outcome', payoutAmount: null, settlementAssetCode: null },
    ],
    rawPayload: minimalPositionPayload(row),
  }
}

function positionFromProviderRow(row: Record<string, unknown>, retrievedAt: string): Record<string, unknown> | null {
  const externalId = nonEmptyString(row.token_id)
  const externalMarketId = nonEmptyString(row.condition_id)
  const quantity = decimalString(row.current_size)
  if (!externalId || !externalMarketId || quantity === null) return null
  return {
    kind: 'position',
    externalId,
    externalMarketId,
    externalInstrumentId: externalId,
    observedAt: retrievedAt,
    quantity,
    averageCostPrice: decimalString(row.avg_price),
    markPrice: decimalString(row.current_price),
    markAt: null,
    settlementAssetCode: null,
    origin: 'provider_reported',
    reconciliationStatus: 'not_started',
    providerStatus: nonEmptyString(row.status),
    redeemable: booleanOrNull(row.redeemable),
    mergeable: booleanOrNull(row.mergeable),
    archived: booleanOrNull(row.archived),
    providerReported: {
      currentValue: decimalString(row.current_value),
      realizedPnl: decimalString(row.realized_pnl),
      unrealizedPnl: decimalString(row.unrealized_pnl),
      totalPnl: decimalString(row.total_pnl),
      entryCost: decimalString(row.entry_cost_usdc),
      entryFees: decimalString(row.entry_fees_usdc),
      totalCost: decimalString(row.total_cost_usdc),
      totalSize: decimalString(row.total_size),
      percentPnl: decimalString(row.percent_pnl),
    },
    rawPayload: minimalPositionPayload(row),
  }
}

function priceFromPosition(row: Record<string, unknown>, retrievedAt: string): Record<string, unknown> | null {
  const externalInstrumentId = nonEmptyString(row.token_id)
  const externalMarketId = nonEmptyString(row.condition_id)
  const price = decimalString(row.current_price)
  if (!externalInstrumentId || !externalMarketId || price === null) return null
  return {
    kind: 'price',
    externalId: `data-api-mark:${externalInstrumentId}`,
    externalMarketId,
    externalInstrumentId,
    observedAt: retrievedAt,
    price,
    priceKind: 'data_api_current_mark',
    assetCode: 'USDC',
    rawPayload: {
      token_id: externalInstrumentId,
      condition_id: externalMarketId,
      current_price: price,
      timestamp_basis: 'scevia_retrieved_at',
    },
  }
}

function fillFromProviderRow(row: Record<string, unknown>, token: Record<string, unknown>): Record<string, unknown> | null {
  const externalMarketId = nonEmptyString(row.condition_id)
  const externalInstrumentId = nonEmptyString(row.token_id)
  const side = nonEmptyString(row.side)?.toUpperCase()
  const occurredAt = epochSecondsToIso(row.timestamp)
  const quantity = decimalString(row.size)
  const price = decimalString(row.price)
  const transactionHash = nonEmptyString(row.transaction_hash)?.toLowerCase() ?? null
  if (!externalMarketId || !externalInstrumentId || (side !== 'BUY' && side !== 'SELL') || !occurredAt || quantity === null || price === null) return null
  const id = fingerprint('trade', [
    nonEmptyString(row.proxy_wallet)?.toLowerCase() ?? '', transactionHash ?? '', externalMarketId,
    externalInstrumentId, side, occurredAt, quantity, price,
  ])
  return {
    kind: 'fill',
    externalId: `polymarket-v2:${id}`,
    externalMarketId,
    externalInstrumentId,
    direction: side.toLowerCase(),
    occurredAt,
    quantity,
    price,
    feeAmount: null,
    feeStatus: 'unavailable',
    settlementAssetCode: 'USDC',
    finality: 'unknown',
    rawPayload: {
      transaction_hash: transactionHash,
      proxy_wallet: nonEmptyString(row.proxy_wallet)?.toLowerCase() ?? null,
      condition_id: externalMarketId,
      token_id: externalInstrumentId,
      side,
      timestamp: Number(row.timestamp),
      size: quantity,
      price,
      token_outcome: nonEmptyString(token.outcome),
    },
  }
}

function marketFromTokenPair(
  token: Record<string, unknown>,
  opposite: Record<string, unknown>,
  trade: Record<string, unknown>,
): Record<string, unknown> | null {
  const marketId = nonEmptyString(token.condition_id)
  const tokenId = nonEmptyString(token.token_id)
  const oppositeId = nonEmptyString(opposite.token_id)
  const title = nonEmptyString(token.title) ?? nonEmptyString(trade.title)
  if (!marketId || !tokenId || !oppositeId || !title) return null
  if (nonEmptyString(opposite.condition_id) !== marketId) return null
  const eventSlug = nonEmptyString(token.event_slug) ?? nonEmptyString(trade.event_slug)
  const eventId = nonEmptyString(token.event_id) ?? eventSlug ?? marketId
  const lifecycle = token.resolved === true || opposite.resolved === true
    ? 'resolved'
    : token.closed === true || opposite.closed === true ? 'closed' : 'open'
  return {
    kind: 'market',
    externalEventId: eventId,
    eventName: eventSlug ?? title,
    eventDescription: null,
    resolutionRules: null,
    eventLifecycle: lifecycle,
    eventResolvesAt: null,
    externalMarketId: marketId,
    marketTitle: title,
    marketLifecycle: lifecycle,
    settlementRules: null,
    settlementAssetCode: null,
    eventSourceUpdatedAt: null,
    sourceUpdatedAt: null,
    outcomes: [
      {
        externalId: tokenId,
        name: nonEmptyString(token.outcome) ?? `Outcome ${String(token.outcome_index ?? '0')}`,
        outcomeType: 'provider_outcome',
        payoutAmount: decimalString(token.final_price),
        settlementAssetCode: null,
      },
      {
        externalId: oppositeId,
        name: nonEmptyString(opposite.outcome) ?? `Outcome ${String(opposite.outcome_index ?? '1')}`,
        outcomeType: 'provider_outcome',
        payoutAmount: decimalString(opposite.final_price),
        settlementAssetCode: null,
      },
    ],
    rawPayload: {
      condition_id: marketId,
      event_id: eventId,
      event_slug: eventSlug,
      title,
      version: nonEmptyString(token.module),
      outcomes: [tokenId, oppositeId],
    },
  }
}

function cashMovementFromActivity(row: Record<string, unknown>): Record<string, unknown> | null {
  const activityType = nonEmptyString(row.type)?.toUpperCase()
  const occurredAt = epochSecondsToIso(row.timestamp)
  const amount = decimalString(row.usdc_size)
  if ((activityType !== 'DEPOSIT' && activityType !== 'WITHDRAWAL') || !occurredAt || amount === null) return null
  const absoluteAmount = new Decimal(amount).abs()
  if (absoluteAmount.isZero()) return null
  const movementKind = activityType === 'DEPOSIT' ? 'deposit' : 'withdrawal'
  const signedAmount = movementKind === 'deposit' ? absoluteAmount.toFixed() : absoluteAmount.negated().toFixed()
  const id = fingerprint('cash', activityIdentity(row, occurredAt, amount))
  return {
    kind: 'cash_movement',
    externalId: `polymarket-v2:${id}`,
    movementKind,
    occurredAt,
    signedAmount,
    assetCode: 'USDC',
    feeAmount: null,
    feeStatus: 'unavailable',
    rawPayload: minimalActivityPayload(row),
  }
}

function activityFactFromRow(row: Record<string, unknown>): Record<string, unknown> | null {
  const activityType = nonEmptyString(row.type)?.toUpperCase()
  const occurredAt = epochSecondsToIso(row.timestamp)
  if (!activityType || !occurredAt) return null
  const amount = decimalString(row.usdc_size)
  const quantity = decimalString(row.size)
  const id = fingerprint('activity', activityIdentity(row, occurredAt, amount ?? quantity ?? ''))
  return {
    kind: 'activity_fact',
    externalId: `polymarket-v2:${id}`,
    activityType,
    occurredAt,
    transactionHash: nonEmptyString(row.transaction_hash)?.toLowerCase() ?? null,
    externalMarketId: nonEmptyString(row.condition_id),
    externalInstrumentId: nonEmptyString(row.token_id),
    side: nonEmptyString(row.side),
    quantity,
    amount,
    assetCode: amount === null ? null : 'USDC',
    rawPayload: minimalActivityPayload(row),
  }
}

function activityIdentity(row: Record<string, unknown>, occurredAt: string, amount: string): unknown[] {
  return [
    nonEmptyString(row.proxy_wallet)?.toLowerCase() ?? '',
    nonEmptyString(row.transaction_hash)?.toLowerCase() ?? '',
    nonEmptyString(row.type)?.toUpperCase() ?? '',
    occurredAt,
    nonEmptyString(row.condition_id) ?? '',
    nonEmptyString(row.token_id) ?? '',
    nonEmptyString(row.side) ?? '',
    decimalString(row.size) ?? '',
    amount,
  ]
}

function minimalActivityPayload(row: Record<string, unknown>): Record<string, unknown> {
  return {
    type: nonEmptyString(row.type)?.toUpperCase() ?? null,
    transaction_hash: nonEmptyString(row.transaction_hash)?.toLowerCase() ?? null,
    proxy_wallet: nonEmptyString(row.proxy_wallet)?.toLowerCase() ?? null,
    timestamp: Number.isFinite(Number(row.timestamp)) ? Number(row.timestamp) : null,
    condition_id: nonEmptyString(row.condition_id),
    token_id: nonEmptyString(row.token_id),
    side: nonEmptyString(row.side),
    size: decimalString(row.size),
    usdc_size: decimalString(row.usdc_size),
    price: decimalString(row.price),
    outcome_index: integerOrNull(row.outcome_index),
    is_combo: booleanOrNull(row.is_combo),
  }
}

function minimalPositionPayload(row: Record<string, unknown>): Record<string, unknown> {
  return {
    proxy_wallet: nonEmptyString(row.proxy_wallet)?.toLowerCase() ?? null,
    token_id: nonEmptyString(row.token_id),
    condition_id: nonEmptyString(row.condition_id),
    status: nonEmptyString(row.status),
    current_size: decimalString(row.current_size),
    avg_price: decimalString(row.avg_price),
    current_price: decimalString(row.current_price),
    current_value: decimalString(row.current_value),
    entry_cost_usdc: decimalString(row.entry_cost_usdc),
    entry_fees_usdc: decimalString(row.entry_fees_usdc),
    total_cost_usdc: decimalString(row.total_cost_usdc),
    total_size: decimalString(row.total_size),
    realized_pnl: decimalString(row.realized_pnl),
    unrealized_pnl: decimalString(row.unrealized_pnl),
    total_pnl: decimalString(row.total_pnl),
    redeemable: booleanOrNull(row.redeemable),
    mergeable: booleanOrNull(row.mergeable),
    archived: booleanOrNull(row.archived),
  }
}

function uniqueTokenIds(values: unknown[]): string[] {
  return Array.from(new Set(values.map(nonEmptyString).filter((value): value is string => value !== null && TOKEN_ID_PATTERN.test(value))))
}

function fingerprint(prefix: string, values: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(values)).digest('hex')
  return `${prefix}:${digest}`
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function integerOrNull(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) ? number : null
}

function epochSecondsToIso(value: unknown): string | null {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null
  const date = new Date(seconds * 1_000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

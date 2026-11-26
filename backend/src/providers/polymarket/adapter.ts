import type { PolymarketCollateralReader } from './collateral.js'
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
  stream: 'positions' | 'closed_positions' | 'trades' | 'activity'
  positionStatus?: 'OPEN' | 'CLOSED'
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
        auxiliaryEntities: ['activity'],
        strategy: 'full_refresh',
        snapshotSemantics: { positions: 'incremental' },
      },
      {
        name: 'closed_positions',
        entities: [],
        auxiliaryEntities: ['activity'],
        strategy: 'provider_checkpoint',
        snapshotSemantics: {},
      },
      {
        name: 'trades',
        entities: ['markets', 'fills'],
        auxiliaryEntities: ['activity'],
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

  constructor(private readonly client = new PolymarketHttpClient(), private readonly collateral?: PolymarketCollateralReader) {
    if (collateral) {
      this.capabilities.operations.cash_balances = 'supported'
      this.capabilities.streams.unshift({ name: 'polygon_pusd_balance', entities: ['cash_balances'], strategy: 'full_refresh',
        snapshotSemantics: { cash_balances: 'complete' } })
    }
  }

  async fetchPage(request: FetchPageRequest): Promise<ProviderPage> {
    if (!ADDRESS_PATTERN.test(request.externalAccountId)) {
      throw new ProviderAdapterError('invalid_polymarket_wallet_address', false)
    }
    try {
      if (request.streamName === 'polygon_pusd_balance' && this.collateral) {
        const record = await this.collateral.balance(request.externalAccountId, request.signal)
        return { payload: [record], nextCursor: null, checkpoint: null,
          coverage: { cash_balances: { status: 'complete', sourceAsOf: record.kind === 'cash_balance' ? record.observedAt : null,
            reasonCode: 'polygon_finalized_pusd_wallet_balance_only' } } }
      }
      if (request.streamName === 'positions' || request.streamName === 'closed_positions') return await this.fetchPositions(request)
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
    if (streamName === 'polygon_pusd_balance') return z.array(normalizedRecordSchema).parse(page.payload)
    const parsedPayload = z.object({
      stream: z.enum(['positions', 'closed_positions', 'trades', 'activity']),
      positionStatus: z.enum(['OPEN', 'CLOSED']).optional(),
      rows: z.array(z.record(z.string(), z.unknown())).max(PAGE_SIZE),
      tokenRows: z.array(z.record(z.string(), z.unknown())).max(PAGE_SIZE * 4),
      retrievedAt: z.string().datetime({ offset: true }),
    }).strict().safeParse(page.payload)
    if (!parsedPayload.success || parsedPayload.data.stream !== streamName) {
      throw new ProviderAdapterError('invalid_provider_payload', false)
    }
    const { rows, tokenRows, retrievedAt } = parsedPayload.data
    const records: unknown[] = []
    let sourceRowsRetained = 0
    let invalidRecords = 0

    if (streamName === 'positions' || streamName === 'closed_positions') {
      for (const row of rows) {
        const historical = streamName === 'closed_positions'
          || parsedPayload.data.positionStatus === 'CLOSED'
          || nonEmptyString(row.status)?.toUpperCase() === 'CLOSED'
        const market = historical ? null : marketFromPosition(row)
        if (market) records.push(market)
        const position = historical ? null : positionFromProviderRow(row, retrievedAt, parsedPayload.data.positionStatus)
        if (position) {
          sourceRowsRetained += 1
          records.push(position)
          const price = priceFromPosition(row, retrievedAt)
          if (price) records.push(price)
        } else {
          const unresolved = hasRetainableSourceEvidence(row)
            ? activityFactFromRow(row, 'unresolved', historical ? 'historical_closure_not_current_balance' : 'position_fields_invalid',
              'positions', historical ? 'POSITION_CLOSURE' : 'POSITION_UNRESOLVED')
            : null
          if (unresolved) {
            records.push({
              ...unresolved,
              rawPayload: { ...(unresolved.rawPayload as Record<string, unknown>), ...minimalPositionPayload(row) },
            })
            sourceRowsRetained += 1
          } else invalidRecords += 1
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
        if (!token || !opposite) {
          const unresolved = unresolvedTradeFact(row, !token ? 'token_metadata_missing' : 'opposite_token_metadata_missing')
          if (unresolved) { records.push(unresolved); sourceRowsRetained += 1 } else invalidRecords += 1
          continue
        }
        const market = marketFromTokenPair(token, opposite, row)
        if (!market) {
          const unresolved = unresolvedTradeFact(row, 'market_metadata_invalid')
          if (unresolved) { records.push(unresolved); sourceRowsRetained += 1 } else invalidRecords += 1
          continue
        }
        const externalMarketId = nonEmptyString(market.externalMarketId)
        if (!externalMarketId) {
          const unresolved = unresolvedTradeFact(row, 'market_identity_missing')
          if (unresolved) { records.push(unresolved); sourceRowsRetained += 1 } else invalidRecords += 1
          continue
        }
        if (!emittedMarkets.has(externalMarketId)) {
          emittedMarkets.add(externalMarketId)
          records.push(market)
        }
        const fill = fillFromProviderRow(row, token)
        if (fill) { records.push(fill); sourceRowsRetained += 1 }
        else {
          const unresolved = unresolvedTradeFact(row, nativeTradeId(row) ? 'trade_fields_invalid' : 'trade_identity_ambiguous')
          if (unresolved) { records.push(unresolved); sourceRowsRetained += 1 } else invalidRecords += 1
        }
      }
    } else {
      for (const row of rows) {
        const type = nonEmptyString(row.type)?.toUpperCase().slice(0, 64)
        if (!type) {
          const unresolved = hasRetainableSourceEvidence(row)
            ? activityFactFromRow(row, 'unresolved', 'activity_type_missing', 'activity', 'UNKNOWN_ACTIVITY')
            : null
          if (unresolved) { records.push(unresolved); sourceRowsRetained += 1 } else invalidRecords += 1
          continue
        }
        if (type === 'TRADE') {
          const overlap = activityFactFromRow(row, 'overlap_candidate', null, 'activity')
          if (overlap) { records.push(overlap); sourceRowsRetained += 1 } else invalidRecords += 1
          continue
        }
        if (type === 'DEPOSIT' || type === 'WITHDRAWAL') {
          const nativeId = nativeActivityId(row)
          const movement = nativeId ? cashMovementFromActivity(row, nativeId) : null
          if (movement) { records.push(movement); sourceRowsRetained += 1 }
          else {
            const unresolved = activityFactFromRow(row, 'unresolved', nativeId ? 'cash_movement_fields_invalid' : 'cash_movement_identity_ambiguous', 'activity')
            if (unresolved) { records.push(unresolved); sourceRowsRetained += 1 } else invalidRecords += 1
          }
          continue
        }
        const activityFact = activityFactFromRow(row)
        if (activityFact) { records.push(activityFact); sourceRowsRetained += 1 } else invalidRecords += 1
      }
    }

    page.diagnostics = { ...page.diagnostics, sourceRowsRetained, invalidRecords }
    const unresolvedRows = records.filter((record) => typeof record === 'object' && record !== null
      && (record as { kind?: unknown }).kind === 'activity_fact'
      && (record as { classification?: unknown }).classification === 'unresolved').length
    const coverageReason = invalidRecords > 0 ? 'provider_records_rejected'
      : unresolvedRows > 0 && streamName === 'trades' ? 'unresolved_trade_rows'
        : unresolvedRows > 0 ? 'unresolved_activity_rows' : null
    if (coverageReason !== null) {
      const affectedEntities = streamName === 'positions' ? ['positions']
        : streamName === 'trades' ? ['fills']
          : ['activity', 'cash_movements']
      for (const entity of affectedEntities) {
        const prior = page.coverage[entity as keyof ProviderPage['coverage']]
        if (prior && prior.reasonCode !== 'account_identity_mismatch') {
          page.coverage[entity as keyof ProviderPage['coverage']] = { ...prior, status: 'partial', reasonCode: coverageReason }
        }
      }
    }
    try {
      return records.map((record) => normalizedRecordSchema.parse(record))
    } catch {
      throw new ProviderAdapterError('invalid_normalized_polymarket_record', false)
    }
  }

  private async fetchPositions(request: FetchPageRequest): Promise<ProviderPage> {
    const status = request.streamName === 'closed_positions' ? 'CLOSED' : 'OPEN'
    const positionPage = { status, cursor: decodePositionCursor(request.cursor).cursor }
    const query = new URLSearchParams({
      user: request.externalAccountId.toLowerCase(),
      limit: String(PAGE_SIZE),
      status: positionPage.status,
      sort_by: 'TIMESTAMP',
      sort_direction: 'DESC',
      filter_type: 'TOKENS',
      filter_amount: '0',
      include_archived: 'true',
    })
    if (positionPage.cursor) query.set('cursor', positionPage.cursor)
    const envelope = envelopeSchema.parse(await this.client.getData('positions', query, request.signal))
    const returnedRows = envelope.data ?? []
    const { rows, excludedRecords } = validateAccountRows(returnedRows, request.externalAccountId)
    const nextCursor = envelope.pagination?.next_cursor ?? null
    const cursorAfterPage = nextCursor !== null
      ? encodePositionCursor(status, nextCursor)
      : null
    const retrievedAt = new Date().toISOString()
    return {
      payload: { stream: status === 'OPEN' ? 'positions' : 'closed_positions', positionStatus: status, rows, tokenRows: [], retrievedAt } satisfies PagePayload,
      nextCursor: cursorAfterPage,
      checkpoint: null,
      diagnostics: { upstreamRowsReceived: returnedRows.length, excludedRecords },
      coverage: status === 'CLOSED' ? {} : {
        positions: partialCoverage(excludedRecords > 0 ? 'account_identity_mismatch' : 'provider_position_filter_and_snapshot_order'),
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
    const returnedRows = envelope.data ?? []
    const { rows, excludedRecords } = validateAccountRows(returnedRows, request.externalAccountId)
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
      diagnostics: { upstreamRowsReceived: returnedRows.length, excludedRecords },
      coverage: {
        fills: partialCoverage(excludedRecords > 0 ? 'account_identity_mismatch' : 'provider_trade_id_not_exposed'),
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
    const returnedRows = envelope.data ?? []
    const { rows, excludedRecords } = validateAccountRows(returnedRows, request.externalAccountId)
    return {
      payload: {
        stream: 'activity', rows, tokenRows: [], retrievedAt: new Date().toISOString(),
      } satisfies PagePayload,
      nextCursor: envelope.pagination?.next_cursor ?? null,
      checkpoint: JSON.stringify(window),
      diagnostics: { upstreamRowsReceived: returnedRows.length, excludedRecords },
      coverage: {
        activity: partialCoverage(excludedRecords > 0 ? 'account_identity_mismatch' : 'provider_activity_id_not_exposed'),
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

function decodePositionCursor(value: string | null): { status: 'OPEN' | 'CLOSED'; cursor: string | null } {
  if (value === null) return { status: 'OPEN', cursor: null }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if ((parsed.status === 'OPEN' || parsed.status === 'CLOSED')
      && (parsed.cursor === null || typeof parsed.cursor === 'string')) {
      return { status: parsed.status, cursor: parsed.cursor as string | null }
    }
  } catch {
    // Older checkpoints stored the provider cursor directly; resume them as OPEN.
  }
  return { status: 'OPEN', cursor: value }
}

function encodePositionCursor(status: 'OPEN' | 'CLOSED', cursor: string | null): string {
  return JSON.stringify({ status, cursor })
}

function validateAccountRows(
  rows: Record<string, unknown>[],
  requestedAccount: string,
): { rows: Record<string, unknown>[]; excludedRecords: number } {
  const normalizedRequested = requestedAccount.toLowerCase()
  const validRows: Record<string, unknown>[] = []
  let excludedRecords = 0
  for (const row of rows) {
    const hasProxyWallet = Object.hasOwn(row, 'proxy_wallet') || Object.hasOwn(row, 'proxyWallet')
    const returnedAccount = nonEmptyString(row.proxy_wallet) ?? nonEmptyString(row.proxyWallet)
    // The documented request is scoped by `user`; older response shapes may omit proxy_wallet.
    if (!hasProxyWallet) {
      validRows.push(row)
      continue
    }
    if (returnedAccount === null || !ADDRESS_PATTERN.test(returnedAccount) || returnedAccount.toLowerCase() !== normalizedRequested) {
      excludedRecords += 1
      continue
    }
    validRows.push(row)
  }
  return { rows: validRows, excludedRecords }
}

function marketFromPosition(row: Record<string, unknown>): Record<string, unknown> | null {
  const conditionId = nonEmptyString(row.condition_id)
  const tokenId = nonEmptyString(row.token_id)
  const oppositeTokenId = nonEmptyString(row.opposite_token_id)
  const title = nonEmptyString(row.title)
  if (!conditionId || !tokenId || !oppositeTokenId || !title) return null
  const outcome = nonEmptyString(row.outcome) ?? 'Outcome 0'
  const oppositeOutcome = nonEmptyString(row.opposite_outcome) ?? 'Outcome 1'
  const eventIdentity = providerEventIdentity(row.event_id, row.event_slug, conditionId)
  const eventName = nonEmptyString(row.event_slug) ?? title
  return {
    kind: 'market',
    externalEventId: eventIdentity.externalId,
    eventIdentityKind: eventIdentity.kind,
    eventName,
    eventDescription: null,
    resolutionRules: null,
    // A wallet position can indicate market state, but it cannot determine the event lifecycle.
    eventLifecycle: 'unknown',
    eventResolvesAt: null,
    externalMarketId: conditionId,
    marketTitle: title,
    marketLifecycle: 'unknown',
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

function positionFromProviderRow(
  row: Record<string, unknown>,
  retrievedAt: string,
  queriedStatus: 'OPEN' | 'CLOSED' | undefined,
): Record<string, unknown> | null {
  const externalId = nonEmptyString(row.token_id)
  const externalMarketId = nonEmptyString(row.condition_id)
  const providerStatus = nonEmptyString(row.status)?.toUpperCase() ?? queriedStatus ?? null
  const quantity = row.current_size === undefined || row.current_size === null
    ? providerStatus === 'CLOSED' ? '0' : null
    : decimalString(row.current_size)
  const averageCostPrice = probabilityPrice(row.avg_price)
  const markPrice = probabilityPrice(row.current_price)
  const invalidProvidedPrice = (row.avg_price !== undefined && row.avg_price !== null && averageCostPrice === null)
    || (row.current_price !== undefined && row.current_price !== null && markPrice === null)
  if (!externalId || !externalMarketId || quantity === null || new Decimal(quantity).lessThan(0) || invalidProvidedPrice) return null
  return {
    kind: 'position',
    externalId,
    externalMarketId,
    externalInstrumentId: externalId,
    observedAt: retrievedAt,
    quantity,
    averageCostPrice,
    markPrice,
    markAt: null,
    settlementAssetCode: null,
    origin: 'provider_reported',
    reconciliationStatus: 'not_started',
    providerStatus,
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
    rawPayload: { ...minimalPositionPayload(row), queried_status: queriedStatus ?? null },
  }
}

function priceFromPosition(row: Record<string, unknown>, retrievedAt: string): Record<string, unknown> | null {
  const externalInstrumentId = nonEmptyString(row.token_id)
  const externalMarketId = nonEmptyString(row.condition_id)
  const price = probabilityPrice(row.current_price)
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

function probabilityPrice(value: unknown): string | null {
  const price = decimalString(value)
  if (price === null) return null
  const decimal = new Decimal(price)
  return decimal.greaterThanOrEqualTo(0) && decimal.lessThanOrEqualTo(1) ? price : null
}

function nativeTradeId(row: Record<string, unknown>): string | null {
  return nonEmptyString(row.id) ?? nonEmptyString(row.trade_id) ?? nonEmptyString(row.tradeId)
}

function fillFromProviderRow(
  row: Record<string, unknown>,
  token: Record<string, unknown>,
): Record<string, unknown> | null {
  const externalMarketId = nonEmptyString(row.condition_id)
  const externalInstrumentId = nonEmptyString(row.token_id)
  const side = nonEmptyString(row.side)?.toUpperCase()
  const occurredAt = epochSecondsToIso(row.timestamp)
  const quantity = decimalString(row.size)
  const price = decimalString(row.price)
  const transactionHash = nonEmptyString(row.transaction_hash)?.toLowerCase() ?? null
  if (!externalMarketId || !externalInstrumentId || (side !== 'BUY' && side !== 'SELL') || !occurredAt || quantity === null
    || new Decimal(quantity).lessThanOrEqualTo(0) || price === null || new Decimal(price).lessThan(0) || new Decimal(price).greaterThan(1)) return null
  const nativeId = nativeTradeId(row)
  if (!nativeId) return null
  return {
    kind: 'fill',
    externalId: `polymarket-v2:provider:${nativeId}`,
    identityKind: 'provider_native',
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
      timestamp: Number.isFinite(Number(row.timestamp)) ? Number(row.timestamp) : null,
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
  if (nonEmptyString(opposite.condition_id) !== marketId || nonEmptyString(trade.condition_id) !== marketId) return null
  const eventSlug = nonEmptyString(token.event_slug) ?? nonEmptyString(trade.event_slug)
  const eventIdentity = providerEventIdentity(token.event_id ?? trade.event_id, eventSlug, marketId)
  const lifecycle = token.resolved === true || opposite.resolved === true
    ? 'resolved'
    : token.closed === true || opposite.closed === true ? 'closed' : 'open'
  return {
    kind: 'market',
    externalEventId: eventIdentity.externalId,
    eventIdentityKind: eventIdentity.kind,
    eventName: eventSlug ?? title,
    eventDescription: null,
    resolutionRules: null,
    eventLifecycle: 'unknown',
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
      event_id: nonEmptyString(token.event_id) ?? nonEmptyString(trade.event_id),
      event_slug: eventSlug,
      event_identity_kind: eventIdentity.kind,
      title,
      version: nonEmptyString(token.module),
      outcomes: [tokenId, oppositeId],
    },
  }
}

function cashMovementFromActivity(row: Record<string, unknown>, nativeId: string): Record<string, unknown> | null {
  const activityType = nonEmptyString(row.type)?.toUpperCase()
  const occurredAt = epochSecondsToIso(row.timestamp)
  const amount = decimalString(row.usdc_size)
  if ((activityType !== 'DEPOSIT' && activityType !== 'WITHDRAWAL') || !occurredAt || amount === null) return null
  const absoluteAmount = new Decimal(amount).abs()
  if (absoluteAmount.isZero()) return null
  const movementKind = activityType === 'DEPOSIT' ? 'deposit' : 'withdrawal'
  const signedAmount = movementKind === 'deposit' ? absoluteAmount.toFixed() : absoluteAmount.negated().toFixed()
  const id = `activity:provider:${activityType}:${nativeId}`
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

function activityFactFromRow(
  row: Record<string, unknown>,
  classification: 'unreconciled' | 'unresolved' | 'overlap_candidate' = 'unreconciled',
  resolutionReason: string | null = null,
  sourceEndpoint: 'activity' | 'trades' | 'positions' = 'activity',
  activityTypeOverride: string | null = null,
): Record<string, unknown> | null {
  const activityType = activityTypeOverride ?? nonEmptyString(row.type)?.toUpperCase().slice(0, 64)
  const occurredAt = epochSecondsToIso(row.timestamp)
  if (!activityType || !hasRetainableSourceEvidence(row)) return null
  const reportedAmount = decimalString(row.usdc_size ?? row.current_value)
  const amount = reportedAmount === null ? null : activityType === 'WITHDRAWAL'
    ? new Decimal(reportedAmount).abs().negated().toFixed()
    : activityType === 'DEPOSIT' ? new Decimal(reportedAmount).abs().toFixed() : reportedAmount
  const quantity = decimalString(row.size ?? row.current_size)
  const id = sourceObservationIdentity(row, activityType, occurredAt)
  return {
    kind: 'activity_fact',
    externalId: `polymarket-v2:${id.value}`,
    identityKind: id.identityKind,
    classification,
    resolutionReason,
    sourceEndpoint,
    activityType,
    occurredAt,
    transactionHash: nonEmptyString(row.transaction_hash)?.toLowerCase() ?? null,
    externalMarketId: nonEmptyString(row.condition_id),
    externalInstrumentId: nonEmptyString(row.token_id),
    side: nonEmptyString(row.side),
    quantity,
    amount,
    price: decimalString(row.price ?? row.current_price),
    assetCode: amount === null ? null : 'USDC',
    rawPayload: { ...minimalActivityPayload(row), source_endpoint: sourceEndpoint, source_identity_kind: id.identityKind, resolution_reason: resolutionReason },
  }
}

function unresolvedTradeFact(row: Record<string, unknown>, reasonCode: string): Record<string, unknown> | null {
  const fact = activityFactFromRow(row, 'unresolved', reasonCode, 'trades', 'TRADE_UNRESOLVED')
  if (!fact || fact.kind !== 'activity_fact') return null
  return { ...fact, activityType: 'TRADE_UNRESOLVED' }
}

function hasRetainableSourceEvidence(row: Record<string, unknown>): boolean {
  return nonEmptyString(row.transaction_hash) !== null
    || nonEmptyString(row.condition_id) !== null
    || nonEmptyString(row.token_id) !== null
    || nonEmptyString(row.proxy_wallet) !== null
    || decimalString(row.size ?? row.current_size) !== null
    || decimalString(row.usdc_size ?? row.current_value) !== null
    || decimalString(row.price ?? row.current_price) !== null
    || epochSecondsToIso(row.timestamp) !== null
}

function sourceObservationIdentity(
  row: Record<string, unknown>,
  type: string,
  occurredAt: string | null,
): { value: string; identityKind: 'provider_native' | 'source_fingerprint' } {
  const nativeId = nativeActivityId(row) ?? nonEmptyString(row.trade_id)
  if (nativeId) return { value: `provider:${type}:${nativeId}`, identityKind: 'provider_native' }
  return {
    value: fingerprint('source-observation', [
      nonEmptyString(row.proxy_wallet)?.toLowerCase() ?? '',
      nonEmptyString(row.transaction_hash)?.toLowerCase() ?? '',
      type,
      occurredAt,
      nonEmptyString(row.condition_id) ?? '',
      nonEmptyString(row.token_id) ?? '',
      nonEmptyString(row.side)?.toUpperCase() ?? '',
      decimalString(row.size ?? row.current_size),
      decimalString(row.usdc_size),
      decimalString(row.price ?? row.current_price),
    ]),
    identityKind: 'source_fingerprint',
  }
}

function providerEventIdentity(
  eventId: unknown,
  eventSlug: unknown,
  marketId: string,
): { externalId: string; kind: 'provider_native' | 'provider_slug' | 'market_scoped_fallback' } {
  const id = nonEmptyString(eventId)
  if (id) return { externalId: `polymarket:event:id:${id}`, kind: 'provider_native' }
  const slug = nonEmptyString(eventSlug)
  if (slug) return { externalId: `polymarket:event:slug:${slug}`, kind: 'provider_slug' }
  return { externalId: `polymarket:event:market:${marketId}`, kind: 'market_scoped_fallback' }
}

function nativeActivityId(row: Record<string, unknown>): string | null {
  return nonEmptyString(row.id) ?? nonEmptyString(row.activity_id)
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

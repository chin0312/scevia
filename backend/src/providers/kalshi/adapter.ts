import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { decimalTextSchema, normalizedRecordSchema, type NormalizedRecord, type ProviderCapabilities, type CoverageEntity } from '../../domain/model.js'
import { ProviderAdapterError, type ProviderAdapter, type ProviderPage } from '../adapter.js'
import { KalshiClient } from './client.js'

const ticker = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,127}$/)
const time = z.iso.datetime({ offset: true })
const side = z.enum(['yes', 'no'])
const outcome = (market: string, leg: string) => market + ':' + leg
const market = z.object({ ticker, event_ticker: ticker, title: z.string().min(1).max(500),
  market_type: z.string(), status: z.string().max(32), close_time: time.optional(), rules_primary: z.string().max(10000).optional() })
const fill = z.object({ exchange_index: z.number().int().optional(), fill_id: z.string().min(1).max(256), market_ticker: ticker, action: z.enum(['buy', 'sell']).optional(),
  side: side.optional(), outcome_side: side.optional(), count_fp: decimalTextSchema, yes_price_dollars: decimalTextSchema,
  no_price_dollars: decimalTextSchema, fee_cost: decimalTextSchema.optional(), created_time: time })
const position = z.object({ ticker, exchange_index: z.number().int().optional(), position_fp: decimalTextSchema, market_exposure_dollars: decimalTextSchema.optional(), last_updated_ts: time.optional() })
const balance = z.object({ balance_dollars: decimalTextSchema.optional(), balance: z.number().int().safe().optional(), updated_ts: z.number().int().min(0).max(8_640_000_000_000) })
const settlement = z.object({ ticker, exchange_index: z.number().int().optional(), settled_time: time, market_result: z.string().max(64),
  yes_count_fp: decimalTextSchema.optional(), no_count_fp: decimalTextSchema.optional(), revenue: z.number().int().safe().optional() })
const cents = z.number().int().safe().min(0)
const epoch = z.number().int().min(0).max(8_640_000_000_000)
const cashActivity = z.object({ id: z.string().min(1).max(128), status: z.string().max(32), type: z.string().max(64),
  amount_cents: cents, fee_cents: cents, created_ts: epoch, finalized_ts: epoch.nullable().optional() })
const creditActivity = z.object({ credit_id: z.string().min(1).max(128), type: z.string().max(64), status: z.string().max(32),
  amount_dollars: decimalTextSchema, created_time: time })
const pageEnvelope = z.object({ cursor: z.string().max(4000).optional() }).passthrough()
const next = z.object({ tier: z.enum(['current', 'historical']), cursor: z.string().max(4000).nullable(), observedAt: time }).strict()
const fail = (reason: string): never => { throw new ProviderAdapterError(reason, false) }

export function normalizeKalshiMarket(value: unknown): NormalizedRecord {
  const row = market.parse(value)
  if (row.market_type !== 'binary') return fail('kalshi_market_structure_unsupported')
  const lifecycle = { active: 'open', closed: 'closed', determined: 'closed', finalized: 'resolved' }[row.status] ?? 'unknown'
  return normalizedRecordSchema.parse({ kind: 'market', externalEventId: row.event_ticker,
    eventName: row.event_ticker, eventDescription: null, resolutionRules: null, eventLifecycle: 'unknown', eventResolvesAt: null,
    externalMarketId: row.ticker, marketTitle: row.title, marketLifecycle: lifecycle, settlementRules: row.rules_primary ?? null,
    settlementAssetCode: 'USD', eventSourceUpdatedAt: null, sourceUpdatedAt: null,
    outcomes: ['yes', 'no'].map((leg) => ({ externalId: outcome(row.ticker, leg), name: leg.toUpperCase(),
      outcomeType: leg, payoutAmount: null, settlementAssetCode: 'USD' })), rawPayload: row })
}

export class KalshiAdapter implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities = {
    providerCode: 'kalshi', displayName: 'Kalshi (restricted)', adapterKind: 'production', accountKinds: ['fixture'],
    operations: { markets: 'supported', fills: 'supported', positions: 'supported', cash_balances: 'supported',
      activity: 'supported', settlements: 'unsupported', cash_movements: 'unsupported', prices: 'unsupported' },
    streams: [
      { name: 'markets', entities: ['markets'], strategy: 'full_refresh', snapshotSemantics: {} },
      { name: 'fills', entities: ['fills'], referenceEntities: ['markets'], auxiliaryEntities: ['activity'], strategy: 'full_refresh', snapshotSemantics: {} },
      { name: 'positions', entities: ['positions'], referenceEntities: ['markets'], strategy: 'full_refresh', snapshotSemantics: { positions: 'complete' } },
      { name: 'balance', entities: ['cash_balances'], strategy: 'full_refresh', snapshotSemantics: { cash_balances: 'complete' } },
      { name: 'settlement_activity', entities: ['activity'], strategy: 'full_refresh', snapshotSemantics: {} },
      ...(['deposits', 'withdrawals', 'credits'] as const).map((name) => ({
        name, entities: [], auxiliaryEntities: ['activity' as const], strategy: 'full_refresh' as const, snapshotSemantics: {},
      })),
      { name: 'settled_observations', entities: [], auxiliaryEntities: ['activity'], strategy: 'full_refresh', snapshotSemantics: {} },
    ],
    pagination: 'supported', incrementalSync: 'unsupported',
  }
  constructor(private readonly fixtureClient?: (externalAccountId: string) => KalshiClient) {}
  async fetchPage(request: Parameters<ProviderAdapter['fetchPage']>[0]): Promise<ProviderPage> {
    if (!this.fixtureClient) return fail('kalshi_live_disabled')
    const client = this.fixtureClient(request.externalAccountId)
    const state = request.cursor ? next.parse(JSON.parse(request.cursor)) : { tier: 'current', cursor: null, observedAt: new Date().toISOString() }
    const query = new URLSearchParams()
    if (state.cursor) query.set('cursor', state.cursor)
    if (!['markets', 'deposits', 'withdrawals', 'credits'].includes(request.streamName)) query.set('subaccount', '0')
    if (request.streamName === 'balance') query.set('exchange_index', '0')
    if (request.streamName !== 'balance') query.set('limit', '50')
    const get = (operation: Parameters<KalshiClient['read']>[0]) => client.read(operation, query, request.signal)
    const records: NormalizedRecord[] = []
    let cursor: string | null = null
    let entity: CoverageEntity
    let partial = false
    let nextTier: 'historical' | null = null
    const predictionRecord = (row: { exchange_index?: number | undefined }) => row.exchange_index === undefined || row.exchange_index === 0
    const reference = async (tickers: string[]) => {
      const supported = new Set<string>()
      for (const id of new Set(tickers)) {
        try {
          let detail: unknown
          try { detail = await client.read('market', new URLSearchParams(), request.signal, id) }
          catch (error) {
            if (!(error instanceof ProviderAdapterError) || error.code !== 'kalshi_http_404') throw error
            detail = await client.read('historicalMarket', new URLSearchParams(), request.signal, id)
          }
          const record = normalizeKalshiMarket((detail as { market: unknown }).market)
          if (record.kind !== 'market' || record.externalMarketId !== id) return fail('kalshi_market_identity_mismatch')
          records.push(record)
          supported.add(id)
        } catch (error) {
          if (!(error instanceof ProviderAdapterError) || !['kalshi_market_structure_unsupported', 'kalshi_http_404'].includes(error.code)) throw error
          partial = true
        }
      }
      return supported
    }
    if (request.streamName === 'markets') {
      entity = 'markets'
      const parsed = pageEnvelope.extend({ markets: z.array(z.unknown()).max(100) }).parse(await get('markets'))
      cursor = parsed.cursor || null
      for (const row of parsed.markets) {
        try { records.push(normalizeKalshiMarket(row)) } catch { partial = true }
      }
    } else if (request.streamName === 'balance') {
      entity = 'cash_balances'
      const row = balance.parse(await get('balance'))
      if (row.balance_dollars === undefined && row.balance === undefined) return fail('kalshi_balance_missing')
      records.push(normalizedRecordSchema.parse({ kind: 'cash_balance', externalId: 'primary:usd', observedAt: state.observedAt,
        balance: row.balance_dollars ?? new Decimal(row.balance!).div(100).toFixed(), assetCode: 'USD', rawPayload: row }))
    } else if (request.streamName === 'positions') {
      entity = 'positions'
      query.set('settlement_status', 'unsettled')
      const parsed = pageEnvelope.extend({ market_positions: z.array(position).max(100) }).parse(await get('positions'))
      cursor = parsed.cursor || null
      const supported = await reference(parsed.market_positions.filter(predictionRecord).map((row) => row.ticker))
      for (const row of parsed.market_positions.filter(predictionRecord)) {
        const quantity = new Decimal(row.position_fp)
        if (quantity.isZero() || !supported.has(row.ticker)) continue
        const instrument = outcome(row.ticker, quantity.isNegative() ? 'no' : 'yes')
        records.push(normalizedRecordSchema.parse({ kind: 'position', externalId: instrument, externalMarketId: row.ticker,
          externalInstrumentId: instrument, observedAt: state.observedAt, quantity: quantity.abs().toFixed(),
          averageCostPrice: null, markPrice: null, markAt: null, settlementAssetCode: 'USD',
          origin: 'provider_reported', reconciliationStatus: 'not_started', rawPayload: row }))
      }
    } else if (request.streamName === 'fills') {
      entity = 'fills'
      const parsed = pageEnvelope.extend({ fills: z.array(fill).max(100) }).parse(await get(state.tier === 'historical' ? 'historicalFills' : 'fills'))
      cursor = parsed.cursor || null
      if (state.tier === 'current') nextTier = 'historical'
      const supported = await reference(parsed.fills.filter(predictionRecord).map((row) => row.market_ticker))
      for (const row of parsed.fills.filter(predictionRecord)) {
        const leg = row.side
        const quote = leg === 'yes' ? row.yes_price_dollars : row.no_price_dollars
        const consistent = leg && row.action && (!row.outcome_side || row.outcome_side === (row.action === 'buy' ? leg : leg === 'yes' ? 'no' : 'yes'))
        if (!supported.has(row.market_ticker) || !consistent || new Decimal(quote).lt(0) || new Decimal(quote).gt(1) || !new Decimal(row.count_fp).gt(0)) {
          partial = true
          records.push(normalizedRecordSchema.parse({ kind: 'activity_fact', externalId: 'fill:' + row.fill_id,
            identityKind: 'provider_native', classification: 'unresolved', resolutionReason: 'kalshi_fill_direction_unverified',
            activityType: 'TRADE_UNRESOLVED', occurredAt: row.created_time, transactionHash: null,
            externalMarketId: row.market_ticker, externalInstrumentId: null, side: null,
            quantity: row.count_fp, amount: null, assetCode: 'USD', rawPayload: row }))
          continue
        }
        records.push(normalizedRecordSchema.parse({ kind: 'fill', externalId: row.fill_id, identityKind: 'provider_native',
          externalMarketId: row.market_ticker, externalInstrumentId: outcome(row.market_ticker, leg!), direction: row.action,
          occurredAt: row.created_time, quantity: row.count_fp, price: quote,
          feeAmount: row.fee_cost ?? null, feeStatus: row.fee_cost === undefined ? 'unavailable' : 'reported',
          settlementAssetCode: 'USD', finality: 'confirmed', rawPayload: row }))
      }
    } else if (request.streamName === 'settlement_activity') {
      entity = 'activity'
      partial = true
      const parsed = pageEnvelope.extend({ settlements: z.array(settlement).max(100) }).parse(await get('settlements'))
      cursor = parsed.cursor || null
      for (const row of parsed.settlements.filter(predictionRecord)) records.push(normalizedRecordSchema.parse({ kind: 'activity_fact',
        externalId: 'settlement:' + row.ticker + ':' + row.settled_time, identityKind: 'source_fingerprint',
        classification: 'unresolved', resolutionReason: 'kalshi_settlement_allocation_unverified', activityType: 'SETTLEMENT_UNRESOLVED',
        occurredAt: row.settled_time, transactionHash: null, externalMarketId: row.ticker, externalInstrumentId: null,
        side: null, quantity: null, amount: null, assetCode: 'USD', rawPayload: row }))
    } else if (request.streamName === 'deposits' || request.streamName === 'withdrawals' || request.streamName === 'credits') {
      entity = 'activity'
      const stream = request.streamName
      const body = pageEnvelope.parse(await get(stream))
      cursor = body.cursor || null
      const cashRows = stream === 'credits' ? [] : z.array(cashActivity).max(100).parse(body[stream])
      const creditRows = stream === 'credits' ? z.array(creditActivity).max(100).parse(body.credits) : []
      const evidence = [
        ...cashRows.map((row) => ({ id: row.id, status: row.status, amount: new Decimal(row.amount_cents).div(100).toFixed(),
          timestamp: new Date((row.finalized_ts ?? row.created_ts) * 1000).toISOString(), raw: row })),
        ...creditRows.map((row) => ({ id: row.credit_id, status: row.status, amount: row.amount_dollars, timestamp: row.created_time, raw: row })),
      ]
      for (const row of evidence) records.push(normalizedRecordSchema.parse({ kind: 'activity_fact',
        externalId: stream + ':' + row.id, identityKind: 'provider_native',
        classification: row.status === 'applied' ? 'unresolved' : 'unreconciled',
        resolutionReason: 'kalshi_cash_attribution_unverified', activityType: row.status === 'applied' ? 'CASH_UNRESOLVED' : 'CASH_STATUS_OBSERVATION',
        occurredAt: row.timestamp, transactionHash: null, externalMarketId: null, externalInstrumentId: null,
        side: null, quantity: null, amount: row.amount, assetCode: 'USD', rawPayload: row.raw }))
    } else if (request.streamName === 'settled_observations') {
      entity = 'activity'
      partial = true
      if (state.tier === 'current') {
        query.set('settlement_status', 'settled')
        nextTier = 'historical'
      }
      const parsed = pageEnvelope.extend({ market_positions: z.array(position).max(100) }).parse(
        await get(state.tier === 'current' ? 'positions' : 'historicalPositions'))
      cursor = parsed.cursor || null
      for (const row of parsed.market_positions.filter(predictionRecord)) records.push(normalizedRecordSchema.parse({ kind: 'activity_fact',
        externalId: 'settled-position:' + row.ticker, identityKind: 'source_fingerprint',
        classification: 'unreconciled', resolutionReason: 'kalshi_archived_position_observation', activityType: 'HISTORICAL_POSITION',
        occurredAt: row.last_updated_ts ?? null, transactionHash: null, externalMarketId: row.ticker, externalInstrumentId: null,
        side: null, quantity: row.position_fp, amount: row.market_exposure_dollars ?? null, assetCode: 'USD', rawPayload: row }))
    } else return fail('kalshi_unknown_stream')
    const continuation = cursor ? { ...state, cursor } : nextTier ? { ...state, tier: nextTier, cursor: null } : null
    return { payload: records, nextCursor: continuation ? JSON.stringify(continuation) : null, checkpoint: null,
      coverage: ['settled_observations', 'deposits', 'withdrawals', 'credits'].includes(request.streamName) ? {} : { [entity]: { status: partial ? 'partial' : 'complete', sourceAsOf: state.observedAt,
        reasonCode: partial ? 'kalshi_unresolved_financial_evidence' : null } } }
  }
  normalizePage(page: ProviderPage) {
    return z.array(normalizedRecordSchema).parse(page.payload)
  }
}

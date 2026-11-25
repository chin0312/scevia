import { z } from 'zod'
import { normalizedRecordSchema, type EntityCoverageReport, type NormalizedRecord, type ProviderCapabilities } from '../../domain/model.js'
import { ProviderAdapterError, type ProviderAdapter, type ProviderPage } from '../adapter.js'
import { MULTI_OUTCOME_ACCOUNT_ID, multiOutcomePages } from './data.js'

const marketSchema = z.object({
  eventId: z.string(),
  eventName: z.string(),
  eventDescription: z.string().nullable(),
  resolutionRules: z.string().nullable(),
  eventLifecycle: z.string(),
  eventResolvesAt: z.string().datetime({ offset: true }).nullable(),
  marketId: z.string(),
  marketTitle: z.string(),
  marketLifecycle: z.string(),
  settlementRules: z.string().nullable(),
  settlementAssetCode: z.string().nullable(),
  eventUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
  sourceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  outcomes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    payout: z.string().nullable(),
    asset: z.string().nullable(),
  }).strict()).min(2),
}).strict()

const fillSchema = z.object({
  id: z.string(),
  contract: z.string(),
  outcome: z.string(),
  action: z.enum(['buy', 'sell']),
  timestamp: z.string().datetime({ offset: true }),
  quantity: z.string(),
  price: z.string(),
  feeAmount: z.string().nullable(),
  feeStatus: z.enum(['reported', 'estimated', 'unavailable']),
  asset: z.string(),
  finality: z.string(),
}).strict()

const transferSchema = z.object({
  id: z.string(),
  direction: z.enum(['deposit', 'withdrawal', 'transfer', 'adjustment']),
  timestamp: z.string().datetime({ offset: true }),
  amount: z.string(),
  asset: z.string(),
  feeAmount: z.string().nullable(),
  feeStatus: z.enum(['reported', 'estimated', 'unavailable']),
}).strict()

const positionSchema = z.object({
  id: z.string(),
  contract: z.string(),
  outcome: z.string(),
  observed: z.string().datetime({ offset: true }),
  quantity: z.string(),
  averageCost: z.string().nullable(),
  mark: z.string().nullable(),
  markTimestamp: z.string().datetime({ offset: true }).nullable(),
  asset: z.string().nullable(),
  origin: z.enum(['provider_reported', 'reconstructed']),
}).strict()

const cashSchema = z.object({
  id: z.string(),
  observed: z.string().datetime({ offset: true }),
  amount: z.string(),
  asset: z.string(),
}).strict()

const priceSchema = z.object({
  id: z.string(),
  contract: z.string(),
  outcome: z.string(),
  observed: z.string().datetime({ offset: true }),
  value: z.string(),
  kind: z.string(),
  asset: z.string(),
}).strict()

const settlementSchema = z.object({
  id: z.string(),
  contract: z.string(),
  outcome: z.string(),
  timestamp: z.string().datetime({ offset: true }),
  quantity: z.string(),
  payout: z.string(),
  asset: z.string(),
  feeAmount: z.string().nullable(),
  feeStatus: z.enum(['reported', 'estimated', 'unavailable']),
}).strict()

const pageSchema = z.object({
  markets: z.array(marketSchema),
  trades: z.array(fillSchema),
  transfers: z.array(transferSchema),
  positions: z.array(positionSchema),
  cash: z.array(cashSchema),
  prices: z.array(priceSchema),
  settlements: z.array(settlementSchema),
}).strict()

const completeReport = (coverageStart: string | null = null, coverageEnd: string | null = null): EntityCoverageReport => ({
  status: 'complete', coverageStart, coverageEnd, sourceAsOf: '2026-11-24T10:00:00Z', reasonCode: null,
})

const emptyActivityPayload = () => ({ markets: [], trades: [], transfers: [], positions: [], cash: [], prices: [], settlements: [] })

export class MultiOutcomeFixtureAdapter implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities = {
    providerCode: 'fixture-multisided',
    displayName: 'Fixture Multi-outcome Provider',
    adapterKind: 'fixture',
    accountKinds: ['fixture'],
    operations: {
      markets: 'supported',
      fills: 'supported',
      cash_movements: 'supported',
      settlements: 'supported',
      positions: 'supported',
      cash_balances: 'supported',
      prices: 'supported',
    },
    streams: [
      {
        name: 'activity',
        entities: ['markets', 'fills', 'cash_movements', 'settlements'],
        strategy: 'provider_checkpoint',
        snapshotSemantics: {},
      },
      {
        name: 'account-state',
        entities: ['positions', 'cash_balances', 'prices'],
        strategy: 'full_refresh',
        snapshotSemantics: { positions: 'complete', cash_balances: 'complete' },
      },
    ],
    pagination: 'supported',
    incrementalSync: 'supported',
  }

  async fetchPage({ externalAccountId, streamName, cursor, checkpoint, signal }: Parameters<ProviderAdapter['fetchPage']>[0]): Promise<ProviderPage> {
    if (signal.aborted) throw new ProviderAdapterError('request_aborted', true)
    if (externalAccountId !== MULTI_OUTCOME_ACCOUNT_ID) {
      throw new ProviderAdapterError('fixture_account_not_found', false)
    }
    if (streamName === 'activity' && checkpoint === 'activity-through-page-2' && cursor === null) {
      return {
        payload: emptyActivityPayload(),
        nextCursor: null,
        checkpoint,
        coverage: {
          markets: completeReport('2026-11-24T09:00:00Z', '2026-11-24T09:00:00Z'),
          fills: completeReport('2026-11-20T12:30:00Z', '2026-11-21T13:15:00Z'),
          cash_movements: completeReport('2026-11-18T08:00:00Z', '2026-11-22T07:30:00Z'),
          settlements: completeReport('2026-11-23T12:00:00Z', '2026-11-23T12:00:00Z'),
        },
      }
    }
    if (streamName === 'activity' && cursor === null && checkpoint === null) {
      return {
        payload: multiOutcomePages.first,
        nextCursor: 'page-2',
        checkpoint: null,
        coverage: {
          markets: completeReport('2026-11-24T09:00:00Z', '2026-11-24T09:00:00Z'),
          fills: completeReport('2026-11-20T12:30:00Z', '2026-11-21T13:15:00Z'),
          cash_movements: completeReport('2026-11-18T08:00:00Z', '2026-11-22T07:30:00Z'),
          settlements: completeReport('2026-11-23T12:00:00Z', '2026-11-23T12:00:00Z'),
        },
      }
    }
    if (streamName === 'activity' && cursor === 'page-2') {
      return {
        payload: multiOutcomePages.second,
        nextCursor: null,
        checkpoint: 'activity-through-page-2',
        coverage: {
          markets: completeReport('2026-11-24T09:00:00Z', '2026-11-24T09:00:00Z'),
          fills: completeReport('2026-11-20T12:30:00Z', '2026-11-21T13:15:00Z'),
          cash_movements: completeReport('2026-11-18T08:00:00Z', '2026-11-22T07:30:00Z'),
          settlements: completeReport('2026-11-23T12:00:00Z', '2026-11-23T12:00:00Z'),
        },
      }
    }
    if (streamName === 'account-state' && cursor === null && checkpoint === null) {
      const first = multiOutcomePages.first as Record<string, unknown[]>
      return {
        payload: { ...emptyActivityPayload(), positions: first.positions, cash: first.cash, prices: first.prices },
        nextCursor: null,
        checkpoint: null,
        coverage: {
          positions: completeReport('2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z'),
          cash_balances: completeReport('2026-11-24T10:00:00Z', '2026-11-24T10:00:00Z'),
          prices: completeReport('2026-11-24T09:59:00Z', '2026-11-24T09:59:00Z'),
        },
      }
    }
    throw new ProviderAdapterError('invalid_fixture_cursor', false)
  }

  normalizePage(page: ProviderPage, streamName: string): NormalizedRecord[] {
    const parsedPage = pageSchema.safeParse(page.payload)
    if (!parsedPage.success) throw new ProviderAdapterError('invalid_provider_payload', false)
    const parsed = parsedPage.data
    const isActivity = streamName === 'activity'
    const isAccountState = streamName === 'account-state'
    if (!isActivity && !isAccountState) throw new ProviderAdapterError('unknown_fixture_stream', false)
    const markets = isActivity ? parsed.markets : []
    const trades = isActivity ? parsed.trades : []
    const transfers = isActivity ? parsed.transfers : []
    const positions = isAccountState ? parsed.positions : []
    const cash = isAccountState ? parsed.cash : []
    const prices = isAccountState ? parsed.prices : []
    const settlements = isActivity ? parsed.settlements : []
    const records: unknown[] = [
      ...markets.map((market) => ({
        kind: 'market',
        externalEventId: market.eventId,
        eventName: market.eventName,
        eventDescription: market.eventDescription,
        resolutionRules: market.resolutionRules,
        eventLifecycle: market.eventLifecycle,
        eventResolvesAt: market.eventResolvesAt,
        externalMarketId: market.marketId,
        marketTitle: market.marketTitle,
        marketLifecycle: market.marketLifecycle,
        settlementRules: market.settlementRules,
        settlementAssetCode: market.settlementAssetCode,
        eventSourceUpdatedAt: market.eventUpdatedAt ?? market.sourceUpdatedAt,
        sourceUpdatedAt: market.sourceUpdatedAt,
        outcomes: market.outcomes.map((outcome) => ({
          externalId: outcome.id,
          name: outcome.name,
          outcomeType: outcome.type,
          payoutAmount: outcome.payout,
          settlementAssetCode: outcome.asset,
        })),
        rawPayload: market,
      })),
      ...trades.map((trade) => ({
        kind: 'fill', externalId: trade.id, externalMarketId: trade.contract, externalInstrumentId: trade.outcome,
        direction: trade.action, occurredAt: trade.timestamp, quantity: trade.quantity, price: trade.price,
        feeAmount: trade.feeAmount, feeStatus: trade.feeStatus, settlementAssetCode: trade.asset,
        finality: trade.finality, rawPayload: trade,
      })),
      ...transfers.map((transfer) => ({
        kind: 'cash_movement', externalId: transfer.id, movementKind: transfer.direction,
        occurredAt: transfer.timestamp,
        signedAmount: transfer.direction === 'withdrawal' ? `-${transfer.amount}` : transfer.amount,
        assetCode: transfer.asset, feeAmount: transfer.feeAmount, feeStatus: transfer.feeStatus,
        rawPayload: transfer,
      })),
      ...positions.map((position) => ({
        kind: 'position', externalId: position.id, externalMarketId: position.contract,
        externalInstrumentId: position.outcome, observedAt: position.observed, quantity: position.quantity,
        averageCostPrice: position.averageCost, markPrice: position.mark, markAt: position.markTimestamp,
        settlementAssetCode: position.asset, origin: position.origin, reconciliationStatus: 'not_started',
        rawPayload: position,
      })),
      ...cash.map((balance) => ({
        kind: 'cash_balance', externalId: balance.id, observedAt: balance.observed,
        balance: balance.amount, assetCode: balance.asset, rawPayload: balance,
      })),
      ...prices.map((price) => ({
        kind: 'price', externalId: price.id, externalMarketId: price.contract,
        externalInstrumentId: price.outcome, observedAt: price.observed, price: price.value,
        priceKind: price.kind, assetCode: price.asset, rawPayload: price,
      })),
      ...settlements.map((settlement) => ({
        kind: 'settlement', externalId: settlement.id, externalMarketId: settlement.contract,
        externalInstrumentId: settlement.outcome, settledAt: settlement.timestamp,
        quantity: settlement.quantity, payoutAmount: settlement.payout, assetCode: settlement.asset,
        feeAmount: settlement.feeAmount, feeStatus: settlement.feeStatus, rawPayload: settlement,
      })),
    ]
    return records.map((record) => {
      const normalized = normalizedRecordSchema.parse(record)
      if (normalized.kind === 'fill' || normalized.kind === 'cash_movement' || normalized.kind === 'settlement') {
        const expected = normalized.feeStatus !== 'unavailable'
        if ((normalized.feeAmount !== null) !== expected) throw new ProviderAdapterError('invalid_fee_fields', false)
      }
      return normalized
    })
  }
}

import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import type { Database } from '../db/client.js'
import { activityFactOccurrences, cashBalanceSnapshots, cashMovements, dataCoverage, fills, instruments, markets, positionSnapshots,
  priceObservations, providerAccounts, providerActivityFacts, settlements, sourceRecords, syncRuns } from '../db/schema.js'
import type { Evidence, FinancialObservation } from './model.js'

const limit = 5001
const fixed = (value: string) => new Decimal(value).toFixed()
const nullable = (value: string | null) => value === null ? null : fixed(value)

export async function loadProviderEvidence(db: Pick<Database, 'select' | 'selectDistinctOn'>, portfolioId: string, asOf: Date, accountIds?: string[]) {
  const owned = and(eq(providerAccounts.portfolioId, portfolioId),
    accountIds === undefined ? undefined : inArray(providerAccounts.id, accountIds))
  const account = { account: providerAccounts.id, venue: providerAccounts.providerCode }
  const source = { sourceRecordId: sourceRecords.id, payloadSha256: sourceRecords.payloadSha256 }
  const tradeRows = await db.select({ ...account, ...source, row: fills, instrument: instruments.id, market: markets.id, event: markets.eventId, title: markets.title, externalInstrument: instruments.externalId }).from(fills)
      .innerJoin(providerAccounts, eq(fills.providerAccountId, providerAccounts.id))
      .innerJoin(instruments, eq(fills.instrumentId, instruments.id))
      .innerJoin(markets, eq(instruments.marketId, markets.id))
      .innerJoin(sourceRecords, eq(fills.sourceRecordId, sourceRecords.id))
      .where(and(owned, lte(fills.occurredAt, asOf))).orderBy(fills.occurredAt, fills.id).limit(limit)
  const cashRows = await db.select({ ...account, ...source, row: cashMovements }).from(cashMovements)
      .innerJoin(providerAccounts, eq(cashMovements.providerAccountId, providerAccounts.id))
      .innerJoin(sourceRecords, eq(cashMovements.sourceRecordId, sourceRecords.id))
      .where(and(owned, lte(cashMovements.occurredAt, asOf))).orderBy(cashMovements.occurredAt, cashMovements.id).limit(limit)
  const settlementRows = await db.select({ ...account, ...source, row: settlements }).from(settlements)
      .innerJoin(providerAccounts, eq(settlements.providerAccountId, providerAccounts.id))
      .innerJoin(sourceRecords, eq(settlements.sourceRecordId, sourceRecords.id))
      .where(and(owned, lte(settlements.settledAt, asOf))).orderBy(settlements.settledAt, settlements.id).limit(limit)
  const factRows = await db.select({ ...account, ...source, row: providerActivityFacts, instrument: instruments.id, payload: sourceRecords.payload, firstIngestedAt: sourceRecords.ingestedAt,
      largestObservedRunCount: sql<number | null>`(select max(observations) from ${activityFactOccurrences}
        where ${activityFactOccurrences.activityFactId} = ${providerActivityFacts.id})`.as('largest_observed_run_count'),
    }).from(providerActivityFacts)
      .innerJoin(providerAccounts, eq(providerActivityFacts.providerAccountId, providerAccounts.id))
      .innerJoin(sourceRecords, eq(providerActivityFacts.sourceRecordId, sourceRecords.id))
      .leftJoin(markets, and(eq(providerAccounts.providerCode, markets.providerCode), eq(providerActivityFacts.externalMarketId, markets.externalId)))
      .leftJoin(instruments, and(eq(instruments.marketId, markets.id), eq(providerActivityFacts.externalInstrumentId, instruments.externalId)))
      .where(owned).orderBy(providerActivityFacts.id).limit(limit)
  const markRows = await db.select({ ...account, ...source, row: priceObservations }).from(priceObservations)
      .innerJoin(providerAccounts, eq(priceObservations.providerAccountId, providerAccounts.id))
      .innerJoin(sourceRecords, eq(priceObservations.sourceRecordId, sourceRecords.id))
      .where(and(owned, lte(priceObservations.observedAt, asOf))).orderBy(priceObservations.observedAt, priceObservations.id).limit(limit)
  const positions = await db.selectDistinctOn([positionSnapshots.providerAccountId, positionSnapshots.instrumentId], {
      ...account, sourceRecordId: positionSnapshots.sourceRecordId, instrument: positionSnapshots.instrumentId,
      syncRunId: positionSnapshots.syncRunId, asset: positionSnapshots.settlementAssetCode,
      observedAt: positionSnapshots.observedAt, mark: positionSnapshots.markPrice, markAt: positionSnapshots.markAt, quantity: positionSnapshots.quantity, averageCost: positionSnapshots.averageCostPrice,
    }).from(positionSnapshots).innerJoin(providerAccounts, eq(positionSnapshots.providerAccountId, providerAccounts.id))
      .innerJoin(syncRuns, eq(positionSnapshots.syncRunId, syncRuns.id))
      .where(and(owned, lte(positionSnapshots.observedAt, asOf), eq(positionSnapshots.origin, 'provider_reported'),
        sql`(${providerAccounts.providerCode} <> 'kalshi' OR ${providerAccounts.kind} <> 'authenticated_account'
          OR (${syncRuns.status} = 'complete' AND ${syncRuns.finishedAt} <= ${asOf.toISOString()}::timestamptz))`))
      .orderBy(positionSnapshots.providerAccountId, positionSnapshots.instrumentId, desc(positionSnapshots.observedAt), desc(positionSnapshots.ingestedAt), desc(positionSnapshots.id)).limit(501)
  const balances = await db.selectDistinctOn([cashBalanceSnapshots.providerAccountId, cashBalanceSnapshots.assetCode], {
      ...account, sourceRecordId: cashBalanceSnapshots.sourceRecordId, syncRunId: cashBalanceSnapshots.syncRunId,
      asset: cashBalanceSnapshots.assetCode, observedAt: cashBalanceSnapshots.observedAt, balance: cashBalanceSnapshots.balance,
    }).from(cashBalanceSnapshots).innerJoin(providerAccounts, eq(cashBalanceSnapshots.providerAccountId, providerAccounts.id))
      .innerJoin(syncRuns, eq(cashBalanceSnapshots.syncRunId, syncRuns.id))
      .where(and(owned, lte(cashBalanceSnapshots.observedAt, asOf),
        sql`(${providerAccounts.providerCode} <> 'kalshi' OR ${providerAccounts.kind} <> 'authenticated_account'
          OR (${syncRuns.cashBalanceSnapshotComplete} AND ${syncRuns.finishedAt} <= ${asOf.toISOString()}::timestamptz))`))
      .orderBy(cashBalanceSnapshots.providerAccountId, cashBalanceSnapshots.assetCode, desc(cashBalanceSnapshots.observedAt), desc(cashBalanceSnapshots.ingestedAt), desc(cashBalanceSnapshots.id)).limit(501)
  const coverage = await db.select({ ...account, entity: dataCoverage.entityType, status: dataCoverage.status,
      lastSuccessfulRunId: dataCoverage.lastSuccessfulRunId, lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
      lastAttemptAt: dataCoverage.lastAttemptAt, lastAttemptStatus: dataCoverage.lastAttemptStatus })
      .from(dataCoverage).innerJoin(providerAccounts, eq(dataCoverage.providerAccountId, providerAccounts.id)).where(owned).limit(limit)
  const accounts = await db.select({ ...account, kind: providerAccounts.kind, externalId: providerAccounts.externalAccountId }).from(providerAccounts).where(owned).limit(limit)
  const evidence: Evidence[] = []
  const add = (ref: { account: string; venue: string; sourceRecordId: string; payloadSha256: string },
    event: Pick<FinancialObservation, 'id' | 'timestamp' | 'type' | 'asset'> & Partial<FinancialObservation>, unresolvedReason?: string) => {
    evidence.push({ providerAccountId: ref.account, sourceRecordId: ref.sourceRecordId, payloadSha256: ref.payloadSha256,
      observation: { sequence: null, instrument: null, amount: null, price: null, quantity: null, fee: null, feeAsset: null,
        ...event, venue: ref.venue, account: ref.account }, ...(unresolvedReason ? { unresolvedReason } : {}) })
  }
  for (const ref of tradeRows) {
    const row = ref.row
    add(ref, { id: 'fill:' + row.externalId, timestamp: row.occurredAt.toISOString(), type: row.direction,
      asset: row.settlementAssetCode, instrument: ref.instrument, quantity: fixed(row.quantity), price: fixed(row.price),
      fee: row.feeStatus === 'reported' ? nullable(row.feeAmount) : null },
    row.identityKind !== 'provider_native' ? 'provider_fill_identity_ambiguous'
      : !['confirmed', 'final'].includes(row.finality) ? 'provider_fill_finality_unverified' : undefined)
    evidence.at(-1)!.instrumentMetadata = { market: ref.market, event: ref.event, title: ref.title, instrument: ref.externalInstrument }
  }
  for (const ref of cashRows) {
    const row = ref.row
    const supported = row.movementKind === 'deposit' || row.movementKind === 'withdrawal'
    // Polymarket legacy cash fingerprints and newer endpoint-native IDs have different namespaces.
    const identity = ref.venue !== 'polymarket' || row.externalId.startsWith('polymarket-v2:activity:provider:')
    add(ref, { id: 'cash:' + row.externalId, timestamp: row.occurredAt.toISOString(),
      type: row.movementKind === 'withdrawal' ? 'withdrawal' : 'deposit', asset: row.assetCode,
      amount: new Decimal(row.signedAmount).abs().toFixed(), fee: row.feeStatus === 'reported' ? nullable(row.feeAmount) : null },
    supported && identity ? undefined : 'provider_cash_identity_or_direction_unverified')
  }
  for (const ref of settlementRows) {
    const row = ref.row
    add(ref, { id: 'settlement:' + row.externalId, timestamp: row.settledAt.toISOString(), type: 'settlement',
      asset: row.assetCode, instrument: row.instrumentId, quantity: fixed(row.quantity), amount: fixed(row.payoutAmount) },
    'provider_settlement_entitlement_or_payment_unverified')
  }
  for (const ref of factRows) {
    const row = ref.row
    if (ref.venue === 'kalshi' && ['HISTORICAL_POSITION', 'CASH_STATUS_OBSERVATION', 'KALSHI_PAYOUT_UNVERIFIED'].includes(row.activityType)) continue
    const knownAt = row.occurredAt ?? ref.firstIngestedAt
    if (knownAt > asOf) continue
    if (ref.venue === 'kalshi' && ref.instrument && row.quantity !== null && row.amount !== null && row.price !== null
      && row.assetCode === 'USD' && ['KALSHI_BINARY_ENTITLEMENT', 'KALSHI_BINARY_PAYOUT'].includes(row.activityType)) {
      const paid = row.activityType === 'KALSHI_BINARY_PAYOUT'
      const id = 'kalshi:' + row.externalId
      add(ref, { id, timestamp: knownAt.toISOString(), type: paid ? 'redemption' : 'settlement',
        sequence: paid ? 2 : 1, ...(paid ? { entitlementId: id.slice(0, -':receipt'.length) } : {}),
        asset: 'USD', instrument: ref.instrument, quantity: fixed(row.quantity), amount: fixed(row.amount), price: fixed(row.price) })
      continue
    }
    const confirmableCash = ref.venue === 'kalshi' && row.resolutionReason === 'kalshi_final_cash_requires_account_attribution'
      && ['KALSHI_APPLIED_DEPOSIT', 'KALSHI_APPLIED_WITHDRAWAL'].includes(row.activityType) && row.amount !== null
      && typeof ref.payload.fee_cents === 'number' && Number.isSafeInteger(ref.payload.fee_cents) && ref.payload.fee_cents >= 0
    add(ref, { id: null, timestamp: knownAt.toISOString(), type: confirmableCash
      ? row.activityType === 'KALSHI_APPLIED_DEPOSIT' ? 'deposit' : 'withdrawal' : 'unresolved_activity', asset: row.assetCode ?? 'UNKNOWN',
      ...(confirmableCash ? { fee: new Decimal(ref.payload.fee_cents as number).div(100).toFixed() } : {}),
      instrument: row.externalInstrumentId, quantity: nullable(row.quantity), amount: nullable(row.amount), price: nullable(row.price),
    }, confirmableCash ? 'kalshi_final_cash_requires_account_attribution' : 'provider_activity_requires_reconciliation')
    evidence.at(-1)!.providerActivity = {
      type: row.activityType, classification: row.classification, occurredAt: row.occurredAt?.toISOString() ?? null,
      transactionHash: row.transactionHash, externalId: row.externalId, market: row.externalMarketId,
      instrument: row.externalInstrumentId, side: row.side, largestObservedRunCount: ref.largestObservedRunCount,
      identityKind: row.identityKind, reason: row.resolutionReason,
    }
  }
  for (const ref of markRows) {
    const row = ref.row
    if (row.priceKind === 'data_api_current_mark') continue
    add(ref, { id: 'mark:' + row.id, timestamp: row.observedAt.toISOString(), type: 'mark',
      asset: row.assetCode, instrument: row.instrumentId, price: fixed(row.price) })
  }
  const truncated = [tradeRows, cashRows, settlementRows, factRows, markRows, positions, balances, coverage, accounts]
    .some((rows) => rows.length === limit) || positions.length === 501 || balances.length === 501
  const activityEvidence = factRows.filter(({ row, firstIngestedAt }) => (row.occurredAt ?? firstIngestedAt) <= asOf)
    .map(({ account, venue, sourceRecordId, row, largestObservedRunCount }) => ({
      account, venue, sourceRecordId, occurredAt: row.occurredAt, classification: row.classification, activityType: row.activityType,
      largestObservedRunCount, transactionHash: row.transactionHash, externalId: row.externalId,
      market: row.externalMarketId, instrument: row.externalInstrumentId, quantity: row.quantity,
      price: row.price, amount: row.amount, asset: row.assetCode, identityKind: row.identityKind, reason: row.resolutionReason,
    }))
  return { evidence, accounts, positions, balances, coverage, activityEvidence, truncated }
}

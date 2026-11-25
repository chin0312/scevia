import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import type { Database } from '../db/client.js'
import { activityFactOccurrences, cashBalanceSnapshots, cashMovements, dataCoverage, fills, instruments, positionSnapshots,
  priceObservations, providerAccounts, providerActivityFacts, settlements, sourceRecords } from '../db/schema.js'
import type { Evidence, FinancialObservation } from './model.js'

const limit = 5001
const fixed = (value: string) => new Decimal(value).toFixed()
const nullable = (value: string | null) => value === null ? null : fixed(value)

export async function loadProviderEvidence(db: Pick<Database, 'select' | 'selectDistinctOn'>, portfolioId: string, asOf: Date) {
  const owned = eq(providerAccounts.portfolioId, portfolioId)
  const account = { account: providerAccounts.id, venue: providerAccounts.providerCode }
  const source = { sourceRecordId: sourceRecords.id, payloadSha256: sourceRecords.payloadSha256 }
  const tradeRows = await db.select({ ...account, ...source, row: fills, instrument: instruments.id }).from(fills)
      .innerJoin(providerAccounts, eq(fills.providerAccountId, providerAccounts.id))
      .innerJoin(instruments, eq(fills.instrumentId, instruments.id))
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
  const factRows = await db.select({ ...account, ...source, row: providerActivityFacts, firstIngestedAt: sourceRecords.ingestedAt,
      largestObservedRunCount: sql<number | null>`(select max(observations) from ${activityFactOccurrences}
        where ${activityFactOccurrences.activityFactId} = ${providerActivityFacts.id})`.as('largest_observed_run_count'),
    }).from(providerActivityFacts)
      .innerJoin(providerAccounts, eq(providerActivityFacts.providerAccountId, providerAccounts.id))
      .innerJoin(sourceRecords, eq(providerActivityFacts.sourceRecordId, sourceRecords.id))
      .where(owned).orderBy(providerActivityFacts.id).limit(limit)
  const markRows = await db.select({ ...account, ...source, row: priceObservations }).from(priceObservations)
      .innerJoin(providerAccounts, eq(priceObservations.providerAccountId, providerAccounts.id))
      .innerJoin(sourceRecords, eq(priceObservations.sourceRecordId, sourceRecords.id))
      .where(and(owned, lte(priceObservations.observedAt, asOf))).orderBy(priceObservations.observedAt, priceObservations.id).limit(limit)
  const positions = await db.selectDistinctOn([positionSnapshots.providerAccountId, positionSnapshots.instrumentId], {
      ...account, sourceRecordId: positionSnapshots.sourceRecordId, instrument: positionSnapshots.instrumentId,
      syncRunId: positionSnapshots.syncRunId, asset: positionSnapshots.settlementAssetCode,
      observedAt: positionSnapshots.observedAt, quantity: positionSnapshots.quantity, averageCost: positionSnapshots.averageCostPrice,
    }).from(positionSnapshots).innerJoin(providerAccounts, eq(positionSnapshots.providerAccountId, providerAccounts.id))
      .where(and(owned, lte(positionSnapshots.observedAt, asOf), eq(positionSnapshots.origin, 'provider_reported')))
      .orderBy(positionSnapshots.providerAccountId, positionSnapshots.instrumentId, desc(positionSnapshots.observedAt), desc(positionSnapshots.ingestedAt), desc(positionSnapshots.id)).limit(501)
  const balances = await db.selectDistinctOn([cashBalanceSnapshots.providerAccountId, cashBalanceSnapshots.assetCode], {
      ...account, sourceRecordId: cashBalanceSnapshots.sourceRecordId, syncRunId: cashBalanceSnapshots.syncRunId,
      asset: cashBalanceSnapshots.assetCode, observedAt: cashBalanceSnapshots.observedAt, balance: cashBalanceSnapshots.balance,
    }).from(cashBalanceSnapshots).innerJoin(providerAccounts, eq(cashBalanceSnapshots.providerAccountId, providerAccounts.id))
      .where(and(owned, lte(cashBalanceSnapshots.observedAt, asOf)))
      .orderBy(cashBalanceSnapshots.providerAccountId, cashBalanceSnapshots.assetCode, desc(cashBalanceSnapshots.observedAt), desc(cashBalanceSnapshots.ingestedAt), desc(cashBalanceSnapshots.id)).limit(501)
  const coverage = await db.select({ ...account, entity: dataCoverage.entityType, status: dataCoverage.status,
      lastSuccessfulRunId: dataCoverage.lastSuccessfulRunId, lastAttemptStatus: dataCoverage.lastAttemptStatus })
      .from(dataCoverage).innerJoin(providerAccounts, eq(dataCoverage.providerAccountId, providerAccounts.id)).where(owned).limit(limit)
  const accounts = await db.select(account).from(providerAccounts).where(owned).limit(limit)
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
    const knownAt = row.occurredAt ?? ref.firstIngestedAt
    if (knownAt > asOf) continue
    add(ref, { id: null, timestamp: knownAt.toISOString(),
      type: 'merge', asset: row.assetCode ?? 'UNKNOWN' }, 'provider_activity_requires_reconciliation')
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
      largestObservedRunCount,
    }))
  return { evidence, accounts, positions, balances, coverage, activityEvidence, truncated }
}

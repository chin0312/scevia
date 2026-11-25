import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import type { NodePgTransaction } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema.js'
import type { Database } from '../db/client.js'
import {
  cashBalanceSnapshots,
  cashMovements,
  events,
  fills,
  instruments,
  markets,
  positionSnapshots,
  priceObservations,
  settlements,
  sourceRecordRevisions,
  sourceRecords,
  syncCheckpoints,
  syncRuns,
} from '../db/schema.js'
import type { CoverageEntity, CoverageState, NormalizedRecord, ProviderCapabilities } from '../domain/model.js'
import { assertFeeIsExplicit } from '../domain/model.js'
import { IngestionError } from './errors.js'

export type DatabaseTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>

export interface PersistPageInput {
  database: Database
  providerAccountId: string
  providerCode: string
  checkpointId: string
  runId: string
  leaseToken: string
  nextCursor: string | null
  retrievedAt: string
  records: NormalizedRecord[]
}

export interface PersistPageResult {
  recordsSeen: number
  recordsByType: Record<string, number>
}

async function upsertSourceRecord(
  tx: DatabaseTransaction,
  input: {
    providerAccountId: string
    record: NormalizedRecord
    retrievedAt: string
  },
): Promise<string> {
  const { providerAccountId, record, retrievedAt } = input
  const recordType = record.kind
  const externalRecordId = record.kind === 'market' ? record.externalMarketId : record.externalId
  const payload = record.rawPayload
  const payloadSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const sourceOccurredAt = record.kind === 'market'
    ? record.sourceUpdatedAt
    : record.kind === 'fill' || record.kind === 'cash_movement'
      ? record.occurredAt
      : record.kind === 'settlement'
        ? record.settledAt
        : record.observedAt
  const [current] = await tx
    .select({ id: sourceRecords.id, payload: sourceRecords.payload, payloadSha256: sourceRecords.payloadSha256, retrievedAt: sourceRecords.retrievedAt, normalizationVersion: sourceRecords.normalizationVersion })
    .from(sourceRecords)
    .where(and(
      eq(sourceRecords.providerAccountId, providerAccountId),
      eq(sourceRecords.recordType, recordType),
      eq(sourceRecords.externalRecordId, externalRecordId),
    ))
    .limit(1)

  if (current) {
    if (current.payloadSha256 !== payloadSha256) {
      await tx.insert(sourceRecordRevisions).values({
        sourceRecordId: current.id,
        payload: current.payload,
        payloadSha256: current.payloadSha256,
        normalizationVersion: current.normalizationVersion,
        retrievedAt: current.retrievedAt,
      }).onConflictDoNothing()
    }
    await tx.update(sourceRecords).set({
      payload,
      payloadSha256,
      normalizationVersion: '1',
      sourceOccurredAt: sourceOccurredAt === null ? null : new Date(sourceOccurredAt),
      retrievedAt: new Date(retrievedAt),
    }).where(eq(sourceRecords.id, current.id))
    return current.id
  }

  const [created] = await tx.insert(sourceRecords).values({
    providerAccountId,
    recordType,
    externalRecordId,
    payload,
    payloadSha256,
    normalizationVersion: '1',
    sourceOccurredAt: sourceOccurredAt === null ? null : new Date(sourceOccurredAt),
    retrievedAt: new Date(retrievedAt),
  }).onConflictDoNothing().returning({ id: sourceRecords.id })
  if (created) return created.id

  const [raced] = await tx.select({ id: sourceRecords.id }).from(sourceRecords).where(and(
    eq(sourceRecords.providerAccountId, providerAccountId),
    eq(sourceRecords.recordType, recordType),
    eq(sourceRecords.externalRecordId, externalRecordId),
  )).limit(1)
  if (!raced) throw new IngestionError('source_record_persist_failed')
  return raced.id
}

async function upsertMarket(
  tx: DatabaseTransaction,
  providerCode: string,
  record: Extract<NormalizedRecord, { kind: 'market' }>,
): Promise<void> {
  const [event] = await tx.insert(events).values({
    providerCode,
    externalId: record.externalEventId,
    name: record.eventName,
    description: record.eventDescription,
    resolutionRules: record.resolutionRules,
    lifecycle: record.eventLifecycle,
    resolvesAt: record.eventResolvesAt === null ? null : new Date(record.eventResolvesAt),
    sourceUpdatedAt: record.sourceUpdatedAt === null ? null : new Date(record.sourceUpdatedAt),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [events.providerCode, events.externalId],
    set: {
      name: record.eventName,
      description: record.eventDescription,
      resolutionRules: record.resolutionRules,
      lifecycle: record.eventLifecycle,
      resolvesAt: record.eventResolvesAt === null ? null : new Date(record.eventResolvesAt),
      sourceUpdatedAt: record.sourceUpdatedAt === null ? null : new Date(record.sourceUpdatedAt),
      updatedAt: new Date(),
    },
  }).returning({ id: events.id })
  if (!event) throw new IngestionError('event_persist_failed')

  const [market] = await tx.insert(markets).values({
    eventId: event.id,
    providerCode,
    externalId: record.externalMarketId,
    title: record.marketTitle,
    lifecycle: record.marketLifecycle,
    settlementRules: record.settlementRules,
    settlementAssetCode: record.settlementAssetCode,
    sourceUpdatedAt: record.sourceUpdatedAt === null ? null : new Date(record.sourceUpdatedAt),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [markets.providerCode, markets.externalId],
    set: {
      eventId: event.id,
      title: record.marketTitle,
      lifecycle: record.marketLifecycle,
      settlementRules: record.settlementRules,
      settlementAssetCode: record.settlementAssetCode,
      sourceUpdatedAt: record.sourceUpdatedAt === null ? null : new Date(record.sourceUpdatedAt),
      updatedAt: new Date(),
    },
  }).returning({ id: markets.id })
  if (!market) throw new IngestionError('market_persist_failed')

  for (const outcome of record.outcomes) {
    await tx.insert(instruments).values({
      marketId: market.id,
      externalId: outcome.externalId,
      outcomeName: outcome.name,
      outcomeType: outcome.outcomeType,
      payoutAmount: outcome.payoutAmount,
      settlementAssetCode: outcome.settlementAssetCode,
    }).onConflictDoUpdate({
      target: [instruments.marketId, instruments.externalId],
      set: {
        outcomeName: outcome.name,
        outcomeType: outcome.outcomeType,
        payoutAmount: outcome.payoutAmount,
        settlementAssetCode: outcome.settlementAssetCode,
      },
    })
  }
}

async function resolveInstrument(
  tx: DatabaseTransaction,
  providerCode: string,
  externalMarketId: string,
  externalInstrumentId: string,
): Promise<string> {
  const [instrument] = await tx.select({ id: instruments.id })
    .from(instruments)
    .innerJoin(markets, eq(instruments.marketId, markets.id))
    .where(and(
      eq(markets.providerCode, providerCode),
      eq(markets.externalId, externalMarketId),
      eq(instruments.externalId, externalInstrumentId),
    ))
    .limit(1)
  if (!instrument) throw new IngestionError('unresolved_market_reference')
  return instrument.id
}

export async function persistPage(input: PersistPageInput): Promise<PersistPageResult> {
  const marketRecords = input.records.filter((record) => record.kind === 'market')
  const financialRecords = input.records.filter((record) => record.kind !== 'market')
  const recordsByType: Record<string, number> = {}

  await input.database.transaction(async (tx) => {
    for (const record of marketRecords) {
      await upsertSourceRecord(tx, { providerAccountId: input.providerAccountId, record, retrievedAt: input.retrievedAt })
      await upsertMarket(tx, input.providerCode, record)
      recordsByType[record.kind] = (recordsByType[record.kind] ?? 0) + 1
    }

    for (const record of financialRecords) {
      if ('feeAmount' in record) assertFeeIsExplicit(record)
      const sourceRecordId = await upsertSourceRecord(tx, { providerAccountId: input.providerAccountId, record, retrievedAt: input.retrievedAt })

      if (record.kind === 'fill') {
        const instrumentId = await resolveInstrument(tx, input.providerCode, record.externalMarketId, record.externalInstrumentId)
        await tx.insert(fills).values({
          providerAccountId: input.providerAccountId,
          instrumentId,
          sourceRecordId,
          externalId: record.externalId,
          direction: record.direction,
          occurredAt: new Date(record.occurredAt),
          quantity: record.quantity,
          price: record.price,
          feeAmount: record.feeAmount,
          feeStatus: record.feeStatus,
          settlementAssetCode: record.settlementAssetCode,
          finality: record.finality,
        }).onConflictDoUpdate({
          target: [fills.providerAccountId, fills.externalId],
          set: {
            instrumentId,
            sourceRecordId,
            direction: record.direction,
            occurredAt: new Date(record.occurredAt),
            quantity: record.quantity,
            price: record.price,
            feeAmount: record.feeAmount,
            feeStatus: record.feeStatus,
            settlementAssetCode: record.settlementAssetCode,
            finality: record.finality,
          },
        })
      } else if (record.kind === 'cash_movement') {
        await tx.insert(cashMovements).values({
          providerAccountId: input.providerAccountId,
          sourceRecordId,
          externalId: record.externalId,
          movementKind: record.movementKind,
          occurredAt: new Date(record.occurredAt),
          signedAmount: record.signedAmount,
          assetCode: record.assetCode,
          feeAmount: record.feeAmount,
          feeStatus: record.feeStatus,
        }).onConflictDoUpdate({
          target: [cashMovements.providerAccountId, cashMovements.externalId],
          set: {
            sourceRecordId,
            movementKind: record.movementKind,
            occurredAt: new Date(record.occurredAt),
            signedAmount: record.signedAmount,
            assetCode: record.assetCode,
            feeAmount: record.feeAmount,
            feeStatus: record.feeStatus,
          },
        })
      } else if (record.kind === 'settlement') {
        const instrumentId = await resolveInstrument(tx, input.providerCode, record.externalMarketId, record.externalInstrumentId)
        await tx.insert(settlements).values({
          providerAccountId: input.providerAccountId,
          instrumentId,
          sourceRecordId,
          externalId: record.externalId,
          settledAt: new Date(record.settledAt),
          quantity: record.quantity,
          payoutAmount: record.payoutAmount,
          assetCode: record.assetCode,
          feeAmount: record.feeAmount,
          feeStatus: record.feeStatus,
        }).onConflictDoUpdate({
          target: [settlements.providerAccountId, settlements.externalId],
          set: {
            instrumentId,
            sourceRecordId,
            settledAt: new Date(record.settledAt),
            quantity: record.quantity,
            payoutAmount: record.payoutAmount,
            assetCode: record.assetCode,
            feeAmount: record.feeAmount,
            feeStatus: record.feeStatus,
          },
        })
      } else if (record.kind === 'position') {
        const instrumentId = await resolveInstrument(tx, input.providerCode, record.externalMarketId, record.externalInstrumentId)
        await tx.insert(positionSnapshots).values({
          providerAccountId: input.providerAccountId,
          instrumentId,
          sourceRecordId,
          externalId: record.externalId,
          observedAt: new Date(record.observedAt),
          quantity: record.quantity,
          averageCostPrice: record.averageCostPrice,
          markPrice: record.markPrice,
          markAt: record.markAt === null ? null : new Date(record.markAt),
          settlementAssetCode: record.settlementAssetCode,
          origin: record.origin,
          reconciliationStatus: record.reconciliationStatus,
          ingestedAt: new Date(input.retrievedAt),
        }).onConflictDoUpdate({
          target: [positionSnapshots.providerAccountId, positionSnapshots.externalId],
          set: {
            instrumentId,
            sourceRecordId,
            observedAt: new Date(record.observedAt),
            quantity: record.quantity,
            averageCostPrice: record.averageCostPrice,
            markPrice: record.markPrice,
            markAt: record.markAt === null ? null : new Date(record.markAt),
            settlementAssetCode: record.settlementAssetCode,
            origin: record.origin,
            reconciliationStatus: record.reconciliationStatus,
            ingestedAt: new Date(input.retrievedAt),
          },
        })
      } else if (record.kind === 'cash_balance') {
        await tx.insert(cashBalanceSnapshots).values({
          providerAccountId: input.providerAccountId,
          sourceRecordId,
          externalId: record.externalId,
          observedAt: new Date(record.observedAt),
          balance: record.balance,
          assetCode: record.assetCode,
          ingestedAt: new Date(input.retrievedAt),
        }).onConflictDoUpdate({
          target: [cashBalanceSnapshots.providerAccountId, cashBalanceSnapshots.externalId],
          set: {
            sourceRecordId,
            observedAt: new Date(record.observedAt),
            balance: record.balance,
            assetCode: record.assetCode,
            ingestedAt: new Date(input.retrievedAt),
          },
        })
      } else if (record.kind === 'price') {
        const instrumentId = await resolveInstrument(tx, input.providerCode, record.externalMarketId, record.externalInstrumentId)
        await tx.insert(priceObservations).values({
          providerAccountId: input.providerAccountId,
          instrumentId,
          sourceRecordId,
          externalId: record.externalId,
          observedAt: new Date(record.observedAt),
          price: record.price,
          priceKind: record.priceKind,
          assetCode: record.assetCode,
          ingestedAt: new Date(input.retrievedAt),
        }).onConflictDoUpdate({
          target: [priceObservations.providerAccountId, priceObservations.externalId],
          set: {
            instrumentId,
            sourceRecordId,
            observedAt: new Date(record.observedAt),
            price: record.price,
            priceKind: record.priceKind,
            assetCode: record.assetCode,
            ingestedAt: new Date(input.retrievedAt),
          },
        })
      }
      recordsByType[record.kind] = (recordsByType[record.kind] ?? 0) + 1
    }

    const [checkpoint] = await tx.update(syncCheckpoints).set({
      cursor: input.nextCursor,
      status: 'running',
      leaseExpiresAt: sql`now() + interval '2 minutes'`,
      updatedAt: new Date(input.retrievedAt),
    }).where(and(
      eq(syncCheckpoints.id, input.checkpointId),
      eq(syncCheckpoints.leaseToken, input.leaseToken),
    )).returning({ id: syncCheckpoints.id })
    if (!checkpoint) throw new IngestionError('sync_lease_lost')
    await tx.update(syncRuns).set({
      cursorAtEnd: input.nextCursor,
      pagesRead: sql`${syncRuns.pagesRead} + 1`,
      recordsSeen: sql`${syncRuns.recordsSeen} + ${input.records.length}`,
    }).where(eq(syncRuns.id, input.runId))
  })

  return { recordsSeen: input.records.length, recordsByType }
}

export interface CoverageWriteInput {
  providerAccountId: string
  capabilities: ProviderCapabilities
  coverage: Partial<Record<CoverageEntity, CoverageState>>
  sourceAsOf: string | null
  historyStart: string | null
  historyEnd: string | null
  retrievedAt: string
  syncStatus: 'complete' | 'partial' | 'failed'
  pagesPersisted: boolean
}

export async function writeCoverage(tx: DatabaseTransaction, input: CoverageWriteInput): Promise<void> {
  for (const [entityType, capability] of Object.entries(input.capabilities.operations)) {
    const reportedCoverage = input.coverage[entityType as CoverageEntity]
    const status = capability === 'unsupported'
      ? 'unavailable'
      : input.syncStatus === 'failed'
        ? input.pagesPersisted ? 'partial' : 'unknown'
        : input.syncStatus === 'partial' || reportedCoverage === undefined
          ? 'partial'
          : reportedCoverage
    const reasonCode = capability === 'unsupported'
      ? 'unsupported_by_provider'
      : status === 'unknown'
        ? 'sync_failed'
        : status === 'partial'
          ? input.syncStatus === 'failed' ? 'sync_failed_after_partial_import' : 'provider_reports_partial_history'
          : null
    await tx.insert(schema.dataCoverage).values({
      providerAccountId: input.providerAccountId,
      entityType,
      status,
      reasonCode,
      historyStart: input.historyStart === null ? null : new Date(input.historyStart),
      historyEnd: input.historyEnd === null ? null : new Date(input.historyEnd),
      sourceAsOf: input.sourceAsOf === null ? null : new Date(input.sourceAsOf),
      retrievedAt: new Date(input.retrievedAt),
      updatedAt: new Date(input.retrievedAt),
    }).onConflictDoUpdate({
      target: [schema.dataCoverage.providerAccountId, schema.dataCoverage.entityType],
      set: {
        status,
        reasonCode,
        historyStart: input.historyStart === null ? null : new Date(input.historyStart),
        historyEnd: input.historyEnd === null ? null : new Date(input.historyEnd),
        sourceAsOf: input.sourceAsOf === null ? null : new Date(input.sourceAsOf),
        retrievedAt: new Date(input.retrievedAt),
        updatedAt: new Date(input.retrievedAt),
      },
    })
  }
}

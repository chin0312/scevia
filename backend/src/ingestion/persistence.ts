import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
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
import type { CoverageEntity, EntityCoverageReport, NormalizedRecord, ProviderCapabilities, ProviderSyncStream } from '../domain/model.js'
import { assertFeeIsExplicit } from '../domain/model.js'
import { IngestionError } from './errors.js'

export type DatabaseTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>

export interface PersistPageInput {
  database: Database
  providerAccountId: string
  providerCode: string
  accountCheckpointId: string
  streamCheckpointId: string
  runId: string
  leaseToken: string
  nextCursor: string | null
  durableCheckpoint: string | null
  retrievedAt: string
  records: NormalizedRecord[]
  snapshotSemantics: ProviderSyncStream['snapshotSemantics']
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
): Promise<{ id: string; accepted: boolean }> {
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
    .select({ id: sourceRecords.id, payload: sourceRecords.payload, payloadSha256: sourceRecords.payloadSha256, retrievedAt: sourceRecords.retrievedAt, normalizationVersion: sourceRecords.normalizationVersion, sourceRevisionAt: sourceRecords.sourceRevisionAt })
    .from(sourceRecords)
    .where(and(
      eq(sourceRecords.providerAccountId, providerAccountId),
      eq(sourceRecords.recordType, recordType),
      eq(sourceRecords.externalRecordId, externalRecordId),
    ))
    .limit(1)

  if (current) {
    const incomingRevisionAt = record.kind === 'market' && record.sourceUpdatedAt !== null
      ? new Date(record.sourceUpdatedAt)
      : null
    const staleMarketRevision = record.kind === 'market' && current.sourceRevisionAt !== null
      && (incomingRevisionAt === null || incomingRevisionAt < current.sourceRevisionAt)
    if (staleMarketRevision) {
      if (current.payloadSha256 !== payloadSha256) {
        await tx.insert(sourceRecordRevisions).values({
          sourceRecordId: current.id,
          payload,
          payloadSha256,
          normalizationVersion: '1',
          sourceRevisionAt: incomingRevisionAt,
          retrievedAt: new Date(retrievedAt),
          revisionType: 'stale_observation',
        }).onConflictDoNothing()
      }
      // Keep the latest source-record payload, but let upsertMarket decide the
      // event and market revisions independently. A newer event revision can
      // accompany an older market revision in the same provider response.
      return { id: current.id, accepted: true }
    }
    if (current.payloadSha256 !== payloadSha256) {
      await tx.insert(sourceRecordRevisions).values({
        sourceRecordId: current.id,
        payload: current.payload,
        payloadSha256: current.payloadSha256,
        normalizationVersion: current.normalizationVersion,
        sourceRevisionAt: current.sourceRevisionAt,
        retrievedAt: current.retrievedAt,
        revisionType: 'superseded',
      }).onConflictDoNothing()
    }
    await tx.update(sourceRecords).set({
      payload,
      payloadSha256,
      normalizationVersion: '1',
      sourceOccurredAt: sourceOccurredAt === null ? null : new Date(sourceOccurredAt),
      sourceRevisionAt: record.kind === 'market' && record.sourceUpdatedAt !== null ? new Date(record.sourceUpdatedAt) : null,
      retrievedAt: new Date(retrievedAt),
    }).where(eq(sourceRecords.id, current.id))
    return { id: current.id, accepted: true }
  }

  const [created] = await tx.insert(sourceRecords).values({
    providerAccountId,
    recordType,
    externalRecordId,
    payload,
    payloadSha256,
    normalizationVersion: '1',
    sourceOccurredAt: sourceOccurredAt === null ? null : new Date(sourceOccurredAt),
    sourceRevisionAt: record.kind === 'market' && record.sourceUpdatedAt !== null ? new Date(record.sourceUpdatedAt) : null,
    retrievedAt: new Date(retrievedAt),
  }).onConflictDoNothing().returning({ id: sourceRecords.id })
  if (created) return { id: created.id, accepted: true }

  const [raced] = await tx.select({ id: sourceRecords.id }).from(sourceRecords).where(and(
    eq(sourceRecords.providerAccountId, providerAccountId),
    eq(sourceRecords.recordType, recordType),
    eq(sourceRecords.externalRecordId, externalRecordId),
  )).limit(1)
  if (!raced) throw new IngestionError('source_record_persist_failed')
  return { id: raced.id, accepted: true }
}

async function upsertMarket(
  tx: DatabaseTransaction,
  providerCode: string,
  record: Extract<NormalizedRecord, { kind: 'market' }>,
): Promise<boolean> {
  const incomingEventUpdatedAt = record.eventSourceUpdatedAt === null ? null : new Date(record.eventSourceUpdatedAt)
  const incomingMarketUpdatedAt = record.sourceUpdatedAt === null ? null : new Date(record.sourceUpdatedAt)
  const [existingEvent] = await tx.select({ id: events.id, sourceUpdatedAt: events.sourceUpdatedAt })
    .from(events).where(and(eq(events.providerCode, providerCode), eq(events.externalId, record.externalEventId))).limit(1).for('update')

  const [event] = await tx.insert(events).values({
    providerCode,
    externalId: record.externalEventId,
    name: record.eventName,
    description: record.eventDescription,
    resolutionRules: record.resolutionRules,
    lifecycle: record.eventLifecycle,
    resolvesAt: record.eventResolvesAt === null ? null : new Date(record.eventResolvesAt),
    sourceUpdatedAt: incomingEventUpdatedAt,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [events.providerCode, events.externalId],
    set: {
      name: record.eventName,
      description: record.eventDescription,
      resolutionRules: record.resolutionRules,
      lifecycle: record.eventLifecycle,
      resolvesAt: record.eventResolvesAt === null ? null : new Date(record.eventResolvesAt),
      sourceUpdatedAt: incomingEventUpdatedAt,
      updatedAt: new Date(),
    },
    setWhere: incomingEventUpdatedAt === null
      ? isNull(events.sourceUpdatedAt)
      : sql`${events.sourceUpdatedAt} IS NULL OR ${events.sourceUpdatedAt} <= ${incomingEventUpdatedAt}`,
  }).returning({ id: events.id })
  let eventId = event?.id ?? existingEvent?.id
  if (!eventId) {
    const [racedEvent] = await tx.select({ id: events.id }).from(events).where(and(
      eq(events.providerCode, providerCode),
      eq(events.externalId, record.externalEventId),
    )).limit(1)
    eventId = racedEvent?.id
  }
  if (!eventId) throw new IngestionError('provider_event_persist_failed')

  const [existingMarket] = await tx.select({ id: markets.id, sourceUpdatedAt: markets.sourceUpdatedAt })
    .from(markets).where(and(eq(markets.providerCode, providerCode), eq(markets.externalId, record.externalMarketId))).limit(1).for('update')
  if (existingMarket?.sourceUpdatedAt && (!incomingMarketUpdatedAt || incomingMarketUpdatedAt < existingMarket.sourceUpdatedAt)) return false

  const [market] = await tx.insert(markets).values({
    eventId,
    providerCode,
    externalId: record.externalMarketId,
    title: record.marketTitle,
    lifecycle: record.marketLifecycle,
    settlementRules: record.settlementRules,
    settlementAssetCode: record.settlementAssetCode,
    sourceUpdatedAt: incomingMarketUpdatedAt,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [markets.providerCode, markets.externalId],
    set: {
      eventId,
      title: record.marketTitle,
      lifecycle: record.marketLifecycle,
      settlementRules: record.settlementRules,
      settlementAssetCode: record.settlementAssetCode,
      sourceUpdatedAt: incomingMarketUpdatedAt,
      updatedAt: new Date(),
    },
    setWhere: incomingMarketUpdatedAt === null
      ? isNull(markets.sourceUpdatedAt)
      : sql`${markets.sourceUpdatedAt} IS NULL OR ${markets.sourceUpdatedAt} <= ${incomingMarketUpdatedAt}`,
  }).returning({ id: markets.id })
  if (!market) {
    const [racedMarket] = await tx.select({ id: markets.id }).from(markets).where(and(
      eq(markets.providerCode, providerCode),
      eq(markets.externalId, record.externalMarketId),
    )).limit(1)
    if (!racedMarket) throw new IngestionError('provider_market_persist_failed')
    return false
  }

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
  return true
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
      const source = await upsertSourceRecord(tx, { providerAccountId: input.providerAccountId, record, retrievedAt: input.retrievedAt })
      if (source.accepted) await upsertMarket(tx, input.providerCode, record)
      recordsByType[record.kind] = (recordsByType[record.kind] ?? 0) + 1
    }

    for (const record of financialRecords) {
      if ('feeAmount' in record) assertFeeIsExplicit(record)
      const source = await upsertSourceRecord(tx, { providerAccountId: input.providerAccountId, record, retrievedAt: input.retrievedAt })
      const sourceRecordId = source.id

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
        const observedAt = new Date(record.observedAt)
        const [coverage] = await tx.select({ snapshotAsOf: schema.dataCoverage.snapshotAsOf })
          .from(schema.dataCoverage).where(and(
            eq(schema.dataCoverage.providerAccountId, input.providerAccountId),
            eq(schema.dataCoverage.entityType, 'positions'),
          )).limit(1)
        const [current] = await tx.select({ observedAt: positionSnapshots.observedAt })
          .from(positionSnapshots)
          .where(and(eq(positionSnapshots.providerAccountId, input.providerAccountId), eq(positionSnapshots.instrumentId, instrumentId), eq(positionSnapshots.isCurrent, true)))
          .limit(1)
        const canUpdateCurrent = input.snapshotSemantics.positions === 'incremental'
          && (!coverage?.snapshotAsOf || observedAt >= coverage.snapshotAsOf)
          && (!current || observedAt >= current.observedAt)
        if (canUpdateCurrent) {
          await tx.update(positionSnapshots).set({ isCurrent: false }).where(and(
            eq(positionSnapshots.providerAccountId, input.providerAccountId),
            eq(positionSnapshots.instrumentId, instrumentId),
            eq(positionSnapshots.isCurrent, true),
          ))
        }
        await tx.insert(positionSnapshots).values({
          providerAccountId: input.providerAccountId,
          instrumentId,
          sourceRecordId,
          externalId: record.externalId,
          syncRunId: input.runId,
          observedAt,
          quantity: record.quantity,
          averageCostPrice: record.averageCostPrice,
          markPrice: record.markPrice,
          markAt: record.markAt === null ? null : new Date(record.markAt),
          settlementAssetCode: record.settlementAssetCode,
          origin: record.origin,
          reconciliationStatus: record.reconciliationStatus,
          isCurrent: false,
          ingestedAt: new Date(input.retrievedAt),
        }).onConflictDoUpdate({
          target: [positionSnapshots.providerAccountId, positionSnapshots.externalId, positionSnapshots.observedAt, positionSnapshots.syncRunId],
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
            isCurrent: false,
            ingestedAt: new Date(input.retrievedAt),
          },
        })
        if (canUpdateCurrent) {
          await tx.update(positionSnapshots).set({ isCurrent: true }).where(and(
            eq(positionSnapshots.providerAccountId, input.providerAccountId),
            eq(positionSnapshots.externalId, record.externalId),
            eq(positionSnapshots.observedAt, observedAt),
            eq(positionSnapshots.syncRunId, input.runId),
          ))
        }
      } else if (record.kind === 'cash_balance') {
        const observedAt = new Date(record.observedAt)
        const [coverage] = await tx.select({ snapshotAsOf: schema.dataCoverage.snapshotAsOf })
          .from(schema.dataCoverage).where(and(
            eq(schema.dataCoverage.providerAccountId, input.providerAccountId),
            eq(schema.dataCoverage.entityType, 'cash_balances'),
          )).limit(1)
        const [current] = await tx.select({ observedAt: cashBalanceSnapshots.observedAt })
          .from(cashBalanceSnapshots)
          .where(and(eq(cashBalanceSnapshots.providerAccountId, input.providerAccountId), eq(cashBalanceSnapshots.assetCode, record.assetCode), eq(cashBalanceSnapshots.isCurrent, true)))
          .limit(1)
        const canUpdateCurrent = input.snapshotSemantics.cash_balances === 'incremental'
          && (!coverage?.snapshotAsOf || observedAt >= coverage.snapshotAsOf)
          && (!current || observedAt >= current.observedAt)
        if (canUpdateCurrent) {
          await tx.update(cashBalanceSnapshots).set({ isCurrent: false }).where(and(
            eq(cashBalanceSnapshots.providerAccountId, input.providerAccountId),
            eq(cashBalanceSnapshots.assetCode, record.assetCode),
            eq(cashBalanceSnapshots.isCurrent, true),
          ))
        }
        await tx.insert(cashBalanceSnapshots).values({
          providerAccountId: input.providerAccountId,
          sourceRecordId,
          externalId: record.externalId,
          syncRunId: input.runId,
          observedAt,
          balance: record.balance,
          assetCode: record.assetCode,
          isCurrent: false,
          ingestedAt: new Date(input.retrievedAt),
        }).onConflictDoUpdate({
          target: [cashBalanceSnapshots.providerAccountId, cashBalanceSnapshots.externalId, cashBalanceSnapshots.observedAt, cashBalanceSnapshots.syncRunId],
          set: {
            sourceRecordId,
            observedAt: new Date(record.observedAt),
            balance: record.balance,
            assetCode: record.assetCode,
            isCurrent: false,
            ingestedAt: new Date(input.retrievedAt),
          },
        })
        if (canUpdateCurrent) {
          await tx.update(cashBalanceSnapshots).set({ isCurrent: true }).where(and(
            eq(cashBalanceSnapshots.providerAccountId, input.providerAccountId),
            eq(cashBalanceSnapshots.externalId, record.externalId),
            eq(cashBalanceSnapshots.observedAt, observedAt),
            eq(cashBalanceSnapshots.syncRunId, input.runId),
          ))
        }
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
          target: [priceObservations.providerAccountId, priceObservations.externalId, priceObservations.observedAt],
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

    const [lease] = await tx.update(syncCheckpoints).set({
      leaseExpiresAt: sql`now() + interval '2 minutes'`,
      updatedAt: new Date(input.retrievedAt),
    }).where(and(
      eq(syncCheckpoints.id, input.accountCheckpointId),
      eq(syncCheckpoints.leaseToken, input.leaseToken),
    )).returning({ id: syncCheckpoints.id })
    if (!lease) throw new IngestionError('sync_lease_lost')
    await tx.update(syncCheckpoints).set({
      cursor: input.nextCursor,
      durableCheckpoint: input.durableCheckpoint,
      status: 'running',
      updatedAt: new Date(input.retrievedAt),
    }).where(eq(syncCheckpoints.id, input.streamCheckpointId))
    await tx.update(syncRuns).set({
      cursorAtEnd: input.nextCursor,
      pagesRead: sql`${syncRuns.pagesRead} + 1`,
      recordsSeen: sql`${syncRuns.recordsSeen} + ${input.records.length}`,
    }).where(eq(syncRuns.id, input.runId))
    await updateObservedRanges(tx, input.providerAccountId, input.records, new Date(input.retrievedAt))
  })

  return { recordsSeen: input.records.length, recordsByType }
}

export async function initializeCoverage(
  tx: DatabaseTransaction,
  providerAccountId: string,
  capabilities: ProviderCapabilities,
  initializedAt: Date,
): Promise<void> {
  for (const [entityType, capability] of Object.entries(capabilities.operations)) {
    const unsupported = capability === 'unsupported'
    await tx.insert(schema.dataCoverage).values({
      providerAccountId,
      entityType,
      status: unsupported ? 'unavailable' : 'unknown',
      reasonCode: unsupported ? 'unsupported_by_provider' : null,
      updatedAt: initializedAt,
    }).onConflictDoNothing()
  }
}

function coverageTimestamp(record: NormalizedRecord): string | null {
  if (record.kind === 'market') return record.sourceUpdatedAt
  if (record.kind === 'fill' || record.kind === 'cash_movement') return record.occurredAt
  if (record.kind === 'settlement') return record.settledAt
  return record.observedAt
}

export async function updateObservedRanges(
  tx: DatabaseTransaction,
  providerAccountId: string,
  records: NormalizedRecord[],
  retrievedAt: Date,
): Promise<void> {
  const ranges = new Map<CoverageEntity, { start: Date; end: Date }>()
  for (const record of records) {
    const at = coverageTimestamp(record)
    if (at === null) continue
    const entity = record.kind === 'market' ? 'markets'
      : record.kind === 'fill' ? 'fills'
        : record.kind === 'cash_movement' ? 'cash_movements'
          : record.kind === 'settlement' ? 'settlements'
            : record.kind === 'position' ? 'positions'
              : record.kind === 'cash_balance' ? 'cash_balances' : 'prices'
    const timestamp = new Date(at)
    const current = ranges.get(entity)
    ranges.set(entity, {
      start: current && current.start < timestamp ? current.start : timestamp,
      end: current && current.end > timestamp ? current.end : timestamp,
    })
  }

  for (const [entityType, range] of ranges) {
    const [existing] = await tx.select({
      observedRecordStart: schema.dataCoverage.observedRecordStart,
      observedRecordEnd: schema.dataCoverage.observedRecordEnd,
    }).from(schema.dataCoverage).where(and(
      eq(schema.dataCoverage.providerAccountId, providerAccountId),
      eq(schema.dataCoverage.entityType, entityType),
    )).limit(1)
    if (existing) {
      await tx.update(schema.dataCoverage).set({
        observedRecordStart: !existing.observedRecordStart || range.start < existing.observedRecordStart ? range.start : existing.observedRecordStart,
        observedRecordEnd: !existing.observedRecordEnd || range.end > existing.observedRecordEnd ? range.end : existing.observedRecordEnd,
        updatedAt: retrievedAt,
      }).where(and(
        eq(schema.dataCoverage.providerAccountId, providerAccountId),
        eq(schema.dataCoverage.entityType, entityType),
      ))
    } else {
      await tx.insert(schema.dataCoverage).values({
        providerAccountId,
        entityType,
        status: 'unknown',
        observedRecordStart: range.start,
        observedRecordEnd: range.end,
        updatedAt: retrievedAt,
      }).onConflictDoNothing()
    }
  }
}

export interface CoverageWriteInput {
  providerAccountId: string
  stream: ProviderSyncStream
  reports: Partial<Record<CoverageEntity, EntityCoverageReport>>
  retrievedAt: string
  syncStatus: 'complete' | 'partial' | 'failed'
  errorCode: string | null
  pagesPersisted: boolean
  positionSnapshotComplete: boolean
  cashBalanceSnapshotComplete: boolean
}

export async function writeStreamCoverage(tx: DatabaseTransaction, input: CoverageWriteInput): Promise<void> {
  const attemptedAt = new Date(input.retrievedAt)
  for (const entityType of input.stream.entities) {
    const report = input.reports[entityType]
    const [existing] = await tx.select().from(schema.dataCoverage).where(and(
      eq(schema.dataCoverage.providerAccountId, input.providerAccountId),
      eq(schema.dataCoverage.entityType, entityType),
    )).limit(1)

    let establishedStatus = existing?.status ?? 'unknown'
    let reasonCode = existing?.reasonCode ?? null
    let coverageStart = existing?.coverageStart ?? null
    let coverageEnd = existing?.coverageEnd ?? null
    let sourceAsOf = existing?.sourceAsOf ?? null

    const temporaryUnavailable = report !== undefined
      && (report.status === 'unavailable' || report.status === 'unknown')
      && existing !== undefined
      && (existing.status === 'complete' || existing.status === 'partial')
    const staleSnapshotNotPublished = input.syncStatus === 'complete'
      && report?.status === 'complete'
      && ((entityType === 'positions' && input.stream.snapshotSemantics.positions === 'complete' && !input.positionSnapshotComplete)
        || (entityType === 'cash_balances' && input.stream.snapshotSemantics.cash_balances === 'complete' && !input.cashBalanceSnapshotComplete))
    if (input.syncStatus === 'complete' && report && !temporaryUnavailable) {
      establishedStatus = report.status
      reasonCode = report.reasonCode ?? (report.status === 'partial' ? 'provider_reports_partial_history' : report.status === 'unavailable' ? 'provider_temporarily_unavailable' : null)
      if (report.coverageStart) {
        const candidate = new Date(report.coverageStart)
        if (!coverageStart || candidate < coverageStart) coverageStart = candidate
      }
      if (report.coverageEnd) {
        const candidate = new Date(report.coverageEnd)
        if (!coverageEnd || candidate > coverageEnd) coverageEnd = candidate
      }
      if (report.sourceAsOf) {
        const candidate = new Date(report.sourceAsOf)
        if (!sourceAsOf || candidate > sourceAsOf) sourceAsOf = candidate
      }
    } else if (input.syncStatus !== 'complete' && input.pagesPersisted
      && (!existing || existing.status === 'unknown' || (existing.status === 'unavailable' && existing.reasonCode !== 'unsupported_by_provider'))) {
      establishedStatus = 'partial'
      reasonCode = 'sync_incomplete'
      if (report?.coverageStart) coverageStart = new Date(report.coverageStart)
      if (report?.coverageEnd) coverageEnd = new Date(report.coverageEnd)
      if (report?.sourceAsOf) sourceAsOf = new Date(report.sourceAsOf)
    }

    const values = {
      status: establishedStatus,
      reasonCode,
      coverageStart,
      coverageEnd,
      sourceAsOf,
      lastAttemptAt: attemptedAt,
      lastAttemptStatus: input.syncStatus,
      lastAttemptCoverageStatus: report?.status ?? 'unknown' as const,
      lastAttemptReasonCode: staleSnapshotNotPublished ? 'stale_snapshot_rejected' : report?.reasonCode ?? input.errorCode,
      lastSuccessfulSyncAt: input.syncStatus === 'complete'
        && (report?.status === 'complete' || report?.status === 'partial')
        && (entityType !== 'positions' || input.stream.snapshotSemantics.positions !== 'complete' || input.positionSnapshotComplete)
        && (entityType !== 'cash_balances' || input.stream.snapshotSemantics.cash_balances !== 'complete' || input.cashBalanceSnapshotComplete)
        ? attemptedAt
        : existing?.lastSuccessfulSyncAt ?? null,
      updatedAt: attemptedAt,
    }
    await tx.insert(schema.dataCoverage).values({
      providerAccountId: input.providerAccountId,
      entityType,
      ...values,
    }).onConflictDoUpdate({
      target: [schema.dataCoverage.providerAccountId, schema.dataCoverage.entityType],
      set: values,
    })
  }
}

export async function finalizeSnapshots(input: {
  tx: DatabaseTransaction
  providerAccountId: string
  runId: string
  stream: ProviderSyncStream
  reports: Partial<Record<CoverageEntity, EntityCoverageReport>>
  finishedAt: Date
}): Promise<{ positionSnapshotComplete: boolean; cashBalanceSnapshotComplete: boolean }> {
  const { tx, providerAccountId, runId, stream, reports, finishedAt } = input
  let positionSnapshotComplete = false
  let cashBalanceSnapshotComplete = false

  if (stream.snapshotSemantics.positions === 'complete' && reports.positions?.status === 'complete') {
    const asOf = new Date(reports.positions.sourceAsOf ?? finishedAt.toISOString())
    const [coverage] = await tx.select({ snapshotAsOf: schema.dataCoverage.snapshotAsOf })
      .from(schema.dataCoverage).where(and(
        eq(schema.dataCoverage.providerAccountId, providerAccountId),
        eq(schema.dataCoverage.entityType, 'positions'),
      )).limit(1)
    const [latestCurrent] = await tx.select({ observedAt: positionSnapshots.observedAt }).from(positionSnapshots).where(and(
      eq(positionSnapshots.providerAccountId, providerAccountId),
      eq(positionSnapshots.isCurrent, true),
    )).orderBy(sql`${positionSnapshots.observedAt} DESC`).limit(1)
    if ((!coverage?.snapshotAsOf || coverage.snapshotAsOf <= asOf) && (!latestCurrent || latestCurrent.observedAt <= asOf)) {
      await tx.update(positionSnapshots).set({ isCurrent: false }).where(and(
        eq(positionSnapshots.providerAccountId, providerAccountId),
        eq(positionSnapshots.isCurrent, true),
      ))
      const rows = await tx.select({ id: positionSnapshots.id, instrumentId: positionSnapshots.instrumentId, observedAt: positionSnapshots.observedAt })
        .from(positionSnapshots).where(and(
          eq(positionSnapshots.providerAccountId, providerAccountId),
          eq(positionSnapshots.syncRunId, runId),
        ))
      const currentByInstrument = new Map<string, typeof rows[number]>()
      for (const row of rows) {
        const prior = currentByInstrument.get(row.instrumentId)
        if (!prior || row.observedAt > prior.observedAt) currentByInstrument.set(row.instrumentId, row)
      }
      for (const row of currentByInstrument.values()) {
        await tx.update(positionSnapshots).set({ isCurrent: true }).where(eq(positionSnapshots.id, row.id))
      }
      await tx.update(schema.dataCoverage).set({ snapshotAsOf: asOf, updatedAt: finishedAt }).where(and(
        eq(schema.dataCoverage.providerAccountId, providerAccountId),
        eq(schema.dataCoverage.entityType, 'positions'),
      ))
      positionSnapshotComplete = true
    }
  }

  if (stream.snapshotSemantics.cash_balances === 'complete' && reports.cash_balances?.status === 'complete') {
    const asOf = new Date(reports.cash_balances.sourceAsOf ?? finishedAt.toISOString())
    const [coverage] = await tx.select({ snapshotAsOf: schema.dataCoverage.snapshotAsOf })
      .from(schema.dataCoverage).where(and(
        eq(schema.dataCoverage.providerAccountId, providerAccountId),
        eq(schema.dataCoverage.entityType, 'cash_balances'),
      )).limit(1)
    const [latestCurrent] = await tx.select({ observedAt: cashBalanceSnapshots.observedAt }).from(cashBalanceSnapshots).where(and(
      eq(cashBalanceSnapshots.providerAccountId, providerAccountId),
      eq(cashBalanceSnapshots.isCurrent, true),
    )).orderBy(sql`${cashBalanceSnapshots.observedAt} DESC`).limit(1)
    if ((!coverage?.snapshotAsOf || coverage.snapshotAsOf <= asOf) && (!latestCurrent || latestCurrent.observedAt <= asOf)) {
      await tx.update(cashBalanceSnapshots).set({ isCurrent: false }).where(and(
        eq(cashBalanceSnapshots.providerAccountId, providerAccountId),
        eq(cashBalanceSnapshots.isCurrent, true),
      ))
      const rows = await tx.select({ id: cashBalanceSnapshots.id, assetCode: cashBalanceSnapshots.assetCode, observedAt: cashBalanceSnapshots.observedAt })
        .from(cashBalanceSnapshots).where(and(
          eq(cashBalanceSnapshots.providerAccountId, providerAccountId),
          eq(cashBalanceSnapshots.syncRunId, runId),
        ))
      const currentByAsset = new Map<string, typeof rows[number]>()
      for (const row of rows) {
        const prior = currentByAsset.get(row.assetCode)
        if (!prior || row.observedAt > prior.observedAt) currentByAsset.set(row.assetCode, row)
      }
      for (const row of currentByAsset.values()) await tx.update(cashBalanceSnapshots).set({ isCurrent: true }).where(eq(cashBalanceSnapshots.id, row.id))
      await tx.update(schema.dataCoverage).set({ snapshotAsOf: asOf, updatedAt: finishedAt }).where(and(
        eq(schema.dataCoverage.providerAccountId, providerAccountId),
        eq(schema.dataCoverage.entityType, 'cash_balances'),
      ))
      cashBalanceSnapshotComplete = true
    }
  }

  return { positionSnapshotComplete, cashBalanceSnapshotComplete }
}

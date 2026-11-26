import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

const scevia = pgSchema('scevia')

export const accountKindEnum = scevia.enum('account_kind', [
  'public_wallet',
  'authenticated_account',
  'file_import',
  'fixture',
])
export const feeStatusEnum = scevia.enum('fee_status', ['reported', 'estimated', 'unavailable'])
export const tradeDirectionEnum = scevia.enum('trade_direction', ['buy', 'sell'])
export const cashMovementKindEnum = scevia.enum('cash_movement_kind', [
  'deposit',
  'withdrawal',
  'transfer',
  'adjustment',
])
export const positionOriginEnum = scevia.enum('position_origin', ['provider_reported', 'reconstructed'])
export const reconciliationStatusEnum = scevia.enum('reconciliation_status', [
  'not_started',
  'pending',
  'matched',
  'difference',
])
export const syncStatusEnum = scevia.enum('sync_status', [
  'idle',
  'running',
  'complete',
  'partial',
  'failed',
  'unavailable',
])
export const coverageStatusEnum = scevia.enum('coverage_status', [
  'complete',
  'partial',
  'unavailable',
  'unknown',
])
export const relationshipClassEnum = scevia.enum('relationship_class', [
  'equivalent',
  'mutually_exclusive',
  'related',
  'unknown',
])
export const relationshipReviewEnum = scevia.enum('relationship_review', [
  'unverified',
  'confirmed',
  'rejected',
])

export const users = scevia.table('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  authSubject: text('auth_subject').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const portfolios = scevia.table(
  'portfolios',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    demo: jsonb('demo').$type<{ revision: string; catalogRevision?: string; dataset: import('../demo/dataset.js').DemoDataset; priorMarkets?: import('../demo/dataset.js').DemoDataset['markets'] }>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('portfolios_owner_id_idx').on(table.ownerId)],
)

export const providerAccounts = scevia.table(
  'provider_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    portfolioId: uuid('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
    providerCode: text('provider_code').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    label: text('label').notNull(),
    kind: accountKindEnum('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('provider_accounts_source_unique').on(
      table.portfolioId,
      table.providerCode,
      table.externalAccountId,
    ),
    index('provider_accounts_portfolio_id_idx').on(table.portfolioId),
  ],
)

export const events = scevia.table(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerCode: text('provider_code').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    resolutionRules: text('resolution_rules'),
    lifecycle: text('lifecycle').notNull().default('unknown'),
    resolvesAt: timestamp('resolves_at', { withTimezone: true }),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('events_provider_external_unique').on(table.providerCode, table.externalId),
    index('events_provider_code_idx').on(table.providerCode),
  ],
)

export const markets = scevia.table(
  'markets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
    providerCode: text('provider_code').notNull(),
    externalId: text('external_id').notNull(),
    eventIdentityKind: text('event_identity_kind').notNull().default('provider_native'),
    title: text('title').notNull(),
    lifecycle: text('lifecycle').notNull().default('unknown'),
    settlementRules: text('settlement_rules'),
    settlementAssetCode: text('settlement_asset_code'),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('markets_provider_external_unique').on(table.providerCode, table.externalId),
    index('markets_event_id_idx').on(table.eventId),
  ],
)

export const instruments = scevia.table(
  'instruments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    marketId: uuid('market_id').notNull().references(() => markets.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    outcomeName: text('outcome_name').notNull(),
    outcomeType: text('outcome_type').notNull().default('unknown'),
    payoutAmount: numeric('payout_amount', { precision: 38, scale: 18 }),
    settlementAssetCode: text('settlement_asset_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('instruments_market_external_unique').on(table.marketId, table.externalId),
    index('instruments_market_id_idx').on(table.marketId),
  ],
)

export const eventRelationships = scevia.table(
  'event_relationships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventAId: uuid('event_a_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
    eventBId: uuid('event_b_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
    relationshipClass: relationshipClassEnum('relationship_class').notNull(),
    review: relationshipReviewEnum('review').notNull().default('unverified'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('event_relationships_pair_unique').on(table.eventAId, table.eventBId),
    check('event_relationships_distinct_ordered', sql`${table.eventAId} < ${table.eventBId}`),
  ],
)

export const sourceRecords = scevia.table(
  'source_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    recordType: text('record_type').notNull(),
    externalRecordId: text('external_record_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    normalizationVersion: text('normalization_version').notNull(),
    sourceOccurredAt: timestamp('source_occurred_at', { withTimezone: true }),
    sourceRevisionAt: timestamp('source_revision_at', { withTimezone: true }),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('source_records_external_unique').on(
      table.providerAccountId,
      table.recordType,
      table.externalRecordId,
    ),
    index('source_records_retrieved_at_idx').on(table.providerAccountId, table.retrievedAt),
  ],
)

export const sourceRecordRevisions = scevia.table(
  'source_record_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceRecordId: uuid('source_record_id').notNull().references(() => sourceRecords.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    normalizationVersion: text('normalization_version').notNull(),
    sourceRevisionAt: timestamp('source_revision_at', { withTimezone: true }),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
    revisionType: text('revision_type').notNull().default('superseded'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('source_record_revisions_hash_unique').on(table.sourceRecordId, table.payloadSha256),
    index('source_record_revisions_recorded_idx').on(table.sourceRecordId, table.recordedAt),
  ],
)

export const fills = scevia.table(
  'fills',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id').notNull().references(() => instruments.id),
    sourceRecordId: uuid('source_record_id').notNull().references(() => sourceRecords.id),
    externalId: text('external_id').notNull(),
    identityKind: text('identity_kind').notNull().default('provider_native'),
    direction: tradeDirectionEnum('direction').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    quantity: numeric('quantity', { precision: 38, scale: 18 }).notNull(),
    price: numeric('price', { precision: 38, scale: 18 }).notNull(),
    feeAmount: numeric('fee_amount', { precision: 38, scale: 18 }),
    feeStatus: feeStatusEnum('fee_status').notNull(),
    settlementAssetCode: text('settlement_asset_code').notNull(),
    finality: text('finality').notNull().default('unknown'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('fills_account_external_unique').on(table.providerAccountId, table.externalId),
    index('fills_account_occurred_idx').on(table.providerAccountId, table.occurredAt, table.id),
    check('fills_quantity_positive', sql`${table.quantity} > 0`),
    check('fills_price_nonnegative', sql`${table.price} >= 0`),
    check(
      'fills_fee_status_consistent',
      sql`(${table.feeStatus} = 'unavailable' AND ${table.feeAmount} IS NULL) OR (${table.feeStatus} IN ('reported', 'estimated') AND ${table.feeAmount} IS NOT NULL)`,
    ),
  ],
)

export const providerActivityFacts = scevia.table(
  'provider_activity_facts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    sourceRecordId: uuid('source_record_id').notNull().references(() => sourceRecords.id),
    externalId: text('external_id').notNull(),
    identityKind: text('identity_kind').notNull().default('source_fingerprint'),
    sourceEndpoint: text('source_endpoint').notNull().default('activity'),
    activityType: text('activity_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    transactionHash: text('transaction_hash'),
    externalMarketId: text('external_market_id'),
    externalInstrumentId: text('external_instrument_id'),
    side: text('side'),
    quantity: numeric('quantity', { precision: 38, scale: 18 }),
    price: numeric('price', { precision: 38, scale: 18 }),
    amount: numeric('amount', { precision: 38, scale: 18 }),
    assetCode: text('asset_code'),
    classification: text('classification').notNull().default('unreconciled'),
    resolutionReason: text('resolution_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('provider_activity_facts_account_external_unique').on(table.providerAccountId, table.externalId),
    index('provider_activity_facts_account_occurred_idx').on(table.providerAccountId, table.occurredAt, table.id),
  ],
)

export const cashMovements = scevia.table(
  'cash_movements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    sourceRecordId: uuid('source_record_id').notNull().references(() => sourceRecords.id),
    externalId: text('external_id').notNull(),
    movementKind: cashMovementKindEnum('movement_kind').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    signedAmount: numeric('signed_amount', { precision: 38, scale: 18 }).notNull(),
    assetCode: text('asset_code').notNull(),
    feeAmount: numeric('fee_amount', { precision: 38, scale: 18 }),
    feeStatus: feeStatusEnum('fee_status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('cash_movements_account_external_unique').on(table.providerAccountId, table.externalId),
    index('cash_movements_account_occurred_idx').on(table.providerAccountId, table.occurredAt, table.id),
    check(
      'cash_movements_direction_sign',
      sql`(${table.movementKind} = 'deposit' AND ${table.signedAmount} > 0) OR (${table.movementKind} = 'withdrawal' AND ${table.signedAmount} < 0) OR ${table.movementKind} IN ('transfer', 'adjustment')`,
    ),
    check(
      'cash_movements_fee_status_consistent',
      sql`(${table.feeStatus} = 'unavailable' AND ${table.feeAmount} IS NULL) OR (${table.feeStatus} IN ('reported', 'estimated') AND ${table.feeAmount} IS NOT NULL)`,
    ),
  ],
)

export const settlements = scevia.table(
  'settlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id').notNull().references(() => instruments.id),
    sourceRecordId: uuid('source_record_id').notNull().references(() => sourceRecords.id),
    externalId: text('external_id').notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
    quantity: numeric('quantity', { precision: 38, scale: 18 }).notNull(),
    payoutAmount: numeric('payout_amount', { precision: 38, scale: 18 }).notNull(),
    assetCode: text('asset_code').notNull(),
    feeAmount: numeric('fee_amount', { precision: 38, scale: 18 }),
    feeStatus: feeStatusEnum('fee_status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('settlements_account_external_unique').on(table.providerAccountId, table.externalId),
    index('settlements_account_settled_idx').on(table.providerAccountId, table.settledAt, table.id),
    check('settlements_quantity_positive', sql`${table.quantity} > 0`),
    check('settlements_payout_nonnegative', sql`${table.payoutAmount} >= 0`),
    check(
      'settlements_fee_status_consistent',
      sql`(${table.feeStatus} = 'unavailable' AND ${table.feeAmount} IS NULL) OR (${table.feeStatus} IN ('reported', 'estimated') AND ${table.feeAmount} IS NOT NULL)`,
    ),
  ],
)

export const positionSnapshots = scevia.table(
  'position_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id').notNull().references(() => instruments.id),
    sourceRecordId: uuid('source_record_id').notNull().references(() => sourceRecords.id),
    externalId: text('external_id').notNull(),
    syncRunId: uuid('sync_run_id').notNull().references(() => syncRuns.id, { onDelete: 'cascade' }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    quantity: numeric('quantity', { precision: 38, scale: 18 }).notNull(),
    averageCostPrice: numeric('average_cost_price', { precision: 38, scale: 18 }),
    markPrice: numeric('mark_price', { precision: 38, scale: 18 }),
    markAt: timestamp('mark_at', { withTimezone: true }),
    settlementAssetCode: text('settlement_asset_code'),
    providerStatus: text('provider_status'),
    redeemable: boolean('redeemable'),
    mergeable: boolean('mergeable'),
    archived: boolean('archived'),
    providerCurrentValue: numeric('provider_current_value', { precision: 38, scale: 18 }),
    providerRealizedPnl: numeric('provider_realized_pnl', { precision: 38, scale: 18 }),
    providerUnrealizedPnl: numeric('provider_unrealized_pnl', { precision: 38, scale: 18 }),
    providerTotalPnl: numeric('provider_total_pnl', { precision: 38, scale: 18 }),
    providerEntryCost: numeric('provider_entry_cost', { precision: 38, scale: 18 }),
    providerEntryFees: numeric('provider_entry_fees', { precision: 38, scale: 18 }),
    providerTotalCost: numeric('provider_total_cost', { precision: 38, scale: 18 }),
    providerTotalSize: numeric('provider_total_size', { precision: 38, scale: 18 }),
    providerPercentPnl: numeric('provider_percent_pnl', { precision: 38, scale: 18 }),
    origin: positionOriginEnum('origin').notNull(),
    reconciliationStatus: reconciliationStatusEnum('reconciliation_status').notNull().default('not_started'),
    isCurrent: boolean('is_current').notNull().default(false),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('position_snapshots_observation_unique').on(table.providerAccountId, table.externalId, table.observedAt, table.syncRunId),
    uniqueIndex('position_snapshots_current_unique').on(table.providerAccountId, table.instrumentId).where(sql`${table.isCurrent}`),
    index('position_snapshots_latest_idx').on(table.providerAccountId, table.instrumentId, table.observedAt, table.ingestedAt),
    check('position_snapshots_avg_cost_nonnegative', sql`${table.averageCostPrice} IS NULL OR ${table.averageCostPrice} >= 0`),
    check('position_snapshots_mark_nonnegative', sql`${table.markPrice} IS NULL OR ${table.markPrice} >= 0`),
  ],
)

export const cashBalanceSnapshots = scevia.table(
  'cash_balance_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    sourceRecordId: uuid('source_record_id').notNull().references(() => sourceRecords.id),
    externalId: text('external_id').notNull(),
    syncRunId: uuid('sync_run_id').notNull().references(() => syncRuns.id, { onDelete: 'cascade' }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    balance: numeric('balance', { precision: 38, scale: 18 }).notNull(),
    assetCode: text('asset_code').notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('cash_balance_snapshots_observation_unique').on(table.providerAccountId, table.externalId, table.observedAt, table.syncRunId),
    uniqueIndex('cash_balance_snapshots_current_unique').on(table.providerAccountId, table.assetCode).where(sql`${table.isCurrent}`),
    index('cash_balance_snapshots_latest_idx').on(table.providerAccountId, table.observedAt),
  ],
)

export const priceObservations = scevia.table(
  'price_observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id').notNull().references(() => instruments.id),
    sourceRecordId: uuid('source_record_id').notNull().references(() => sourceRecords.id),
    externalId: text('external_id').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    price: numeric('price', { precision: 38, scale: 18 }).notNull(),
    priceKind: text('price_kind').notNull(),
    assetCode: text('asset_code').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('price_observations_account_external_time_unique').on(table.providerAccountId, table.externalId, table.observedAt),
    index('price_observations_instrument_time_idx').on(table.instrumentId, table.observedAt),
    check('price_observations_nonnegative', sql`${table.price} >= 0`),
  ],
)

export const syncRuns = scevia.table(
  'sync_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    syncName: text('sync_name').notNull(),
    status: syncStatusEnum('status').notNull(),
    cursorAtStart: text('cursor_at_start'),
    cursorAtEnd: text('cursor_at_end'),
    checkpointAtStart: text('checkpoint_at_start'),
    checkpointAtEnd: text('checkpoint_at_end'),
    positionSnapshotComplete: boolean('position_snapshot_complete').notNull().default(false),
    cashBalanceSnapshotComplete: boolean('cash_balance_snapshot_complete').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    pagesRead: integer('pages_read').notNull().default(0),
    recordsSeen: integer('records_seen').notNull().default(0),
    recordsRejected: integer('records_rejected').notNull().default(0),
    rowsReceived: integer('rows_received').notNull().default(0),
    sourceRowsRetained: integer('source_rows_retained').notNull().default(0),
    invalidRecords: integer('invalid_records').notNull().default(0),
    recordsPersisted: integer('records_persisted').notNull().default(0),
    exactDuplicates: integer('exact_duplicates').notNull().default(0),
    unresolvedRecords: integer('unresolved_records').notNull().default(0),
    overlapCandidates: integer('overlap_candidates').notNull().default(0),
    excludedRecords: integer('excluded_records').notNull().default(0),
    errorCode: text('error_code'),
  },
  (table) => [
    index('sync_runs_account_started_idx').on(table.providerAccountId, table.startedAt),
    check('sync_runs_pages_nonnegative', sql`${table.pagesRead} >= 0`),
    check('sync_runs_records_nonnegative', sql`${table.recordsSeen} >= 0 AND ${table.recordsRejected} >= 0 AND ${table.rowsReceived} >= 0 AND ${table.sourceRowsRetained} >= 0 AND ${table.invalidRecords} >= 0 AND ${table.recordsPersisted} >= 0 AND ${table.exactDuplicates} >= 0 AND ${table.unresolvedRecords} >= 0 AND ${table.overlapCandidates} >= 0 AND ${table.excludedRecords} >= 0`),
  ],
)

export const syncCheckpoints = scevia.table(
  'sync_checkpoints',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    syncName: text('sync_name').notNull(),
    cursor: text('cursor'),
    durableCheckpoint: text('durable_checkpoint'),
    status: syncStatusEnum('status').notNull().default('idle'),
    lastRunId: uuid('last_run_id'),
    lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
    lastCompletedAt: timestamp('last_completed_at', { withTimezone: true }),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('sync_checkpoints_account_name_unique').on(table.providerAccountId, table.syncName),
    index('sync_checkpoints_lease_idx').on(table.leaseExpiresAt),
  ],
)

export const dataCoverage = scevia.table(
  'data_coverage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => providerAccounts.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    status: coverageStatusEnum('status').notNull(),
    reasonCode: text('reason_code'),
    observedRecordStart: timestamp('observed_record_start', { withTimezone: true }),
    observedRecordEnd: timestamp('observed_record_end', { withTimezone: true }),
    coverageStart: timestamp('coverage_start', { withTimezone: true }),
    coverageEnd: timestamp('coverage_end', { withTimezone: true }),
    sourceAsOf: timestamp('source_as_of', { withTimezone: true }),
    snapshotAsOf: timestamp('snapshot_as_of', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastAttemptStatus: syncStatusEnum('last_attempt_status'),
    lastAttemptCoverageStatus: coverageStatusEnum('last_attempt_coverage_status'),
    lastAttemptReasonCode: text('last_attempt_reason_code'),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
    lastSuccessfulRunId: uuid('last_successful_run_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('data_coverage_account_entity_unique').on(table.providerAccountId, table.entityType),
    index('data_coverage_account_updated_idx').on(table.providerAccountId, table.updatedAt),
  ],
)

// Counts source rows committed within one attempt, independently of economic multiplicity.
export const activityFactOccurrences = scevia.table('activity_fact_occurrences', {
  syncRunId: uuid('sync_run_id').notNull().references(() => syncRuns.id, { onDelete: 'cascade' }),
  activityFactId: uuid('activity_fact_id').notNull().references(() => providerActivityFacts.id, { onDelete: 'cascade' }),
  observations: integer('observations').notNull(),
}, (table) => [
  uniqueIndex('activity_fact_occurrences_run_fact_unique').on(table.syncRunId, table.activityFactId),
  index('activity_fact_occurrences_fact_idx').on(table.activityFactId),
  check('activity_fact_occurrences_positive', sql`${table.observations} > 0`),
])

export const financialImportBatches = scevia.table('financial_import_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  portfolioId: uuid('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash').notNull(),
  associatedAccountId: uuid('associated_account_id').references(() => providerAccounts.id, { onDelete: 'cascade' }),
  sourceLinks: jsonb('source_links').$type<Record<string, string>>().notNull().default({}),
  reviewDigest: text('review_digest'),
  reviewReplaces: uuid('review_replaces'),
  manual: boolean('manual').notNull().default(false),
  acceptUnlinked: boolean('accept_unlinked').notNull().default(false),
  observations: jsonb('observations').$type<import('../accounting/model.js').FinancialObservation[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  supersededBy: uuid('superseded_by'),
}, (table) => [
  uniqueIndex('financial_import_batches_portfolio_content').on(table.portfolioId, table.contentHash),
])

export const portfolioAccountingDecisions = scevia.table('portfolio_accounting_decisions', {
  id: uuid('id').defaultRandom().primaryKey(),
  portfolioId: uuid('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
  recordKey: text('record_key').notNull(),
  decision: jsonb('decision').$type<import('../accounting/model.js').PortfolioDecision | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revision: integer('revision').notNull(),
  operationDigest: text('operation_digest'),
  operationCount: integer('operation_count'),
}, (table) => [
  uniqueIndex('accounting_decision_operation_unique').on(table.portfolioId, table.operationDigest),
  uniqueIndex('accounting_decision_revision_unique').on(table.portfolioId, table.revision),
  index('accounting_decision_record_idx').on(table.portfolioId, table.recordKey, table.revision),
])

// Verified binary payout rules are curated evidence. Portfolio users cannot create these through analytics routes.
export const reviewedBinaryRules = scevia.table('reviewed_binary_rules', {
  marketId: uuid('market_id').primaryKey().references(() => markets.id, { onDelete: 'cascade' }),
  yesInstrumentId: uuid('yes_instrument_id').notNull().references(() => instruments.id, { onDelete: 'cascade' }),
  noInstrumentId: uuid('no_instrument_id').notNull().references(() => instruments.id, { onDelete: 'cascade' }),
  assetCode: text('asset_code').notNull(),
  evidence: text('evidence').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
}, (table) => [
  check('reviewed_binary_distinct_legs', sql`${table.yesInstrumentId} <> ${table.noInstrumentId}`),
  check('reviewed_binary_evidence_required', sql`length(trim(${table.evidence})) > 0`),
])

export const reviewedSettlementConstraints = scevia.table('reviewed_settlement_constraints', {
  leftMarketId: uuid('left_market_id').notNull().references(() => reviewedBinaryRules.marketId, { onDelete: 'cascade' }),
  rightMarketId: uuid('right_market_id').notNull().references(() => reviewedBinaryRules.marketId, { onDelete: 'cascade' }),
  kind: text('kind').$type<'equivalent' | 'exclusive' | 'implies'>().notNull(),
  evidence: text('evidence').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex('reviewed_settlement_constraint_unique').on(table.leftMarketId, table.rightMarketId, table.kind),
  check('reviewed_settlement_constraint_distinct_markets', sql`${table.leftMarketId} <> ${table.rightMarketId}`),
  check('reviewed_settlement_constraint_kind', sql`${table.kind} in ('equivalent','exclusive','implies')`),
  check('reviewed_settlement_constraint_evidence_required', sql`length(trim(${table.evidence})) > 0`),
])

export const portfolioScenarios = scevia.table('portfolio_scenarios', {
  id: uuid('id').defaultRandom().primaryKey(),
  portfolioId: uuid('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  revision: integer('revision').default(1).notNull(),
  baseline: jsonb('baseline').$type<import('../scenarios/engine.js').ScenarioBaseline>().notNull(),
  source: jsonb('source').$type<import('../http/scenarios.js').BaselineSource>().notNull(),
  input: jsonb('input').$type<import('../scenarios/engine.js').ScenarioInput>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('portfolio_scenarios_portfolio_idx').on(table.portfolioId)])

export const portfolioScenarioBundles = scevia.table('portfolio_scenario_bundles', {
  id: uuid('id').defaultRandom().primaryKey(),
  portfolioId: uuid('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  revision: integer('revision').default(1).notNull(),
  frozen: jsonb('frozen').$type<import('../http/scenarios.js').FrozenDenominationScenario>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('portfolio_scenario_bundles_portfolio_idx').on(table.portfolioId)])

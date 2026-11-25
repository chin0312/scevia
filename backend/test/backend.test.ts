import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { createDatabase, type Database } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import {
  cashMovements,
  events,
  fills,
  instruments,
  markets,
  portfolios,
  positionSnapshots,
  providerActivityFacts,
  providerAccounts,
  sourceRecordRevisions,
  sourceRecords,
  syncCheckpoints,
  syncRuns,
  users,
  dataCoverage,
  markets as marketTable,
  cashBalanceSnapshots,
} from '../src/db/schema.js'
import { loadConfig } from '../src/config.js'
import { matchesDevelopmentBearer } from '../src/http/auth.js'
import { buildApp } from '../src/http/app.js'
import { IngestionService } from '../src/ingestion/sync.js'
import { IngestionError, SyncAlreadyRunningError } from '../src/ingestion/errors.js'
import { ProviderAdapterError, type ProviderAdapter, type ProviderPage } from '../src/providers/adapter.js'
import { MultiOutcomeFixtureAdapter } from '../src/providers/fixtures/multi-outcome-adapter.js'
import { MULTI_OUTCOME_ACCOUNT_ID, SNAPSHOT_ACCOUNT_ID } from '../src/providers/fixtures/data.js'
import { ProviderRegistry, providerRegistry } from '../src/providers/registry.js'
import { PolymarketAdapter } from '../src/providers/polymarket/adapter.js'
import { PolymarketHttpClient } from '../src/providers/polymarket/http.js'
import { PolymarketMarketDataService } from '../src/providers/polymarket/market-data.js'
import { assertSafeTestDatabaseUrl } from '../scripts/safety.js'
import type { CoverageEntity, EntityCoverageReport, NormalizedRecord, ProviderCapabilities } from '../src/domain/model.js'
import type { ServerConfig } from '../src/config.js'

const OWNER_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_OWNER_ID = '00000000-0000-4000-8000-000000000002'
const PORTFOLIO_ID = '00000000-0000-4000-8000-000000000101'
const OTHER_PORTFOLIO_ID = '00000000-0000-4000-8000-000000000102'
const MULTI_ACCOUNT_ROW_ID = '00000000-0000-4000-8000-000000000201'
const SNAPSHOT_ACCOUNT_ROW_ID = '00000000-0000-4000-8000-000000000202'
const OTHER_ACCOUNT_ROW_ID = '00000000-0000-4000-8000-000000000203'
const TOKEN = 'a-local-test-token-with-more-than-thirty-two-bytes'
const RUNNING_SYNC_NAME = 'portfolio-history'
const ALL_ENTITIES: CoverageEntity[] = [
  'markets', 'fills', 'activity', 'cash_movements', 'settlements', 'positions', 'cash_balances', 'prices',
]
const COMPLETE_COVERAGE = Object.fromEntries(ALL_ENTITIES.map((entity) => [entity, {
  status: 'complete',
  coverageStart: '2026-11-24T00:00:00Z',
  coverageEnd: '2026-11-24T00:00:00Z',
  sourceAsOf: '2026-11-24T00:00:00Z',
  reasonCode: null,
}])) as Record<CoverageEntity, EntityCoverageReport>

let pool: Pool
let database: Database
let openApps: Array<{ close: () => Promise<void> }> = []

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for the backend test process')
  assertSafeTestDatabaseUrl(url)
  pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5_000 })
  await pool.query('DROP SCHEMA IF EXISTS scevia CASCADE')
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
  await pool.end()
  const created = createDatabase({ url, ssl: false }, 8)
  database = created.database
  pool = created.pool
  await runMigrations(database)
})

beforeEach(async () => {
  await pool.query(`TRUNCATE TABLE
    scevia.users,
    scevia.portfolios,
    scevia.provider_accounts,
    scevia.events,
    scevia.markets,
    scevia.instruments,
    scevia.event_relationships,
    scevia.source_records,
    scevia.source_record_revisions,
    scevia.fills,
    scevia.cash_movements,
    scevia.provider_activity_facts,
    scevia.settlements,
    scevia.position_snapshots,
    scevia.cash_balance_snapshots,
    scevia.price_observations,
    scevia.sync_runs,
    scevia.sync_checkpoints,
    scevia.data_coverage
    RESTART IDENTITY CASCADE`)
  await seedOwnershipData()
})

afterEach(async () => {
  await Promise.all(openApps.map((app) => app.close()))
  openApps = []
})

afterAll(async () => {
  await pool.end()
})

describe('migrations and canonical persistence', () => {
  it('applies a clean migration set and rejects inconsistent fee values', async () => {
    const ingestion = new IngestionService(database, providerRegistry)
    const result = await ingestion.syncProviderAccount({
      id: MULTI_ACCOUNT_ROW_ID,
      providerCode: 'fixture-multisided',
      externalAccountId: MULTI_OUTCOME_ACCOUNT_ID,
    })
    expect(result.status).toBe('complete')
    expect(result.streams.map((stream) => stream.streamName)).toEqual(['activity', 'account-state'])
    const streamRuns = await database.select({ syncName: syncRuns.syncName, checkpointAtEnd: syncRuns.checkpointAtEnd })
      .from(syncRuns).where(eq(syncRuns.providerAccountId, MULTI_ACCOUNT_ROW_ID))
    expect(streamRuns.find((run) => run.syncName === 'activity')?.checkpointAtEnd).toBe('activity-through-page-2')
    expect(streamRuns.find((run) => run.syncName === 'account-state')?.checkpointAtEnd).toBeNull()
    const fill = await database.select({ price: fills.price, feeAmount: fills.feeAmount, feeStatus: fills.feeStatus })
      .from(fills).where(eq(fills.externalId, 'fill-multi-001')).then((rows) => rows[0])
    expect(fill?.price).toBe('0.234567890123456789')
    expect(fill?.feeAmount).toBeNull()
    expect(fill?.feeStatus).toBe('unavailable')
    await expect(pool.query("UPDATE scevia.fills SET fee_amount = NULL WHERE external_id = 'fill-multi-002'")).rejects.toThrow()
  })

  it('ingests Polymarket records into PostgreSQL and exposes only authorized normalized facts', async () => {
    const wallet = '0x1234567890abcdef1234567890abcdef12345678'
    let omitPositions = false
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/v2/positions')) {
        if (omitPositions) {
          return new Response(JSON.stringify({ data: [], pagination: { next_cursor: null } }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({
          data: url.searchParams.get('status') === 'OPEN' ? [{
            proxy_wallet: wallet,
            condition_id: 'condition-a',
            token_id: '101',
            opposite_token_id: '102',
            event_id: 'event-a',
            event_slug: 'event-a',
            title: 'Will the test condition happen?',
            outcome: 'Yes',
            opposite_outcome: 'No',
            current_size: '4.500000000000000001',
            avg_price: '0.25',
            current_price: '0.4',
            current_value: '1.8',
            entry_cost_usdc: '1.125',
            entry_fees_usdc: '0',
            total_cost_usdc: '1.125',
            total_size: '4.5',
            realized_pnl: '0',
            unrealized_pnl: '0.675',
            total_pnl: '0.675',
            percent_pnl: '60',
            status: 'OPEN',
            redeemable: false,
            mergeable: false,
            archived: false,
          }, {
            proxy_wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            condition_id: 'condition-other',
            token_id: '999',
            current_size: '9',
          }] : [],
          pagination: { next_cursor: null },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname.endsWith('/v2/trades')) {
        return new Response(JSON.stringify({
          data: [{
            proxy_wallet: wallet,
            transaction_hash: '0xabc123',
            condition_id: 'condition-a',
            token_id: '101',
            side: 'BUY',
            size: '4.500000000000000001',
            price: '0.25',
            timestamp: 1795564800,
            title: 'Will the test condition happen?',
            event_id: 'event-a',
          }, {
            proxy_wallet: wallet,
            transaction_hash: '0xmissing-meta',
            condition_id: 'condition-a',
            token_id: '999',
            side: 'SELL',
            size: '2.5',
            price: '0.3',
            timestamp: 1795564700,
          }],
          pagination: { next_cursor: null },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname.endsWith('/v2/tokens')) {
        const requested = new Set((url.searchParams.get('token_id') ?? '').split(','))
        const tokens = [
          { token_id: '101', opposite_token_id: '102', condition_id: 'condition-a', title: 'Will the test condition happen?', outcome: 'Yes', outcome_index: 0, event_id: 'event-a', event_slug: 'event-a', module: 'v1' },
          { token_id: '102', opposite_token_id: '101', condition_id: 'condition-a', title: 'Will the test condition happen?', outcome: 'No', outcome_index: 1, event_id: 'event-a', event_slug: 'event-a', module: 'v1' },
        ]
        return new Response(JSON.stringify({ data: tokens.filter((token) => requested.has(token.token_id)) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname.endsWith('/v2/activity')) {
        return new Response(JSON.stringify({
          data: [
            { type: 'DEPOSIT', transaction_hash: '0xdeposit', proxy_wallet: wallet, timestamp: 1795564800, usdc_size: '10.25' },
            { type: 'REDEEM', transaction_hash: '0xredeem', proxy_wallet: wallet, timestamp: 1795564900, condition_id: 'condition-a', token_id: '101', size: '1', usdc_size: '1' },
          ],
          pagination: { next_cursor: null },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected Polymarket API request: ${url.pathname}`)
    }
    const app = await buildApp({
      config: testConfig(),
      database,
      registry: new ProviderRegistry([new PolymarketAdapter(new PolymarketHttpClient(fetcher))]),
    })
    openApps.push(app)
    const auth = { authorization: `Bearer ${TOKEN}` }
    const source = await app.inject({
      method: 'POST',
      url: `/v1/portfolios/${PORTFOLIO_ID}/sources/polymarket`,
      headers: auth,
      payload: { walletAddress: wallet },
    })
    expect(source.statusCode).toBe(201)
    const accountId = source.json().id as string
    const first = await app.inject({ method: 'POST', url: `/v1/provider-accounts/${accountId}/sync`, headers: auth })
    const second = await app.inject({ method: 'POST', url: `/v1/provider-accounts/${accountId}/sync`, headers: auth })

    expect(first.statusCode).toBe(200)
    expect(first.json().status).toBe('complete')
    expect(second.statusCode).toBe(200)
    expect(second.json().status).toBe('complete')
    const firstStreams = first.json().streams as Array<Record<string, unknown>>
    const secondStreams = second.json().streams as Array<Record<string, unknown>>
    expect(firstStreams.find((stream) => stream.streamName === 'positions')).toMatchObject({
      rowsReceived: 2, sourceRowsRetained: 1, excludedRecords: 1,
    })
    expect(firstStreams.find((stream) => stream.streamName === 'trades')).toMatchObject({
      rowsReceived: 2, sourceRowsRetained: 2, unresolvedRecords: 1,
    })
    expect((secondStreams.find((stream) => stream.streamName === 'trades')?.exactDuplicates as number)).toBeGreaterThan(0)
    expect(await database.select({ id: fills.id }).from(fills)).toHaveLength(1)
    expect(await database.select({ id: cashMovements.id }).from(cashMovements)).toHaveLength(1)
    expect(await database.select({ id: providerActivityFacts.id }).from(providerActivityFacts)).toHaveLength(2)
    const [fill] = await database.select({ quantity: fills.quantity, feeAmount: fills.feeAmount, feeStatus: fills.feeStatus }).from(fills)
    expect(fill).toEqual({ quantity: '4.500000000000000001', feeAmount: null, feeStatus: 'unavailable' })

    const positionsResponse = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/positions`,
      headers: auth,
    })
    const factsResponse = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/activity-facts`,
      headers: auth,
    })
    const hiddenFacts = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${OTHER_PORTFOLIO_ID}/activity-facts`,
      headers: auth,
    })
    expect(positionsResponse.statusCode).toBe(200)
    const sourceScopedPositions = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/positions?providerAccountId=${encodeURIComponent(accountId)}`,
      headers: auth,
    })
    expect(sourceScopedPositions.statusCode).toBe(200)
    expect(sourceScopedPositions.json().items.every((item: { providerAccountId: string }) => item.providerAccountId === accountId)).toBe(true)
    expect(positionsResponse.json().items[0]).toMatchObject({
      providerStatus: 'OPEN',
      providerReported: { currentValue: '1.800000000000000000' },
    })
    expect(factsResponse.statusCode).toBe(200)
    expect(factsResponse.json().items[0]).toMatchObject({ activityType: 'REDEEM', classification: 'unreconciled' })
    expect(factsResponse.json().items[1]).toMatchObject({
      activityType: 'TRADE_UNRESOLVED',
      sourceEndpoint: 'trades',
      classification: 'unresolved',
      resolutionReason: 'token_metadata_missing',
      quantity: '2.500000000000000000',
      price: '0.300000000000000000',
    })
    expect(factsResponse.body).not.toContain('rawPayload')
    expect(hiddenFacts.statusCode).toBe(404)

    omitPositions = true
    const emptyRefresh = await app.inject({ method: 'POST', url: `/v1/provider-accounts/${accountId}/sync`, headers: auth })
    expect(emptyRefresh.statusCode).toBe(200)
    expect(emptyRefresh.json().status).toBe('complete')
    const stalePositionRead = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/positions?providerAccountId=${encodeURIComponent(accountId)}`,
      headers: auth,
    })
    expect(stalePositionRead.statusCode).toBe(200)
    expect(stalePositionRead.json().items[0]).toMatchObject({
      quantity: '4.500000000000000001',
      observationStatus: 'not_seen_in_latest_successful_refresh',
      positionState: 'not_seen_in_latest_successful_refresh',
    })
  })

  it('keeps provider events distinct and stores varying outcome and settlement values', async () => {
    const ingestion = new IngestionService(database, providerRegistry)
    await ingestion.syncProviderAccount({ id: MULTI_ACCOUNT_ROW_ID, providerCode: 'fixture-multisided', externalAccountId: MULTI_OUTCOME_ACCOUNT_ID })
    await ingestion.syncProviderAccount({ id: SNAPSHOT_ACCOUNT_ROW_ID, providerCode: 'fixture-account-snapshot', externalAccountId: SNAPSHOT_ACCOUNT_ID })
    const [marketCount] = await database.select({ count: sql<number>`count(*)::int` }).from(markets)
    const settlements = await pool.query('SELECT payout_amount::text FROM scevia.settlements WHERE external_id = $1', ['settlement-multi-001'])
    const marks = await database.select({ markPrice: positionSnapshots.markPrice }).from(positionSnapshots)
    expect(marketCount?.count).toBe(2)
    expect(settlements.rows[0]?.payout_amount).toBe('2.750000000000000000')
    expect(marks.some((position) => position.markPrice === null)).toBe(true)
  })

  it('upserts repeated records without duplicating fills or cash movements', async () => {
    const ingestion = new IngestionService(database, providerRegistry)
    const account = { id: MULTI_ACCOUNT_ROW_ID, providerCode: 'fixture-multisided', externalAccountId: MULTI_OUTCOME_ACCOUNT_ID }
    await ingestion.syncProviderAccount(account)
    await ingestion.syncProviderAccount(account)
    const fillRows = await database.select({ id: fills.id }).from(fills)
    const movementRows = await database.select({ id: cashMovements.id }).from(cashMovements)
    const rawRows = await database.select({ id: sourceRecords.id }).from(sourceRecords)
    expect(fillRows).toHaveLength(2)
    expect(movementRows).toHaveLength(2)
    expect(rawRows).toHaveLength(9)
  })

  it('retains the prior sanitized source version when a provider corrects a fill', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    const correctedAdapter: ProviderAdapter = {
      capabilities: original.capabilities,
      fetchPage: (request) => original.fetchPage(request.streamName === 'activity' ? { ...request, checkpoint: null } : request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName).map((record) => {
        if (record.kind !== 'fill' || record.externalId !== 'fill-multi-001') return record
        return { ...record, price: '0.24', rawPayload: { ...record.rawPayload, price: '0.24' } }
      }),
    }
    const baseAccount = { id: MULTI_ACCOUNT_ROW_ID, providerCode: 'fixture-multisided', externalAccountId: MULTI_OUTCOME_ACCOUNT_ID }
    await new IngestionService(database, providerRegistry).syncProviderAccount(baseAccount)
    const result = await new IngestionService(database, new ProviderRegistry([correctedAdapter])).syncProviderAccount(baseAccount)
    const [updatedFill] = await database.select({ price: fills.price }).from(fills).where(eq(fills.externalId, 'fill-multi-001'))
    const revisions = await database.select({ id: sourceRecordRevisions.id }).from(sourceRecordRevisions)
    expect(result.status).toBe('complete')
    expect(updatedFill?.price).toBe('0.240000000000000000')
    expect(revisions).toHaveLength(1)
  })

  it('resumes from the last committed page after a later page fails', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    let failSecondPage = true
    const recoverableAdapter: ProviderAdapter = {
      capabilities: original.capabilities,
      async fetchPage(request) {
        if (request.cursor === 'page-2' && failSecondPage) {
          throw new ProviderAdapterError('fixture_page_unavailable', false)
        }
        return original.fetchPage(request)
      },
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    const service = new IngestionService(database, new ProviderRegistry([recoverableAdapter]))
    const account = { id: MULTI_ACCOUNT_ROW_ID, providerCode: 'fixture-multisided', externalAccountId: MULTI_OUTCOME_ACCOUNT_ID }
    const failed = await service.syncProviderAccount(account)
    const [checkpointAfterFailure] = await database.select({ cursor: syncCheckpoints.cursor, durableCheckpoint: syncCheckpoints.durableCheckpoint, status: syncCheckpoints.status })
      .from(syncCheckpoints).where(and(eq(syncCheckpoints.providerAccountId, MULTI_ACCOUNT_ROW_ID), eq(syncCheckpoints.syncName, 'stream:activity')))
    const [coverageAfterFailure] = await database.select({ status: dataCoverage.status, lastAttemptStatus: dataCoverage.lastAttemptStatus })
      .from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, MULTI_ACCOUNT_ROW_ID), eq(dataCoverage.entityType, 'fills')))
    expect(failed.status).toBe('partial')
    expect(failed.streams.find((stream) => stream.streamName === 'activity')?.errorCode).toBe('fixture_page_unavailable')
    expect(failed.streams.find((stream) => stream.streamName === 'activity')?.pagesRead).toBe(1)
    expect(checkpointAfterFailure?.cursor).toBe('page-2')
    expect(checkpointAfterFailure?.status).toBe('partial')
    expect(checkpointAfterFailure?.durableCheckpoint).toBeNull()
    expect(coverageAfterFailure?.status).toBe('partial')
    expect(coverageAfterFailure?.lastAttemptStatus).toBe('partial')

    failSecondPage = false
    const resumed = await service.syncProviderAccount(account)
    const [checkpointAfterResume] = await database.select({ cursor: syncCheckpoints.cursor, durableCheckpoint: syncCheckpoints.durableCheckpoint, status: syncCheckpoints.status })
      .from(syncCheckpoints).where(and(eq(syncCheckpoints.providerAccountId, MULTI_ACCOUNT_ROW_ID), eq(syncCheckpoints.syncName, 'stream:activity')))
    const [coverageAfterResume] = await database.select({ status: dataCoverage.status, lastAttemptStatus: dataCoverage.lastAttemptStatus })
      .from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, MULTI_ACCOUNT_ROW_ID), eq(dataCoverage.entityType, 'fills')))
    const fillRows = await database.select({ id: fills.id }).from(fills)
    expect(resumed.status).toBe('complete')
    expect(resumed.streams.find((stream) => stream.streamName === 'activity')?.pagesRead).toBe(1)
    expect(checkpointAfterResume?.cursor).toBeNull()
    expect(checkpointAfterResume?.durableCheckpoint).toBe('activity-through-page-2')
    expect(checkpointAfterResume?.status).toBe('complete')
    expect(coverageAfterResume?.status).toBe('complete')
    expect(coverageAfterResume?.lastAttemptStatus).toBe('complete')
    expect(fillRows).toHaveLength(2)
  })

  it('retries retryable provider failures within a fixed bound', async () => {
    let attempts = 0
    const adapter = emptyFixtureAdapter('fixture-retry', async () => {
      attempts += 1
      if (attempts === 1) throw new ProviderAdapterError('temporary_unavailable', true)
      return emptyPage()
    })
    await addProviderAccount('fixture-retry', 'retry-account', '00000000-0000-4000-8000-000000000301')
    const result = await new IngestionService(database, new ProviderRegistry([adapter])).syncProviderAccount({
      id: '00000000-0000-4000-8000-000000000301',
      providerCode: 'fixture-retry',
      externalAccountId: 'retry-account',
    })
    expect(result.status).toBe('complete')
    expect(attempts).toBe(2)
    const [coverage] = await database.select({
      status: dataCoverage.status,
      observedRecordStart: dataCoverage.observedRecordStart,
      coverageStart: dataCoverage.coverageStart,
      lastAttemptStatus: dataCoverage.lastAttemptStatus,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, '00000000-0000-4000-8000-000000000301'), eq(dataCoverage.entityType, 'fills')))
    expect(coverage?.status).toBe('complete')
    expect(coverage?.observedRecordStart).toBeNull()
    expect(coverage?.coverageStart?.toISOString()).toBe('2026-11-24T00:00:00.000Z')
    expect(coverage?.lastAttemptStatus).toBe('complete')
    expect(coverage?.lastSuccessfulSyncAt).not.toBeNull()
  })

  it('keeps a committed pagination cursor and refuses a cursor cycle before committing the repeated page', async () => {
    const accountId = '00000000-0000-4000-8000-000000000301'
    const adapter = emptyFixtureAdapter('fixture-cursor-cycle', async () => ({ ...emptyPage(), nextCursor: 'cursor-a' }))
    await addProviderAccount('fixture-cursor-cycle', 'cycle-account', accountId)
    const result = await new IngestionService(database, new ProviderRegistry([adapter])).syncProviderAccount(accountId)
    const [checkpoint] = await database.select({ cursor: syncCheckpoints.cursor, status: syncCheckpoints.status })
      .from(syncCheckpoints).where(and(eq(syncCheckpoints.providerAccountId, accountId), eq(syncCheckpoints.syncName, 'stream:records')))
    const [run] = await database.select({ pagesRead: syncRuns.pagesRead, status: syncRuns.status })
      .from(syncRuns).where(and(eq(syncRuns.providerAccountId, accountId), eq(syncRuns.syncName, 'records')))
    expect(result.status).toBe('partial')
    expect(result.streams[0]?.errorCode).toBe('provider_cursor_did_not_advance')
    expect(checkpoint?.cursor).toBe('cursor-a')
    expect(checkpoint?.status).toBe('partial')
    expect(run?.pagesRead).toBe(1)
    expect(run?.status).toBe('partial')
  })

  it('does not commit a page after the account lease token changes', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    let replaced = false
    const staleWorkerAdapter: ProviderAdapter = {
      capabilities: original.capabilities,
      async fetchPage(request) {
        if (!replaced) {
          replaced = true
          await database.update(syncCheckpoints).set({ leaseToken: '00000000-0000-4000-8000-000000000999' }).where(and(
            eq(syncCheckpoints.providerAccountId, MULTI_ACCOUNT_ROW_ID),
            eq(syncCheckpoints.syncName, RUNNING_SYNC_NAME),
          ))
        }
        return original.fetchPage(request)
      },
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    await expect(new IngestionService(database, new ProviderRegistry([staleWorkerAdapter])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID))
      .rejects.toMatchObject({ code: 'sync_lease_lost' })
    expect(await database.select({ id: marketTable.id }).from(marketTable)).toHaveLength(0)
    expect(await database.select({ id: sourceRecords.id }).from(sourceRecords)).toHaveLength(0)
  })

  it('rejects a concurrent sync for the same account while the durable lease is active', async () => {
    let signalEntered: () => void = () => undefined
    let releaseFetch: () => void = () => undefined
    const entered = new Promise<void>((resolve) => { signalEntered = resolve })
    const waitForRelease = new Promise<void>((resolve) => { releaseFetch = resolve })
    const adapter = emptyFixtureAdapter('fixture-lock', async () => {
      signalEntered()
      await waitForRelease
      return emptyPage()
    })
    const accountId = '00000000-0000-4000-8000-000000000301'
    await addProviderAccount('fixture-lock', 'lock-account', accountId)
    const service = new IngestionService(database, new ProviderRegistry([adapter]))
    const firstRun = service.syncProviderAccount({ id: accountId, providerCode: 'fixture-lock', externalAccountId: 'lock-account' })
    await entered
    await expect(service.syncProviderAccount({ id: accountId, providerCode: 'fixture-lock', externalAccountId: 'lock-account' }))
      .rejects.toBeInstanceOf(SyncAlreadyRunningError)
    releaseFetch()
    const result = await firstRun
    expect(result.status).toBe('complete')
  })

  it('recovers an expired lease and marks the abandoned run interrupted', async () => {
    const accountId = '00000000-0000-4000-8000-000000000301'
    const abandonedRunId = '00000000-0000-4000-8000-000000000401'
    const checkpointId = '00000000-0000-4000-8000-000000000501'
    const leaseToken = '00000000-0000-4000-8000-000000000601'
    await addProviderAccount('fixture-recovery', 'recovery-account', accountId)
    await database.insert(syncCheckpoints).values({
      id: checkpointId,
      providerAccountId: accountId,
      syncName: RUNNING_SYNC_NAME,
      cursor: 'resume-here',
      status: 'running',
      leaseToken,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      lastRunId: abandonedRunId,
    })
    await database.insert(syncCheckpoints).values({
      id: '00000000-0000-4000-8000-000000000502',
      providerAccountId: accountId,
      syncName: 'stream:records',
      cursor: 'resume-here',
      status: 'partial',
    })
    await database.insert(syncRuns).values({
      id: abandonedRunId,
      providerAccountId: accountId,
      syncName: 'records',
      status: 'running',
      cursorAtStart: null,
      cursorAtEnd: 'resume-here',
    })
    const adapter = emptyFixtureAdapter('fixture-recovery', async (cursor) => {
      expect(cursor).toBe('resume-here')
      return emptyPage()
    })
    const result = await new IngestionService(database, new ProviderRegistry([adapter])).syncProviderAccount({
      id: accountId,
      providerCode: 'fixture-recovery',
      externalAccountId: 'recovery-account',
    })
    const [abandonedRun] = await database.select({ status: syncRuns.status, errorCode: syncRuns.errorCode })
      .from(syncRuns).where(eq(syncRuns.id, abandonedRunId))
    expect(result.status).toBe('complete')
    expect(abandonedRun?.status).toBe('failed')
    expect(abandonedRun?.errorCode).toBe('interrupted')
  })

  it('keeps independent observed and provider-confirmed ranges without using resolution dates', async () => {
    const result = await new IngestionService(database, providerRegistry).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    expect(result.status).toBe('complete')
    const rows = await database.select({
      entityType: dataCoverage.entityType,
      observedRecordStart: dataCoverage.observedRecordStart,
      observedRecordEnd: dataCoverage.observedRecordEnd,
      coverageStart: dataCoverage.coverageStart,
      coverageEnd: dataCoverage.coverageEnd,
      status: dataCoverage.status,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
    }).from(dataCoverage).where(eq(dataCoverage.providerAccountId, MULTI_ACCOUNT_ROW_ID))
    const marketCoverage = rows.find((row) => row.entityType === 'markets')
    const fillCoverage = rows.find((row) => row.entityType === 'fills')
    const positionCoverage = rows.find((row) => row.entityType === 'positions')
    expect(marketCoverage?.observedRecordEnd?.toISOString()).toBe('2026-11-24T09:00:00.000Z')
    expect(marketCoverage?.observedRecordEnd?.toISOString()).not.toBe('2026-12-01T00:00:00.000Z')
    expect(fillCoverage?.observedRecordEnd?.toISOString()).toBe('2026-11-21T13:15:00.000Z')
    expect(positionCoverage?.observedRecordEnd?.toISOString()).toBe('2026-11-24T10:00:00.000Z')
    expect(fillCoverage?.coverageStart?.toISOString()).toBe('2026-11-20T12:30:00.000Z')
    expect(positionCoverage?.coverageStart?.toISOString()).toBe('2026-11-24T10:00:00.000Z')
    expect(rows.filter((row) => row.entityType !== 'activity').every((row) => row.status === 'complete' && row.lastSuccessfulSyncAt !== null)).toBe(true)
    expect(rows.find((row) => row.entityType === 'activity')?.status).toBe('unavailable')
  })

  it('preserves established coverage after a failed incremental attempt and records the failure separately', async () => {
    const accountId = MULTI_ACCOUNT_ROW_ID
    await new IngestionService(database, providerRegistry).syncProviderAccount(accountId)
    const [before] = await database.select({
      status: dataCoverage.status,
      coverageStart: dataCoverage.coverageStart,
      coverageEnd: dataCoverage.coverageEnd,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'fills')))
    const original = new MultiOutcomeFixtureAdapter()
    const failing: ProviderAdapter = {
      capabilities: original.capabilities,
      async fetchPage(request) {
        if (request.streamName === 'activity') throw new ProviderAdapterError('temporary_activity_failure', false)
        return original.fetchPage(request)
      },
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    const result = await new IngestionService(database, new ProviderRegistry([failing])).syncProviderAccount(accountId)
    const [after] = await database.select({
      status: dataCoverage.status,
      coverageStart: dataCoverage.coverageStart,
      coverageEnd: dataCoverage.coverageEnd,
      lastAttemptStatus: dataCoverage.lastAttemptStatus,
      lastAttemptReasonCode: dataCoverage.lastAttemptReasonCode,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'fills')))
    expect(result.status).toBe('partial')
    expect(result.streams.find((stream) => stream.streamName === 'activity')?.status).toBe('failed')
    expect(after?.status).toBe(before?.status)
    expect(after?.coverageStart?.toISOString()).toBe(before?.coverageStart?.toISOString())
    expect(after?.coverageEnd?.toISOString()).toBe(before?.coverageEnd?.toISOString())
    expect(after?.lastSuccessfulSyncAt?.toISOString()).toBe(before?.lastSuccessfulSyncAt?.toISOString())
    expect(after?.lastAttemptStatus).toBe('failed')
    expect(after?.lastAttemptReasonCode).toBe('temporary_activity_failure')

    const unavailableAdapter: ProviderAdapter = {
      capabilities: original.capabilities,
      async fetchPage(request) {
        const page = await original.fetchPage(request.streamName === 'activity' ? { ...request, checkpoint: null } : request)
        if (request.streamName !== 'activity') return page
        return {
          ...page,
          coverage: {
            ...page.coverage,
            fills: { status: 'unavailable', reasonCode: 'provider_temporarily_unavailable' },
          },
        }
      },
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    await new IngestionService(database, new ProviderRegistry([unavailableAdapter])).syncProviderAccount(accountId)
    const [afterUnavailable] = await database.select({
      status: dataCoverage.status,
      lastAttemptStatus: dataCoverage.lastAttemptStatus,
      lastAttemptCoverageStatus: dataCoverage.lastAttemptCoverageStatus,
      coverageStart: dataCoverage.coverageStart,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'fills')))
    expect(afterUnavailable?.status).toBe('complete')
    expect(afterUnavailable?.lastAttemptStatus).toBe('complete')
    expect(afterUnavailable?.lastAttemptCoverageStatus).toBe('unavailable')
    expect(afterUnavailable?.coverageStart?.toISOString()).toBe(before?.coverageStart?.toISOString())
    expect(afterUnavailable?.lastSuccessfulSyncAt?.toISOString()).toBe(before?.lastSuccessfulSyncAt?.toISOString())

    const unknownAdapter: ProviderAdapter = {
      capabilities: original.capabilities,
      async fetchPage(request) {
        const page = await original.fetchPage(request.streamName === 'activity' ? { ...request, checkpoint: null } : request)
        if (request.streamName !== 'activity') return page
        return { ...page, coverage: { ...page.coverage, fills: { status: 'unknown', reasonCode: 'provider_freshness_unknown' } } }
      },
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    await new IngestionService(database, new ProviderRegistry([unknownAdapter])).syncProviderAccount(accountId)
    const [afterUnknown] = await database.select({
      lastAttemptCoverageStatus: dataCoverage.lastAttemptCoverageStatus,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'fills')))
    expect(afterUnknown?.lastAttemptCoverageStatus).toBe('unknown')
    expect(afterUnknown?.lastSuccessfulSyncAt?.toISOString()).toBe(before?.lastSuccessfulSyncAt?.toISOString())

    const incrementalAdapter: ProviderAdapter = {
      capabilities: original.capabilities,
      async fetchPage(request) {
        const page = await original.fetchPage(request.streamName === 'activity' ? { ...request, checkpoint: null } : request)
        if (request.streamName !== 'activity') return page
        return {
          ...page,
          coverage: {
            ...page.coverage,
            fills: {
              status: 'complete',
              coverageStart: '2026-12-01T00:00:00Z',
              coverageEnd: '2026-12-03T00:00:00Z',
              sourceAsOf: '2026-12-03T00:00:00Z',
            },
          },
        }
      },
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    await new IngestionService(database, new ProviderRegistry([incrementalAdapter])).syncProviderAccount(accountId)
    const [extended] = await database.select({ coverageStart: dataCoverage.coverageStart, coverageEnd: dataCoverage.coverageEnd })
      .from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'fills')))
    expect(extended?.coverageStart?.toISOString()).toBe('2026-11-20T12:30:00.000Z')
    expect(extended?.coverageEnd?.toISOString()).toBe('2026-12-03T00:00:00.000Z')
  })

  it('restarts nonempty complete snapshots after interruption and publishes all pages without duplicates', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    let failSecondPage = false
    let firstPageRequests = 0
    const stateCoverage = {
      positions: { status: 'complete' as const, sourceAsOf: '2026-11-25T10:00:00Z' },
      cash_balances: { status: 'complete' as const, sourceAsOf: '2026-11-25T10:00:00Z' },
      prices: { status: 'complete' as const, sourceAsOf: '2026-11-25T10:00:00Z' },
    }
    const position = (id: string, outcome: string, quantity: string) => ({
      id,
      contract: 'market-city-council-winner',
      outcome,
      observed: '2026-11-25T10:00:00Z',
      quantity,
      averageCost: '0.2',
      mark: '0.3',
      markTimestamp: '2026-11-25T09:59:00Z',
      asset: 'USD',
      origin: 'provider_reported',
    })
    const cash = (id: string, amount: string, asset: string) => ({
      id,
      observed: '2026-11-25T10:00:00Z',
      amount,
      asset,
    })
    const payload = (positions: ReturnType<typeof position>[], balances: ReturnType<typeof cash>[]) => ({
      markets: [], trades: [], transfers: [], positions, cash: balances, prices: [], settlements: [],
    })
    const adapter: ProviderAdapter = {
      capabilities: original.capabilities,
      async fetchPage(request) {
        if (request.streamName !== 'account-state') return original.fetchPage(request)
        if (request.cursor === 'snapshot-page-2' && failSecondPage) {
          throw new ProviderAdapterError('snapshot_page_failed', false)
        }
        if (request.cursor === null) {
          firstPageRequests += 1
          return {
            payload: payload([
              position('snapshot-position-a', 'candidate-north', '4'),
              position('snapshot-position-b', 'candidate-south', '2'),
            ], [cash('snapshot-cash-usd', '100', 'USD')]),
            nextCursor: 'snapshot-page-2',
            checkpoint: null,
            coverage: stateCoverage,
          }
        }
        return {
          payload: payload([position('snapshot-position-c', 'other-candidate', '3')], [cash('snapshot-cash-usdc', '50', 'USDC')]),
          nextCursor: null,
          checkpoint: null,
          coverage: stateCoverage,
        }
      },
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    const service = new IngestionService(database, new ProviderRegistry([adapter]))
    const account = { id: MULTI_ACCOUNT_ROW_ID, providerCode: 'fixture-multisided', externalAccountId: MULTI_OUTCOME_ACCOUNT_ID }
    const currentPositions = async () => database.select({ id: positionSnapshots.id, externalId: positionSnapshots.externalId })
      .from(positionSnapshots).where(and(eq(positionSnapshots.providerAccountId, MULTI_ACCOUNT_ROW_ID), eq(positionSnapshots.isCurrent, true)))
    const currentCash = async () => database.select({ id: cashBalanceSnapshots.id, assetCode: cashBalanceSnapshots.assetCode })
      .from(cashBalanceSnapshots).where(and(eq(cashBalanceSnapshots.providerAccountId, MULTI_ACCOUNT_ROW_ID), eq(cashBalanceSnapshots.isCurrent, true)))

    const initial = await service.syncProviderAccount(account)
    expect(initial.status).toBe('complete')
    expect(await currentPositions()).toHaveLength(3)
    expect(await currentCash()).toHaveLength(2)
    expect(firstPageRequests).toBe(1)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      failSecondPage = true
      const partial = await service.syncProviderAccount(account)
      const [checkpointAfterFailure] = await database.select({ cursor: syncCheckpoints.cursor }).from(syncCheckpoints).where(and(
        eq(syncCheckpoints.providerAccountId, MULTI_ACCOUNT_ROW_ID),
        eq(syncCheckpoints.syncName, 'stream:account-state'),
      ))
      expect(partial.status).toBe('partial')
      expect(partial.streams.find((stream) => stream.streamName === 'account-state')?.pagesRead).toBe(1)
      expect(checkpointAfterFailure?.cursor).toBe('snapshot-page-2')
      expect(await currentPositions()).toHaveLength(3)
      expect(await currentCash()).toHaveLength(2)

      failSecondPage = false
      const beforeRecovery = firstPageRequests
      const recovered = await service.syncProviderAccount(account)
      const [recoveredRun] = await database.select({ cursorAtStart: syncRuns.cursorAtStart }).from(syncRuns).where(and(
        eq(syncRuns.providerAccountId, MULTI_ACCOUNT_ROW_ID),
        eq(syncRuns.syncName, 'account-state'),
      )).orderBy(sql`${syncRuns.startedAt} DESC`).limit(1)
      const positions = await currentPositions()
      const balances = await currentCash()
      expect(recovered.status).toBe('complete')
      expect(recoveredRun?.cursorAtStart).toBeNull()
      expect(firstPageRequests).toBe(beforeRecovery + 1)
      expect(positions.map((row) => row.externalId).sort()).toEqual([
        'snapshot-position-a', 'snapshot-position-b', 'snapshot-position-c',
      ])
      expect(balances.map((row) => row.assetCode).sort()).toEqual(['USD', 'USDC'])
    }

    expect(firstPageRequests).toBe(5)
    expect(await database.select({ id: positionSnapshots.id }).from(positionSnapshots).where(eq(positionSnapshots.providerAccountId, MULTI_ACCOUNT_ROW_ID)))
      .toHaveLength(13)
    expect(await database.select({ id: cashBalanceSnapshots.id }).from(cashBalanceSnapshots).where(eq(cashBalanceSnapshots.providerAccountId, MULTI_ACCOUNT_ROW_ID)))
      .toHaveLength(8)
  })

  it('requires complete snapshots to use full-refresh pagination', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    const capabilities: ProviderCapabilities = {
      ...original.capabilities,
      streams: original.capabilities.streams.map((stream) => stream.name === 'account-state'
        ? { ...stream, strategy: 'provider_checkpoint' }
        : stream),
    }
    const invalidAdapter: ProviderAdapter = {
      capabilities,
      fetchPage: (request) => original.fetchPage(request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    await expect(new IngestionService(database, new ProviderRegistry([invalidAdapter])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID))
      .rejects.toMatchObject<Partial<IngestionError>>({ code: 'complete_snapshot_requires_full_refresh' })
  })

  it('publishes only fully completed position and cash snapshots while retaining history', async () => {
    const accountId = MULTI_ACCOUNT_ROW_ID
    const original = new MultiOutcomeFixtureAdapter()
    await new IngestionService(database, new ProviderRegistry([original])).syncProviderAccount(accountId)
    const countBefore = await database.select({ id: positionSnapshots.id }).from(positionSnapshots)
    const cashBefore = await database.select({ id: cashBalanceSnapshots.id }).from(cashBalanceSnapshots)
    expect(await database.select({ id: positionSnapshots.id }).from(positionSnapshots).where(and(
      eq(positionSnapshots.providerAccountId, accountId), eq(positionSnapshots.isCurrent, true),
    ))).toHaveLength(1)
    expect(await database.select({ id: cashBalanceSnapshots.id }).from(cashBalanceSnapshots).where(and(
      eq(cashBalanceSnapshots.providerAccountId, accountId), eq(cashBalanceSnapshots.isCurrent, true),
    ))).toHaveLength(1)

    let failSecondPage = true
    const emptyPayload = { markets: [], trades: [], transfers: [], positions: [], cash: [], prices: [], settlements: [] }
    const emptyCoverage = {
      positions: { status: 'complete' as const, sourceAsOf: '2026-11-25T10:00:00Z' },
      cash_balances: { status: 'complete' as const, sourceAsOf: '2026-11-25T10:00:00Z' },
      prices: { status: 'complete' as const, sourceAsOf: '2026-11-25T10:00:00Z' },
    }
    const adapter: ProviderAdapter = {
      capabilities: original.capabilities,
      async fetchPage(request) {
        if (request.streamName !== 'account-state') return original.fetchPage(request)
        if (request.cursor === 'empty-page-2' && failSecondPage) throw new ProviderAdapterError('snapshot_page_failed', false)
        return {
          payload: emptyPayload,
          nextCursor: failSecondPage ? 'empty-page-2' : null,
          checkpoint: null,
          coverage: emptyCoverage,
        }
      },
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    const service = new IngestionService(database, new ProviderRegistry([adapter]))
    const partial = await service.syncProviderAccount(accountId)
    expect(partial.status).toBe('partial')
    expect(await database.select({ id: positionSnapshots.id }).from(positionSnapshots).where(and(
      eq(positionSnapshots.providerAccountId, accountId), eq(positionSnapshots.isCurrent, true),
    ))).toHaveLength(1)
    expect(await database.select({ id: cashBalanceSnapshots.id }).from(cashBalanceSnapshots).where(and(
      eq(cashBalanceSnapshots.providerAccountId, accountId), eq(cashBalanceSnapshots.isCurrent, true),
    ))).toHaveLength(1)

    failSecondPage = false
    const complete = await service.syncProviderAccount(accountId)
    expect(complete.status).toBe('complete')
    expect(await database.select({ id: positionSnapshots.id }).from(positionSnapshots).where(and(
      eq(positionSnapshots.providerAccountId, accountId), eq(positionSnapshots.isCurrent, true),
    ))).toHaveLength(0)
    expect(await database.select({ id: cashBalanceSnapshots.id }).from(cashBalanceSnapshots).where(and(
      eq(cashBalanceSnapshots.providerAccountId, accountId), eq(cashBalanceSnapshots.isCurrent, true),
    ))).toHaveLength(0)
    expect(await database.select({ id: positionSnapshots.id }).from(positionSnapshots)).toHaveLength(countBefore.length)
    expect(await database.select({ id: cashBalanceSnapshots.id }).from(cashBalanceSnapshots)).toHaveLength(cashBefore.length)
    const [latestRun] = await database.select({ positionSnapshotComplete: syncRuns.positionSnapshotComplete, cashBalanceSnapshotComplete: syncRuns.cashBalanceSnapshotComplete })
      .from(syncRuns).where(and(eq(syncRuns.providerAccountId, accountId), eq(syncRuns.syncName, 'account-state')))
      .orderBy(sql`${syncRuns.startedAt} DESC`).limit(1)
    expect(latestRun?.positionSnapshotComplete).toBe(true)
    expect(latestRun?.cashBalanceSnapshotComplete).toBe(true)

    const [coverageAfterEmpty] = await database.select({
      positionSnapshotAsOf: dataCoverage.snapshotAsOf,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'positions')))
    const [cashCoverageAfterEmpty] = await database.select({
      snapshotAsOf: dataCoverage.snapshotAsOf,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'cash_balances')))
    expect(coverageAfterEmpty?.positionSnapshotAsOf?.toISOString()).toBe('2026-11-25T10:00:00.000Z')
    expect(cashCoverageAfterEmpty?.snapshotAsOf?.toISOString()).toBe('2026-11-25T10:00:00.000Z')

    const olderSnapshotAdapter: ProviderAdapter = {
      capabilities: original.capabilities,
      fetchPage: (request) => original.fetchPage(request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName),
    }
    const staleSnapshot = await new IngestionService(database, new ProviderRegistry([olderSnapshotAdapter])).syncProviderAccount(accountId)
    const [coverageAfterStaleSnapshot] = await database.select({
      snapshotAsOf: dataCoverage.snapshotAsOf,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
      lastAttemptReasonCode: dataCoverage.lastAttemptReasonCode,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'positions')))
    const [cashCoverageAfterStaleSnapshot] = await database.select({
      snapshotAsOf: dataCoverage.snapshotAsOf,
      lastSuccessfulSyncAt: dataCoverage.lastSuccessfulSyncAt,
      lastAttemptReasonCode: dataCoverage.lastAttemptReasonCode,
    }).from(dataCoverage).where(and(eq(dataCoverage.providerAccountId, accountId), eq(dataCoverage.entityType, 'cash_balances')))
    const [staleSnapshotRun] = await database.select({ positionSnapshotComplete: syncRuns.positionSnapshotComplete })
      .from(syncRuns).where(and(eq(syncRuns.providerAccountId, accountId), eq(syncRuns.syncName, 'account-state')))
      .orderBy(sql`${syncRuns.startedAt} DESC`).limit(1)
    expect(staleSnapshot.status).toBe('complete')
    expect(await database.select({ id: positionSnapshots.id }).from(positionSnapshots).where(and(
      eq(positionSnapshots.providerAccountId, accountId), eq(positionSnapshots.isCurrent, true),
    ))).toHaveLength(0)
    expect(await database.select({ id: cashBalanceSnapshots.id }).from(cashBalanceSnapshots).where(and(
      eq(cashBalanceSnapshots.providerAccountId, accountId), eq(cashBalanceSnapshots.isCurrent, true),
    ))).toHaveLength(0)
    expect(coverageAfterStaleSnapshot?.snapshotAsOf?.toISOString()).toBe('2026-11-25T10:00:00.000Z')
    expect(coverageAfterStaleSnapshot?.lastSuccessfulSyncAt?.toISOString())
      .toBe(coverageAfterEmpty?.lastSuccessfulSyncAt?.toISOString())
    expect(coverageAfterStaleSnapshot?.lastAttemptReasonCode).toBe('stale_snapshot_rejected')
    expect(cashCoverageAfterStaleSnapshot?.snapshotAsOf?.toISOString()).toBe('2026-11-25T10:00:00.000Z')
    expect(cashCoverageAfterStaleSnapshot?.lastSuccessfulSyncAt?.toISOString())
      .toBe(cashCoverageAfterEmpty?.lastSuccessfulSyncAt?.toISOString())
    expect(cashCoverageAfterStaleSnapshot?.lastAttemptReasonCode).toBe('stale_snapshot_rejected')
    expect(staleSnapshotRun?.positionSnapshotComplete).toBe(false)
  })

  it('does not make an older incremental position observation current', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    const service = new IngestionService(database, new ProviderRegistry([original]))
    await service.syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const capabilities: ProviderCapabilities = {
      ...original.capabilities,
      streams: original.capabilities.streams.map((stream) => stream.name === 'account-state'
        ? { ...stream, snapshotSemantics: { positions: 'incremental', cash_balances: 'complete' } }
        : stream),
    }
    const olderAdapter: ProviderAdapter = {
      capabilities,
      fetchPage: (request) => original.fetchPage(request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName).map((record) => record.kind === 'position'
        ? { ...record, externalId: 'position-older-observation', observedAt: '2026-11-23T10:00:00Z' }
        : record),
    }
    const result = await new IngestionService(database, new ProviderRegistry([olderAdapter])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const history = await database.select({ id: positionSnapshots.id, observedAt: positionSnapshots.observedAt, isCurrent: positionSnapshots.isCurrent })
      .from(positionSnapshots).where(eq(positionSnapshots.providerAccountId, MULTI_ACCOUNT_ROW_ID))
    const current = history.filter((row) => row.isCurrent)
    expect(result.status).toBe('complete')
    expect(history).toHaveLength(2)
    expect(current).toHaveLength(1)
    expect(current[0]?.observedAt.toISOString()).toBe('2026-11-24T10:00:00.000Z')
  })

  it('retains a closed position tombstone and rejects delayed nonzero observations', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    const baseService = new IngestionService(database, new ProviderRegistry([original]))
    await baseService.syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const capabilities: ProviderCapabilities = {
      ...original.capabilities,
      streams: original.capabilities.streams.map((stream) => stream.name === 'account-state'
        ? { ...stream, snapshotSemantics: { positions: 'incremental', cash_balances: 'complete' } }
        : stream),
    }
    const closedAdapter: ProviderAdapter = {
      capabilities,
      fetchPage: (request) => original.fetchPage(request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName).map((record) => record.kind === 'position'
        ? {
          ...record,
          externalId: 'position-closed-zero',
          observedAt: '2026-11-25T10:00:00Z',
          quantity: '0',
          rawPayload: { ...record.rawPayload, id: 'position-closed-zero', observed: '2026-11-25T10:00:00Z', quantity: '0' },
        }
        : record),
    }
    await new IngestionService(database, new ProviderRegistry([closedAdapter])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const staleAdapter: ProviderAdapter = {
      capabilities,
      fetchPage: (request) => original.fetchPage(request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName).map((record) => record.kind === 'position'
        ? {
          ...record,
          externalId: 'position-delayed-nonzero',
          observedAt: '2026-11-24T11:00:00Z',
          quantity: '50',
          rawPayload: { ...record.rawPayload, id: 'position-delayed-nonzero', observed: '2026-11-24T11:00:00Z', quantity: '50' },
        }
        : record),
    }
    await new IngestionService(database, new ProviderRegistry([staleAdapter])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const history = await database.select({ externalId: positionSnapshots.externalId, quantity: positionSnapshots.quantity, isCurrent: positionSnapshots.isCurrent })
      .from(positionSnapshots).where(eq(positionSnapshots.providerAccountId, MULTI_ACCOUNT_ROW_ID))
    const current = history.filter((row) => row.isCurrent)
    expect(current).toHaveLength(1)
    expect(current[0]?.externalId).toBe('position-closed-zero')
    expect(current[0]?.quantity).toBe('0.000000000000000000')
    expect(history.find((row) => row.externalId === 'position-delayed-nonzero')?.isCurrent).toBe(false)

    const app = await createTestApp()
    const response = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/positions?limit=10&offset=0`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().items).toHaveLength(1)
    expect(response.json().items[0]).toMatchObject({
      quantity: '0.000000000000000000',
      positionState: 'not_seen_in_latest_successful_refresh',
      observationStatus: 'not_seen_in_latest_successful_refresh',
    })

    const reopenedAdapter: ProviderAdapter = {
      capabilities,
      fetchPage: (request) => original.fetchPage(request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName).map((record) => record.kind === 'position'
        ? {
          ...record,
          externalId: 'position-reopened',
          observedAt: '2026-11-26T10:00:00Z',
          quantity: '25',
          providerStatus: 'OPEN',
          rawPayload: { ...record.rawPayload, id: 'position-reopened', observed: '2026-11-26T10:00:00Z', quantity: '25' },
        }
        : record),
    }
    const reopened = await new IngestionService(database, new ProviderRegistry([reopenedAdapter])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    expect(reopened.status).toBe('complete')
    const reopenedRead = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/positions?limit=10&offset=0`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(reopenedRead.json().items[0]).toMatchObject({
      quantity: '25.000000000000000000',
      providerStatus: 'OPEN',
      positionState: 'provider_reported_positive',
      observationStatus: 'observed_in_latest_successful_refresh',
    })
  })

  it('keeps newer canonical market metadata when an older source revision arrives', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    const initial = new IngestionService(database, new ProviderRegistry([original]))
    await initial.syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const staleAdapter: ProviderAdapter = {
      capabilities: original.capabilities,
      fetchPage: (request) => original.fetchPage(request.streamName === 'activity' ? { ...request, checkpoint: null } : request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName).map((record) => record.kind === 'market'
        ? { ...record, marketTitle: 'Stale older title', sourceUpdatedAt: '2026-11-23T09:00:00Z', rawPayload: { ...record.rawPayload, marketTitle: 'Stale older title' } }
        : record),
    }
    await new IngestionService(database, new ProviderRegistry([staleAdapter])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const [market] = await database.select({ title: marketTable.title, sourceUpdatedAt: marketTable.sourceUpdatedAt })
      .from(marketTable).where(eq(marketTable.externalId, 'market-city-council-winner'))
    const staleRevisions = await database.select({ id: sourceRecordRevisions.id }).from(sourceRecordRevisions)
      .where(eq(sourceRecordRevisions.revisionType, 'stale_observation'))
    expect(market?.title).toBe('Who wins the city council seat?')
    expect(market?.sourceUpdatedAt?.toISOString()).toBe('2026-11-24T09:00:00.000Z')
    expect(staleRevisions).toHaveLength(1)
  })

  it('imports a new market under a newer event without applying stale event metadata', async () => {
    const original = new MultiOutcomeFixtureAdapter()
    await new IngestionService(database, new ProviderRegistry([original])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const [storedEvent] = await database.select({ id: events.id }).from(events)
      .where(eq(events.externalId, 'event-city-election-2026'))
    expect(storedEvent).toBeDefined()
    await database.update(events).set({
      name: 'Newest event metadata',
      sourceUpdatedAt: new Date('2026-11-26T00:00:00Z'),
    }).where(eq(events.id, storedEvent!.id))

    const newMarket: NormalizedRecord = {
      kind: 'market',
      externalEventId: 'event-city-election-2026',
      eventName: 'Older event metadata from another market',
      eventDescription: null,
      resolutionRules: 'The provider resolves this market from its published results.',
      eventLifecycle: 'open',
      eventResolvesAt: null,
      externalMarketId: 'market-added-late',
      marketTitle: 'Will the late entrant qualify?',
      marketLifecycle: 'open',
      settlementRules: 'One outcome pays one unit.',
      settlementAssetCode: 'USD',
      eventSourceUpdatedAt: '2026-11-25T00:00:00Z',
      sourceUpdatedAt: '2026-11-22T00:00:00Z',
      outcomes: [
        { externalId: 'candidate-added-yes', name: 'Yes', outcomeType: 'yes', payoutAmount: null, settlementAssetCode: 'USD' },
        { externalId: 'candidate-added-no', name: 'No', outcomeType: 'no', payoutAmount: null, settlementAssetCode: 'USD' },
      ],
      rawPayload: { marketId: 'market-added-late', eventUpdatedAt: '2026-11-25T00:00:00Z', sourceUpdatedAt: '2026-11-22T00:00:00Z' },
    }
    const newFill: NormalizedRecord = {
      kind: 'fill',
      externalId: 'fill-added-late-market',
      externalMarketId: 'market-added-late',
      externalInstrumentId: 'candidate-added-yes',
      direction: 'buy',
      occurredAt: '2026-11-24T12:00:00Z',
      quantity: '1',
      price: '0.2',
      feeAmount: '0',
      feeStatus: 'reported',
      settlementAssetCode: 'USD',
      finality: 'confirmed',
      rawPayload: { id: 'fill-added-late-market' },
    }
    const adapter: ProviderAdapter = {
      capabilities: original.capabilities,
      fetchPage: (request) => original.fetchPage(request.streamName === 'activity' ? { ...request, checkpoint: null } : request),
      normalizePage: (page, streamName) => {
        const records = original.normalizePage(page, streamName)
        return streamName === 'activity' && page.nextCursor === 'page-2'
          ? [...records, newMarket, newFill]
          : records
      },
    }
    const result = await new IngestionService(database, new ProviderRegistry([adapter])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const [updatedEvent] = await database.select({ name: events.name, sourceUpdatedAt: events.sourceUpdatedAt }).from(events)
      .where(eq(events.id, storedEvent!.id))
    const [addedMarket] = await database.select({ title: marketTable.title, eventId: marketTable.eventId })
      .from(marketTable).where(eq(marketTable.externalId, 'market-added-late'))
    const [addedInstrument] = await database.select({ id: instruments.id }).from(instruments)
      .where(eq(instruments.externalId, 'candidate-added-yes'))
    const importedFill = await database.select({ id: fills.id }).from(fills).where(eq(fills.externalId, 'fill-added-late-market'))
    expect(result.status).toBe('complete')
    expect(updatedEvent?.name).toBe('Newest event metadata')
    expect(updatedEvent?.sourceUpdatedAt?.toISOString()).toBe('2026-11-26T00:00:00.000Z')
    expect(addedMarket?.title).toBe('Will the late entrant qualify?')
    expect(addedMarket?.eventId).toBe(storedEvent!.id)
    expect(addedInstrument).toBeDefined()
    expect(importedFill).toHaveLength(1)
  })

  it('uses stored provider-account identity instead of caller-supplied provider values', async () => {
    const result = await new IngestionService(database, providerRegistry).syncProviderAccount({
      id: MULTI_ACCOUNT_ROW_ID,
      providerCode: 'fixture-account-snapshot',
      externalAccountId: 'attacker-controlled-account',
    })
    expect(result.status).toBe('complete')
    expect(await database.select({ id: fills.id }).from(fills)).toHaveLength(2)
  })

  it('rejects disabled provider accounts before contacting an adapter', async () => {
    await database.update(providerAccounts).set({ disabledAt: new Date() }).where(eq(providerAccounts.id, MULTI_ACCOUNT_ROW_ID))
    await expect(new IngestionService(database, providerRegistry).syncProviderAccount(MULTI_ACCOUNT_ROW_ID))
      .rejects.toMatchObject<Partial<IngestionError>>({ code: 'provider_account_disabled' })
  })
})

describe('provider contracts and API security', () => {
  it('rejects malformed fixture payloads and declares unsupported capabilities', () => {
    const adapter = new MultiOutcomeFixtureAdapter()
    expect(() => adapter.normalizePage({ payload: { broken: true }, nextCursor: null, checkpoint: null, coverage: {} }, 'activity'))
      .toThrowError(ProviderAdapterError)
    const snapshot = providerRegistry.listCapabilities().find((provider) => provider.providerCode === 'fixture-account-snapshot')
    expect(snapshot?.operations.prices).toBe('unsupported')
    expect(snapshot?.operations.settlements).toBe('unsupported')
  })

  it('keeps the development bearer token separate from caller-supplied identity', async () => {
    const app = await createTestApp()
    const denied = await app.inject({ method: 'GET', url: '/v1/portfolios' })
    const accepted = await app.inject({
      method: 'GET',
      url: '/v1/portfolios',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-user-id': OTHER_OWNER_ID },
    })
    expect(denied.statusCode).toBe(401)
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().items).toHaveLength(1)
    expect(matchesDevelopmentBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(matchesDevelopmentBearer('Bearer wrong-token', TOKEN)).toBe(false)
    expect(matchesDevelopmentBearer(undefined, TOKEN)).toBe(false)
  })

  it('creates owned portfolios and registers normalized public-wallet sources idempotently', async () => {
    const app = await createTestApp()
    const createdPortfolio = await app.inject({
      method: 'POST',
      url: '/v1/portfolios',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name: '  Research  ' },
    })
    expect(createdPortfolio.statusCode).toBe(201)
    expect(createdPortfolio.json().name).toBe('Research')

    const portfolioId = createdPortfolio.json().id as string
    const walletAddress = '0x1234567890ABCDEF1234567890ABCDEF12345678'
    const registered = await app.inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/sources/polymarket`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { walletAddress },
    })
    const duplicate = await app.inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/sources/polymarket`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { walletAddress: walletAddress.toLowerCase(), label: 'ignored on duplicate' },
    })
    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/sources/polymarket`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { walletAddress: '0x0000000000000000000000000000000000000000' },
    })
    const crossOwner = await app.inject({
      method: 'POST',
      url: `/v1/portfolios/${OTHER_PORTFOLIO_ID}/sources/polymarket`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { walletAddress },
    })

    expect(registered.statusCode).toBe(201)
    expect(registered.json()).toMatchObject({ providerCode: 'polymarket', kind: 'public_wallet', alreadyRegistered: false })
    expect(registered.body).not.toContain(walletAddress)
    expect(registered.body).not.toContain(walletAddress.toLowerCase())
    const [storedSource] = await database.select({ externalAccountId: providerAccounts.externalAccountId })
      .from(providerAccounts).where(eq(providerAccounts.id, registered.json().id))
    expect(storedSource?.externalAccountId).toBe(walletAddress.toLowerCase())
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json().alreadyRegistered).toBe(true)
    expect(duplicate.json().id).toBe(registered.json().id)
    expect(invalid.statusCode).toBe(400)
    expect(crossOwner.statusCode).toBe(404)
  })

  it('serves public market lookup without authentication and fails closed on production private routes', async () => {
    let upstreamCalls = 0
    const marketData = new PolymarketMarketDataService(new PolymarketHttpClient(async () => {
      upstreamCalls += 1
      return new Response(JSON.stringify({ events: [], pagination: { hasMore: false, totalResults: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    const publicApp = await buildApp({ config: testConfig(), database, marketData })
    openApps.push(publicApp)
    const search = await publicApp.inject({ method: 'GET', url: '/v1/market-data/search?q=public%20event' })
    const unsafeUrl = await publicApp.inject({ method: 'POST', url: '/v1/market-data/resolve', payload: { url: 'http://127.0.0.1/private' } })
    expect(search.statusCode).toBe(200)
    expect(search.json().items).toEqual([])
    expect(search.headers['access-control-allow-origin']).toBeUndefined()
    expect(unsafeUrl.statusCode).toBe(400)
    expect(upstreamCalls).toBe(1)

    const productionApp = await buildApp({ config: { ...testConfig(), nodeEnv: 'production' }, database })
    openApps.push(productionApp)
    const privateResponse = await productionApp.inject({
      method: 'GET',
      url: '/v1/portfolios',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(privateResponse.statusCode).toBe(503)
    expect(privateResponse.json().error.code).toBe('authentication_unavailable')
  })

  it('rejects development identity configuration in production', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://scevia:secret@db.example.test/scevia',
      DB_SSL: 'true',
      AUTH_MODE: 'development',
      DEV_AUTH_TOKEN: TOKEN,
      DEV_PRINCIPAL_ID: OWNER_ID,
      CORS_ORIGINS: 'https://app.example.test',
    })).toThrow('Development authentication is disabled in production')
    expect(() => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://scevia:secret@db.example.test/scevia',
      DB_SSL: 'true',
      AUTH_MODE: 'external',
      DEV_AUTH_TOKEN: TOKEN,
      DEV_PRINCIPAL_ID: OWNER_ID,
      CORS_ORIGINS: 'https://app.example.test',
    })).toThrow('external authentication principal resolver has not been configured')
  })

  it('returns actual stored values while enforcing owner scope, pagination, and OpenAPI', async () => {
    const service = new IngestionService(database, providerRegistry)
    await service.syncProviderAccount({ id: MULTI_ACCOUNT_ROW_ID, providerCode: 'fixture-multisided', externalAccountId: MULTI_OUTCOME_ACCOUNT_ID })
    await service.syncProviderAccount({ id: SNAPSHOT_ACCOUNT_ROW_ID, providerCode: 'fixture-account-snapshot', externalAccountId: SNAPSHOT_ACCOUNT_ID })
    const app = await createTestApp()

    const positions = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/positions?limit=10&offset=0`,
      headers: { authorization: `Bearer ${TOKEN}`, 'x-user-id': OTHER_OWNER_ID },
    })
    expect(positions.statusCode).toBe(200)
    expect(positions.json().items).toHaveLength(2)
    const alphaPosition = positions.json().items.find((item: { providerCode: string }) => item.providerCode === 'fixture-multisided')
    const betaPosition = positions.json().items.find((item: { providerCode: string }) => item.providerCode === 'fixture-account-snapshot')
    expect(alphaPosition.quantity).toBe('12.000000000000000001')
    expect(alphaPosition.markPrice).toBe('0.250000000000000001')
    expect(betaPosition.markPrice).toBeNull()

    const fillPage = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/fills?limit=1&offset=0`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(fillPage.statusCode).toBe(200)
    expect(fillPage.json().items).toHaveLength(1)
    expect(fillPage.json().pagination).toEqual({ limit: 1, offset: 0, returned: 1 })
    expect(fillPage.json().items[0].quantity).toBe('2.500000000000000000')

    const coverage = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/coverage?limit=100&offset=0`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const unavailableMark = coverage.json().items.find((item: { providerCode: string; entityType: string }) =>
      item.providerCode === 'fixture-account-snapshot' && item.entityType === 'prices',
    )
    const positionCoverage = coverage.json().items.find((item: { providerCode: string; entityType: string }) =>
      item.providerCode === 'fixture-multisided' && item.entityType === 'positions',
    )
    expect(unavailableMark.status).toBe('unavailable')
    expect(unavailableMark.reasonCode).toBe('unsupported_by_provider')
    expect(positionCoverage.snapshotAsOf).toBe('2026-11-24T10:00:00.000Z')

    const hiddenPortfolio = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${OTHER_PORTFOLIO_ID}/positions`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const invalidLimit = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/fills?limit=1000`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const specification = await app.inject({ method: 'GET', url: '/docs/json' })
    expect(hiddenPortfolio.statusCode).toBe(404)
    expect(invalidLimit.statusCode).toBe(400)
    expect(invalidLimit.json().error.code).toBe('invalid_request')
    expect(invalidLimit.body).not.toContain('stack')
    expect(specification.statusCode).toBe(200)
    expect(specification.json().paths['/v1/portfolios/{portfolioId}/positions']).toBeDefined()
    const coverageProperties = specification.json().paths['/v1/portfolios/{portfolioId}/coverage']
      .get.responses['200'].content['application/json'].schema.properties.items.items.properties
    expect(coverageProperties.coverageStart.description).toContain('does not prove continuous history')
    expect(coverageProperties.coverageEnd.description).toContain('does not prove continuous history')

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/v1/provider-accounts/${MULTI_ACCOUNT_ROW_ID}/sync`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const allFills = await database.select({ id: fills.id }).from(fills)
    expect(syncResponse.statusCode).toBe(200)
    expect(syncResponse.json().status).toBe('complete')
    expect(allFills).toHaveLength(3)

    const crossScopeSync = await app.inject({
      method: 'POST',
      url: `/v1/provider-accounts/${OTHER_ACCOUNT_ROW_ID}/sync`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(crossScopeSync.statusCode).toBe(404)
  })

  it('does not expose provider account identifiers through the portfolio source endpoint', async () => {
    const app = await createTestApp()
    const response = await app.inject({
      method: 'GET',
      url: `/v1/portfolios/${PORTFOLIO_ID}/sources`,
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain(MULTI_OUTCOME_ACCOUNT_ID)
    expect(response.body).not.toContain(SNAPSHOT_ACCOUNT_ID)
  })
})

async function seedOwnershipData(): Promise<void> {
  await database.insert(users).values([
    { id: OWNER_ID, authSubject: 'test-owner-primary' },
    { id: OTHER_OWNER_ID, authSubject: 'test-owner-other' },
  ])
  await database.insert(portfolios).values([
    { id: PORTFOLIO_ID, ownerId: OWNER_ID, name: 'Sample portfolio' },
    { id: OTHER_PORTFOLIO_ID, ownerId: OTHER_OWNER_ID, name: 'Private portfolio' },
  ])
  await database.insert(providerAccounts).values([
    {
      id: MULTI_ACCOUNT_ROW_ID,
      portfolioId: PORTFOLIO_ID,
      providerCode: 'fixture-multisided',
      externalAccountId: MULTI_OUTCOME_ACCOUNT_ID,
      label: 'Fixture multi-outcome source',
      kind: 'fixture',
    },
    {
      id: SNAPSHOT_ACCOUNT_ROW_ID,
      portfolioId: PORTFOLIO_ID,
      providerCode: 'fixture-account-snapshot',
      externalAccountId: SNAPSHOT_ACCOUNT_ID,
      label: 'Fixture account snapshot source',
      kind: 'fixture',
    },
    {
      id: OTHER_ACCOUNT_ROW_ID,
      portfolioId: OTHER_PORTFOLIO_ID,
      providerCode: 'fixture-multisided',
      externalAccountId: 'other-owner-fixture-account',
      label: 'Other owner private source',
      kind: 'fixture',
    },
  ])
}

async function addProviderAccount(providerCode: string, externalAccountId: string, id: string): Promise<void> {
  await database.insert(providerAccounts).values({
    id,
    portfolioId: PORTFOLIO_ID,
    providerCode,
    externalAccountId,
    label: `Fixture ${providerCode}`,
    kind: 'fixture',
  })
}

function testConfig(): ServerConfig {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL must be set')
  return {
    url: testDatabaseUrl,
    ssl: false,
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3001,
    authMode: 'development',
    devAuthToken: TOKEN,
    devPrincipalId: OWNER_ID,
    corsOrigins: ['http://localhost:5173'],
  }
}

async function createTestApp() {
  const app = await buildApp({ config: testConfig(), database })
  openApps.push(app)
  return app
}

function emptyFixtureAdapter(
  providerCode: string,
  fetchPage: (cursor: string | null) => Promise<ProviderPage>,
): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    providerCode,
    displayName: `Test ${providerCode}`,
    adapterKind: 'fixture',
    accountKinds: ['fixture'],
    operations: Object.fromEntries(ALL_ENTITIES.map((entity) => [entity, 'supported'])) as Record<CoverageEntity, 'supported'>,
    streams: [{
      name: 'records',
      entities: ALL_ENTITIES,
      strategy: 'provider_checkpoint',
      snapshotSemantics: { positions: 'incremental', cash_balances: 'incremental' },
    }],
    pagination: 'supported',
    incrementalSync: 'supported',
  }
  return {
    capabilities,
    async fetchPage({ cursor }) { return fetchPage(cursor) },
    normalizePage() { return [] },
  }
}

function emptyPage(): ProviderPage {
  return { payload: {}, nextCursor: null, checkpoint: 'checkpoint-1', coverage: COMPLETE_COVERAGE }
}

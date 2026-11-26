import { sharedTrackingEvidence } from '../src/tracking/evidence.js'
import { nextTime, TrackingWorker } from '../src/tracking/worker.js'
import { initializeTrackedAccounts } from '../src/tracking/routes.js'
import { kalshiMarketChoice } from '../src/providers/kalshi/market-data.js'
import { kalshiCredentialSourceId } from '../src/providers/kalshi/live.js'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KalshiAdapter } from '../src/providers/kalshi/adapter.js'
import { KalshiClient } from '../src/providers/kalshi/client.js'
import { KalshiMarketDataService } from '../src/providers/kalshi/market-data.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { createDatabase, type Database } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import {
  accountTracking, marketLifecycleEvidence, marketTracking, sharedMarketObservations,
  activityFactOccurrences,
  cashMovements,
  reviewedBinaryRules,
  financialImportBatches,
  events,
  fills,
  instruments,
  markets,
  portfolios,
  positionSnapshots,
  priceObservations,
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
  it('polls a shared market once and revalues owned mapped portfolios without synchronizing account history', async () => {
    const [event] = await database.insert(events).values({ providerCode: 'kalshi', externalId: 'TRACK-EVENT', name: 'Tracking' }).returning()
    const [market] = await database.insert(markets).values({ providerCode: 'kalshi', externalId: 'TRACK-MARKET',
      eventId: event!.id, title: 'Tracking', settlementAssetCode: 'USD' }).returning()
    const [leg] = await database.insert(instruments).values({ marketId: market!.id, externalId: 'TRACK-MARKET:yes',
      outcomeName: 'Yes', outcomeType: 'yes', settlementAssetCode: 'USD' }).returning()
    const app = await createTestApp()
    const other = await buildApp({ database, config: { ...testConfig(), devPrincipalId: OTHER_OWNER_ID } })
    openApps.push(other)
    const headers = { authorization: `Bearer ${TOKEN}` }
    const roots = ['/v1/portfolios/' + PORTFOLIO_ID, '/v1/portfolios/' + OTHER_PORTFOLIO_ID]
    const setup = async (server: typeof app, root: string) => {
      expect((await server.inject({ method: 'PUT', url: root + '/tracking/markets', headers, payload: { markets: [market!.id] } })).statusCode).toBe(200)
      const csv = ['venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset,coverage_through,canonical_instrument_id',
        'kalshi,tracked,opening,2026-01-01T00:00:00Z,,opening_cash,,USD,,,100,,,,',
        'kalshi,tracked,inventory,2026-01-01T00:00:00Z,,opening_inventory,,USD,,,,,,,',
        `kalshi,tracked,buy,2026-01-02T00:00:00Z,,buy,${leg!.id},USD,10,0.4,,0,USD,,${leg!.id}`,
      ].join('\n')
      const response = await server.inject({ method: 'POST', url: root + '/imports/preview', headers, payload: { csv } })
      expect(response.statusCode, response.body).toBe(200)
      const batch = response.json()
      expect((await server.inject({ method: 'POST', headers,
        url: root + '/imports/' + batch.batchId + '/confirm?reviewRevision=' + batch.reviewRevision })).statusCode).toBe(200)
    }
    await setup(app, roots[0]!)
    await setup(other, roots[1]!)
    expect((await app.inject({ method: 'GET', url: roots[1] + '/tracking', headers })).statusCode).toBe(404)
    for (const [index, server] of [app, other].entries()) {
      const tracking = roots[index] + '/tracking'
      expect((await server.inject({ method: 'POST', url: tracking + '/reconcile', headers })).statusCode).toBe(200)
      expect((await server.inject({ method: 'PUT', url: tracking + '/markets', headers, payload: { markets: [] } })).statusCode).toBe(200)
      expect((await server.inject({ method: 'GET', url: tracking, headers })).json()).toMatchObject({ markets: [],
        holdingsMarkets: [{ marketId: market!.id }] })
    }
    let quoteAt = '2026-01-03T00:00:00.000Z'
    let price = '0.6'
    const lookup = vi.fn(async () => {
      const item = kalshiMarketChoice({ ticker: 'TRACK-MARKET', event_ticker: 'TRACK-EVENT', title: 'Tracking',
        status: 'active', market_type: 'binary', notional_value_dollars: '1' }, quoteAt)
      return { ...item, outcomes: item.outcomes.map((outcome) => ({ ...outcome,
        quote: { value: price, retrievedAt: quoteAt, observedAt: null, provenance: 'provider_book_midpoint' } })) }
    })
    const syncProviderAccount = vi.fn()
    const workerOptions = { kalshi: { lookup }, accountIds: [], marketIntervalMs: 300_000, accountIntervalMs: 300_000,
      ingestion: { syncProviderAccount } }
    const worker = new TrackingWorker(database, workerOptions)
    const restarted = new TrackingWorker(database, workerOptions)
    const signal = new AbortController().signal
    const due = () => database.update(marketTracking).set({ nextAttemptAt: new Date(0) })
    await due()
    expect((await Promise.all([worker.market(signal), restarted.market(signal)])).sort()).toEqual([false, true])
    expect(lookup).toHaveBeenCalledTimes(1)
    await due()
    await worker.market(signal)
    quoteAt = '2026-01-02T23:00:00.000Z'
    price = '0.5'
    await due()
    await restarted.market(signal)
    expect(await database.select().from(sharedMarketObservations)).toHaveLength(2)
    for (const [index, server] of [app, other].entries()) {
      const response = await server.inject({ method: 'GET', url: roots[index] + '/accounting?view=detail&asOf=2026-01-03T01:00:00Z', headers })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json().cash).toContainEqual(expect.objectContaining({ balance: '96', portfolioValue: '102' }))
    }
    expect(syncProviderAccount).not.toHaveBeenCalled()
    lookup.mockRejectedValueOnce(new Error('fixture_outage'))
    await due()
    await restarted.market(signal)
    const [job] = await database.select().from(marketTracking)
    expect(job).toMatchObject({ failures: 1, leaseToken: null })
    expect(await restarted.market(signal)).toBe(false)
    await due()
    await restarted.market(signal)
    expect((await database.select().from(marketTracking))[0]?.failures).toBe(0)
    const url = roots[0] + '/tracking/valuation'
    const firstValue = await app.inject({ method: 'GET', url, headers })
    expect(firstValue.statusCode, firstValue.body).toBe(200)
    const firstRevision = firstValue.json()
    const timed = performance.now()

    const workspace = await app.inject({ method: 'GET', url: url + '?asset=USD', headers })
    expect(workspace.statusCode, workspace.body).toBe(200)
    expect(workspace.json()).toMatchObject({ financialRevision: firstRevision.financialRevision,
      exposure: { reportedExposure: { portfolioNav: null } } })
    if (process.env.TRACKING_BENCHMARK === 'YES') process.stdout.write(JSON.stringify({
      fixtureWorkspaceMs: Math.round(performance.now() - timed),
    }) + '\n')
    const coherent304 = await app.inject({ method: 'GET', url: url + '?asset=USD',
      headers: { ...headers, 'if-none-match': workspace.headers.etag! } })
    expect(coherent304.statusCode).toBe(304)
    const conditional = await app.inject({ method: 'GET', url, headers: { ...headers, 'if-none-match': firstValue.headers.etag! } })
    expect(conditional.statusCode).toBe(304)
    quoteAt = new Date().toISOString()
    price = '0.7'
    await due()
    await restarted.market(signal)
    const updated = (await app.inject({ method: 'GET', url, headers })).json()
    expect(updated.financialRevision).toBe(firstRevision.financialRevision)
    expect(updated.marketRevision).not.toBe(firstRevision.marketRevision)
    expect(updated.cash).toContainEqual(expect.objectContaining({ portfolioValue: '103', balance: '96' }))
    const replayed = (await app.inject({ method: 'GET', url: roots[0] + '/accounting?view=detail', headers })).json()
    expect(updated.cash).toEqual(replayed.cash)
    expect(updated.holdings).toEqual(replayed.holdings)
    const open = (await app.inject({ method: 'GET', url: roots[0] + '/accounting/records', headers })).json()
    const trade = open.items.find((row: { original: { id: string } }) => row.original.id === 'buy')
    const changes = { changes: [{ key: trade.key, action: 'exclude' }] }
    const proposal = await app.inject({ method: 'POST', url: roots[0] + '/accounting/adjustments/preview', headers, payload: changes })
    expect(proposal.statusCode, proposal.body).toBe(200)
    expect((await app.inject({ method: 'POST', url: roots[0] + '/accounting/adjustments/confirm', headers,
      payload: { ...changes, revision: proposal.json().revision } })).statusCode).toBe(200)
    const corrected = (await app.inject({ method: 'GET', url, headers })).json()
    expect(corrected.financialRevision).not.toBe(updated.financialRevision)
    expect(corrected.cash).toContainEqual(expect.objectContaining({ balance: '100' }))
    expect((await app.inject({ method: 'POST', url: roots[0] + '/tracking/reconcile', headers })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: roots[0] + '/tracking', headers })).json().holdingsMarkets).toEqual([])
    const storedAt = '2026-01-01T00:00:00Z'
    await pool.query(`insert into scevia.shared_market_observations
      (instrument_id, asset, method, price, retrieved_at, effective_at, source, revision)
      select $1, 'USD', 'book_midpoint', 0.5, tick, tick, 'fixture', 'fixture:' || tick::text
      from generate_series($2::timestamptz, '2026-04-01T00:00:00Z'::timestamptz, interval '5 minutes') tick`, [leg!.id, storedAt])
    const batch = { batchId: 'fixture', row: 1, observation: { venue: 'kalshi', account: 'fixture', id: 'buy', asset: 'USD',
      type: 'buy' as const, instrument: leg!.id, canonicalInstrumentId: leg!.id, timestamp: storedAt.replace('Z', '.000Z'),
      sequence: null, quantity: '1', amount: null, fee: '0', feeAsset: 'USD', price: '0.4' } }
    const flows = Array.from({ length: 42 }, (_, index) => ({ ...batch, row: 2 + index, observation: {
      ...batch.observation, id: 'flow:' + index, type: 'deposit' as const,
      timestamp: new Date(Date.UTC(2026, 2, 3 + Math.floor(index / 2), index % 2 ? 12 : 13, 3)).toISOString(),
      instrument: null, amount: '1',
    } }))
    for (const [days, from] of [[30, '2026-03-02'], [90, '2026-01-01'], [180, '2025-10-03'], [365, '2025-04-01']] as const) {
      const started = performance.now()
      const history = await sharedTrackingEvidence(database, [batch, ...flows], '2026-04-01T00:00:00.000Z', from + 'T00:00:00.000Z')
      if (process.env.TRACKING_BENCHMARK === 'YES') process.stdout.write(JSON.stringify({
        fixtureObservations: 25921, days, projected: history.evidence.length, queryMs: Math.round(performance.now() - started),
      }) + '\n')
      expect(history.truncated).toBe(false)
      expect(history.evidence.length).toBeLessThan(150)
      const fullStart = performance.now()
      const analytics = await other.inject({ method: 'GET', headers, url: roots[1] + '/analytics/performance?'
        + new URLSearchParams({ asset: 'USD', accounts: 'tracked', from: from + 'T00:00:00Z', asOf: '2026-04-01T00:00:00Z' }) })
      expect(analytics.statusCode, analytics.body).toBe(200)
      if (process.env.TRACKING_BENCHMARK === 'YES') process.stdout.write(JSON.stringify({
        fixtureAnalyticsDays: days, responseMs: Math.round(performance.now() - fullStart),
      }) + '\n')
      expect(history.evidence).toContainEqual(expect.objectContaining({ observation: expect.objectContaining({
        timestamp: (from < '2026-01-01' ? '2026-01-01T23:55:00.000Z' : from + 'T00:00:00.000Z'),
      }) }))
    }

  })

  it('builds a scratch scenario in an empty workspace with independent virtual capital', async () => {
    const [workspace] = await database.insert(portfolios).values({ ownerId: OWNER_ID, name: 'Empty user workspace' }).returning()
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const root = '/v1/portfolios/' + workspace!.id + '/scenarios'
    const preview = await app.inject({ method: 'POST', url: root + '/baseline', headers, payload: {
      mode: 'scratch', asset: 'USD', asOf: '2026-01-01T00:00:00Z',
      buckets: [{ id: 'virtual', account: 'virtual', venue: 'kalshi', cash: '50' }],
      local: [{ id: 'local:test-outcome', mark: '0.4' }],
    } })
    expect(preview.statusCode, preview.body).toBe(200)
    const evaluated = await app.inject({ method: 'POST', url: root + '/evaluate', headers, payload: {
      baselineToken: preview.json().baselineToken, input: { operations: [{ bucket: 'virtual', instrument: 'local:test-outcome',
        kind: 'buy', amount: '10', price: '0.4', fee: { mode: 'fixed', value: '0' } }] },
    } })
    expect(evaluated.statusCode, evaluated.body).toBe(200)
    expect(evaluated.json()).toMatchObject({ funding: [{ endingCash: '46' }] })
    expect(await database.select().from(providerAccounts).where(eq(providerAccounts.portfolioId, workspace!.id))).toEqual([])
  })

  it('keeps a healthy account-history interval separate from the retry ceiling', () => {
    const now = new Date(0)
    expect(nextTime(now, 4 * 3_600_000, 0, 0).getTime()).toBe(4 * 3_600_000)
    expect(nextTime(now, 4 * 3_600_000, 1, 0.9).getTime()).toBe(3_600_000)
  })

  it('schedules only locally approved, enabled account sources and resumes an expired job lease', async () => {
    const [first, foreign] = await database.insert(providerAccounts).values([
      { portfolioId: PORTFOLIO_ID, providerCode: 'polymarket', kind: 'public_wallet', label: 'Approved', externalAccountId: 'wallet-a' },
      { portfolioId: OTHER_PORTFOLIO_ID, providerCode: 'polymarket', kind: 'public_wallet', label: 'Other', externalAccountId: 'wallet-b' },
    ]).returning()
    expect(await initializeTrackedAccounts(database, OWNER_ID, [first!.id, foreign!.id], true)).toEqual([first!.id])
    const syncProviderAccount = vi.fn(async () => ({ status: 'complete' as const, providerAccountId: first!.id,
      streams: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }))
    const opts = { accountIds: [first!.id], marketIntervalMs: 300_000, accountIntervalMs: 300_000, ingestion: { syncProviderAccount } }
    const signal = new AbortController().signal
    const worker = new TrackingWorker(database, opts)
    await database.update(accountTracking).set({ nextAttemptAt: new Date(0), leaseUntil: new Date(1) })
    expect(await worker.account(signal)).toBe(true)
    expect(await new TrackingWorker(database, opts).account(signal)).toBe(true)
    expect(syncProviderAccount.mock.calls).toEqual([[first!.id, 'current'], [first!.id, 'history']])
    await database.update(providerAccounts).set({ disabledAt: new Date() }).where(eq(providerAccounts.id, first!.id))
    await database.update(accountTracking).set({ nextAttemptAt: new Date(0) })
    expect(await worker.account(signal)).toBe(false)
  })

  it('settles an owned captured demo from shared verified lifecycle evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scevia-tracked-demo-'))
    try {
      const path = join(directory, 'fixture-capture.json')
      const capturedAt = '2026-01-03T00:00:00.000Z'
      const tradeAt = '2026-01-02T00:00:00.000Z'
      const closedAt = '2026-01-04T00:00:00.000Z'
      const resolvedAt = '2026-01-05T00:00:00.000Z'
      const verifiedAt = '2026-01-06T00:00:00.000Z'
      const market = { provider: 'kalshi', asset: 'USD', nativeMarket: 'FIXTURE-TRACK', nativeEvent: 'FIXTURE-EVENT',
        title: 'Fixture tracked market', eventTitle: 'Fixture event', category: null, lifecycle: 'open', resolvesAt: null,
        retrievedAt: capturedAt, source: 'authorized_capture',
        outcomes: [{ instrument: 'FIXTURE-TRACK:yes', name: 'YES' }, { instrument: 'FIXTURE-TRACK:no', name: 'NO' }] }
      await writeFile(path, JSON.stringify({ evidenceKind: 'authorized_capture', capturedAt, markets: [market, { ...market, nativeMarket: 'FIXTURE-STALE',
        outcomes: [{ instrument: 'FIXTURE-STALE:yes', name: 'YES' }, { instrument: 'FIXTURE-STALE:no', name: 'NO' }] }],
        capital: [{ provider: 'kalshi', asset: 'USD', amount: '100', openedAt: '2026-01-01T00:00:00.000Z' }],
        quotes: [{ provider: 'kalshi', nativeMarket: market.nativeMarket, instrument: 'FIXTURE-TRACK:yes', price: '0.4',
          method: 'historical_close', source: 'authorized_capture', observedAt: tradeAt, retrievedAt: capturedAt },
        { provider: 'kalshi', nativeMarket: 'FIXTURE-STALE', instrument: 'FIXTURE-STALE:yes', price: '0.4',
          method: 'historical_close', source: 'authorized_capture', observedAt: tradeAt, retrievedAt: capturedAt }],
        trades: [{ id: 'buy', quoteIndex: 0, quantity: '10', direction: 'buy', assumedFee: '0' }, { id: 'stale', quoteIndex: 1, quantity: '5', direction: 'buy', assumedFee: '0' }],
      }))
      const app = await buildApp({ database, config: { ...testConfig(), demoDataset: { path, cacheMs: 1000, allowFixture: true } } })
      openApps.push(app)
      const headers = { authorization: `Bearer ${TOKEN}` }
      const created = await app.inject({ method: 'POST', url: '/v1/demo', headers, payload: {} })
      expect(created.statusCode, created.body).toBe(200)
      const root = '/v1/portfolios/' + created.json().portfolioId
      expect((await app.inject({ method: 'POST', url: root + '/tracking/reconcile', headers })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: root + '/tracking', headers })).json().holdingsMarkets)
        .toContainEqual(expect.objectContaining({ nativeMarket: market.nativeMarket }))
      const lookup = vi.fn().mockResolvedValueOnce({ marketTicker: market.nativeMarket, eventTicker: market.nativeEvent,
        establishedPayoutUnit: '1', lifecycle: 'closed', retrievedAt: closedAt, resolution: null })
        .mockResolvedValueOnce({ marketTicker: market.nativeMarket, eventTicker: market.nativeEvent,
          establishedPayoutUnit: '1', lifecycle: 'resolved', retrievedAt: resolvedAt, resolution: null })
        .mockResolvedValueOnce({ marketTicker: market.nativeMarket, eventTicker: market.nativeEvent,
          establishedPayoutUnit: '1', lifecycle: 'resolved', retrievedAt: verifiedAt,
          resolution: { knownAt: resolvedAt, winningInstrument: 'FIXTURE-TRACK:yes', unitPayout: '1' } })
      const worker = new TrackingWorker(database, { kalshi: { lookup }, accountIds: [], marketIntervalMs: 300_000, accountIntervalMs: 300_000,
        ingestion: { syncProviderAccount: vi.fn() } })
      const [watched] = await database.select({ id: markets.id }).from(markets)
        .where(eq(markets.externalId, market.nativeMarket))
      await database.update(marketTracking).set({ nextAttemptAt: new Date('2099-01-01T00:00:00Z') })
      const poll = async () => {
        await database.update(marketTracking).set({ nextAttemptAt: new Date(0) }).where(eq(marketTracking.marketId, watched!.id))
        expect(await worker.market(new AbortController().signal)).toBe(true)
      }
      const state = async (asOf: string) => (await app.inject({ method: 'GET', url: root + '/accounting?view=detail&asOf=' + asOf, headers })).json()
      await poll()
      expect((await state(closedAt)).cash[0].balance).toBe('94')
      await poll()
      expect((await state(resolvedAt)).cash[0]).toMatchObject({ balance: null, historyCoverage: 'outside_declared_interval' })
      await poll()
      expect((await state(resolvedAt)).cash[0]).toMatchObject({ balance: null, historyCoverage: 'outside_declared_interval' })
      expect((await state(verifiedAt)).cash[0]).toMatchObject({ balance: '104', realized: '6', historyCoverage: 'outside_declared_interval' })
      const journal = await database.select().from(marketLifecycleEvidence).where(eq(marketLifecycleEvidence.marketId, watched!.id))
      expect(journal).toHaveLength(3)
      const demo = (await app.inject({ method: 'GET', url: '/v1/demo', headers })).json()
      expect(demo.trackingCoverage).toEqual(expect.arrayContaining([
        expect.objectContaining({ nativeMarket: 'FIXTURE-TRACK', lifecycleThrough: verifiedAt, resolutionObservedAt: verifiedAt }),
        expect.objectContaining({ nativeMarket: 'FIXTURE-STALE', lifecycleThrough: capturedAt, resolutionStatus: 'pending' }),
      ]))
      await database.insert(marketLifecycleEvidence).values({ marketId: watched!.id, revision: 'manual-fixture-conflict',
        lifecycle: 'resolved', retrievedAt: new Date('2026-01-07T00:00:00Z'), conflict: true,
        resolution: { knownAt: verifiedAt, winningInstrument: 'FIXTURE-TRACK:no', unitPayout: '1' } })
      expect((await app.inject({ method: 'GET', url: '/v1/demo', headers })).json().trackingCoverage)
        .toContainEqual(expect.objectContaining({ nativeMarket: 'FIXTURE-TRACK', resolutionStatus: 'conflict' }))
      expect((await state(closedAt)).cash[0].balance).toBe('94')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('replays a versioned demo capture and isolates user corrections, scenarios and resets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scevia-demo-'))
    try {
      const path = join(directory, 'dataset.json')
      const capturedAt = '2026-11-26T02:00:00Z'
      const start = '2026-11-24T02:00:00Z'
      const tradeAt = '2026-11-25T02:00:00Z'
      const dataset = {
        evidenceKind: 'fixture', capturedAt,
        capital: [{ provider: 'kalshi', asset: 'USD', openedAt: start, amount: '100' },
          { provider: 'polymarket', asset: 'PUSD', openedAt: start, amount: '50' }],
        markets: [
          { provider: 'kalshi', asset: 'USD', nativeMarket: 'SAMPLE-OPEN', nativeEvent: 'EVENT-A', title: 'Reference open market',
            eventTitle: 'Event A', category: null, lifecycle: 'open', resolvesAt: null, retrievedAt: capturedAt, source: 'authorized_capture',
            outcomes: [{ instrument: 'SAMPLE-OPEN:yes', name: 'YES' }, { instrument: 'SAMPLE-OPEN:no', name: 'NO' }] },
          { provider: 'polymarket', asset: 'PUSD', nativeMarket: 'PM-CONDITION', nativeEvent: 'EVENT-PM', title: 'Separate native denomination',
            eventTitle: 'Event Polymarket', category: 'Test', lifecycle: 'open', resolvesAt: null, retrievedAt: capturedAt,
            source: 'authorized_capture', outcomes: [{ instrument: 'PM-YES', name: 'YES' }, { instrument: 'PM-NO', name: 'NO' }] },
          { provider: 'kalshi', asset: 'USD', nativeMarket: 'SAMPLE-CLOSED', nativeEvent: 'EVENT-B', title: 'Reference resolved market',
            eventTitle: 'Event B', category: null, lifecycle: 'resolved', resolvesAt: capturedAt, retrievedAt: capturedAt, source: 'authorized_capture',
            outcomes: [{ instrument: 'CLOSED:YES', name: 'YES' }, { instrument: 'CLOSED:NO', name: 'NO' }],
            resolution: { knownAt: capturedAt, winningInstrument: 'CLOSED:YES', unitPayout: '1' } },
        ],
        quotes: [
          { provider: 'kalshi', nativeMarket: 'SAMPLE-OPEN', instrument: 'SAMPLE-OPEN:yes', price: '0.4',
            method: 'historical_close', source: 'kalshi_candlesticks', observedAt: tradeAt, retrievedAt: capturedAt },
          { provider: 'kalshi', nativeMarket: 'SAMPLE-CLOSED', instrument: 'CLOSED:YES', price: '0.25',
            method: 'historical_close', source: 'kalshi_candlesticks', observedAt: tradeAt, retrievedAt: capturedAt },
          { provider: 'kalshi', nativeMarket: 'SAMPLE-OPEN', instrument: 'SAMPLE-OPEN:yes', price: '0.7',
            method: 'book_midpoint', source: 'kalshi_book', observedAt: null, retrievedAt: capturedAt },
          { provider: 'polymarket', nativeMarket: 'PM-CONDITION', instrument: 'PM-NO', price: '0.25',
            method: 'historical_close', source: 'polymarket_clob', observedAt: tradeAt, retrievedAt: capturedAt },
          { provider: 'polymarket', nativeMarket: 'PM-CONDITION', instrument: 'PM-NO', price: '0.5',
            method: 'book_midpoint', source: 'polymarket_clob', observedAt: null, retrievedAt: capturedAt },
        ],
        trades: [{ id: 'open', quoteIndex: 0, quantity: '10', direction: 'buy', assumedFee: '1' },
          { id: 'resolved', quoteIndex: 1, quantity: '4', direction: 'buy', assumedFee: '0' },
          { id: 'polymarket', quoteIndex: 3, quantity: '10', direction: 'buy', assumedFee: '0' }],
      }
      await writeFile(path, JSON.stringify(dataset))
      const kalshiMarketData = new KalshiMarketDataService(new KalshiClient(async () => Response.json({ market: {
        ticker: 'SAMPLE-OPEN', event_ticker: 'EVENT-A', title: 'Reference open market', status: 'active',
        market_type: 'binary', notional_value_dollars: '1', last_price_dollars: '0.71',
      } })))
      const app = await buildApp({ database, kalshiMarketData, config: { ...testConfig(), demoDataset: { path, cacheMs: 10_000, allowFixture: true } } })
      const other = await buildApp({ database, config: { ...testConfig(), devPrincipalId: OTHER_OWNER_ID,
        demoDataset: { path, cacheMs: 10_000, allowFixture: true } } })
      const disabled = await createTestApp()
      openApps.push(app, other)
      const headers = { authorization: `Bearer ${TOKEN}` }
      const demo = (server: typeof app, method: 'GET' | 'POST', payload?: object) =>
        server.inject({ method, url: '/v1/demo', headers, ...(payload ? { payload } : {}) })
      expect((await demo(disabled, 'GET')).json()).toMatchObject({ status: 'unavailable' })
      const created = await demo(app, 'POST')
      expect(created.statusCode, created.body).toBe(200)
      const { portfolioId, revision } = created.json()
      expect(created.json()).toMatchObject({ mode: 'fixture', capturedAt: new Date(capturedAt).toISOString(), transactions: 'hypothetical' })
      expect((await demo(app, 'POST')).json().portfolioId).toBe(portfolioId)
      const otherId = (await demo(other, 'POST')).json().portfolioId
      expect(otherId).not.toBe(portfolioId)
      const root = '/v1/portfolios/' + portfolioId
      const get = (suffix: string) => app.inject({ method: 'GET', url: root + suffix, headers })
      const post = (suffix: string, payload: object) => app.inject({ method: 'POST', url: root + suffix, headers, payload })
      expect((await other.inject({ method: 'GET', url: root + '/accounting', headers })).statusCode).toBe(404)
      expect((await post('/sources/polymarket', { walletAddress: '0x1111111111111111111111111111111111111111', label: 'Wallet' })).statusCode).toBe(422)
      const first = (await get('/accounting?view=detail&asOf=' + capturedAt)).json()
      const cashByAsset = (rows: Array<{ asset: string }>, asset: string) => rows.find((row) => row.asset === asset) as
        { asset: string; account: string; balance: string; portfolioValue: string }
      expect(cashByAsset(first.cash, 'USD')).toMatchObject({ balance: '98', portfolioValue: '105', knownRealized: '3' })
      expect(cashByAsset(first.cash, 'PUSD')).toMatchObject({ balance: '47.5', portfolioValue: '52.5' })
      expect(cashByAsset((await get('/accounting?view=detail&asOf=' + tradeAt)).json().cash, 'USD')).toMatchObject({ portfolioValue: '99', knownRealized: '0' })
      const performance = async (asOf: string, gain: string, twr: string) => {
        const query = new URLSearchParams({ from: start, asOf, asset: 'USD', accounts: cashByAsset(first.cash, 'USD').account })
        const response = await get('/analytics/performance?' + query)
        expect(response.statusCode, response.body).toBe(200)
        expect(response.json()).toMatchObject({ bridge: { netInvestmentGain: { value: gain } }, returns: { twr: { value: twr } } })
      }
      await performance(capturedAt, '5', '0.05')
      const records = (await get('/accounting/records')).json()
      const fill = records.items.find((row: { original: { id: string } }) => row.original.id === 'simulation:trade:open')
      expect(fill.acquisition).toBe('demo')
      const edits = { changes: [{ key: fill.key, action: 'correct', correction: { quantity: '12' } }] }
      const preview = await post('/accounting/adjustments/preview', edits)
      expect(preview.statusCode, preview.body).toBe(200)
      expect((await post('/accounting/adjustments/confirm', { ...edits, revision: preview.json().revision })).statusCode).toBe(200)
      const after = (await get('/accounting?view=detail&asOf=' + capturedAt)).json()
      expect(cashByAsset(after.cash, 'USD')).toMatchObject({ balance: '97.2', portfolioValue: '105.6' })
      expect(after.holdings).toContainEqual(expect.objectContaining({ quantity: '12', basis: '5.8' }))
      const source = { mode: 'actual', asset: 'USD', asOf: capturedAt, accounts: [cashByAsset(after.cash, 'USD').account] }
      expect((await get('/analytics/denominations?asOf=' + capturedAt + '&assumedUsdPerPusd=0.97')).json())
        .toMatchObject({ conversionAvailability: 'indicative', indicativeUsd: { value: '156.525', fundsTransferable: false } })
      expect((await get('/analytics/denominations?asOf=' + capturedAt)).json())
        .toMatchObject({ conversionAvailability: 'assumption_required', indicativeUsd: null })
      const baseline = await post('/scenarios/baseline', { ...source, publicOutcomes: [
        { url: 'https://kalshi.com/markets/SAMPLE-OPEN', assetIdType: 'kalshi_outcome', assetId: 'SAMPLE-OPEN:yes' },
      ] })
      expect(baseline.statusCode, baseline.body).toBe(200)
      expect(baseline.json().instruments).toHaveLength(1)
      expect(baseline.json().instrumentAliases['kalshi:SAMPLE-OPEN:yes']).toBe(baseline.json().holdings[0].instrument)
      const scenario = await post('/scenarios', { name: 'Demo alternative', source: baseline.json().baselineSource,
        baselineToken: baseline.json().baselineToken, input: {} })
      expect(scenario.statusCode, scenario.body).toBe(201)
      expect((await post('/scenarios/evaluate', { scenarioId: scenario.json().id })).statusCode).toBe(200)
      const pusd = await post('/scenarios/baseline', { mode: 'actual', asOf: capturedAt, asset: 'PUSD', accounts: [cashByAsset(after.cash, 'PUSD').account] })
      expect(pusd.statusCode, pusd.body).toBe(200)
      const mixed = { components: [{ baselineToken: baseline.json().baselineToken, input: {} },
        { baselineToken: pusd.json().baselineToken, input: {} }], assumedUsdPerUnit: { PUSD: '0.97' } }
      const mixedResult = await post('/scenarios/evaluate-denominations', mixed)
      expect(mixedResult.statusCode, mixedResult.body).toBe(200)
      expect(mixedResult.json().indicativeUsd.value).toBe('156.525')
      const saved = await post('/scenarios/denomination-scenarios', { ...mixed, name: 'Demo mixed',
        previewDigest: mixedResult.json().previewDigest })
      expect(saved.statusCode, saved.body).toBe(201)
      const rebasePath = '/scenarios/denomination-scenarios/' + saved.json().id + '/rebase'
      const reviewed = await post(rebasePath, { revision: 1, asOf: '2026-11-26T03:00:00Z' })
      expect(reviewed.statusCode, reviewed.body).toBe(200)
      expect(reviewed.json().previewToken).toEqual(expect.any(String))
      const rebased = await post(rebasePath, { revision: 1, previewToken: reviewed.json().previewToken })
      expect(rebased.statusCode, rebased.body).toBe(200)
      expect(rebased.json().revision).toBe(2)
      expect((await post(rebasePath, { revision: 1, previewToken: reviewed.json().previewToken })).statusCode).toBe(409)

      const refreshedAt = '2026-11-26T03:00:00Z'
      await writeFile(path, JSON.stringify({ ...dataset, capturedAt: refreshedAt, quotes: [...dataset.quotes,
        { ...dataset.quotes[2], price: '0.8', retrievedAt: refreshedAt }] }))
      const refreshApp = await buildApp({ database, config: { ...testConfig(), demoDataset: { path, cacheMs: 10_000, allowFixture: true } } })
      openApps.push(refreshApp)
      const refresh = await refreshApp.inject({ method: 'POST', url: '/v1/demo/refresh', headers, payload: { portfolioId, revision } })
      expect(refresh.statusCode, refresh.body).toBe(200)
      expect(refresh.json().revision).not.toBe(revision)
      expect(refresh.json().catalogRevision).toBe(revision)
      const updated = (await get('/accounting?view=detail&asOf=' + refreshedAt)).json()
      expect(cashByAsset(updated.cash, 'USD')).toMatchObject({ balance: '97.2', portfolioValue: '106.8' })
      await performance(refreshedAt, '6.8', '0.068')
      expect(updated.holdings).toContainEqual(expect.objectContaining({ quantity: '12', basis: '5.8' }))
      const oldOwner = await other.inject({ method: 'GET', url: '/v1/portfolios/' + otherId + '/accounting?view=detail&asOf=' + capturedAt, headers })
      expect(cashByAsset(oldOwner.json().cash, 'USD').portfolioValue).toBe('105')
      const lifecycleRefresh = async (lifecycle: 'open' | 'closed' | 'resolved', time: string, currentRevision: string,
        winningInstrument: string | null = 'SAMPLE-OPEN:yes', conflict = false) => {
        const resolution = lifecycle === 'resolved' && winningInstrument ? {
          knownAt: '2026-11-26T04:30:00Z', winningInstrument, unitPayout: '1',
        } : undefined
        await writeFile(path, JSON.stringify({ ...dataset, capturedAt: time, markets: dataset.markets.map((row, index) =>
          index === 0 ? { ...row, lifecycle, retrievedAt: time, resolvesAt: '2026-11-26T04:30:00Z',
            tradingClosesAt: '2026-11-26T04:00:00Z', ...(resolution ? { resolution } : {}) } : row) }))
        const server = await buildApp({ database, config: { ...testConfig(), demoDataset: { path, cacheMs: 10_000, allowFixture: true } } })
        openApps.push(server)
        const apply = (revision: string) => server.inject({ method: 'POST', url: '/v1/demo/refresh', headers, payload: { portfolioId, revision } })
        const result = await apply(currentRevision)
        if (conflict) {
          expect(result.statusCode, result.body).toBe(409)
          expect(result.json()).toMatchObject({ error: { code: 'demo_resolution_conflict' } })
          return currentRevision
        }
        expect(result.statusCode, result.body).toBe(200)
        expect(result.json().markets[0].latestRetrievedAt).toBe(new Date(time).toISOString())
        expect(result.json().markets[0].lifecycle).toBe(lifecycle)
        expect((await apply(result.json().revision)).json().revision).toBe(result.json().revision)
        return result.json().revision
      }
      const metadataOnly = await lifecycleRefresh('open', '2026-11-26T03:15:00Z', refresh.json().revision)
      const observedAgain = await lifecycleRefresh('open', '2026-11-26T03:25:00Z', metadataOnly)
      const [stored] = await database.select({ demo: portfolios.demo }).from(portfolios).where(eq(portfolios.id, portfolioId))
      expect(stored?.demo?.priorMarkets).toHaveLength(1)
      expect(stored?.demo?.dataset.markets[0]).toMatchObject({ retrievedAt: '2026-11-26T03:15:00.000Z',
        tradingClosesAt: '2026-11-26T04:00:00.000Z' })
      const afterClose = await lifecycleRefresh('closed', '2026-11-26T04:00:00Z', observedAgain)
      const cashAt = async (asOf: string) => cashByAsset((await get('/accounting?view=detail&asOf=' + asOf)).json().cash, 'USD')
      expect((await cashAt('2026-11-26T04:20:00Z')).balance).toBe('97.2')
      const unverifiedAt = '2026-11-26T04:45:00Z'
      const unverified = await lifecycleRefresh('resolved', unverifiedAt, afterClose, null)
      expect(await cashAt(unverifiedAt)).toMatchObject({ historyCoverage: 'declared_with_unresolved_evidence', balance: null })
      const unverifiedQuery = new URLSearchParams({ from: start, asOf: unverifiedAt, asset: 'USD', accounts: cashByAsset(first.cash, 'USD').account })
      expect((await get('/analytics/performance?' + unverifiedQuery)).json()).toMatchObject({ returns: { twr: { value: null } } })
      const afterResolution = await lifecycleRefresh('resolved', '2026-11-26T05:00:00Z', unverified)
      await lifecycleRefresh('resolved', '2026-11-26T05:10:00Z', afterResolution, 'SAMPLE-OPEN:no', true)
      expect(await cashAt('2026-11-26T05:00:00Z')).toMatchObject({ balance: '109.2', knownRealized: '9.2', historyCoverage: 'simulated_ledger_complete' })
      expect(await cashAt('2026-11-26T05:05:00Z')).toMatchObject({ historyCoverage: 'outside_declared_interval' })
      await performance('2026-11-26T05:00:00Z', '9.2', '0.092')
      const correct = async (action: string, quantity?: string) => {
        const changes = { changes: [{ key: fill.key, action, ...(quantity ? { correction: { quantity } } : {}) }] }
        const update = await post('/accounting/adjustments/preview', changes)
        expect(update.statusCode, update.body).toBe(200)
        expect((await post('/accounting/adjustments/confirm', { ...changes, revision: update.json().revision })).statusCode).toBe(200)
      }
      await correct('correct', '20')
      expect(await cashAt('2026-11-26T05:00:00Z')).toMatchObject({ balance: '114', knownRealized: '14' })
      await performance('2026-11-26T05:00:00Z', '14', '0.14')
      await correct('correct', '10')
      expect(await cashAt('2026-11-26T05:00:00Z')).toMatchObject({ balance: '108', knownRealized: '8' })
      await correct('exclude')
      expect((await cashAt('2026-11-26T05:00:00Z')).balance).toBe('103')
      await performance('2026-11-26T05:00:00Z', '3', '0.03')
      await correct('restore')
      expect((await cashAt('2026-11-26T05:00:00Z')).balance).toBe('108')
      expect((await get('/scenarios/denomination-scenarios/' + saved.json().id)).json().result.indicativeUsd.value).toBe('156.525')
      const clean = await demo(refreshApp, 'POST', { resetFromPortfolioId: portfolioId })
      expect(clean.json()).toMatchObject({ status: 'available' })
      expect(clean.json().portfolioId).not.toBe(portfolioId)
      expect((await demo(refreshApp, 'POST', { resetFromPortfolioId: portfolioId })).statusCode).toBe(409)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires only reporting rates for the native buckets present', async () => {
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const asOf = '2026-11-26T02:00:00Z'
    for (const [assets, rate, value] of [
      [['USD'], '', '100'], [['USD', 'USDC'], '&assumedUsdPerUsdc=0.98', '198'],
      [['USD', 'PUSD'], '&assumedUsdPerPusd=0.97', '197'],
      [['USD', 'USDC', 'PUSD'], '&assumedUsdPerPusd=0.97', null],
      [['USD', 'USDC', 'PUSD'], '&assumedUsdPerPusd=0.97&assumedUsdPerUsdc=0.98', '295'],
    ] as const) {
      const portfolio = await app.inject({ method: 'POST', url: '/v1/portfolios', headers, payload: { name: assets.join(' ') } })
      const base = '/v1/portfolios/' + portfolio.json().id
      const csv = ['venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset',
        ...assets.flatMap((asset) => [
          `independent,local,open-${asset},${asOf},,opening_cash,,${asset},,,100,,`,
          `independent,local,inventory-${asset},${asOf},,opening_inventory,,${asset},,,,,`,
        ])].join('\n')
      const preview = await app.inject({ method: 'POST', url: base + '/imports/preview', headers, payload: { csv } })
      expect(preview.statusCode, preview.body).toBe(200)
      const { batchId, reviewRevision } = preview.json()
      const confirmed = await app.inject({ method: 'POST', url: base + '/imports/' + batchId + '/confirm?reviewRevision=' + reviewRevision, headers })
      expect(confirmed.statusCode, confirmed.body).toBe(200)
      const result = (await app.inject({ method: 'GET', url: base + '/analytics/denominations?asOf=' + asOf + rate, headers })).json()
      expect(result.indicativeUsd?.value ?? null).toBe(value)
      expect(result.conversionAvailability).toBe(value === null ? 'assumption_required' : 'indicative')
    }
  })

  it('binds development Kalshi credentials and values signed inventory with a qualified book mark', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scevia-kalshi-'))
    try {
      const keyFile = join(directory, 'signer.pem')
      const { privateKey } = generateKeyPairSync('ed25519')
      const pem = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }))
      await writeFile(keyFile, pem, { mode: 0o600 })
      const externalId = kalshiCredentialSourceId('demo', 'test-key', pem)
      let quantity: string | null = '-2.5'
      let revision = new Date(Date.now() - 5000).toISOString()
      let interrupted = false
      let failedDepositState = 'pending'
      let settledAt = '2026-11-22T01:00:00Z'
      const [account, other] = await database.insert(providerAccounts).values([
        { portfolioId: PORTFOLIO_ID, providerCode: 'kalshi', externalAccountId: externalId, kind: 'authenticated_account', label: 'Authorized source' },
        { portfolioId: OTHER_PORTFOLIO_ID, providerCode: 'kalshi', externalAccountId: externalId, kind: 'authenticated_account', label: 'Other tenant' },
      ]).returning()
      const calls: string[] = []
      const app = await buildApp({ database, config: { ...testConfig(), nodeEnv: 'development',
        kalshi: { environment: 'demo', publicAuthorized: true, accountAuthorized: true,
          binding: { accountId: account!.id, portfolioId: PORTFOLIO_ID, keyId: 'test-key', keyFile } } },
        kalshiTransport: async (url, init) => {
          const path = url.pathname.replace('/trade-api/v2', '')
          calls.push(path)
          expect(url.origin).toBe('https://external-api.demo.kalshi.co')
          const signed = new Headers(init.headers).has('kalshi-access-key')
          if (path === '/api_keys') {
            expect(signed).toBe(true)
            return Response.json({ api_keys: [{ api_key_id: 'test-key', scopes: ['read'], subaccount: 0 }] })
          }
          if (path === '/portfolio/balance') {
            expect(signed).toBe(true)
            expect(url.searchParams.get('exchange_index')).toBe('0')
            return Response.json({ balance: 1050, updated_ts: Math.floor(Date.now() / 1000) })
          }
          if (path === '/portfolio/positions') {
            expect(signed).toBe(true)
            if (url.searchParams.has('cursor')) return Response.json({}, { status: 400 })
            return Response.json({ market_positions: quantity === null ? [] : [{ ticker: 'KX-BOOK', exchange_index: 0, position_fp: quantity,
              market_exposure_dollars: '1.25', last_updated_ts: revision }], cursor: interrupted ? 'second' : '' })
          }
          if (path === '/markets/KX-BOOK') {
            expect(signed).toBe(false)
            return Response.json({ market: { ticker: 'KX-BOOK', event_ticker: 'KX-EVENT', title: 'Book example',
              market_type: 'binary', status: 'active', notional_value_dollars: '1', yes_bid_dollars: '0.30',
              yes_ask_dollars: '0.50', yes_bid_size_fp: '10', yes_ask_size_fp: '10' } })
          }
          if (path === '/historical/cutoff') return Response.json({ trades_created_ts: '2026-01-01T00:00:00Z',
            market_settled_ts: '2026-01-01T00:00:00Z' })
          if (path === '/portfolio/fills') {
            const base = { exchange_index: 0, subaccount_number: 0, side: 'yes',
              market_ticker: 'KX-RESOLVED', action: 'buy', outcome_side: 'yes', book_side: 'bid',
              yes_price_dollars: '0.40', no_price_dollars: '0.60', fee_cost: '1' }
            return Response.json({ fills: [
              { ...base, fill_id: 'verified-buy', count_fp: '100', created_time: '2026-11-21T01:00:00Z' },
              { ...base, fill_id: 'fractional-buy', market_ticker: 'KX-FRACTION', count_fp: '2.5',
                fee_cost: '0.10', created_time: '2026-11-23T01:00:00Z' },
              { ...base, fill_id: 'fractional-sale', market_ticker: 'KX-FRACTION', count_fp: '1', action: 'sell',
                book_side: 'ask', outcome_side: 'no', yes_price_dollars: '0.60', no_price_dollars: '0.40',
                fee_cost: '0.02', created_time: '2026-11-24T01:00:00Z' },
            ] })
          }
          if (path === '/historical/fills') return Response.json({ fills: [] })
          if (path === '/markets') return Response.json({ markets: [] })
          if (path === '/markets/KX-RESOLVED' || path === '/markets/KX-FRACTION') return Response.json({ market: {
            ticker: path.split('/').at(-1), event_ticker: 'KX-RESULT', title: 'Resolved example', market_type: 'binary',
            status: 'finalized', result: 'yes', notional_value_dollars: '1', settlement_value_dollars: '1',
          } })
          if (path === '/portfolio/settlements') {
            const base = { exchange_index: 0, market_result: 'yes', no_count_fp: '0', fee_cost: '1' }
            return Response.json({ settlements: [
              { ...base, ticker: 'KX-RESOLVED', yes_count_fp: '100', revenue: 10000, settled_time: settledAt },
              { ...base, ticker: 'KX-FRACTION', yes_count_fp: '1.5', revenue: 150, settled_time: '2026-11-25T01:00:00Z' },
            ] })
          }
          if (path === '/portfolio/deposits') return Response.json({ deposits: [
            { id: 'approved', status: 'applied', type: 'ach', amount_cents: 10000, fee_cents: 0, created_ts: 1795132800, finalized_ts: 1795132900 },
            { id: 'failed', status: failedDepositState, type: 'ach', amount_cents: 50000, fee_cents: 0,
              created_ts: 1795132800, finalized_ts: failedDepositState === 'failed' ? 1795132900 : null },
          ] })
          if (path === '/portfolio/withdrawals') return Response.json({ withdrawals: [] })
          if (path === '/portfolio/credit_history') return Response.json({ credits: [{ credit_id: 'unlinked-credit',
            amount_dollars: '100', type: 'credit', status: 'applied', created_time: '2026-11-22T01:00:00Z' }] })
          if (path === '/historical/positions') return Response.json({ market_positions: [] })
          throw new Error('Unexpected Kalshi path')
        } })
      openApps.push(app)
      const headers = { authorization: `Bearer ${TOKEN}` }
      let requestAddress = 1
      const sync = (id: string, scope = 'current') => app.inject({ method: 'POST', url: '/v1/provider-accounts/' + id + '/sync?scope=' + scope,
        headers, remoteAddress: '127.0.0.' + requestAddress++ })
      expect((await sync(other!.id)).statusCode).toBe(404)
      expect(calls).toEqual([])
      const response = await sync(account!.id)
      expect(response.statusCode, response.body).toBe(200)
      expect(calls).toEqual(['/api_keys', '/portfolio/balance', '/portfolio/positions', '/markets/KX-BOOK'])
      expect(await database.select().from(positionSnapshots).where(eq(positionSnapshots.providerAccountId, account!.id)))
        .toEqual(expect.arrayContaining([expect.objectContaining({ quantity: '2.500000000000000000', averageCostPrice: '0.500000000000000000', markPrice: '0.600000000000000000' })]))
      expect(await database.select().from(priceObservations).where(eq(priceObservations.providerAccountId, account!.id)))
        .toMatchObject([{ price: '0.600000000000000000', priceKind: 'kalshi_retrieved_book_midpoint' }])
      const exposure = await app.inject({ method: 'GET', url: '/v1/portfolios/' + PORTFOLIO_ID + '/analytics/exposure?asset=USD&venue=kalshi&asOf=' + encodeURIComponent(new Date().toISOString()), headers })
      expect(exposure.statusCode, exposure.body).toBe(200)
      expect(exposure.json().reportedExposure).toMatchObject({ knownCashSubtotal: '10.5', knownPositionSubtotal: '1.5',
        knownCombinedSubtotal: '12', portfolioNav: null, eventAllocation: { denominator: '1.5' } })
      expect(exposure.json().reportedExposure.rows).toEqual(expect.arrayContaining([expect.objectContaining({ observedMarketValue: '1.5', providerCoverage: 'partial' })]))
      const scenarios = '/v1/portfolios/' + PORTFOLIO_ID + '/scenarios'
      const preview = await app.inject({ method: 'POST', url: scenarios + '/baseline', headers,
        payload: { mode: 'actual', accounts: [account!.id], venue: 'kalshi', asset: 'USD', asOf: new Date().toISOString(),
          useReportedKalshiSnapshot: true } })
      expect(preview.statusCode, preview.body).toBe(200)
      const baseline = preview.json()
      expect(baseline.buckets).toMatchObject([{ cash: '10.5', inventoryComplete: false, cashObservation: { sourceRecordId: expect.any(String) } }])
      expect(baseline.holdings).toMatchObject([{ quantity: '2.5', basis: null, quantityObservation: { sourceRecordId: expect.any(String) } }])
      const evaluation = await app.inject({ method: 'POST', url: scenarios + '/evaluate', headers, payload: {
        baselineToken: baseline.baselineToken, input: { operations: [{ bucket: baseline.buckets[0].id,
          instrument: baseline.holdings[0].instrument, kind: 'sell', amount: '1', price: '0.6', fee: { mode: 'excluded' } }] },
      } })
      expect(evaluation.statusCode, evaluation.body).toBe(200)
      expect(evaluation.json()).toMatchObject({ status: 'partial', funding: [{ endingCash: '11.1' }],
        availability: { quantities: 'partial', basis: 'partial', valuation: 'partial' },
        positions: [{ quantity: '1.5', value: '0.9' }], bridge: { endingValue: null } })
      expect(await database.select().from(fills).where(eq(fills.providerAccountId, account!.id))).toEqual([])
      const currentLegs = async () => {
        const data = await database.select({ id: positionSnapshots.externalId, quantity: positionSnapshots.quantity }).from(positionSnapshots)
          .where(and(eq(positionSnapshots.providerAccountId, account!.id), eq(positionSnapshots.isCurrent, true)))
        return Object.fromEntries(data.map((row) => [row.id.split(':').at(-1), Number(row.quantity)]))
      }
      expect(await currentLegs()).toEqual({ yes: 0, no: 2.5 })
      const held = (await database.select().from(positionSnapshots).where(eq(positionSnapshots.providerAccountId, account!.id)))
        .find((row) => Number(row.quantity) === 2.5)!
      const mark = new Date(Date.now() + 1000)
      await database.insert(sharedMarketObservations).values({ instrumentId: held.instrumentId, asset: 'USD', method: 'book_midpoint',
        price: '0.8', effectiveAt: mark, retrievedAt: mark, source: 'kalshi_book', revision: 'shared-reported' })
      const repriced = await app.inject({ method: 'GET',
        url: '/v1/portfolios/' + PORTFOLIO_ID + '/analytics/exposure?asset=USD&venue=kalshi&asOf=' + encodeURIComponent(mark.toISOString()), headers })
      expect(repriced.json().reportedExposure).toMatchObject({ knownPositionSubtotal: '2', portfolioNav: null })

      const prior = revision
      revision = new Date(Date.parse(revision) + 1000).toISOString()
      quantity = '3'
      interrupted = true
      expect((await sync(account!.id)).json().status).toBe('partial')
      expect(await currentLegs()).toEqual({ yes: 0, no: 2.5 })
      interrupted = false
      expect((await sync(account!.id)).statusCode).toBe(200)
      expect(await currentLegs()).toEqual({ yes: 3, no: 0 })
      quantity = '-4'
      const latest = revision
      revision = prior
      await sync(account!.id)
      expect(await currentLegs()).toEqual({ yes: 3, no: 0 })
      revision = new Date(Date.parse(latest) + 1000).toISOString()
      await sync(account!.id)
      expect(await currentLegs()).toEqual({ yes: 0, no: 4 })
      quantity = null
      await sync(account!.id)
      expect(await currentLegs()).toEqual({ yes: 0, no: 4 })
      quantity = '0'
      revision = new Date(Date.parse(revision) + 1000).toISOString()
      await sync(account!.id)
      expect(await currentLegs()).toEqual({ yes: 0, no: 0 })
      expect((await sync(account!.id, 'history')).statusCode).toBe(200)
      const root = '/v1/portfolios/' + PORTFOLIO_ID
      const listed = await app.inject({ method: 'GET', url: root + '/accounting/records?account=' + account!.id, headers })
      const candidate = listed.json().items.find((row: { originalReason: string }) => row.originalReason === 'kalshi_final_cash_requires_account_attribution')
      expect(candidate).toBeDefined()
      const change = { changes: [{ key: candidate.key, action: 'include' }] }
      const cashPreview = await app.inject({ method: 'POST', url: root + '/accounting/adjustments/preview', headers, payload: change })
      expect(cashPreview.statusCode, cashPreview.body).toBe(200)
      const confirm = await app.inject({ method: 'POST', url: root + '/accounting/adjustments/confirm', headers,
        payload: { ...change, revision: cashPreview.json().revision } })
      expect(confirm.statusCode, confirm.body).toBe(200)
      const snapshot = (asOf?: string) => app.inject({ method: 'GET', url: root + '/accounting?view=detail'
        + (asOf ? '&asOf=' + encodeURIComponent(asOf) : ''), headers })
      const accounting = await snapshot('2026-11-22T02:00:00Z')
      expect(accounting.statusCode, accounting.body).toBe(200)
      expect(accounting.json().cash).toEqual(expect.arrayContaining([expect.objectContaining({ account: account!.id,
        knownDelta: '159', knownRealized: '59' })]))
      expect(accounting.json().holdings).toEqual(expect.arrayContaining([expect.objectContaining({ account: account!.id, quantity: '0', pending: '0' })]))
      const afterSale = await snapshot('2026-11-24T02:00:00Z')
      expect(afterSale.json().holdings).toEqual(expect.arrayContaining([expect.objectContaining({ account: account!.id,
        quantity: '1.5', basis: '0.66' })]))
      expect(afterSale.json().cash).toEqual(expect.arrayContaining([expect.objectContaining({ knownDelta: '158.48', knownRealized: '59.14' })]))
      failedDepositState = 'failed'
      expect((await sync(account!.id, 'history')).statusCode).toBe(200)
      const afterPayout = await snapshot()
      expect(afterPayout.json().cash).toEqual(expect.arrayContaining([expect.objectContaining({ knownDelta: '159.98', knownRealized: '59.98' })]))
      settledAt = '2026-11-22T02:00:00Z'
      await sync(account!.id, 'history')
      const conflict = await database.select().from(providerActivityFacts).where(and(eq(providerActivityFacts.providerAccountId, account!.id),
        eq(providerActivityFacts.activityType, 'KALSHI_SETTLEMENT_TIME_CONFLICT')))
      expect(conflict).toHaveLength(2)
      expect((await snapshot()).json().cash).toEqual(expect.arrayContaining([expect.objectContaining({ knownDelta: '159.98' })]))

      const beforeReplacement = calls.length
      const replacement = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
      await writeFile(keyFile, replacement, { mode: 0o600 })
      const refused = await sync(account!.id)
      expect(refused.statusCode).toBe(422)
      expect(refused.json().error.code).toBe('kalshi_credential_source_mismatch')
      expect(calls).toHaveLength(beforeReplacement)

    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reconciles Kalshi fixture fills and Polymarket imports in separate denominations', async () => {
    const nativeMarket = { ticker: 'KX-FIXTURE', event_ticker: 'KX-EVENT', title: 'Synthetic fixture?', market_type: 'binary',
      status: 'active', last_price_dollars: '0.4', notional_value_dollars: '1' }
    const fill = { fill_id: 'fixture-fill', market_ticker: nativeMarket.ticker, action: 'buy', side: 'no', outcome_side: 'no',
      count_fp: '2.5', yes_price_dollars: '0.6', no_price_dollars: '0.4', fee_cost: '0.1', created_time: '2026-11-25T01:00:00Z' }
    let emptyPositions = false
    let interruptPositions = false
    const seen: string[] = []
    const client = new KalshiClient(async (url, request) => {
      expect(request.method).toBe('GET')
      seen.push(url.pathname)
      const path = url.pathname.replace('/trade-api/v2', '')
      if (path === '/markets') return Response.json({ markets: [nativeMarket], cursor: '' })
      if (path === '/markets/KX-FIXTURE') return Response.json({ market: nativeMarket })
      if (path === '/portfolio/fills' || path === '/historical/fills') return Response.json({ fills: [fill], cursor: '' })
      if (path === '/historical/positions') return Response.json({ market_positions: [{ ticker: nativeMarket.ticker,
        position_fp: '0', market_exposure_dollars: '0', last_updated_ts: '2026-11-20T00:00:00Z' }], cursor: '' })
      if (path === '/portfolio/positions' && interruptPositions && url.searchParams.get('settlement_status') === 'unsettled') {
        return url.searchParams.has('cursor') ? Response.json({}, { status: 400 }) : Response.json({ market_positions: [], cursor: 'next-position' })
      }
      if (path === '/portfolio/positions') return Response.json({ market_positions: emptyPositions || url.searchParams.get('settlement_status') === 'settled' ? [] :
        [{ ticker: nativeMarket.ticker, position_fp: '-2.5', market_exposure_dollars: '1' }], cursor: '' })
      if (path === '/portfolio/balance') return Response.json({ balance: 9890, updated_ts: 1795568400 })
      if (path === '/portfolio/settlements') return Response.json({ settlements: [], cursor: '' })
      if (path === '/portfolio/deposits') return Response.json({ deposits: [{ id: 'pending-cash', status: 'pending', type: 'ach',
        amount_cents: 250, fee_cents: 0, created_ts: 1795568400 }], cursor: '' })
      if (path === '/portfolio/withdrawals') return Response.json({ withdrawals: [], cursor: '' })
      if (path === '/portfolio/credit_history') return Response.json({ credits: [], cursor: '' })
      throw new Error('Unexpected fixture endpoint')
    })
    const app = await buildApp({ config: testConfig(), database, registry: new ProviderRegistry([new KalshiAdapter(() => client)]),
      kalshiMarketData: new KalshiMarketDataService(client) })
    openApps.push(app)
    const headers = { authorization: `Bearer ${TOKEN}` }
    const fresh = await app.inject({ method: 'POST', url: '/v1/portfolios', headers, payload: { name: 'Two denominations' } })
    const portfolioId = fresh.json().id
    expect(fresh.statusCode).toBe(201)
    const [account] = await database.insert(providerAccounts).values({ portfolioId, providerCode: 'kalshi', externalAccountId: 'kalshi-fixture',
      label: 'Kalshi fixture', kind: 'fixture' }).returning()
    const prefix = '/v1/portfolios/' + portfolioId
    const sync = () => app.inject({ method: 'POST', url: '/v1/provider-accounts/' + account!.id + '/sync', headers })
    const first = await sync()
    expect(first.statusCode, first.body).toBe(200)
    expect(seen).toContain('/trade-api/v2/historical/fills')
    expect(seen).toContain('/trade-api/v2/historical/positions')
    expect(await database.select().from(providerActivityFacts).where(eq(providerActivityFacts.providerAccountId, account!.id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ activityType: 'HISTORICAL_POSITION' }),
        expect.objectContaining({ activityType: 'CASH_STATUS_OBSERVATION', amount: '2.500000000000000000' })]))
    expect(await database.select().from(fills).where(eq(fills.providerAccountId, account!.id))).toHaveLength(1)
    const current = await app.inject({ method: 'GET', url: prefix + '/positions', headers })
    expect(current.json().items).toMatchObject([{ quantity: '2.500000000000000000' }])
    interruptPositions = true
    const interrupted = await sync()
    expect(interrupted.json().status).toBe('partial')
    expect((await app.inject({ method: 'GET', url: prefix + '/positions', headers })).json().items).toMatchObject([{ quantity: '2.500000000000000000' }])
    interruptPositions = false
    emptyPositions = true
    expect((await sync()).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: prefix + '/positions', headers })).json().items).toEqual([])
    expect(await database.select().from(positionSnapshots).where(and(eq(positionSnapshots.providerAccountId, account!.id),
      eq(positionSnapshots.isCurrent, true)))).toEqual([])
    const catalog = await app.inject({ method: 'POST', url: '/v1/market-catalog/kalshi/resolve', payload: { url: 'https://kalshi.com/events/KX-EVENT' } })
    expect(catalog.json()).toMatchObject({ items: [{ eventTicker: 'KX-EVENT', outcomes: [{ side: 'yes' }, { side: 'no' }] }] })
    const [no] = await database.select().from(instruments).where(eq(instruments.externalId, 'KX-FIXTURE:no'))
    const [observedFill] = await database.select().from(fills).where(eq(fills.providerAccountId, account!.id))
    const mappedImport = await app.inject({ method: 'POST', url: prefix + '/imports/preview', headers, payload: {
      csv: 'id,time,market,side,action,lots,price,fee\nfixture-fill,2026-11-25T01:00:00Z,KX-FIXTURE,no,buy,2.5,0.4,0.1',
      providerAccountId: account!.id, sourceLinks: { 'fixture-fill': observedFill!.sourceRecordId },
      kalshiMapping: { format: 'kalshi_activity', account: 'mapped', activity: 'fill', units: 'dollars',
        columns: { id: 'id', timestamp: 'time', ticker: 'market', side: 'side', action: 'action', quantity: 'lots', price: 'price', fee: 'fee' } },
    } })
    expect(mappedImport.statusCode, mappedImport.body).toBe(200)
    expect(mappedImport.json()).toMatchObject({ rows: [{ id: 'fixture-fill', instrument: no!.id }] })
    const markAt = new Date().toISOString()
    const csv = [
      'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset,canonical_instrument_id',
      `kalshi,${account!.id},opening,2026-11-24T00:00:00Z,,opening_cash,,USD,,,100,,,`,
      `kalshi,${account!.id},inventory,2026-11-24T00:00:00Z,,opening_inventory,,USD,,,,,,`,
      `kalshi,${account!.id},mark,${markAt},,mark,${no!.id},USD,,0.6,,,,${no!.id}`,
      'polymarket,independent,opening,2026-11-24T00:00:00Z,,opening_cash,,USDC,,,50,,,',
      'polymarket,independent,inventory,2026-11-24T00:00:00Z,,opening_inventory,,USDC,,,,,,',
    ].join('\n')
    const preview = await app.inject({ method: 'POST', url: prefix + '/imports/preview', headers, payload: { csv } })
    expect(preview.statusCode, preview.body).toBe(200)
    const review = preview.json()
    const confirmed = await app.inject({ method: 'POST', url: prefix + '/imports/' + review.batchId + '/confirm?reviewRevision=' + review.reviewRevision, headers })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const asOf = new Date(Date.now() + 1000).toISOString()
    const denominations = prefix + '/analytics/denominations?asOf=' + encodeURIComponent(asOf)
    const native = await app.inject({ method: 'GET', url: denominations, headers })
    expect(native.json()).toMatchObject({ groups: [{ asset: 'USD', value: '100.4' }, { asset: 'USDC', value: '50' }], indicativeUsd: null })
    const reporting = await app.inject({ method: 'GET', url: denominations + '&assumedUsdPerUsdc=0.98', headers })
    expect(reporting.json().indicativeUsd).toMatchObject({ value: '149.4', methodology: 'user_assumed_rate', fundsTransferable: false })
    const risk = await app.inject({ method: 'GET', url: prefix + '/analytics/exposure?asset=USD&venue=kalshi&asOf=' + encodeURIComponent(asOf), headers })
    expect(risk.json()).toMatchObject({ exposure: { instruments: [{ quantity: '2.5', basis: '1.1' }] },
      settlement: { result: { status: 'unavailable' } } })
    const scenario = await app.inject({ method: 'POST', url: prefix + '/scenarios/evaluate', headers, payload: {
      source: { mode: 'actual', accounts: [account!.id], venue: 'kalshi', asOf, asset: 'USD' },
      input: { operations: [{ bucket: JSON.stringify(['kalshi', account!.id]), instrument: no!.id, kind: 'sell', amount: '1',
        price: '0.6', fee: { mode: 'excluded' } }] },
    } })
    expect(scenario.statusCode, scenario.body).toBe(200)
    expect(scenario.json()).toMatchObject({ hypotheticalRealized: '0.16', bridge: { startingValue: '100.4', endingValue: '100.4' } })
    const publicScenario = await app.inject({ method: 'POST', url: prefix + '/scenarios/evaluate', headers, payload: {
      source: { mode: 'scratch', asset: 'USD', asOf, buckets: [{ id: 'usd', account: 'scratch', venue: 'kalshi', cash: '10' }],
        publicOutcomes: [{ url: 'https://kalshi.com/markets/KX-FIXTURE', assetId: 'KX-FIXTURE:no',
          assetIdType: 'kalshi_outcome', captureCurrentQuote: true }] },
      input: { operations: [{ bucket: 'usd', instrument: 'kalshi:KX-FIXTURE:no', kind: 'buy', amount: '1', price: '0.6', fee: { mode: 'excluded' } }] },
    } })
    expect(publicScenario.statusCode, publicScenario.body).toBe(200)
    expect(publicScenario.json()).toMatchObject({ positions: [{ instrument: no!.id, value: '0.6' }], bridge: { endingValue: '10' } })
  })

  it('returns authorized performance and reviewed settlement risk from persisted accounting evidence', async () => {
    await new IngestionService(database, providerRegistry).syncProviderAccount(SNAPSHOT_ACCOUNT_ROW_ID)
    const legs = await database.select({ id: instruments.id, external: instruments.externalId, market: instruments.marketId })
      .from(instruments)
    const yes = legs.find((row) => row.external === 'leg-river-yes')!
    const no = legs.find((row) => row.external === 'leg-river-no')!
    await database.insert(reviewedBinaryRules).values({ marketId: yes.market, yesInstrumentId: yes.id, noInstrumentId: no.id,
      assetCode: 'USDC', evidence: 'Reviewed deterministic fixture binary rules', reviewedAt: new Date('2026-11-01T00:00:00Z') })
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const prefix = `/v1/portfolios/${PORTFOLIO_ID}`
    const csv = [
      'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset,coverage_through,canonical_instrument_id',
      'isolated,performance,cash,2026-11-01T00:00:00Z,,opening_cash,,USD,,,1000,,,,',
      'isolated,performance,inventory,2026-11-01T00:00:00Z,,opening_inventory,,USD,,,,,,,',
      'isolated,performance,history,2026-11-01T00:00:00Z,,history_complete,,USD,,,,,,2026-11-09T00:00:00Z,',
      'isolated,performance,growth1,2026-11-02T00:00:00Z,,reward,,USD,,,100,,,,',
      'isolated,performance,deposit,2026-11-03T00:00:00Z,,deposit,,USD,,,1000,,,,',
      'isolated,performance,growth2,2026-11-04T00:00:00Z,,reward,,USD,,,105,,,,',
      'isolated,risk,cash,2026-11-01T00:00:00Z,,opening_cash,,USDC,,,0,,,,',
      'isolated,risk,inventory,2026-11-01T00:00:00Z,,opening_inventory,,USDC,,,,,,,',
      `isolated,risk,open-y,2026-11-01T00:00:00Z,,opening_position,${yes.id},USDC,100,,60,,,,${yes.id}`,
      `isolated,risk,open-n,2026-11-01T00:00:00Z,,opening_position,${no.id},USDC,80,,32,,,,${no.id}`,
      `isolated,risk,mark-y,2026-11-04T00:00:00Z,,mark,${yes.id},USDC,,0.6,,,,,${yes.id}`,
      `isolated,risk,mark-n,2026-11-04T00:00:00Z,,mark,${no.id},USDC,,0.4,,,,,${no.id}`,
      'second-venue,risk,other-cash,2026-11-01T00:00:00Z,,opening_cash,,USD,,,100,,,,',
      `isolated,unmapped,local-holding,2026-11-01T00:00:00Z,,opening_position,${yes.id},USDC,100,,60,,,,`,
      `isolated,unmapped,local-mark,2026-11-04T00:00:00Z,,mark,${yes.id},USDC,,0.6,,,,,`,
    ].join('\n')
    const preview = await app.inject({ method: 'POST', url: prefix + '/imports/preview', headers, payload: { csv } })
    expect(preview.statusCode, preview.body).toBe(200)
    const review = preview.json()
    const confirm = await app.inject({ method: 'POST', url: prefix + '/imports/' + review.batchId + '/confirm?reviewRevision=' + review.reviewRevision, headers })
    expect(confirm.statusCode, confirm.body).toBe(200)
    const from = '2026-11-01T00:00:00Z'
    const asOf = '2026-11-04T00:00:00Z'
    const perfQuery = new URLSearchParams({ asset: 'USD', from, asOf, accounts: 'performance' })
    const perf = await app.inject({ method: 'GET', url: prefix + '/analytics/performance?' + perfQuery, headers })
    expect(perf.statusCode, perf.body).toBe(200)
    expect(perf.json()).toMatchObject({ returns: { twr: { value: '0.155' } }, bridge: { netInvestmentGain: { value: '205' } } })
    const riskQuery = new URLSearchParams({ asset: 'USDC', asOf, accounts: 'risk', venue: 'isolated' })
    const risk = await app.inject({ method: 'GET', url: prefix + '/analytics/exposure?' + riskQuery, headers })
    expect(risk.statusCode, risk.body).toBe(200)
    expect(risk.json().settlement.result).toMatchObject({ reference: '92', worst: { payout: '80' }, best: { payout: '100' } })
    expect(risk.json().settlement.result).toMatchObject({ status: 'exact', basis: 'mathematical_model',
      best: { contributions: expect.arrayContaining([{ market: yes.market, venue: 'isolated', account: 'risk',
        instrument: yes.id, payout: '100', changeFromReference: '40' }]) },
      events: [{ outcomes: [{ jointlyFeasible: true }, { jointlyFeasible: true }] }] })
    const combined = new URLSearchParams({ asset: 'USDC', asOf, accounts: 'risk' })
    const combinedRisk = await app.inject({ method: 'GET', url: prefix + '/analytics/exposure?' + combined, headers })
    const combinedPerf = await app.inject({ method: 'GET', url: prefix + '/analytics/performance?' + combined + '&from=' + encodeURIComponent(from), headers })
    expect(combinedRisk.statusCode, combinedRisk.body).toBe(200)
    expect(combinedPerf.statusCode, combinedPerf.body).toBe(200)
    expect(combinedPerf.json().ending.value).toBeNull()
    expect(combinedRisk.json()).toMatchObject({ allocationBases: { cashInclusive: { denominator: null, availability: 'unavailable' } },
      settlement: { cashInclusive: null } })
    expect(combinedRisk.json().allocationBases.cashInclusive.rows).toContainEqual({ id: 'cash', kind: 'cash', value: '0', weight: null })

    const local = await app.inject({ method: 'GET', url: prefix + '/analytics/exposure?' +
      new URLSearchParams({ asset: 'USDC', asOf, accounts: 'unmapped' }), headers })
    expect(local.statusCode, local.body).toBe(200)
    expect(local.json()).toMatchObject({ exposure: { instruments: [{ instrument: yes.id, market: null, event: null }] },
      allocation: { byInstrument: { denominator: '60' }, byMarket: { denominator: null },
        byEvent: { denominator: null, concentration: null, mappingCoverage: { unmappedKnownValue: '60', unmappedHoldings: 1 } } },
      settlement: { result: { status: 'unavailable', reason: 'no_supported_groups' } } })
    const conditional = await app.inject({ method: 'POST', url: prefix + '/analytics/conditional-settlement', headers,
      payload: { venue: 'isolated', account: 'risk', asOf, asset: 'USDC', yes: yes.id, no: no.id, unitPayout: '2' } })
    expect(conditional.statusCode, conditional.body).toBe(200)
    expect(conditional.json()).toMatchObject({
      scope: 'user_declared_contract_known_selected_quantities', result: { worst: { payout: '160' }, best: { payout: '200' } },
    })
    const assets = await app.inject({ method: 'GET', url: prefix + '/analytics/scope', headers })
    expect(assets.json().accounts).toContainEqual(expect.objectContaining({ id: 'risk', assets: ['USDC'] }))
    const beforeMark = new URLSearchParams({ asset: 'USDC', asOf: '2026-11-03T00:00:00Z', accounts: 'risk' })
    const historicalRisk = await app.inject({ method: 'GET', url: prefix + '/analytics/exposure?' + beforeMark, headers })
    expect(historicalRisk.json().settlement.result).toMatchObject({ reference: null, worst: { payout: '80', changeFromReference: null } })
    const sampled = new URLSearchParams(perfQuery)
    sampled.set('sampling', 'monthly')
    const monthly = await app.inject({ method: 'GET', url: prefix + '/analytics/performance?' + sampled, headers })
    expect(monthly.json().returns).toEqual(perf.json().returns)
    expect(monthly.json().periodicReturns).toEqual(perf.json().periodicReturns)
    expect(monthly.json().periodicReturns.monthly).toMatchObject([{ partial: true, knownNetExternalFlows: '1000',
      twr: { value: '0.155', quality: 'reconstructed_selected_value' } }])
    expect(risk.json()).toMatchObject({ catalogRevision: expect.any(String), snapshotRevision: expect.any(String),
      settlementEvidenceRevision: expect.any(String), context: { coverageRevision: expect.any(String),
        accountIdentities: [{ venue: 'isolated', account: 'risk', knownAssets: ['USDC'], selectedAssetEvidence: 'observed' }] } })
    expect(monthly.json().history).toHaveLength(2)
    const recordPage = await app.inject({ method: 'GET', url: prefix + '/accounting/records?search=growth2', headers })
    const change = { changes: [{ key: recordPage.json().items[0].key, action: 'exclude' }] }
    const adjustment = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/preview', headers, payload: change })
    expect(adjustment.statusCode).toBe(200)
    const applied = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/confirm', headers,
      payload: { ...change, revision: adjustment.json().revision } })
    expect(applied.statusCode).toBe(200)
    const revised = await app.inject({ method: 'GET', url: prefix + '/analytics/performance?' + perfQuery, headers })
    expect(revised.json()).toMatchObject({ context: { accountingScope: 'user_selected' }, returns: { twr: { value: '0.1' } } })
    expect(revised.json().context.evidenceRevision).not.toBe(perf.json().context.evidenceRevision)
    const scenarioUrl = prefix + '/scenarios'
    const frozenSource = { mode: 'actual', asset: 'USDC', asOf, accounts: ['risk'], venue: 'isolated' }
    const draft = await app.inject({ method: 'POST', url: scenarioUrl + '/baseline', headers, payload: frozenSource })
    expect(draft.statusCode, draft.body).toBe(200)
    const baselineToken = draft.json().baselineToken
    const frozen = await app.inject({ method: 'POST', url: scenarioUrl, headers, payload: { name: 'Frozen',
      source: { mode: 'actual', asset: 'USDC', asOf, accounts: ['risk'], venue: 'isolated' }, input: {} } })
    expect(frozen.statusCode, frozen.body).toBe(201)
    const frozenId = frozen.json().id
    const withIndependentCapital = await app.inject({ method: 'POST', url: scenarioUrl + '/evaluate', headers, payload: {
      scenarioId: frozenId, input: {
        hypotheticalBuckets: [{ id: 'hypothetical:new', account: 'new', venue: 'abstract', asset: 'USDC', startingCapital: '1000' }],
        operations: [{ bucket: 'hypothetical:new', instrument: yes.id, kind: 'buy', amount: '10', price: '0.6', fee: { mode: 'excluded' } }],
      },
    } })
    expect(withIndependentCapital.statusCode, withIndependentCapital.body).toBe(200)
    expect(withIndependentCapital.json()).toMatchObject({ funding: [
      { actualOrScratchStartingCash: '0', endingCash: '0' }, { hypotheticalStartingCapital: '1000', endingCash: '994' },
    ] })
    const unchangedScenario = await app.inject({ method: 'GET', url: scenarioUrl + '/' + frozenId, headers })
    expect(unchangedScenario.json().baseline.buckets).toHaveLength(1)
    const mappedRows = await app.inject({ method: 'GET', url: prefix + '/accounting/records?search=open-y', headers })
    const mappedEdit = { changes: [{ key: mappedRows.json().items[0].key, action: 'correct', correction: { quantity: '110' } }] }
    const mappedPreview = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/preview', headers, payload: mappedEdit })
    expect(mappedPreview.statusCode, mappedPreview.body).toBe(200)
    const mappedConfirm = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/confirm', headers,
      payload: { ...mappedEdit, revision: mappedPreview.json().revision } })
    expect(mappedConfirm.statusCode, mappedConfirm.body).toBe(200)
    const correctedRisk = await app.inject({ method: 'GET', url: prefix + '/analytics/exposure?' + riskQuery, headers })
    expect(correctedRisk.json().settlement.result).toMatchObject({ status: 'exact', best: { payout: '110' } })
    expect(correctedRisk.json().context.evidenceRevision).not.toBe(risk.json().context.evidenceRevision)
    const draftEval = async (token: string, input = {}) => app.inject({ method: 'POST', url: scenarioUrl + '/evaluate', headers,
      payload: { baselineToken: token, input } })
    for (const changes of [{}, { funding: [{ bucket: JSON.stringify(['isolated', 'risk']), added: '5' }] }]) {
      const result = await draftEval(baselineToken, changes)
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json().settlement.verified.result).toMatchObject({ best: { payout: '100' } })
    }
    const draftExtension = await app.inject({ method: 'POST', url: scenarioUrl + '/baseline/instruments', headers,
      payload: { baselineToken, local: [{ id: 'local:new', mark: '0.2' }] } })
    expect(draftExtension.statusCode, draftExtension.body).toBe(200)
    expect(draftExtension.json().holdings).toEqual(draft.json().holdings)
    const extendedToken = draftExtension.json().baselineToken
    const savedDraft = await app.inject({ method: 'POST', url: scenarioUrl, headers, payload: {
      baselineToken: extendedToken, name: 'Reviewed baseline', input: {}, source: draftExtension.json().baselineSource,
    } })
    expect(savedDraft.statusCode, savedDraft.body).toBe(201)
    expect(savedDraft.json().baseline.holdings).toEqual(draft.json().holdings)
    const ownerPortfolio = await app.inject({ method: 'POST', url: '/v1/portfolios', headers, payload: { name: 'Separate context' } })
    const wrongTokenPortfolio = await app.inject({ method: 'POST', url: '/v1/portfolios/' + ownerPortfolio.json().id + '/scenarios/evaluate',
      headers, payload: { baselineToken, input: {} } })
    expect(wrongTokenPortfolio.json()).toMatchObject({ error: { code: 'baseline_preview_unavailable' } })
    expect((await draftEval('0'.repeat(64))).json()).toMatchObject({ error: { code: 'baseline_preview_unavailable' } })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000)
    try {
      expect((await draftEval(baselineToken)).json()).toMatchObject({ error: { code: 'baseline_preview_expired' } })
    } finally { clock.mockRestore() }
    const fixedResult = await app.inject({ method: 'POST', url: scenarioUrl + '/evaluate', headers, payload: { scenarioId: frozenId } })
    expect(fixedResult.statusCode, fixedResult.body).toBe(200)
    expect(fixedResult.json().settlement.verified.result).toMatchObject({ best: { payout: '100' } })
    const previewRebase = await app.inject({ method: 'POST', url: scenarioUrl + '/' + frozenId + '/rebase', headers,
      payload: { asOf, revision: 1 } })
    expect(previewRebase.statusCode, previewRebase.body).toBe(200)
    expect(previewRebase.json()).toMatchObject({ changed: true, result: { settlement: { verified: { result: { best: { payout: '110' } } } } } })
    const rebased = await app.inject({ method: 'POST', url: scenarioUrl + '/' + frozenId + '/rebase', headers,
      payload: { asOf, revision: 1, previewToken: previewRebase.json().previewToken } })
    expect(rebased.statusCode, rebased.body).toBe(200)
    expect(rebased.json().revision).toBe(2)
    const markRecords = await app.inject({ method: 'GET', url: prefix + '/accounting/records?search=mark-y', headers })
    const changeMark = { changes: [{ key: markRecords.json().items[0].key, action: 'correct', correction: { price: '0.65' } }] }
    const markPreview = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/preview', headers, payload: changeMark })
    expect(markPreview.statusCode, markPreview.body).toBe(200)
    const markSaved = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/confirm', headers,
      payload: { ...changeMark, revision: markPreview.json().revision } })
    expect(markSaved.statusCode, markSaved.body).toBe(200)
    const fresh = await app.inject({ method: 'POST', url: scenarioUrl, headers, payload: { name: 'New holding marks', source: frozenSource, input: {} } })
    expect(fresh.statusCode, fresh.body).toBe(201)
    const comparable = await app.inject({ method: 'POST', url: scenarioUrl + '/compare', headers,
      payload: { scenarioIds: [frozenId, fresh.json().id] } })
    expect(comparable.json()).toMatchObject({ compatibility: { sameFinancialBaseline: true, sameActualValuationReferences: false } })
    const originalRules = await database.select().from(reviewedBinaryRules)
    const bucket = JSON.stringify(['isolated', 'risk'])
    const sell = { bucket, instrument: yes.id, kind: 'sell', amount: '100', price: '0.6', fee: { mode: 'excluded' } }
    const toClose = await app.inject({ method: 'POST', url: scenarioUrl, headers, payload: { name: 'Sell held shares',
      source: { mode: 'actual', asset: 'USDC', asOf, accounts: ['risk'], venue: 'isolated' },
      input: { operations: [sell] } } })
    expect(toClose.statusCode, toClose.body).toBe(201)
    const reduce = { changes: [{ ...mappedEdit.changes[0], correction: { quantity: '50' } }] }
    const reducePreview = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/preview', headers, payload: reduce })
    const reduced = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/confirm', headers,
      payload: { ...reduce, revision: reducePreview.json().revision } })
    expect(reduced.statusCode, reduced.body).toBe(200)
    const rebaseUrl = scenarioUrl + '/' + toClose.json().id + '/rebase'
    const conflict = await app.inject({ method: 'POST', url: rebaseUrl, headers, payload: { asOf, revision: 1 } })
    expect(conflict.json()).toMatchObject({ limitation: 'short_sale_unsupported', conflicts: [{ operationIndex: 0, reason: 'short_sale_unsupported' }],
      changes: { holdings: [{ before: { quantity: '110' }, after: { quantity: '50' } }] } })
    const resolution = { operations: [{ ...sell, amount: '40' }] }
    const rejectedConfirmation = await app.inject({ method: 'POST', url: rebaseUrl, headers,
      payload: { asOf, revision: 1, input: resolution, previewToken: conflict.json().previewToken } })
    expect(rejectedConfirmation.statusCode).toBe(409)
    const resolvedPreview = await app.inject({ method: 'POST', url: rebaseUrl, headers, payload: { asOf, revision: 1, input: resolution } })
    expect(resolvedPreview.json()).toMatchObject({ conflicts: [], result: { operations: [{ proposedQuantity: '10' }] } })
    const resolvedConfirmation = await app.inject({ method: 'POST', url: rebaseUrl, headers,
      payload: { asOf, revision: 1, input: resolution, previewToken: resolvedPreview.json().previewToken } })
    expect(resolvedConfirmation.statusCode, resolvedConfirmation.body).toBe(200)
    expect(resolvedConfirmation.json()).toMatchObject({ revision: 2, input: { operations: [{ amount: '40' }] } })
    expect(await database.select().from(reviewedBinaryRules)).toEqual(originalRules)
    const actualAfterRebase = await app.inject({ method: 'GET', url: prefix + '/analytics/exposure?' + riskQuery, headers })
    expect(actualAfterRebase.json().exposure.instruments).toContainEqual(expect.objectContaining({ instrument: yes.id, quantity: '50' }))
    const remove = { changes: [{ key: mappedRows.json().items[0].key, action: 'exclude' }] }
    const removePreview = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/preview', headers, payload: remove })
    const removed = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/confirm', headers,
      payload: { ...remove, revision: removePreview.json().revision } })
    expect(removed.statusCode, removed.body).toBe(200)
    const afterClose = await app.inject({ method: 'POST', url: rebaseUrl, headers, payload: { asOf, revision: 2 } })
    expect(afterClose.json()).toMatchObject({ changes: { holdings: [{ before: { quantity: '50' }, after: null }] },
      candidate: { instruments: expect.arrayContaining([expect.objectContaining({ id: yes.id })]) },
      conflicts: [{ reason: 'short_sale_unsupported' }] })
    const denied = await app.inject({ method: 'GET', url: `/v1/portfolios/${OTHER_PORTFOLIO_ID}/analytics/exposure?` + riskQuery, headers })
    expect(denied.statusCode).toBe(404)
    riskQuery.set('accounts', 'missing')
    const wrongAccount = await app.inject({ method: 'GET', url: prefix + '/analytics/exposure?' + riskQuery, headers })
    expect(wrongAccount.statusCode).toBe(422)
  })

  it('freezes an explicitly selected outcome from a supported public link', async () => {
    const requests: string[] = []
    let noQuote = '0.4'
    const marketData = new PolymarketMarketDataService(new PolymarketHttpClient(async (url) => {
      requests.push(String(url))
      const info = { id: 'm', slug: 'market-fixture', conditionId: 'condition', question: 'Fixture question?',
        version: 'v1', outcomes: ['Yes', 'No'], clobTokenIds: ['101', '102'], active: true,
        feesEnabled: true, feeSchedule: { rate: '0.05', exponent: 1, takerOnly: true } }
      return new Response(JSON.stringify(String(url).includes('markets/slug') ? info : { '101': '0.6', '102': noQuote }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const app = await buildApp({ config: testConfig(), database, marketData })
    openApps.push(app)
    const headers = { authorization: `Bearer ${TOKEN}` }
    const url = `/v1/portfolios/${PORTFOLIO_ID}/scenarios`
    const response = await app.inject({ method: 'POST', url, headers, payload: {
      name: 'Public outcome', source: { mode: 'scratch', asOf: '2026-11-01T00:00:00Z', asset: 'USDC',
        buckets: [{ id: 'a', venue: 'polymarket', account: 'a', cash: '100' }],
        publicOutcomes: [{ url: 'https://polymarket.com/market/market-fixture', assetIdType: 'clob_token_id', assetId: '102' }] },
      input: { marks: [{ instrument: 'polymarket:clob_token_id:102', price: '0.4' }],
        operations: [{ bucket: 'a', instrument: 'polymarket:clob_token_id:102', kind: 'buy', amount: '10', price: '0.4', fee: { mode: 'provider', role: 'taker' } }] },
    } })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().baseline.instruments).toMatchObject([{ id: 'polymarket:clob_token_id:102', outcome: 'No',
      mark: null, settlementAsset: 'USDC', feeSchedule: { rate: '0.05' } }])
    const roundTrips = requests.length
    const evaluated = await app.inject({ method: 'POST', url: url + '/evaluate', headers, payload: { scenarioId: response.json().id } })
    expect(evaluated.statusCode, evaluated.body).toBe(200)
    expect(evaluated.json()).toMatchObject({ bridge: { endingValue: '99.88', unexplained: '0' },
      operations: [{ feeAmount: '0.12' }], settlement: { verified: { unsupported: [expect.any(String)] } } })
    expect(requests.length).toBe(roundTrips)
    const [event] = await database.insert(events).values({ providerCode: 'polymarket', externalId: 'test-public-event', name: 'Public event' }).returning()
    const [market] = await database.insert(markets).values({ providerCode: 'polymarket', externalId: 'condition',
      eventId: event!.id, title: 'Public fixture', lifecycle: 'open', settlementAssetCode: 'USDC' }).returning()
    const canonical = await database.insert(instruments).values([
      { marketId: market!.id, externalId: '101', outcomeName: 'Yes' }, { marketId: market!.id, externalId: '102', outcomeName: 'No' },
    ]).returning()
    const source = { mode: 'scratch', asOf: '2026-11-01T00:00:00Z', asset: 'USDC', catalog: canonical.map((row) => row.id),
      buckets: [{ id: 'a', venue: 'polymarket', account: 'a', cash: '100' }],
      publicOutcomes: ['101', '102'].map((assetId) => ({ url: 'https://polymarket.com/market/market-fixture',
        assetIdType: 'clob_token_id', assetId, captureCurrentQuote: true })) }
    const preview = await app.inject({ method: 'POST', url: url + '/baseline', headers, payload: source })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().instruments).toHaveLength(2)
    expect(preview.json().instrumentAliases).toMatchObject({ 'polymarket:clob_token_id:102': canonical[1]!.id })
    expect(preview.json().instruments).toContainEqual(expect.objectContaining({ id: canonical[1]!.id, mark: '0.4', markSource: 'assumed_current_quote' }))
    const beforeSave = requests.length
    noQuote = '0.42'
    const unsaved = await app.inject({ method: 'POST', url: url + '/evaluate', headers,
      payload: { baselineToken: preview.json().baselineToken, input: { operations: [{ bucket: 'a',
        instrument: 'polymarket:clob_token_id:102', kind: 'buy', amount: '5', price: '0.4', fee: { mode: 'excluded' } }] } } })
    expect(unsaved.statusCode, unsaved.body).toBe(200)
    expect(unsaved.json().positions[0]).toMatchObject({ mark: '0.4', value: '2' })
    expect(requests.length).toBe(beforeSave)
    const conditional = await app.inject({ method: 'POST', url, headers, payload: { name: 'Captured', source,
      baselineToken: preview.json().baselineToken, input: { operations: [{ bucket: 'a', instrument: 'polymarket:clob_token_id:102',
        kind: 'buy', amount: '5', price: '0.4', fee: { mode: 'excluded' } }],
        rules: [{ id: 'conditional-market', yes: 'polymarket:clob_token_id:101', no: canonical[1]!.id, asset: 'USDC' }] } } })
    expect(conditional.statusCode, conditional.body).toBe(201)
    expect(requests.length).toBe(beforeSave)
    const mixed = await app.inject({ method: 'POST', url: url + '/evaluate', headers, payload: { scenarioId: conditional.json().id } })
    expect(mixed.statusCode, mixed.body).toBe(200)
    expect(mixed.json()).toMatchObject({ valuationBasis: 'mixed_current_quote_assumption',
      operations: [{ instrument: canonical[1]!.id }], settlement: {
        verified: { result: { status: 'unavailable' } }, conditional: { result: { best: { payout: '5' } } },
      } })
    const mismatch = await app.inject({ method: 'POST', url: url + '/evaluate', headers, payload: {
      source: { ...source, publicOutcomes: [], buckets: [{ id: 'a', venue: 'kalshi', account: 'a', cash: '100' }] },
      input: { operations: [{ bucket: 'a', instrument: canonical[0]!.id, kind: 'buy', amount: '5', price: '0.4', fee: { mode: 'excluded' } }] },
    } })
    expect(mismatch.json()).toMatchObject({ error: { code: 'instrument_venue_mismatch' } })
  })

  it('combines frozen denomination evaluations without letting one venue fund another', async () => {
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const url = `/v1/portfolios/${PORTFOLIO_ID}/scenarios`
    const asOf = '2026-11-01T00:00:00Z'
    const part = async (asset: string, venue: string, quantity: string) => {
      const key = 'local:' + venue
      const preview = await app.inject({ method: 'POST', url: url + '/baseline', headers, payload: {
        asset, asOf, mode: 'scratch', buckets: [{ id: venue, account: venue, venue, cash: '100' }],
        local: [{ id: key, mark: '0.40' }],
      } })
      expect(preview.statusCode, preview.body).toBe(200)
      return { baselineToken: preview.json().baselineToken, input: { operations: [{
        bucket: venue, instrument: key, kind: 'buy', amount: quantity, price: '0.40', fee: { mode: 'fixed', value: '1' },
      }] } }
    }
    const usd = await part('USD', 'kalshi', '100')
    const usdc = await part('USDC', 'polymarket', '50')
    const evaluate = (components: unknown[]) => app.inject({ method: 'POST', url: url + '/evaluate-denominations', headers,
      payload: { components, assumedUsdPerUnit: { USDC: '0.98' } } })
    const result = await evaluate([usd, usdc])
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ indicativeUsd: { value: '196.02' }, fundingTransfers: false,
      components: [{ asset: 'USD', funding: [{ endingCash: '59' }] }, { asset: 'USDC', funding: [{ endingCash: '79' }] }] })
    const underfunded = await evaluate([usd, await part('USDC', 'polymarket', '300')])
    expect(underfunded.json()).toMatchObject({ indicativeUsd: null,
      components: [{ asset: 'USD', additionalCapitalRequired: '0' }, { asset: 'USDC', additionalCapitalRequired: '21' }] })
    const path = url + '/denomination-scenarios'
    const bundle = { components: [usd, usdc], assumedUsdPerUnit: { USDC: '0.98' }, name: 'Cross-platform',
      previewDigest: result.json().previewDigest }
    const saved = await app.inject({ method: 'POST', url: path, headers, payload: bundle })
    expect(saved.statusCode, saved.body).toBe(201)
    const { id } = saved.json()
    const secondApp = await createTestApp()
    const resumed = await secondApp.inject({ method: 'GET', url: path + '/' + id, headers })
    expect(resumed.json().result.indicativeUsd.value).toBe('196.02')
    const duplicate = await secondApp.inject({ method: 'POST', url: path + '/' + id + '/duplicate', headers, payload: { name: 'Duplicate' } })
    expect(duplicate.statusCode, duplicate.body).toBe(201)
    const comparison = await app.inject({ method: 'POST', url: path + '/compare', headers,
      payload: { scenarioIds: [id, duplicate.json().id] } })
    expect(comparison.json()).toMatchObject({ compatibleAssets: true, sameReportingAssumptions: true })
    const changed = await app.inject({ method: 'POST', url: path + '/' + id + '/instruments', headers,
      payload: { asset: 'USD', revision: 1, local: [{ id: 'local:extension', mark: '0.55' }] } })
    expect(changed.statusCode, changed.body).toBe(200)
    const remove = (revision: number) => app.inject({ method: 'POST', url: path + '/' + id + '/delete', headers, payload: { revision } })
    expect((await remove(1)).statusCode).toBe(409)
    expect((await remove(2)).statusCode).toBe(204)

  })

  it('persists isolated scratch scenarios with explicit revisions and unsaved evaluation', async () => {
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const url = `/v1/portfolios/${PORTFOLIO_ID}/scenarios`
    const asOf = '2026-11-01T00:00:00Z'
    const payload = { name: 'Scratch', source: { mode: 'scratch', asset: 'USD', asOf,
      buckets: [{ id: 'a', venue: 'local', account: 'a', cash: '100' }], local: [{ id: 'local:yes', mark: '0.6' }] },
    input: { operations: [{ bucket: 'a', instrument: 'local:yes', kind: 'buy', amount: '100', price: '0.6', fee: { mode: 'fixed', value: '1' } }] } }
    const created = await app.inject({ method: 'POST', url, headers, payload })
    expect(created.statusCode, created.body).toBe(201)
    const { id } = created.json()
    const evaluated = await app.inject({ method: 'POST', url: url + '/evaluate', headers, payload: { scenarioId: id } })
    expect(evaluated.statusCode, evaluated.body).toBe(200)
    expect(evaluated.json()).toMatchObject({ status: 'calculated', bridge: { endingValue: '99' }, funding: [{ endingCash: '39' }] })
    const rename = await app.inject({ method: 'PATCH', url: url + '/' + id, headers, payload: { name: 'Alternative', revision: 1 } })
    expect(rename.statusCode, rename.body).toBe(200)
    expect(rename.json()).toMatchObject({ name: 'Alternative', revision: 2 })
    const stale = await app.inject({ method: 'PATCH', url: url + '/' + id, headers, payload: { name: 'Old', revision: 1 } })
    expect(stale.statusCode).toBe(409)
    const duplicate = await app.inject({ method: 'POST', url: url + '/' + id + '/duplicate', headers, payload: { name: 'Copy' } })
    expect(duplicate.statusCode, duplicate.body).toBe(201)
    const comparison = await app.inject({ method: 'POST', url: url + '/compare', headers, payload: { scenarioIds: [id, duplicate.json().id] } })
    expect(comparison.statusCode, comparison.body).toBe(200)
    expect(comparison.json()).toMatchObject({ compatibility: { sameAsset: true, sameBaseline: true } })
    const rejected = await app.inject({ method: 'GET', url: `/v1/portfolios/${OTHER_PORTFOLIO_ID}/scenarios/${id}`, headers })
    expect(rejected.statusCode).toBe(404)
    const extended = await app.inject({ method: 'POST', url: url + '/' + id + '/instruments', headers,
      payload: { revision: 2, local: [{ id: 'local:no', mark: '0.4' }] } })
    expect(extended.statusCode, extended.body).toBe(200)
    expect(extended.json()).toMatchObject({ revision: 3, baseline: { buckets: [{ cash: '100' }],
      instruments: [{ id: 'local:yes' }, { id: 'local:no' }] } })
    const differentCatalog = await app.inject({ method: 'POST', url: url + '/compare', headers, payload: { scenarioIds: [id, duplicate.json().id] } })
    expect(differentCatalog.json()).toMatchObject({ compatibility: { sameBaseline: false, sameFinancialBaseline: true, sameAccountScope: true } })
    const alternate = async (value: string) => app.inject({ method: 'POST', url, headers, payload: { ...payload,
      input: { operations: [{ ...payload.input.operations[0], fee: { mode: 'rate', value } }] } } })
    const onePercent = await alternate('0.01')
    const fivePercent = await alternate('0.05')
    expect(onePercent.statusCode, onePercent.body).toBe(201)
    expect(fivePercent.statusCode, fivePercent.body).toBe(201)
    const rates = await app.inject({ method: 'POST', url: url + '/compare', headers,
      payload: { scenarioIds: [onePercent.json().id, fivePercent.json().id] } })
    expect(rates.json()).toMatchObject({ compatibility: { sameFeeMethodology: true, sameFeeAssumptions: false } })
    const deleted = await app.inject({ method: 'POST', url: url + '/' + id + '/delete', headers, payload: { revision: 3 } })
    expect(deleted.statusCode, deleted.body).toBe(204)
  })

  it('loads 30 independent reviewed markets through the authorized exposure API', async () => {
    const marketsToCreate = Array.from({ length: 30 }, (_, index) => 'depth-' + index)
    const eventRows = await database.insert(events).values(marketsToCreate.map((externalId) => ({
      providerCode: 'scale-fixture', externalId, name: externalId,
    }))).returning()
    const marketRows = await database.insert(markets).values(eventRows.map((event) => ({
      providerCode: 'scale-fixture', externalId: event.externalId, eventId: event.id, title: event.name, lifecycle: 'open',
    }))).returning()
    const outcomes = await database.insert(instruments).values(marketRows.flatMap((market) => ['yes', 'no'].map((outcome) => ({
      marketId: market.id, externalId: outcome, outcomeName: outcome,
    })))).returning()
    await database.insert(reviewedBinaryRules).values(marketRows.map((market) => ({
      marketId: market.id, yesInstrumentId: outcomes.find((row) => row.marketId === market.id && row.externalId === 'yes')!.id,
      noInstrumentId: outcomes.find((row) => row.marketId === market.id && row.externalId === 'no')!.id,
      assetCode: 'USD', evidence: 'Reviewed independent synthetic rule', reviewedAt: new Date('2026-11-01T00:00:00Z'),
    })))
    const csv = [
      'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset,canonical_instrument_id',
      'scale-fixture,large,inventory,2026-11-01T00:00:00Z,,opening_inventory,,USD,,,,,,',
      ...outcomes.flatMap((row, i) => [
        `scale-fixture,large,basis-${i},2026-11-01T00:00:00Z,,opening_position,${row.id},USD,${row.externalId === 'yes' ? 100 : 80},,10,,,${row.id}`,
        `scale-fixture,large,mark-${i},2026-11-01T01:00:00Z,,mark,${row.id},USD,,${row.externalId === 'yes' ? '0.6' : '0.4'},,,,`,
      ]),
    ].join('\n')
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const prefix = `/v1/portfolios/${PORTFOLIO_ID}`
    const preview = await app.inject({ method: 'POST', url: prefix + '/imports/preview', headers, payload: { csv } })
    expect(preview.statusCode, preview.body).toBe(200)
    const { batchId, reviewRevision } = preview.json()
    const confirmed = await app.inject({ method: 'POST', url: prefix + '/imports/' + batchId + '/confirm?reviewRevision=' + reviewRevision, headers })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const exposure = await app.inject({ method: 'GET',
      url: prefix + '/analytics/exposure?' + new URLSearchParams({ asset: 'USD', accounts: 'large', asOf: '2026-11-01T02:00:00Z' }), headers })
    expect(exposure.statusCode, exposure.body).toBe(200)
    expect(exposure.json().settlement.result).toMatchObject({ status: 'exact', feasibleCountExact: '1073741824',
      reference: '2760', downside: '360', worst: { payout: '2400' }, best: { payout: '3000' } })
  })

  it('previews and confirms owned financial CSV batches idempotently', async () => {
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const prefix = `/v1/portfolios/${PORTFOLIO_ID}`
    const header = 'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset'
    const cash = 'fixture,import,open,2026-11-25T00:00:00Z,,opening_cash,,USDC,,,0,,'
    const deposit = 'fixture,import,deposit,2026-11-25T01:00:00Z,,deposit,,USDC,,,40,,'
    const preview = (rows: string[], replaces?: string) => app.inject({
      method: 'POST', url: prefix + '/imports/preview', headers, payload: { csv: [header, ...rows].join('\n'), replaces },
    })
    const first = await preview([cash, deposit])
    expect(first.statusCode).toBe(200)
    const batch = first.json().batchId
    expect((await preview([deposit, cash])).json().batchId).toBe(batch)
    expect((await preview([cash, 'invalid'])).statusCode).toBe(422)
    const read = () => app.inject({ method: 'GET', url: prefix + '/accounting?asOf=2026-11-25T02:00:00Z', headers })
    expect((await read()).json().events).toEqual([])
    const confirm = () => app.inject({ method: 'POST', url: prefix + '/imports/' + batch + '/confirm?reviewRevision=' + first.json().reviewRevision, headers })
    const confirmed = await confirm()
    expect(confirmed.statusCode).toBe(200)
    expect((await confirm()).json()).toEqual(confirmed.json())
    expect((await read()).json().events).toHaveLength(2)
    const revised = await preview([cash, deposit.replace(',40,,', ',45,,')], batch)
    expect(revised.statusCode).toBe(200)
    const replace = () => app.inject({
      method: 'POST', url: prefix + '/imports/' + revised.json().batchId + '/confirm?replaces=' + batch + '&reviewRevision=' + revised.json().reviewRevision, headers,
    })
    const replaced = await replace()
    expect(replaced.statusCode).toBe(200)
    expect((await replace()).json()).toEqual(replaced.json())
    expect((await read()).json().cash).toMatchObject([{ knownDelta: '45' }])
    const history = await app.inject({
      method: 'GET', url: prefix + '/accounting/history?from=2026-11-24&through=2026-11-25', headers,
    })
    expect(history.statusCode).toBe(200)
    expect(history.json().points).toMatchObject([
      { asOf: '2026-11-24T23:59:59.999Z', balances: [] },
      { asOf: '2026-11-25T23:59:59.999Z', balances: [{ knownDelta: '45' }] },
    ])
    const unauthorized = await app.inject({
      method: 'POST', url: `/v1/portfolios/${OTHER_PORTFOLIO_ID}/imports/${batch}/confirm`, headers,
    })
    expect(unauthorized.statusCode).toBe(404)
  })

  it('persists portfolio decisions, freezes filtered selections, and restores the reference valuation', async () => {
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const prefix = `/v1/portfolios/${PORTFOLIO_ID}`
    const post = (path: string, payload: object) => app.inject({ method: 'POST', url: prefix + path, headers, payload })
    const get = (path: string) => app.inject({ method: 'GET', url: prefix + path, headers })
    const newAccount = await post('/accounting/accounts', { venue: 'fixture-multisided', label: 'Independent import' })
    expect(newAccount.statusCode).toBe(201)
    const account = newAccount.json().id
    const csv = [
      'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset',
      'fixture-multisided,local,cash,2026-11-25T00:00:00Z,,opening_cash,,USD,,,0,,',
      'fixture-multisided,local,inventory,2026-11-25T00:00:00Z,,opening_inventory,,USD,,,,,',
      'fixture-multisided,local,funding,2026-11-25T01:00:00Z,,deposit,,USD,,,1000,,',
      'fixture-multisided,local,buy-a,2026-11-25T02:00:00Z,,buy,yes,USD,100,0.4,,0,',
      'fixture-multisided,local,buy-b,2026-11-25T03:00:00Z,,buy,yes,USD,100,0.6,,0,',
      'fixture-multisided,local,duplicate-b,2026-11-25T03:00:00Z,,buy,yes,USD,100,0.6,,0,',
      'fixture-multisided,local,sale,2026-11-25T04:00:00Z,,sell,yes,USD,80,0.75,,0,',
      'fixture-multisided,local,mark,2026-11-25T05:00:00Z,,mark,yes,USD,,0.55,,,',
    ].join('\n')
    const preview = await post('/imports/preview', { csv, providerAccountId: account })
    expect(preview.statusCode).toBe(200)
    const batch = preview.json().batchId
    expect((await post('/imports/' + batch + '/confirm?reviewRevision=' + preview.json().reviewRevision, {})).statusCode).toBe(200)
    const rows = (await get('/accounting/records?account=' + account + '&type=buy')).json().items
    const first = rows.find((row: { original: { id: string } }) => row.original.id === 'buy-a')
    const duplicate = rows.find((row: { original: { id: string } }) => row.original.id === 'duplicate-b')
    const preferred = rows.find((row: { original: { id: string } }) => row.original.id === 'buy-b')
    expect(duplicate.potentialOverlap.count).toBe(1)
    const choose = async (request: object) => {
      const result = await post('/accounting/adjustments/preview', request)
      expect(result.statusCode).toBe(200)
      return post('/accounting/adjustments/confirm', { ...request, revision: result.json().revision })
    }
    expect((await choose({ changes: [{ key: duplicate.key, action: 'duplicate', duplicateOf: preferred.key }] })).statusCode).toBe(200)
    const state = async () => (await get('/accounting?asOf=2026-11-25T06:00:00Z')).json()
    expect((await state()).cash).toContainEqual(expect.objectContaining({ account, balance: '960', realized: '20', portfolioValue: '1026' }))
    const bulk = { selection: { batchId: batch, type: 'buy', action: 'exclude', except: [preferred.key, duplicate.key] } }
    expect((await choose(bulk)).statusCode).toBe(200)
    const selected = await state()
    expect(selected.portfolioScope).toBe('user_selected')
    expect(selected.holdings).toContainEqual(expect.objectContaining({ account, quantity: '20', basis: '12', unrealized: '-1' }))
    expect(selected.cash).toContainEqual(expect.objectContaining({ account, balance: '1000', realized: '12', portfolioValue: '1011', fullAccountValue: null }))
    expect((await choose({ changes: [{ key: first.key, action: 'restore' }] })).statusCode).toBe(200)
    expect((await state()).cash).toContainEqual(expect.objectContaining({ account, portfolioValue: '1026' }))
    const adjustment = { changes: [{ key: first.key, action: 'correct', correction: { price: '0.45' } }] }
    const stale = await post('/accounting/adjustments/preview', adjustment)
    expect(stale.statusCode).toBe(200)
    const manual = { accountId: account, clientId: '00000000-0000-4000-8000-000000000912',
      event: { type: 'reward', timestamp: '2026-11-25T05:30:00Z', asset: 'USD', amount: '1' } }
    const reviewedCsv = [
      'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset',
      'fixture-multisided,local,bonus,2026-11-25T05:40:00Z,,reward,,USD,,,2,,',
    ].join('\n')
    const importPreview = await post('/imports/preview', { csv: reviewedCsv, providerAccountId: account })
    expect(importPreview.statusCode).toBe(200)
    const added = await post('/accounting/manual-records', manual)
    expect(added.statusCode).toBe(200)
    expect((await post('/accounting/manual-records', manual)).json()).toEqual(added.json())
    expect((await post('/accounting/adjustments/confirm', { ...adjustment, revision: stale.json().revision })).statusCode).toBe(409)
    const importPath = '/imports/' + importPreview.json().batchId + '/confirm'
    expect((await post(importPath, {})).json()).toMatchObject({ error: { code: 'import_preview_stale' } })
    const importRefreshed = await post('/imports/preview', { csv: reviewedCsv, providerAccountId: account })
    expect(importRefreshed.json().batchId).toBe(importPreview.json().batchId)
    expect((await post(importPath + '?reviewRevision=' + importRefreshed.json().reviewRevision, {})).statusCode).toBe(200)
    expect((await choose(adjustment)).statusCode).toBe(200)
    const revised = (await get('/accounting/records?key=' + encodeURIComponent(first.key))).json().items[0]
    expect(revised.original.price).toBe('0.4')
    expect(revised.effective.observation.price).toBe('0.45')
    expect((await choose({ changes: [{ key: first.key, action: 'exclude' }] })).statusCode).toBe(200)
    expect((await choose({ changes: [{ key: first.key, action: 'restore' }] })).statusCode).toBe(200)
    expect((await get('/accounting/records?key=' + encodeURIComponent(first.key))).json().items[0]
      .effective.observation.price).toBe('0.45')
    const beforeRewards = async () => (await get('/accounting?asOf=2026-11-25T05:15:00Z')).json()
    const correctedState = await beforeRewards()
    expect(correctedState.holdings).toContainEqual(expect.objectContaining({
      account, quantity: '120', basis: '63', averageCost: '0.525', marketValue: '66', unrealized: '3',
    }))
    expect(correctedState.cash).toContainEqual(expect.objectContaining({
      account, balance: '955', realized: '18', portfolioValue: '1021',
    }))
    const timestamp = '2026-11-25T02:15:00.000Z'
    const quantityPatch = { key: first.key, action: 'correct', correction: { quantity: '120', timestamp } }
    expect((await choose({ changes: [quantityPatch] })).statusCode).toBe(200)
    expect((await choose({ changes: [{ key: first.key, action: 'exclude' }] })).statusCode).toBe(200)
    const filters = { account, inclusion: 'excluded', from: timestamp, through: timestamp }
    const filtered = (await get('/accounting/records?' + new URLSearchParams(filters))).json()
    expect(filtered.items).toEqual([expect.objectContaining({ key: first.key, effective: null,
      original: expect.objectContaining({ price: '0.4', quantity: '100' }),
      adjusted: expect.objectContaining({ price: '0.45', quantity: '120', timestamp }),
    })])
    expect((await choose({ selection: { ...filters, action: 'restore' } })).statusCode).toBe(200)
    expect((await get('/accounting/records?key=' + encodeURIComponent(first.key))).json().items[0])
      .toMatchObject({ effective: { observation: { price: '0.45', quantity: '120', timestamp } } })
    const reset = await choose({ changes: [{ key: first.key, action: 'reset_correction' }] })
    expect(reset.statusCode).toBe(200)
    expect((await get('/accounting/records?key=' + encodeURIComponent(first.key))).json().items[0])
      .toMatchObject({ adjusted: { price: '0.4', quantity: '100', timestamp: '2026-11-25T02:00:00.000Z' } })
    expect((await beforeRewards()).cash).toContainEqual(expect.objectContaining({ account, portfolioValue: '1026' }))
    expect((await choose(adjustment)).statusCode).toBe(200)
    expect((await choose({ changes: [{ key: preferred.key, action: 'exclude' }] })).statusCode).toBe(200)
    const broken = (await get('/accounting/records?key=' + encodeURIComponent(duplicate.key))).json().items[0]
    expect(broken).toMatchObject({ inclusion: 'unresolved', duplicateLinkStatus: 'review_required' })
    expect((await state()).discrepancies).toContainEqual(expect.objectContaining({ reason: 'duplicate_relationship_requires_review' }))
    expect((await choose({ changes: [{ key: preferred.key, action: 'restore' }] })).statusCode).toBe(200)
    expect((await choose({ changes: [{ key: preferred.key, action: 'correct', correction: { price: '0.61' } }] })).statusCode).toBe(200)
    expect((await get('/accounting/records?key=' + encodeURIComponent(duplicate.key))).json().items[0])
      .toMatchObject({ inclusion: 'unresolved', duplicateLinkStatus: 'target_revised' })
    const cycle = await post('/accounting/adjustments/preview', { changes: [{ key: preferred.key, action: 'duplicate', duplicateOf: duplicate.key }] })
    expect(cycle.statusCode).toBe(422)
    expect((await choose({ changes: [{ key: preferred.key, action: 'reset_correction' }] })).statusCode).toBe(200)
    const [header, ...body] = csv.split('\n')
    const reordered = [header, ...body.map((line) => line.includes(',buy-a,') ? line.replace(',0.4,', ',0.45,') : line).reverse()].join('\n')
    const replacement = await post('/imports/preview', { csv: reordered, providerAccountId: account, replaces: batch })
    expect(replacement.statusCode).toBe(200)
    expect(replacement.json().replacementDecisions).toContainEqual(expect.objectContaining({ from: first.key, status: 'correction_incorporated' }))
    expect(replacement.json().replacementDecisions).toContainEqual(expect.objectContaining({ from: duplicate.key, status: 'carried' }))
    const replacementPath = '/imports/' + replacement.json().batchId + '/confirm?replaces=' + batch
    expect((await post(replacementPath, {})).statusCode).toBe(409)
    expect((await post(replacementPath + '&reviewRevision=' + replacement.json().reviewRevision, {})).statusCode).toBe(200)
    const afterReplacement = (await get('/accounting/records?batchId=' + replacement.json().batchId)).json().items
    expect(afterReplacement).toContainEqual(expect.objectContaining({ original: expect.objectContaining({ id: 'duplicate-b' }),
      duplicateLinkStatus: 'selected', inclusion: 'excluded' }))
    expect((await app.inject({ method: 'POST', url: `/v1/portfolios/${OTHER_PORTFOLIO_ID}/accounting/adjustments/preview`,
      headers, payload: adjustment })).statusCode).toBe(404)
  })

  it('handles 526 filtered records and hundreds of manual records without using CSV batch capacity', async () => {
    await new IngestionService(database, providerRegistry).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const prefix = `/v1/portfolios/${PORTFOLIO_ID}`
    const post = (path: string, payload: object) => app.inject({ method: 'POST', url: prefix + path, headers, payload })
    const created = await post('/accounting/accounts', { venue: 'fixture-multisided', label: 'Scale test' })
    const account = created.json().id
    const now = new Date()
    await database.insert(financialImportBatches).values(Array.from({ length: 250 }, (_, index) => ({
      portfolioId: PORTFOLIO_ID, associatedAccountId: account, contentHash: 'scale-manual-' + index,
      manual: true, confirmedAt: now, expiresAt: now, observations: [{
        venue: 'fixture-multisided', account, id: 'manual-' + index, type: 'reward' as const,
        timestamp: '2026-11-01T00:00:00.000Z', asset: 'USD', amount: '1',
        instrument: null, quantity: null, price: null, fee: null, feeAsset: null, sequence: null,
      }],
    })))
    const csvHeader = 'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset'
    const lines = Array.from({ length: 526 }, (_, index) =>
      `fixture-multisided,local,large-${index},2026-11-02T00:00:00Z,,buy,yes,USD,1,0.25,,0,`)
    for (const group of [lines, ['fixture-multisided,local,bonus-scale,2026-11-03T00:00:00Z,,reward,,USD,,,1,,']]) {
      const preview = await post('/imports/preview', { providerAccountId: account, csv: [csvHeader, ...group].join('\n') })
      expect(preview.statusCode).toBe(200)
      expect((await post('/imports/' + preview.json().batchId + '/confirm?reviewRevision=' + preview.json().reviewRevision, {})).statusCode).toBe(200)
    }
    const manual = await post('/accounting/manual-records', { accountId: account, clientId: '00000000-0000-4000-8000-000000000913',
      event: { type: 'reward', timestamp: '2026-11-04T00:00:00Z', asset: 'USD', amount: '1' } })
    expect(manual.statusCode).toBe(200)
    const filters = { source: 'import', venue: 'fixture-multisided', type: 'buy', from: '2026-11-01T00:00:00Z',
      through: '2026-11-15T23:59:59Z', duplicates: 'yes' }
    const page = await app.inject({ method: 'GET', url: prefix + '/accounting/records?' + new URLSearchParams(filters), headers })
    expect(page.json()).toMatchObject({ total: 526, limit: 50 })
    const request = { selection: { ...filters, action: 'exclude', except: [page.json().items[0].key] } }
    const preview = await post('/accounting/adjustments/preview', request)
    expect(preview.json().affected).toBe(525)
    const confirmation = { ...request, revision: preview.json().revision }
    expect((await post('/accounting/adjustments/confirm', confirmation)).json()).toEqual({ applied: 525 })
    expect((await post('/accounting/adjustments/confirm', confirmation)).json()).toEqual({ applied: 525 })
    const summary = await app.inject({ method: 'GET', url: prefix + '/accounting?view=summary', headers })
    expect(summary.json().holdings).toContainEqual(expect.objectContaining({ account, quantity: '1' }))
    expect(summary.json().ledger).toBeUndefined()
  })

  it('replays synchronized provider evidence and coalesces an explicitly linked CSV observation', async () => {
    await new IngestionService(database, providerRegistry).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const app = await createTestApp()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const prefix = `/v1/portfolios/${PORTFOLIO_ID}`
    const read = () => app.inject({ method: 'GET', url: prefix + '/accounting?asOf=2026-11-25T02:00:00Z', headers })
    const initial = await read()
    expect(initial.statusCode).toBe(200)
    const before = initial.json()
    expect(before.status).toBe('partial')
    const fill = before.events.find((event: { id: string }) => event.id === 'fill:fill-multi-001')
    expect(fill).toMatchObject({ quantity: '12.000000000000000001', account: MULTI_ACCOUNT_ROW_ID, fee: null })
    expect(before.ledger.filter((entry: { eventId: string }) => entry.eventId === fill.economicId)).toHaveLength(1)
    expect(before.snapshots.positions).toContainEqual(expect.objectContaining({
      account: MULTI_ACCOUNT_ROW_ID, quantity: '12.000000000000000001', knownQuantity: '12.000000000000000001',
      status: 'observed_components_match',
    }))
    expect(before.snapshots.cash).toContainEqual(expect.objectContaining({ status: 'not_comparable' }))
    const header = 'venue,account,id,timestamp,sequence,type,instrument,asset,quantity,price,amount,fee,fee_asset'
    const csv = [header, `fixture-multisided,local,csv-trade,2026-11-20T12:30:00Z,,buy,${fill.instrument},USD,12.000000000000000001,0.234567890123456789,,,`].join('\n')
    const create = (providerAccountId: string, sourceLinks?: Record<string, string>) => app.inject({
      method: 'POST', url: prefix + '/imports/preview', headers, payload: { csv, providerAccountId, sourceLinks },
    })
    expect((await create('00000000-0000-4000-8000-000000000999')).statusCode).toBe(404)
    const preview = await create(MULTI_ACCOUNT_ROW_ID, { 'csv-trade': fill.sources[0].sourceRecordId })
    expect(preview.statusCode).toBe(200)
    const confirm = (batch: { batchId: string; reviewRevision: string }) => app.inject({ method: 'POST', url: prefix + '/imports/' + batch.batchId + '/confirm?reviewRevision=' + batch.reviewRevision, headers })
    expect((await confirm(preview.json())).statusCode).toBe(200)
    const overlap = await create(MULTI_ACCOUNT_ROW_ID)
    expect(overlap.statusCode).toBe(200)
    expect((await confirm(overlap.json())).statusCode).toBe(200)
    const after = (await read()).json()
    expect(after.events.find((event: { economicId: string }) => event.economicId === fill.economicId).sources).toHaveLength(2)
    expect(after.ledger).toEqual(before.ledger)
    expect(after.discrepancies).toContainEqual(expect.objectContaining({ reason: 'cross_source_overlap_unresolved' }))
    const records = (await app.inject({ method: 'GET', url: prefix + '/accounting/records', headers })).json().items
    const pending = records.find((item: { originalReason: string }) => item.originalReason === 'cross_source_overlap_unresolved')
    const providerFill = records.find((item: { original: { id: string }; acquisition: string }) =>
      item.acquisition === 'provider' && item.original.id === 'fill:fill-multi-001')
    const adjust = async (changes: Array<{ key: string; action: string }>) => {
      const proposal = await app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/preview', headers, payload: { changes } })
      expect(proposal.statusCode).toBe(200)
      return app.inject({ method: 'POST', url: prefix + '/accounting/adjustments/confirm', headers, payload: { changes, revision: proposal.json().revision } })
    }
    expect((await adjust([{ key: pending.key, action: 'include' }, { key: providerFill.key, action: 'exclude' }])).statusCode).toBe(200)
    await new IngestionService(database, providerRegistry).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const selected = (await read()).json()
    expect(selected.portfolioScope).toBe('user_selected')
    expect(selected.events).toContainEqual(expect.objectContaining({ authority: 'user_accepted', quantity: '12.000000000000000001' }))
    const decisionRows = (await app.inject({ method: 'GET', url: prefix + '/accounting/records?inclusion=excluded', headers })).json().items
    expect(decisionRows).toContainEqual(expect.objectContaining({ key: providerFill.key, acquisition: 'provider', inclusion: 'excluded' }))

    const gapCsv = [header, 'fixture-multisided,local,,2026-11-10T12:30:00Z,,reward,,USD,,,4,,'].join('\n')
    const supplement = await app.inject({ method: 'POST', url: prefix + '/imports/preview', headers,
      payload: { csv: gapCsv, providerAccountId: MULTI_ACCOUNT_ROW_ID, acceptUnlinked: true } })
    expect(supplement.statusCode).toBe(200)
    expect((await confirm(supplement.json())).statusCode).toBe(200)
    expect((await read()).json().events).toContainEqual(expect.objectContaining({ type: 'reward', amount: '4',
      account: MULTI_ACCOUNT_ROW_ID, authority: 'user_accepted' }))
    const original = new MultiOutcomeFixtureAdapter()
    const correction: ProviderAdapter = {
      capabilities: original.capabilities,
      fetchPage: (request) => original.fetchPage(request.streamName === 'activity' ? { ...request, checkpoint: null } : request),
      normalizePage: (page, streamName) => original.normalizePage(page, streamName).map((record) =>
        record.kind !== 'fill' || record.externalId !== 'fill-multi-001' ? record :
          { ...record, quantity: '13', rawPayload: { ...record.rawPayload, quantity: '13' } }),
    }
    await new IngestionService(database, new ProviderRegistry([correction])).syncProviderAccount(MULTI_ACCOUNT_ROW_ID)
    const revised = (await app.inject({ method: 'GET', url: prefix + '/accounting/records?key=' + encodeURIComponent(providerFill.key), headers })).json().items
    expect(revised).toContainEqual(expect.objectContaining({ key: providerFill.key, inclusion: 'excluded', revisionChanged: true }))

  })

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
    let failSync = false
    let currentOnlyScenario = false
    let interruptSecondPage = true
    const openCursors: Array<string | null> = []
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (failSync) return new Response(null, { status: 403 })
      if (currentOnlyScenario) {
        if (!url.pathname.endsWith('/v2/positions') || url.searchParams.get('status') !== 'OPEN') {
          throw new Error('Current scope must not call historical endpoints')
        }
        const cursor = url.searchParams.get('cursor')
        openCursors.push(cursor)
        if (cursor && interruptSecondPage) return new Response(null, { status: 403 })
        const token = cursor ? '402' : '401'
        return new Response(JSON.stringify({
          data: [{ proxy_wallet: wallet, condition_id: 'current-' + token, token_id: token,
            opposite_token_id: token + '0', title: 'Current holding ' + token, outcome: 'Yes',
            opposite_outcome: 'No', current_size: '1', status: 'OPEN' }],
          pagination: { next_cursor: cursor ? null : 'open-page-2' },
        }), { headers: { 'content-type': 'application/json' } })
      }
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
        const ambiguous = { proxy_wallet: wallet, transaction_hash: '0xno-id', condition_id: 'condition-a',
          token_id: '101', side: 'BUY', size: '2', price: '0.25', timestamp: 1795564600 }
        const later = url.searchParams.has('cursor')
        return new Response(JSON.stringify({
          data: later ? [ambiguous] : [{
            proxy_wallet: wallet,
            id: 'native-fill',
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
          }, ambiguous],
          pagination: { next_cursor: later ? null : 'trade-page-2' },
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
            { id: 'native-deposit', type: 'DEPOSIT', transaction_hash: '0xdeposit', proxy_wallet: wallet, timestamp: 1795564800, usdc_size: '10.25' },
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
    expect(first.json().status).toBe('partial')
    expect(second.statusCode).toBe(200)
    expect(second.json().status).toBe('partial')
    const firstStreams = first.json().streams as Array<Record<string, unknown>>
    const secondStreams = second.json().streams as Array<Record<string, unknown>>
    expect(firstStreams.find((stream) => stream.streamName === 'positions')).toMatchObject({
      rowsReceived: 2, sourceRowsRetained: 1, excludedRecords: 1,
    })
    expect(firstStreams.find((stream) => stream.streamName === 'trades')).toMatchObject({
      rowsReceived: 4, sourceRowsRetained: 4, unresolvedRecords: 3,
    })
    expect((secondStreams.find((stream) => stream.streamName === 'trades')?.exactDuplicates as number)).toBeGreaterThan(0)
    expect(await database.select({ id: fills.id }).from(fills)).toHaveLength(1)
    expect(await database.select({ id: cashMovements.id }).from(cashMovements)).toHaveLength(1)
    expect(await database.select({ id: providerActivityFacts.id }).from(providerActivityFacts)).toHaveLength(3)
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

    const observedAttempts = await database.select({ observations: activityFactOccurrences.observations }).from(activityFactOccurrences)
    expect(observedAttempts.map((row) => row.observations).sort()).toEqual([1, 1, 1, 1, 2, 2])
    const tradeRun = firstStreams.find((stream) => stream.streamName === 'trades')?.runId
    const runEvidence = await app.inject({
      method: 'GET', url: `/v1/portfolios/${PORTFOLIO_ID}/activity-facts?providerAccountId=${accountId}&syncRunId=${tradeRun}`, headers: auth,
    })
    expect(runEvidence.statusCode).toBe(200)
    expect(runEvidence.json().items).toHaveLength(2)
    expect(runEvidence.json().items).toContainEqual(expect.objectContaining({
      resolutionReason: 'trade_identity_ambiguous', observationsInRun: 2,
    }))
    const unresolved = await app.inject({ method: 'GET', url: `/v1/portfolios/${PORTFOLIO_ID}/accounting/records?source=provider&type=TRADE_UNRESOLVED&search=0xno-id`, headers: auth })
    expect(unresolved.statusCode).toBe(200)
    expect(unresolved.json().items).toContainEqual(expect.objectContaining({
      inclusion: 'unresolved', original: expect.objectContaining({ quantity: '2', price: '0.25' }),
      providerActivity: expect.objectContaining({ type: 'TRADE_UNRESOLVED', transactionHash: '0xno-id', largestObservedRunCount: 2 }),
    }))


    omitPositions = true
    const emptyRefresh = await app.inject({ method: 'POST', url: `/v1/provider-accounts/${accountId}/sync?scope=current`, headers: auth })
    expect(emptyRefresh.statusCode).toBe(200)
    expect(emptyRefresh.json().status).toBe('complete')
    expect(emptyRefresh.json().streams.map((stream: { streamName: string }) => stream.streamName)).toEqual(['positions'])
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
    currentOnlyScenario = true
    const refreshCurrent = () => app.inject({ method: 'POST', url: `/v1/provider-accounts/${accountId}/sync?scope=current`, headers: auth })
    expect((await refreshCurrent()).json().status).toBe('partial')
    interruptSecondPage = false
    expect((await refreshCurrent()).json().status).toBe('complete')
    expect(openCursors).toEqual([null, 'open-page-2', null, 'open-page-2'])
    const refreshed = await app.inject({
      method: 'GET', url: `/v1/portfolios/${PORTFOLIO_ID}/positions?providerAccountId=${accountId}`, headers: auth,
    })
    expect(refreshed.json().items.filter((item: { observationStatus: string }) =>
      item.observationStatus === 'observed_in_latest_successful_refresh')).toHaveLength(2)
    currentOnlyScenario = false
    failSync = true
    const failureApp = await buildApp({
      config: testConfig(), database,
      registry: new ProviderRegistry([new PolymarketAdapter(new PolymarketHttpClient(fetcher))]),
    })
    openApps.push(failureApp)
    const failure = await failureApp.inject({ method: 'POST', url: `/v1/provider-accounts/${accountId}/sync`, headers: auth })
    expect(failure.statusCode).toBe(502)
    expect(failure.body).toContain('sync_failed')

    const kalshiId = '00000000-0000-4000-8000-000000000299'
    await addProviderAccount('kalshi', 'native-kalshi-fixture', kalshiId)
    const secondVenue = new KalshiClient(async (url) => {
      if (url.pathname.endsWith('/balance')) return Response.json({ balance_dollars: '125.50', updated_ts: 1795568400 })
      if (url.pathname.endsWith('/positions')) return Response.json({ market_positions: [], cursor: '' })
      throw new Error('Unexpected fixture endpoint')
    })
    const mixedApp = await buildApp({ config: testConfig(), database,
      registry: new ProviderRegistry([new PolymarketAdapter(new PolymarketHttpClient(fetcher)), new KalshiAdapter(() => secondVenue)]) })
    openApps.push(mixedApp)
    const mixedSync = await mixedApp.inject({ method: 'POST', url: '/v1/provider-accounts/' + kalshiId + '/sync?scope=current', headers: auth })
    expect(mixedSync.statusCode, mixedSync.body).toBe(200)
    const mixedCoverage = await mixedApp.inject({ method: 'GET', url: `/v1/portfolios/${PORTFOLIO_ID}/coverage`, headers: auth })
    expect(mixedCoverage.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerCode: 'polymarket', entityType: 'fills' }),
      expect.objectContaining({ providerCode: 'kalshi', entityType: 'cash_balances', status: 'complete' }),
    ]))

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

    const unsafeScenario = await publicApp.inject({ method: 'POST', url: `/v1/portfolios/${PORTFOLIO_ID}/scenarios/baseline`,
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { mode: 'scratch', asset: 'USDC', asOf: '2026-11-01T00:00:00Z',
        buckets: [{ id: 'a', venue: 'polymarket', account: 'a', cash: '100' }],
        publicOutcomes: [{ url: 'http://127.0.0.1/private', assetIdType: 'clob_token_id', assetId: '101' }] } })
    expect(unsafeScenario.statusCode, unsafeScenario.body).toBe(422)
    expect(upstreamCalls).toBe(1)
    const disabledApp = await buildApp({ config: testConfig(), database })
    openApps.push(disabledApp)
    const disabledSearch = await disabledApp.inject({ method: 'GET', url: '/v1/market-data/search?q=public%20event' })
    expect(disabledSearch.statusCode).toBe(503)
    expect(disabledSearch.json().error.code).toBe('provider_live_disabled')

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

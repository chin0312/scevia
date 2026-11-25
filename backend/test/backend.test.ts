import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { createDatabase, type Database } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import {
  cashMovements,
  fills,
  markets,
  portfolios,
  positionSnapshots,
  providerAccounts,
  sourceRecordRevisions,
  sourceRecords,
  syncCheckpoints,
  syncRuns,
  users,
} from '../src/db/schema.js'
import { loadConfig } from '../src/config.js'
import { matchesDevelopmentBearer } from '../src/http/auth.js'
import { buildApp } from '../src/http/app.js'
import { IngestionService } from '../src/ingestion/sync.js'
import { SyncAlreadyRunningError } from '../src/ingestion/errors.js'
import { ProviderAdapterError, type ProviderAdapter, type ProviderPage } from '../src/providers/adapter.js'
import { MultiOutcomeFixtureAdapter } from '../src/providers/fixtures/multi-outcome-adapter.js'
import { MULTI_OUTCOME_ACCOUNT_ID, SNAPSHOT_ACCOUNT_ID } from '../src/providers/fixtures/data.js'
import { ProviderRegistry, providerRegistry } from '../src/providers/registry.js'
import type { CoverageEntity, ProviderCapabilities } from '../src/domain/model.js'
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
  'markets', 'fills', 'cash_movements', 'settlements', 'positions', 'cash_balances', 'prices',
]
const COMPLETE_COVERAGE = Object.fromEntries(ALL_ENTITIES.map((entity) => [entity, 'complete'])) as Record<CoverageEntity, 'complete'>

let pool: Pool
let database: Database
let openApps: Array<{ close: () => Promise<void> }> = []

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for the backend test process')
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
    const fill = await database.select({ price: fills.price, feeAmount: fills.feeAmount, feeStatus: fills.feeStatus })
      .from(fills).where(eq(fills.externalId, 'fill-multi-001')).then((rows) => rows[0])
    expect(fill?.price).toBe('0.234567890123456789')
    expect(fill?.feeAmount).toBeNull()
    expect(fill?.feeStatus).toBe('unavailable')
    await expect(pool.query("UPDATE scevia.fills SET fee_amount = NULL WHERE external_id = 'fill-multi-002'")).rejects.toThrow()
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
      fetchPage: (request) => original.fetchPage(request),
      normalizePage: (page) => original.normalizePage(page).map((record) => {
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
      normalizePage: (page) => original.normalizePage(page),
    }
    const service = new IngestionService(database, new ProviderRegistry([recoverableAdapter]))
    const account = { id: MULTI_ACCOUNT_ROW_ID, providerCode: 'fixture-multisided', externalAccountId: MULTI_OUTCOME_ACCOUNT_ID }
    const failed = await service.syncProviderAccount(account)
    const [checkpointAfterFailure] = await database.select({ cursor: syncCheckpoints.cursor, status: syncCheckpoints.status })
      .from(syncCheckpoints).where(eq(syncCheckpoints.providerAccountId, MULTI_ACCOUNT_ROW_ID))
    expect(failed.status).toBe('partial')
    expect(failed.errorCode).toBe('fixture_page_unavailable')
    expect(failed.pagesRead).toBe(1)
    expect(checkpointAfterFailure?.cursor).toBe('page-2')
    expect(checkpointAfterFailure?.status).toBe('partial')

    failSecondPage = false
    const resumed = await service.syncProviderAccount(account)
    const [checkpointAfterResume] = await database.select({ cursor: syncCheckpoints.cursor, status: syncCheckpoints.status })
      .from(syncCheckpoints).where(eq(syncCheckpoints.providerAccountId, MULTI_ACCOUNT_ROW_ID))
    const fillRows = await database.select({ id: fills.id }).from(fills)
    expect(resumed.status).toBe('complete')
    expect(resumed.pagesRead).toBe(1)
    expect(checkpointAfterResume?.cursor).toBeNull()
    expect(checkpointAfterResume?.status).toBe('complete')
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
    await database.insert(syncRuns).values({
      id: abandonedRunId,
      providerAccountId: accountId,
      syncName: RUNNING_SYNC_NAME,
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
})

describe('provider contracts and API security', () => {
  it('rejects malformed fixture payloads and declares unsupported capabilities', () => {
    const adapter = new MultiOutcomeFixtureAdapter()
    expect(() => adapter.normalizePage({ payload: { broken: true }, nextCursor: null, sourceAsOf: null, coverage: {} }))
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
    expect(unavailableMark.status).toBe('unavailable')
    expect(unavailableMark.reasonCode).toBe('unsupported_by_provider')

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
  return { payload: {}, nextCursor: null, sourceAsOf: '2026-11-24T00:00:00Z', coverage: COMPLETE_COVERAGE }
}

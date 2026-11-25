import { loadDatabaseConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { portfolios, providerAccounts, users } from '../src/db/schema.js'
import { IngestionService } from '../src/ingestion/sync.js'
import { providerRegistry } from '../src/providers/registry.js'
import { MULTI_OUTCOME_ACCOUNT_ID, SNAPSHOT_ACCOUNT_ID } from '../src/providers/fixtures/data.js'
import { assertSafeSeedDatabase } from './safety.js'

const ownerId = '00000000-0000-4000-8000-000000000001'
const portfolioId = '00000000-0000-4000-8000-000000000101'
const multiAccountId = '00000000-0000-4000-8000-000000000201'
const snapshotAccountId = '00000000-0000-4000-8000-000000000202'
const databaseConfig = loadDatabaseConfig()
assertSafeSeedDatabase(databaseConfig.url)
const { database, pool } = createDatabase(databaseConfig)

try {
  await runMigrations(database)
  await database.insert(users).values({ id: ownerId, authSubject: 'development-fixture-principal' }).onConflictDoNothing()
  await database.insert(portfolios).values({ id: portfolioId, ownerId, name: 'Sample portfolio' }).onConflictDoNothing()
  await database.insert(providerAccounts).values([
    {
      id: multiAccountId,
      portfolioId,
      providerCode: 'fixture-multisided',
      externalAccountId: MULTI_OUTCOME_ACCOUNT_ID,
      label: 'Fixture multi-outcome source',
      kind: 'fixture',
    },
    {
      id: snapshotAccountId,
      portfolioId,
      providerCode: 'fixture-account-snapshot',
      externalAccountId: SNAPSHOT_ACCOUNT_ID,
      label: 'Fixture account snapshot source',
      kind: 'fixture',
    },
  ]).onConflictDoNothing()

  const ingestion = new IngestionService(database, providerRegistry)
  const results = await Promise.all([
    ingestion.syncProviderAccount({
      id: multiAccountId,
      providerCode: 'fixture-multisided',
      externalAccountId: MULTI_OUTCOME_ACCOUNT_ID,
    }),
    ingestion.syncProviderAccount({
      id: snapshotAccountId,
      providerCode: 'fixture-account-snapshot',
      externalAccountId: SNAPSHOT_ACCOUNT_ID,
    }),
  ])
  if (results.some((result) => result.status !== 'complete')) {
    throw new Error('Fixture synchronization failed')
  }
  process.stdout.write(`Ingested ${results.length} deterministic fixture sources into the Sample portfolio.\n`)
} finally {
  await pool.end()
}

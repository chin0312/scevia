import { loadDatabaseConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'

const { database, pool } = createDatabase(loadDatabaseConfig())

try {
  await runMigrations(database)
  process.stdout.write('Database migrations applied.\n')
} finally {
  await pool.end()
}

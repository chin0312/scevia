import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'
import type { DatabaseConfig } from '../config.js'

export type Database = NodePgDatabase<typeof schema>

export function createDatabase(config: DatabaseConfig, poolSize = 10) {
  const pool = new Pool({
    connectionString: config.url,
    max: poolSize,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'scevia-backend',
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  })
  const database = drizzle(pool, { schema })
  return { database, pool }
}

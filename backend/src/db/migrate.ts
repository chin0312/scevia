import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Database } from './client.js'

export async function runMigrations(database: Database): Promise<void> {
  await migrate(database, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })
}

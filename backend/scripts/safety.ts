const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function databaseIdentity(connectionString: string): { host: string; database: string } {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('Database URL must be a valid PostgreSQL connection URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Database URL must use the PostgreSQL protocol')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const hostOverrides = [...url.searchParams.getAll('host'), ...url.searchParams.getAll('hostaddr')]
  const hosts = hostOverrides.length ? hostOverrides : [url.hostname]
  if (!hosts.every(Boolean) || !database) throw new Error('Database URL must include a host and database name')
  return { host: hosts.join(',').toLowerCase(), database }
}

export function assertSafeTestDatabaseUrl(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { host, database } = databaseIdentity(connectionString)
  if (env.NODE_ENV === 'production') throw new Error('Destructive backend tests cannot run with NODE_ENV=production')

  if (env.TEST_DATABASE_MODE === 'pglite') {
    if (env.SCEVIA_PGLITE_HARNESS !== '1' || !loopbackHosts.has(host) || database !== 'postgres') {
      throw new Error('PGlite test mode must use the embedded local database started by npm test')
    }
    return
  }

  if (env.ALLOW_DESTRUCTIVE_TEST_DATABASE !== 'true') {
    throw new Error('External test databases require ALLOW_DESTRUCTIVE_TEST_DATABASE=true')
  }
  if (!database.toLowerCase().endsWith('_test')) {
    throw new Error('External destructive tests require a database name ending in _test')
  }
  if (host.split(',').some((candidate) => !loopbackHosts.has(candidate.trim()))) {
    throw new Error('External destructive tests are restricted to a local PostgreSQL host')
  }
}

export function assertSafeSeedDatabase(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { host, database } = databaseIdentity(connectionString)
  if (env.NODE_ENV === 'production') throw new Error('The development fixture seed is disabled in production')
  if (host.split(',').every((candidate) => loopbackHosts.has(candidate.trim())) && ['scevia', 'scevia_test'].includes(database.toLowerCase())) return
  if (env.ALLOW_DEVELOPMENT_SEED === 'true' && database.toLowerCase().endsWith('_dev')) return
  throw new Error('Fixture seeding requires a local scevia database or an explicitly allowed _dev database')
}

import { describe, expect, it } from 'vitest'
import { assertSafeSeedDatabase, assertSafeTestDatabaseUrl } from '../scripts/safety.js'

describe('destructive database operation safeguards', () => {
  it('rejects an ordinary development database even when NODE_ENV is test', () => {
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@localhost:5432/scevia', {
      NODE_ENV: 'test',
    })).toThrow('ALLOW_DESTRUCTIVE_TEST_DATABASE=true')
  })

  it('requires explicit opt-in and a local _test database for external integration tests', () => {
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@localhost:5432/scevia_test', {
      NODE_ENV: 'test',
    })).toThrow('ALLOW_DESTRUCTIVE_TEST_DATABASE=true')
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@localhost:5432/scevia', {
      NODE_ENV: 'test',
      ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
    })).toThrow('ending in _test')
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@database.example/scevia_test', {
      NODE_ENV: 'test',
      ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
    })).toThrow('local PostgreSQL host')
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@localhost:5432/scevia_test?host=db.example.test', {
      NODE_ENV: 'test',
      ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
    })).toThrow('local PostgreSQL host')
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@localhost:5432/scevia_test?host=localhost&host=db.example.test', {
      NODE_ENV: 'test',
      ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
    })).toThrow('local PostgreSQL host')
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@localhost:5432/scevia_test', {
      NODE_ENV: 'production',
      ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
    })).toThrow('NODE_ENV=production')
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@localhost:5432/scevia_test', {
      NODE_ENV: 'test',
      ALLOW_DESTRUCTIVE_TEST_DATABASE: 'true',
    })).not.toThrow()
  })

  it('allows only the embedded loopback PGlite harness in PGlite test mode', () => {
    expect(() => assertSafeTestDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:51000/postgres', {
      NODE_ENV: 'test',
      TEST_DATABASE_MODE: 'pglite',
      SCEVIA_PGLITE_HARNESS: '1',
    })).not.toThrow()
    expect(() => assertSafeTestDatabaseUrl('postgresql://user:password@database.example:51000/postgres', {
      NODE_ENV: 'test',
      TEST_DATABASE_MODE: 'pglite',
      SCEVIA_PGLITE_HARNESS: '1',
    })).toThrow('embedded local database')
  })

  it('keeps fixture seeding local and unavailable in production', () => {
    expect(() => assertSafeSeedDatabase('postgresql://user:password@127.0.0.1:5432/scevia', {
      NODE_ENV: 'development',
    })).not.toThrow()
    expect(() => assertSafeSeedDatabase('postgresql://user:password@127.0.0.1:5432/scevia', {
      NODE_ENV: 'production',
    })).toThrow('disabled in production')
    expect(() => assertSafeSeedDatabase('postgresql://user:password@database.example:5432/scevia_dev', {
      NODE_ENV: 'development',
      ALLOW_DEVELOPMENT_SEED: 'true',
    })).not.toThrow()
  })
})

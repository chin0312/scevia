import 'dotenv/config'
import { z } from 'zod'

const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  DB_SSL: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
})

const serverEnvironmentSchema = z.object({
  POLYMARKET_LIVE_DATA_AUTHORIZED: z.enum(['YES', 'NO']).default('NO'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  AUTH_MODE: z.enum(['development', 'external']).default('development'),
  DEV_AUTH_TOKEN: z.string().optional(),
  DEV_PRINCIPAL_ID: z.string().uuid().default('00000000-0000-4000-8000-000000000001'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
})

export interface DatabaseConfig {
  url: string
  ssl: boolean
}

export interface ServerConfig extends DatabaseConfig {
  polymarketLiveEnabled?: boolean
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  authMode: 'development'
  devAuthToken: string
  devPrincipalId: string
  corsOrigins: string[]
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = databaseEnvironmentSchema.parse(env)
  return { url: parsed.DATABASE_URL, ssl: parsed.DB_SSL }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const database = loadDatabaseConfig(env)
  const parsed = serverEnvironmentSchema.parse(env)

  if (parsed.NODE_ENV === 'production' && parsed.AUTH_MODE === 'development') {
    throw new Error('Development authentication is disabled in production')
  }
  if (parsed.AUTH_MODE === 'external') {
    throw new Error('An external authentication principal resolver has not been configured')
  }
  if (parsed.DEV_AUTH_TOKEN === undefined || Buffer.byteLength(parsed.DEV_AUTH_TOKEN, 'utf8') < 32) {
    throw new Error('DEV_AUTH_TOKEN must contain at least 32 bytes')
  }
  if (parsed.NODE_ENV === 'production' && !database.ssl) {
    throw new Error('DB_SSL=true is required in production')
  }
  if (parsed.NODE_ENV === 'production' && env.CORS_ORIGINS === undefined) {
    throw new Error('CORS_ORIGINS must be configured in production')
  }

  const corsOrigins = parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  if (corsOrigins.includes('*')) throw new Error('Wildcard CORS is not allowed')
  if (parsed.NODE_ENV === 'production' && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must be configured in production')
  }

  return {
    ...database,
    nodeEnv: parsed.NODE_ENV,
    polymarketLiveEnabled: parsed.NODE_ENV === 'development' && ['127.0.0.1', '::1', 'localhost'].includes(parsed.HOST)
      && parsed.POLYMARKET_LIVE_DATA_AUTHORIZED === 'YES',
    host: parsed.HOST,
    port: parsed.PORT,
    authMode: 'development',
    devAuthToken: parsed.DEV_AUTH_TOKEN,
    devPrincipalId: parsed.DEV_PRINCIPAL_ID,
    corsOrigins,
  }
}

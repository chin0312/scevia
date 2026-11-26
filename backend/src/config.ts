import 'dotenv/config'
import { z } from 'zod'

const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  DB_SSL: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
})

const serverEnvironmentSchema = z.object({
  KALSHI_PUBLIC_DATA_AUTHORIZED: z.enum(['YES', 'NO']).default('NO'),
  KALSHI_ACCOUNT_DATA_AUTHORIZED: z.enum(['YES', 'NO']).default('NO'),
  KALSHI_ENVIRONMENT: z.enum(['demo', 'production']).default('demo'),
  POLYMARKET_POLYGON_RPC_AUTHORIZED: z.enum(['YES', 'NO']).default('NO'),
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

export interface KalshiConfig {
  environment: 'demo' | 'production'
  publicAuthorized: boolean
  accountAuthorized: boolean
  binding?: { accountId: string; portfolioId: string; keyId: string; keyFile: string }
}

export interface ServerConfig extends DatabaseConfig {
  kalshi?: KalshiConfig
  tracking?: { accountIds: string[]; marketIntervalMs: number; accountIntervalMs: number; retentionDays: number }
  demoDataset?: { path: string; cacheMs: number; allowFixture: boolean }
  polymarketLiveEnabled?: boolean
  polymarketPolygonRpc?: URL
  ecbReferenceAuthorized?: boolean
  polymarketResolutionRpcAuthorized?: boolean
  polymarketStreamAuthorized?: boolean
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

  const localDevelopment = parsed.NODE_ENV === 'development' && ['127.0.0.1', '::1'].includes(parsed.HOST)
  const kalshi: KalshiConfig = {
    environment: parsed.KALSHI_ENVIRONMENT,
    publicAuthorized: localDevelopment && parsed.KALSHI_PUBLIC_DATA_AUTHORIZED === 'YES',
    accountAuthorized: localDevelopment && parsed.KALSHI_ACCOUNT_DATA_AUTHORIZED === 'YES',
  }
  if (kalshi.accountAuthorized) {
    if (!kalshi.publicAuthorized) throw new Error('Kalshi account ingestion requires separate public catalog authorization')
    kalshi.binding = z.object({
      accountId: z.uuid(), portfolioId: z.uuid(), keyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      keyFile: z.string().startsWith('/'),
    }).parse({ accountId: env.KALSHI_PROVIDER_ACCOUNT_ID, portfolioId: env.KALSHI_PORTFOLIO_ID,
      keyId: env.KALSHI_KEY_ID, keyFile: env.KALSHI_PRIVATE_KEY_FILE })
  }
  let polymarketPolygonRpc: URL | undefined
  if (localDevelopment && parsed.POLYMARKET_LIVE_DATA_AUTHORIZED === 'YES' && parsed.POLYMARKET_POLYGON_RPC_AUTHORIZED === 'YES') {
    try {
      polymarketPolygonRpc = new URL(env.POLYMARKET_POLYGON_RPC_URL ?? '')
      if (polymarketPolygonRpc.protocol !== 'https:' || polymarketPolygonRpc.username || polymarketPolygonRpc.password
        || polymarketPolygonRpc.hash) throw new Error('invalid endpoint')
    } catch { throw new Error('Configure a valid HTTPS Polygon RPC endpoint for authorized Polymarket balance reads') }
  }
  return {
    ...database,
    ...(polymarketPolygonRpc ? { polymarketPolygonRpc,
      polymarketResolutionRpcAuthorized: env.POLYMARKET_CTF_RESOLUTION_AUTHORIZED === 'YES' } : {}),
    kalshi,
    ecbReferenceAuthorized: localDevelopment && env.ECB_FX_REFERENCE_AUTHORIZED === 'YES',
    polymarketStreamAuthorized: localDevelopment && env.POLYMARKET_MARKET_STREAM_AUTHORIZED === 'YES',
    ...(localDevelopment && env.CONTINUOUS_TRACKING_ENABLED === 'YES' ? { tracking: {
      accountIds: z.array(z.uuid()).max(20).parse((env.TRACKED_PROVIDER_ACCOUNT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)),
      retentionDays: z.coerce.number().int().min(1).max(366).parse(env.MARKET_TRACKING_RETENTION_DAYS),
      marketIntervalMs: z.coerce.number().int().min(60_000).max(3_600_000).parse(env.MARKET_TRACKING_INTERVAL_MS ?? '300000'),
      accountIntervalMs: z.coerce.number().int().min(300_000).max(3_600_000).parse(env.ACCOUNT_TRACKING_INTERVAL_MS ?? '900000'),
    } } : {}),
    ...(localDevelopment && env.DEMO_CAPTURE_AUTHORIZED === 'YES' && env.DEMO_DATASET_PATH?.startsWith('/') ? {
      demoDataset: { path: env.DEMO_DATASET_PATH, allowFixture: false,
        cacheMs: z.coerce.number().int().min(1000).max(3_600_000).parse(env.DEMO_DATASET_CACHE_MS ?? '60000') },
    } : {}),
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

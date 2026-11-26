import { createHash, createPublicKey } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import { portfolios, providerAccounts } from '../../db/schema.js'
import type { ServerConfig } from '../../config.js'
import { ProviderAdapterError, type FetchPageRequest } from '../adapter.js'
import { KalshiAdapter } from './adapter.js'
import { KalshiClient, kalshiSigner, type KalshiTransport } from './client.js'
import { KalshiMarketDataService } from './market-data.js'

export function kalshiCredentialSourceId(environment: 'demo' | 'production', keyId: string, pem: Buffer) {
  const publicKey = createPublicKey(pem).export({ format: 'der', type: 'spki' })
  const identity = createHash('sha256').update(keyId).update(Buffer.from([0])).update(publicKey).digest('hex')
  return 'kalshi:' + environment + ':primary:0:' + identity
}

export function createKalshiLive(config: ServerConfig, database: Database, transport: KalshiTransport = fetch) {
  const settings = config.kalshi
  if (config.nodeEnv !== 'development' || !['127.0.0.1', '::1'].includes(config.host) || !settings?.publicAuthorized) return null
  const { environment, binding } = settings
  const sourcePrefix = 'kalshi:' + environment + ':primary:0:'
  const publicClient = new KalshiClient(transport, environment)
  const cache: { entry?: { fingerprint: string; client: KalshiClient } } = {}

  async function resolve(request: FetchPageRequest) {
    if (!binding || request.providerAccountId !== binding.accountId || (!request.externalAccountId.startsWith(sourcePrefix) || !/^[0-9a-f]{64}$/.test(request.externalAccountId.slice(sourcePrefix.length)))) {
      throw new ProviderAdapterError('kalshi_account_binding_mismatch', false)
    }
    const [account] = await database.select({ id: providerAccounts.id }).from(providerAccounts)
      .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
      .where(and(eq(providerAccounts.id, binding.accountId), eq(portfolios.id, binding.portfolioId),
        eq(portfolios.ownerId, config.devPrincipalId), isNull(portfolios.demo), eq(providerAccounts.providerCode, 'kalshi'),
        eq(providerAccounts.kind, 'authenticated_account'), eq(providerAccounts.externalAccountId, request.externalAccountId),
        isNull(providerAccounts.disabledAt))).limit(1)
    if (!account) throw new ProviderAdapterError('kalshi_account_binding_mismatch', false)

    try {
      const handle = await open(binding.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16_384) {
          throw new Error('invalid private key file')
        }
        const bytes = Buffer.alloc(16_385)
        try {
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
          if (bytesRead !== info.size || bytesRead >= bytes.length) throw new Error('private key file changed')
          const material = bytes.subarray(0, bytesRead)
          if (kalshiCredentialSourceId(environment, binding.keyId, material) !== request.externalAccountId) {
            throw new ProviderAdapterError('kalshi_credential_source_mismatch', false)
          }
          if (request.streamName === 'markets') return publicClient
          const fingerprint = createHash('sha256').update(material).digest('hex')
          if (cache.entry?.fingerprint === fingerprint) return cache.entry.client
          const client = new KalshiClient(transport, environment, {
            id: binding.keyId, sign: kalshiSigner(material.toString('utf8')), primaryOnly: true,
          })
          cache.entry = { fingerprint, client }
          return client
        } finally {
          bytes.fill(0)
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      delete cache.entry
      if (error instanceof ProviderAdapterError) throw error
      throw new ProviderAdapterError('kalshi_credential_unavailable', false)
    }
  }

  return {
    marketData: new KalshiMarketDataService(publicClient, environment === 'demo' ? 'demo:' : '', true),
    adapter: new KalshiAdapter(undefined, settings.accountAuthorized && binding ? resolve : undefined, environment),
    accountId: settings.accountAuthorized ? binding?.accountId : undefined,
  }
}

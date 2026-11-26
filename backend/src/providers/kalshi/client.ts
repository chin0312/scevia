import { constants, createPrivateKey, sign } from 'node:crypto'
import { ProviderAdapterError } from '../adapter.js'

export const kalshiPaths = {
  keys: '/api_keys', fills: '/portfolio/fills', historicalFills: '/historical/fills',
  positions: '/portfolio/positions', balance: '/portfolio/balance', cutoff: '/historical/cutoff',
  settlements: '/portfolio/settlements', historicalPositions: '/historical/positions',
  markets: '/markets', events: '/events',
} as const
export type KalshiRead = keyof typeof kalshiPaths | 'market' | 'historicalMarket' | 'event'
export type KalshiTransport = (url: URL, init: RequestInit) => Promise<Response>

export function kalshiSigner(pem: string) {
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType === 'ed25519') return (message: string) => sign(null, Buffer.from(message), key).toString('base64')
  if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) {
    return (message: string) => sign('sha256', Buffer.from(message), {
      key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64')
  }
  throw new ProviderAdapterError('kalshi_signing_key_unsupported', false)
}

/** No default network transport or production credential wiring. */
export class KalshiClient {
  constructor(private readonly transport: KalshiTransport, private readonly environment: 'demo' | 'production' = 'demo',
    private readonly credential?: { id: string; sign: (message: string) => string }) {}

  async read(operation: KalshiRead, query: URLSearchParams, signal: AbortSignal, ticker?: string): Promise<unknown> {
    let path: string
    if (operation === 'market' || operation === 'historicalMarket' || operation === 'event') {
      if (!ticker || !/^[A-Z0-9][A-Z0-9_-]{0,127}$/.test(ticker)) throw new ProviderAdapterError('kalshi_invalid_ticker', false)
      path = '/' + (operation === 'historicalMarket' ? 'historical/markets' : operation === 'market' ? 'markets' : 'events') + '/' + ticker
    } else {
      if (!Object.hasOwn(kalshiPaths, operation)) throw new ProviderAdapterError('kalshi_read_not_allowlisted', false)
      path = kalshiPaths[operation]
    }
    const origin = this.environment === 'demo' ? 'https://external-api.demo.kalshi.co' : 'https://external-api.kalshi.com'
    const url = new URL('/trade-api/v2' + path, origin)
    url.search = query.toString()
    const timestamp = String(Date.now())
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.credential) {
      headers['KALSHI-ACCESS-KEY'] = this.credential.id
      headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp
      headers['KALSHI-ACCESS-SIGNATURE'] = this.credential.sign(timestamp + 'GET' + url.pathname)
    }
    let response: Response
    try { response = await this.transport(url, { method: 'GET', headers, signal, redirect: 'error' }) }
    catch { throw new ProviderAdapterError('kalshi_transport_error', true) }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      const header = response.headers.get('retry-after')
      const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : null
      throw new ProviderAdapterError('kalshi_http_' + response.status, retryable, Number.isSafeInteger(delay) ? delay : null)
    }
    try { return await response.json() }
    catch { throw new ProviderAdapterError('kalshi_invalid_response', false) }
  }

  async verifyReadOnly(signal: AbortSignal) {
    if (!this.credential) throw new ProviderAdapterError('kalshi_credential_missing', false)
    const result = await this.read('keys', new URLSearchParams(), signal) as { api_keys?: Array<{ api_key_id: string; scopes?: unknown }> }
    const matches = Array.isArray(result?.api_keys) ? result.api_keys.filter((key) => key?.api_key_id === this.credential!.id) : []
    const scopes = matches.length === 1 ? matches[0]?.scopes : null
    if (!Array.isArray(scopes) || !scopes.includes('read') || scopes.some((scope) => !['read', 'read::portfolio_balance'].includes(scope))) {
      throw new ProviderAdapterError('kalshi_read_scope_unverified', false)
    }
  }
}

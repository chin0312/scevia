import { constants, createPrivateKey, sign } from 'node:crypto'
import { ProviderAdapterError } from '../adapter.js'

export const kalshiPaths = {
  keys: '/api_keys', fills: '/portfolio/fills', historicalFills: '/historical/fills',
  positions: '/portfolio/positions', balance: '/portfolio/balance', cutoff: '/historical/cutoff',
  settlements: '/portfolio/settlements', deposits: '/portfolio/deposits', withdrawals: '/portfolio/withdrawals',
  credits: '/portfolio/credit_history', historicalPositions: '/historical/positions',
  markets: '/markets', events: '/events',
} as const
export type KalshiRead = keyof typeof kalshiPaths | 'market' | 'historicalMarket' | 'historicalCandles' | 'currentCandles' | 'event' | 'series'
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

const publicReads = new Set<KalshiRead>(['cutoff', 'markets', 'events', 'market', 'historicalMarket', 'historicalCandles', 'currentCandles', 'event', 'series'])
const paginated = ['limit', 'cursor']
const queryKeys: Partial<Record<KalshiRead, string[]>> = {
  markets: [...paginated, 'event_ticker', 'tickers'], events: [...paginated],
  fills: [...paginated, 'subaccount', 'min_ts', 'max_ts'],
  historicalFills: [...paginated, 'subaccount', 'min_ts', 'max_ts'],
  positions: [...paginated, 'subaccount', 'settlement_status'],
  historicalPositions: [...paginated, 'subaccount'], balance: ['subaccount', 'exchange_index'],
  settlements: [...paginated, 'subaccount'], deposits: paginated, withdrawals: paginated, credits: paginated,
  historicalCandles: ['start_ts', 'end_ts', 'period_interval'],
  currentCandles: ['start_ts', 'end_ts', 'period_interval'],
}
const maxResponseBytes = 4 * 1024 * 1024

/** Fixed-origin transport. Private reads verify their credential at the transport boundary. */
export class KalshiClient {
  constructor(private readonly transport: KalshiTransport, private readonly environment: 'demo' | 'production' = 'demo',
    private readonly credential?: { id: string; sign: (message: string) => string; primaryOnly?: boolean }) {}

  private authorizedUntil = 0

  async read(operation: KalshiRead, query: URLSearchParams, signal: AbortSignal, ticker?: string, series?: string): Promise<unknown> {
    let path: string
    if (operation === 'currentCandles') {
      if (!ticker || !series || !/^[A-Z0-9][A-Z0-9_.-]{0,127}$/.test(ticker) || !/^[A-Z0-9][A-Z0-9_.-]{0,127}$/.test(series)) {
        throw new ProviderAdapterError('kalshi_invalid_ticker', false)
      }
      path = '/series/' + series + '/markets/' + ticker + '/candlesticks'
    } else if (operation === 'market' || operation === 'historicalMarket' || operation === 'historicalCandles' || operation === 'event' || operation === 'series') {
      if (!ticker || !/^[A-Z0-9][A-Z0-9_.-]{0,127}$/.test(ticker)) throw new ProviderAdapterError('kalshi_invalid_ticker', false)
      path = '/' + (operation === 'historicalMarket' || operation === 'historicalCandles' ? 'historical/markets' : operation === 'market' ? 'markets' : operation === 'series' ? 'series' : 'events') + '/' + ticker + (operation === 'historicalCandles' ? '/candlesticks' : '')
    } else {
      if (!Object.hasOwn(kalshiPaths, operation)) throw new ProviderAdapterError('kalshi_read_not_allowlisted', false)
      path = kalshiPaths[operation]
    }
    const origin = this.environment === 'demo' ? 'https://external-api.demo.kalshi.co' : 'https://external-api.kalshi.com'
    const url = new URL('/trade-api/v2' + path, origin)
    if ([...query].some(([name, value]) => !queryKeys[operation]?.includes(name)
      || query.getAll(name).length !== 1 || !value || value.length > 4000)) {
      throw new ProviderAdapterError('kalshi_query_not_allowlisted', false)
    }
    if (this.credential?.primaryOnly && ['subaccount', 'exchange_index'].some((key) => query.has(key) && query.get(key) !== '0')) {
      throw new ProviderAdapterError('kalshi_account_scope_unverified', false)
    }
    const privateRead = !publicReads.has(operation)
    if (privateRead && this.credential && operation !== 'keys' && Date.now() >= this.authorizedUntil) {
      await this.verifyReadOnly(signal)
    }
    url.search = query.toString()
    const timestamp = String(Date.now())
    const headers: Record<string, string> = { accept: 'application/json' }
    if (privateRead && this.credential) {
      headers['KALSHI-ACCESS-KEY'] = this.credential.id
      headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp
      headers['KALSHI-ACCESS-SIGNATURE'] = this.credential.sign(timestamp + 'GET' + url.pathname)
    }
    let response: Response
    try { response = await this.transport(url, { method: 'GET', headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), redirect: 'error' }) }
    catch { throw new ProviderAdapterError('kalshi_transport_error', true) }
    if (!response.ok) {
      if (privateRead && (response.status === 401 || response.status === 403)) this.authorizedUntil = 0
      void response.body?.cancel().catch(() => {})
      const retryable = response.status === 429 || response.status >= 500
      const header = response.headers.get('retry-after')
      const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : null
      throw new ProviderAdapterError('kalshi_http_' + response.status, retryable, Number.isSafeInteger(delay) ? delay : null)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new ProviderAdapterError('kalshi_invalid_response', false)
    try {
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxResponseBytes) throw new ProviderAdapterError('kalshi_response_too_large', false)
        chunks.push(value)
      }
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error
      throw new ProviderAdapterError('kalshi_invalid_response', false)
    } finally {
      void reader.cancel().catch(() => {})
    }
  }

  async verifyReadOnly(signal: AbortSignal) {
    if (!this.credential) throw new ProviderAdapterError('kalshi_credential_missing', false)
    this.authorizedUntil = 0
    const result = await this.read('keys', new URLSearchParams(), signal) as { api_keys?: Array<{ api_key_id: string; scopes?: unknown; subaccount?: unknown; fcm_subtrader_id?: unknown }> }
    const matches = Array.isArray(result?.api_keys) ? result.api_keys.filter((key) => key?.api_key_id === this.credential!.id) : []
    const scopes = matches.length === 1 ? matches[0]?.scopes : null
    const key = matches[0]
    if (this.credential.primaryOnly && key && ((key.subaccount !== undefined && key.subaccount !== null && key.subaccount !== 0)
      || (key.fcm_subtrader_id !== undefined && key.fcm_subtrader_id !== null))) {
      throw new ProviderAdapterError('kalshi_account_scope_unverified', false)
    }
    if (!Array.isArray(scopes) || !scopes.includes('read') || scopes.some((scope) => !['read', 'read::portfolio_balance'].includes(scope))) {
      throw new ProviderAdapterError('kalshi_read_scope_unverified', false)
    }
    this.authorizedUntil = Date.now() + 30_000
  }
}

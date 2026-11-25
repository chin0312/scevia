import { Decimal } from 'decimal.js'

const DATA_API = 'https://data-api.polymarket.com'
const GAMMA_API = 'https://gamma-api.polymarket.com'
const CLOB_API = 'https://clob.polymarket.com'
const MAX_RESPONSE_BYTES = 2_000_000
const DEFAULT_TIMEOUT_MS = 8_000

const financialNumberKeys = new Set([
  'size', 'price', 'usdc_size', 'current_size', 'avg_price', 'current_price',
  'current_value', 'entry_cost_usdc', 'entry_fees_usdc', 'total_cost_usdc',
  'total_size', 'realized_pnl', 'unrealized_pnl', 'total_pnl', 'percent_pnl',
  'percent_realized_pnl', 'final_price', 'payout', 'volume', 'liquidity',
])

interface JsonSourceContext {
  source?: string
}

type JsonParseWithSource = (
  text: string,
  reviver: (this: unknown, key: string, value: unknown, context: JsonSourceContext) => unknown,
) => unknown

const parseJsonWithSource = JSON.parse as unknown as JsonParseWithSource

/** Preserve JSON decimal lexemes for known financial fields on the required Node 24 runtime. */
export function parseProviderJson(text: string): unknown {
  return parseJsonWithSource(text, function (key, value, context) {
    if (typeof value === 'number' && financialNumberKeys.has(key) && context.source !== undefined) {
      return context.source
    }
    return value
  })
}

export class PolymarketRequestError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(code)
    this.name = 'PolymarketRequestError'
  }
}

export class PolymarketHttpClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  getData(path: string, query: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
    return this.request(DATA_API, `/v2/${path}`, query, { method: 'GET' }, signal)
  }

  getGamma(path: string, query: URLSearchParams = new URLSearchParams(), signal?: AbortSignal): Promise<unknown> {
    return this.request(GAMMA_API, `/${path}`, query, { method: 'GET' }, signal)
  }

  postClob(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request(CLOB_API, `/${path}`, new URLSearchParams(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, signal)
  }

  private async request(
    base: string,
    path: string,
    query: URLSearchParams,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path, base)
    query.forEach((value, key) => url.searchParams.set(key, value))
    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    let response: Response
    try {
      response = await this.fetcher(url, {
        ...init,
        signal: combinedSignal,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'user-agent': 'Scevia-Backend/0.1 read-only',
          ...init.headers,
        },
      })
    } catch (error) {
      if (error instanceof PolymarketRequestError) throw error
      throw new PolymarketRequestError('polymarket_upstream_unavailable', true)
    }

    if (!response.ok) {
      const status = response.status
      const retryable = status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
      throw new PolymarketRequestError(
        status === 429 ? 'polymarket_rate_limited' : status === 404 ? 'polymarket_not_found' : 'polymarket_upstream_error',
        retryable,
        parseRetryAfter(response.headers.get('retry-after')),
        status,
      )
    }

    const text = await readBoundedText(response, MAX_RESPONSE_BYTES)
    try {
      return parseProviderJson(text)
    } catch {
      throw new PolymarketRequestError('polymarket_invalid_json', false, null, response.status)
    }
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new PolymarketRequestError('polymarket_response_too_large', false, null, response.status)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof PolymarketRequestError) throw error
    throw new PolymarketRequestError('polymarket_upstream_read_failed', true, null, response.status)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 120_000)
  const retryAt = Date.parse(value)
  return Number.isFinite(retryAt) ? Math.max(0, Math.min(retryAt - Date.now(), 120_000)) : null
}

export function decimalString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) return null
  try {
    const result = new Decimal(text)
    return result.isFinite() ? result.toFixed() : null
  } catch {
    return null
  }
}

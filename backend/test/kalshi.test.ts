import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { KalshiClient, kalshiSigner } from '../src/providers/kalshi/client.js'
import { KalshiMarketDataService, parseKalshiLink } from '../src/providers/kalshi/market-data.js'
import { parseMappedKalshiCsv } from '../src/accounting/kalshi-csv.js'

const signal = new AbortController().signal
describe('restricted Kalshi contracts', () => {
  it('signs the fixed GET path without query data and rejects excessive scopes', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const sign = kalshiSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    let scopes = ['read']
    const client = new KalshiClient(async (url, init) => {
      const headers = new Headers(init.headers)
      const message = headers.get('kalshi-access-timestamp') + 'GET' + url.pathname
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
      expect(verify(null, Buffer.from(message), publicKey, Buffer.from(headers.get('kalshi-access-signature')!, 'base64'))).toBe(true)
      expect(url.origin).toBe('https://external-api.demo.kalshi.co')
      return Response.json({ api_keys: [{ api_key_id: 'fixture-key', scopes }] })
    }, 'demo', { id: 'fixture-key', sign })
    await expect(client.verifyReadOnly(signal)).resolves.toBeUndefined()
    scopes = ['read', 'write::trade']
    await expect(client.verifyReadOnly(signal)).rejects.toThrow('kalshi_read_scope_unverified')
    await expect(client.read('orders' as never, new URLSearchParams(), signal)).rejects.toThrow('kalshi_read_not_allowlisted')
    await expect(client.read('market', new URLSearchParams(), signal, '../orders')).rejects.toThrow('kalshi_invalid_ticker')
  })
  it('classifies rate limits for bounded ingestion retry', async () => {
    const client = new KalshiClient(async () => Response.json({}, { status: 429, headers: { 'Retry-After': '2' } }))
    await expect(client.read('fills', new URLSearchParams(), signal)).rejects.toMatchObject({
      code: 'kalshi_http_429', retryable: true, retryAfterMs: 2000,
    })
  })
  it('preserves missing historical closes and labels NO complements', async () => {
    const service = new KalshiMarketDataService(new KalshiClient(async (url) => {
      expect(url.pathname).toBe('/trade-api/v2/historical/markets/KX-V1/candlesticks')
      return Response.json({ ticker: 'KX-V1', candlesticks: [{ end_period_ts: 120, price: { close: '0.41' } },
        { end_period_ts: 180, price: { close: null } }] })
    }))
    const result = await service.historicalPrices({ marketTicker: 'KX-V1', side: 'no', from: 60, through: 180, minutes: 1 }, signal)
    expect(result).toMatchObject({ evidence: 'archived_yes_close_complement', items: [{ price: '0.59' }, { price: null }] })
  })
  it('requires known public links and explicitly mapped transaction columns', () => {
    expect(parseKalshiLink('https://kalshi.com/events/KX-EXAMPLE')).toEqual({ kind: 'event', ticker: 'KX-EXAMPLE' })
    expect(() => parseKalshiLink('https://kalshi.com.attacker.test/events/KX')).toThrow('kalshi_invalid_market_link')
    const result = parseMappedKalshiCsv('id,time,ticker,side,action,lots,cents,fee\n1,2026-11-20T01:02:00Z,KX-V1,NO,buy,2.5,40,1\n2,11/01/2026,KX-V1,YES,buy,1,25,0',
      { format: 'kalshi_activity', activity: 'fill', units: 'cents', account: 'manual',
        columns: { id: 'id', timestamp: 'time', ticker: 'ticker', side: 'side', action: 'action', quantity: 'lots', price: 'cents', fee: 'fee' } })
    expect(result.rows).toMatchObject([{ id: '1', instrument: 'KX-V1:no', asset: 'USD', price: '0.4', quantity: '2.5', fee: '0.01' }])
    expect(result.issues).toEqual([{ row: 3, code: 'invalid_event_order' }])
  })
})

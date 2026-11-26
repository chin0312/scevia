import { Decimal } from 'decimal.js'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { polygonPusd } from '../providers/polymarket/collateral.js'
import { storeReferences } from './reference.js'

const chain = 'polygon-pos'
const source = 'coingecko_polygon_pusd_usd'
const url = 'https://api.coingecko.com/api/v3/simple/token_price/' + chain
  + '?contract_addresses=' + polygonPusd + '&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true'
const quote = z.object({ usd: z.number().positive(), usd_24h_vol: z.number().positive(),
  last_updated_at: z.number().int().positive() })

async function readJson(endpoint: string, key: string, signal: AbortSignal, transport: typeof fetch, limit: number): Promise<unknown> {
  const response = await transport(endpoint, { headers: { 'x-cg-demo-api-key': key }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]) })
  if (!response.ok || !response.body) throw new Error('coingecko_pusd_reference_unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new Error('coingecko_reference_size')
      chunks.push(value)
    }
  } finally { void reader.cancel().catch(() => undefined) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const identity = { chain, contract: polygonPusd, quoteBasis: 'vendor_aggregated_fiat_usd' }
const formatRate = (rate: number) => new Decimal(rate).toDecimalPlaces(18).toFixed()

export async function refreshPusd(db: Pick<Database, 'insert'>, key: string, signal: AbortSignal, transport = fetch) {
  const envelope = z.record(z.string(), z.unknown()).parse(await readJson(url, key, signal, transport, 16_000))
  const row = quote.parse(envelope[polygonPusd])
  const retrievedAt = new Date().toISOString()
  const observedAt = new Date(row.last_updated_at * 1000).toISOString()
  await storeReferences(db, [{ base: 'PUSD', quote: 'USD', rate: formatRate(row.usd), source,
    methodology: 'stablecoin_market_reference', observedAt, retrievedAt,
    tokenIdentity: identity }])
}

const series = z.array(z.tuple([z.number().int().positive(), z.number().nonnegative()])).max(600)
export async function archivePusd(db: Pick<Database, 'insert'>, key: string, signal: AbortSignal, transport = fetch) {
  const endpoint = 'https://api.coingecko.com/api/v3/coins/' + chain + '/contract/' + polygonPusd
    + '/market_chart?vs_currency=usd&days=365&interval=daily'
  const data = z.object({ prices: series, total_volumes: series }).parse(await readJson(endpoint, key, signal, transport, 128_000))
  const retrievedAt = new Date().toISOString()
  const volumes = new Map(data.total_volumes)
  const rows = data.prices.filter(([time, price]) => price > 0 && (volumes.get(time) ?? 0) > 0 && time <= Date.parse(retrievedAt))
    .map(([time, price]) => ({ base: 'PUSD', quote: 'USD', rate: formatRate(price), source: 'coingecko_polygon_pusd_usd_daily',
      methodology: 'stablecoin_market_reference', observedAt: new Date(time).toISOString(), retrievedAt, tokenIdentity: identity }))
  await storeReferences(db, rows)
}

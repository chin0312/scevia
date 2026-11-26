import { Decimal } from 'decimal.js'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { defillamaContracts, defillamaSource, storeReferences } from './reference.js'

const keys = (['USDC', 'PUSD'] as const).map((asset) => [asset, 'polygon:' + defillamaContracts[asset]] as const)
const coins = keys.map(([, key]) => key).join(',')
const point = z.object({ timestamp: z.number().int().positive().max(4_102_444_800), price: z.number().positive() })
const current = point.extend({ confidence: z.number().min(0).max(1), decimals: z.literal(6) })
const chart = current.pick({ confidence: true, decimals: true }).extend({ prices: z.array(point).max(366) })
const envelope = z.object({ coins: z.record(z.string(), z.unknown()) })
const day = 86_400
// Provider confidence is a quality signal. This local admission threshold is
// deliberately conservative and does not certify liquidity or execution.
const minimumConfidence = 0.95

export class DefillamaRateLimit extends Error {
  constructor(readonly retryAfter: string | null) { super('defillama_rate_limit') }
}

async function acquire(db: Pick<Database, 'insert'>, signal: AbortSignal, transport: typeof fetch,
  target: string, cutoff: number | undefined, from?: number) {
  const response = await transport('https://coins.llama.fi/' + target, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]), redirect: 'error',
  })
  if (response.status === 429) throw new DefillamaRateLimit(response.headers.get('retry-after'))
  if (!response.ok || !response.body) throw new Error('defillama_reference_unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > (from === undefined ? 8192 : 128_000)) throw new Error('defillama_reference_size')
      chunks.push(value)
    }
  } finally { void reader.cancel().catch(() => undefined) }

  const retrievedAt = new Date().toISOString()
  const retrieved = Math.floor(Date.parse(retrievedAt) / 1000)
  const { coins: observations } = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const rows = []
  const coverage = []
  for (const [asset, key] of keys) {
    const payload = observations[key]
    const parsed = from === undefined ? current.safeParse(payload) : chart.safeParse(payload)
    const sample = parsed.data
    const points = sample ? ('prices' in sample ? sample.prices : [sample]) : []
    const eligible = points.filter(({ timestamp }) => sample!.confidence >= minimumConfidence
      && timestamp <= (cutoff ?? retrieved) && timestamp <= retrieved
      && (from === undefined || timestamp >= from)
      // Circle's native Polygon contract launched in October 2023. The
      // vendor's oldest USDC price predates this deployment.
      && (asset !== 'USDC' || timestamp >= 1696896000))
    coverage.push({ asset, confidence: sample?.confidence ?? null, received: points.length, eligible: eligible.length,
      status: payload === undefined ? 'missing' : !sample ? 'unsupported' : eligible.length ? 'eligible' : 'ineligible',
      first: eligible.length ? Math.min(...eligible.map((row) => row.timestamp)) : null,
      last: eligible.length ? Math.max(...eligible.map((row) => row.timestamp)) : null })
    for (const { price, timestamp } of eligible) {
      rows.push({ base: asset, quote: 'USD', rate: new Decimal(price).toDecimalPlaces(18).toFixed(),
        source: defillamaSource[asset], methodology: 'stablecoin_market_reference',
        observedAt: new Date(timestamp * 1000).toISOString(), retrievedAt,
        tokenIdentity: { chain: 'polygon-pos', contract: defillamaContracts[asset], quoteBasis: 'vendor_aggregated_fiat_usd' } })
    }
  }
  // Identical raw observations can recur in chart samples. Keep conflicting
  // same-clock prices so the shared selector can surface them.
  const unique = [...new Map(rows.map((row) => [JSON.stringify([row.base, row.observedAt, row.rate]), row])).values()]
  for (let index = 0; index < unique.length; index += 600) await storeReferences(db, unique.slice(index, index + 600))
  return { bytes, coverage, processed: unique.length }
}

export function refreshDefillama(db: Pick<Database, 'insert'>, signal: AbortSignal, transport = fetch) {
  return acquire(db, signal, transport, 'prices/current/' + coins, undefined)
}

export function sampleDefillama(db: Pick<Database, 'insert'>, signal: AbortSignal, cutoff: number, transport = fetch) {
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0 || cutoff > Date.now() / 1000) throw new Error('defillama_cutoff')
  return acquire(db, signal, transport, 'prices/historical/' + cutoff + '/' + coins, cutoff)
}

export async function archiveDefillama(db: Pick<Database, 'insert'>, signal: AbortSignal, days: number, transport = fetch,
  through = Math.floor(Date.now() / 86_400_000) * day) {
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isSafeInteger(through)
    || through < days * day || through > Date.now() / 1000) throw new Error('defillama_archive_range')
  // The API accepts either a start or end anchor, even though both are
  // documented query parameters. Use an end anchor and enforce both bounds locally.
  const from = through - (days - 1) * day
  const windows = []
  // The service caps the combined request at 500 chart points for both tokens.
  for (let remaining = days; remaining > 0;) {
    const span = Math.min(250, remaining)
    const end = from + (remaining - 1) * day
    const query = new URLSearchParams({ end: String(end), span: String(span), period: '1d' })
    const started = performance.now()
    const result = await acquire(db, signal, transport, 'chart/' + coins + '?' + query, through, from)
    windows.push({ end, span, elapsedMs: Math.round(performance.now() - started), ...result })
    remaining -= span
  }
  return { from, through, windows, processed: windows.reduce((count, window) => count + window.processed, 0) }
}

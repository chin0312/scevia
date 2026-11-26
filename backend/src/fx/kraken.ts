import { z } from 'zod'
import type { Database } from '../db/client.js'
import { storeReferences } from './reference.js'

export async function refreshUsdc(db: Pick<Database, 'insert'>, signal: AbortSignal, transport = fetch, archival = false) {
  const interval = archival ? 1440 : 60
  const url = 'https://api.kraken.com/0/public/OHLC?pair=USDCUSD&interval=' + interval
  const response = await transport(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('kraken_usdc_reference_unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 512_000) throw new Error('kraken_reference_size')
      chunks.push(value)
    }
  } finally { void reader.cancel().catch(() => undefined) }
  const envelope = z.object({ error: z.array(z.string()).length(0), result: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const bars = z.array(z.tuple([z.number().int().positive(), z.string(), z.string(), z.string(),
    z.string(), z.string(), z.string(), z.number().int().nonnegative()])).max(721).parse(envelope.result.USDCUSD)
  const retrievedAt = new Date().toISOString()
  const rows = bars.slice(0, -1).filter((bar) => bar[7] > 0)
    .map((bar) => ({ base: 'USDC', quote: 'USD', source: 'kraken_usdc_usd_ohlc', methodology: 'stablecoin_market_reference',
      rate: bar[4], observedAt: new Date((bar[0] + interval * 60) * 1000).toISOString(), retrievedAt }))
    .filter((bar) => bar.observedAt <= retrievedAt)
  await storeReferences(db, rows.slice(archival ? -365 : -24))
}

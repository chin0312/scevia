import type { Database } from '../db/client.js'
import { reportingCurrency, storeReferences } from './reference.js'

const url = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

export async function refreshEcb(db: Pick<Database, 'insert'>, signal: AbortSignal, transport = fetch) {
  const response = await transport(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('ecb_reference_unavailable')
  const reader = response.body.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 32_000) throw new Error('ecb_reference_size')
      chunks.push(value)
    }
  } finally { void reader.cancel().catch(() => undefined) }
  const text = Buffer.concat(chunks).toString('utf8')
  const date = /<Cube time=['"](\d{4}-\d{2}-\d{2})['"]>/.exec(text)?.[1]
  if (!date) throw new Error('ecb_reference_date_unavailable')
  const rows = Array.from(text.matchAll(/<Cube currency=['"]([A-Z]{3})['"] rate=['"]([\d.]+)['"]\s*\/>/g))
    .flatMap((match) => reportingCurrency.safeParse(match[1]).success ? [{ base: 'EUR', quote: match[1], rate: match[2],
      source: 'ecb_euro_reference', methodology: 'fiat_reference', observedAt: date + 'T00:00:00.000Z',
      retrievedAt: new Date().toISOString() }] : [])
  await storeReferences(db, rows)
}

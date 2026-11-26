import type { Database } from '../db/client.js'
import { reportingCurrency, storeReferences } from './reference.js'

const origin = 'https://www.ecb.europa.eu/stats/eurofxref/'

export async function refreshEcb(db: Pick<Database, 'insert'>, signal: AbortSignal, transport = fetch, archival = false) {
  const response = await transport(origin + (archival ? 'eurofxref-hist-90d.xml' : 'eurofxref-daily.xml'), { signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('ecb_reference_unavailable')
  const reader = response.body.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > (archival ? 512_000 : 32_000)) throw new Error('ecb_reference_size')
      chunks.push(value)
    }
  } finally { void reader.cancel().catch(() => undefined) }
  const text = Buffer.concat(chunks).toString('utf8')
  const dates = text.split(/<Cube time=['"](\d{4}-\d{2}-\d{2})['"]>/)
  const retrievedAt = new Date().toISOString()
  const rows = []
  for (let index = 1; index + 1 < dates.length; index += 2) {
    const date = dates[index]!
    for (const match of dates[index + 1]!.matchAll(/<Cube currency=['"]([A-Z]{3})['"] rate=['"]([\d.]+)['"]\s*\/>/g)) {
      if (!reportingCurrency.safeParse(match[1]).success) continue
      if (date + 'T00:00:00.000Z' > retrievedAt) continue
      rows.push({ base: 'EUR', quote: match[1], rate: match[2], source: 'ecb_euro_reference', methodology: 'fiat_reference',
        observedAt: date + 'T00:00:00.000Z', retrievedAt })
    }
  }
  await storeReferences(db, rows)
}

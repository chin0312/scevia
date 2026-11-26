import type { Database } from '../db/client.js'
import { reportingCurrency, storeReferences } from './reference.js'

const origin = 'https://www.ecb.europa.eu/stats/eurofxref/'

export async function refreshEcb(db: Pick<Database, 'insert'>, signal: AbortSignal, transport = fetch, archival = false) {
  const response = await transport(origin + (archival ? 'eurofxref-hist-90d.xml' : 'eurofxref-daily.xml'), { signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]), redirect: 'error' })
  const text = await readEcb(response, archival ? 512_000 : 32_000)
  const dates = text.split(/<Cube time=['"](\d{4}-\d{2}-\d{2})['"]>/)
  const retrievedAt = new Date().toISOString()
  const rows = []
  for (let index = 1; index + 1 < dates.length; index += 2) {
    const date = dates[index]!
    for (const match of dates[index + 1]!.matchAll(/<Cube currency=['"]([A-Z]{3})['"] rate=['"]([\d.]+)['"]\s*\/>/g)) {
      if (!reportingCurrency.safeParse(match[1]).success) continue
      if (date + 'T00:00:00.000Z' > retrievedAt) continue
      rows.push(ecbRow(date, match[1]!, match[2]!, retrievedAt))
    }
  }
  await storeReferences(db, rows)
}

function ecbRow(date: string, quote: string, rate: string, retrievedAt: string) {
  return { base: 'EUR', quote, rate, source: 'ecb_euro_reference', methodology: 'fiat_reference',
    observedAt: date + 'T00:00:00.000Z', retrievedAt } as const
}

async function readEcb(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error('ecb_reference_unavailable')
  const reader = response.body.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new Error('ecb_reference_size')
      chunks.push(value)
    }
  } finally { void reader.cancel().catch(() => undefined) }
  return Buffer.concat(chunks).toString('utf8')
}

export async function refreshEcbAnnual(db: Pick<Database, 'insert'>, signal: AbortSignal, transport = fetch) {
  const dayMs = 86_400_000
  const through = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.parse(through) - 365 * dayMs).toISOString().slice(0, 10)
  const url = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD+GBP.EUR.SP00.A?'
    + new URLSearchParams({ startPeriod: from, endPeriod: through, format: 'csvdata', detail: 'dataonly' })
  const response = await transport(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]), redirect: 'error' })
  const [header, ...lines] = (await readEcb(response, 64_000)).trim().split(/\r?\n/)
  if (header !== 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE') {
    throw new Error('ecb_annual_schema')
  }
  const retrievedAt = new Date().toISOString()
  const rows = lines.map((line) => {
    const match = /^EXR\.D\.(USD|GBP)\.EUR\.SP00\.A,D,\1,EUR,SP00,A,(\d{4}-\d{2}-\d{2}),(\d+(?:\.\d+)?)$/.exec(line)
    if (!match || match[2]! < from || match[2]! > through) throw new Error('ecb_annual_observation')
    return ecbRow(match[2]!, match[1]!, match[3]!, retrievedAt)
  })
  await storeReferences(db, rows)
}

// ECB publishes around 16:00 Central European time on working days. The
// UTC cutoff leaves a margin across both European daylight-saving regimes.
export function nextEcbRefresh(now: Date) {
  const next = new Date(now)
  next.setUTCHours(16, 0, 0, 0)
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime()
}

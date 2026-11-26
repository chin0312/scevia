import { strict as assert } from 'node:assert'
import { Decimal } from 'decimal.js'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { createDatabase } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { fxReferences, users } from '../src/db/schema.js'
import { refreshEcb } from '../src/fx/ecb.js'
import { buildApp } from '../src/http/app.js'

if (process.argv.length !== 3 || process.argv[2] !== '--confirm-ecb-reuse') {
  throw new Error('Pass --confirm-ecb-reuse after reviewing ECB attribution and modification conditions')
}

const pg = new PGlite()
const socket = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: 0 })
let port = 0
socket.addEventListener('listening', (event) => { port = (event as CustomEvent<{ port: number }>).detail.port }, { once: true })
await socket.start()
const url = 'postgresql://postgres:postgres@127.0.0.1:' + port + '/postgres'
const { database, pool } = createDatabase({ url, ssl: false })
const owner = '00000000-0000-4000-8000-000000000001'
const token = 'local-ecb-validation-only-fixture-token'
const requests: Array<{ feed: string; status: number; bytes: number; elapsedMs: number }> = []
const transport: typeof fetch = async (input, options) => {
  const start = performance.now()
  const response = await fetch(input, options)
  const request = { feed: new URL(String(input)).pathname.split('/').at(-1)!, status: response.status, bytes: 0, elapsedMs: 0 }
  requests.push(request)
  if (!response.body) return response
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { request.bytes += chunk.byteLength; controller.enqueue(chunk) },
    flush() { request.elapsedMs = Math.round(performance.now() - start) },
  }))
  return new Response(stream, { status: response.status, headers: response.headers })
}
let app: Awaited<ReturnType<typeof buildApp>> | undefined
try {
  await runMigrations(database)
  await database.insert(users).values({ id: owner, authSubject: 'ecb-live-local' })
  const signal = AbortSignal.timeout(20_000)
  await refreshEcb(database, signal, transport)
  const daily = await database.select().from(fxReferences)
  await refreshEcb(database, signal, transport, true)
  const history = await database.select().from(fxReferences)
  assert(daily.length > 0)
  assert(history.length > daily.length)
  assert.equal(new Set(history.map((row) => row.revision)).size, history.length)
  const days = [...new Set(history.map((row) => row.observedAt.toISOString().slice(0, 10)))].sort()
  const first = days[0]!
  const last = days.at(-1)!
  assert(days.every((date) => ![0, 6].includes(new Date(date).getUTCDay())))
  const nextDay = (date: string) => new Date(Date.parse(date) + 86_400_000).toISOString()
  const from = nextDay(first)
  // Use the following UTC day for archive clocks, or local retrieval if the
  // latest business-day rate was published earlier today.
  const now = new Date().toISOString()
  const through = nextDay(last) > now ? now : nextDay(last)
  const recentFriday = days.findLast((date) => new Date(date).getUTCDay() === 5
    && Date.parse(date) + 2 * 86_400_000 < Date.parse(through))
  assert(recentFriday)
  const sunday = new Date(Date.parse(recentFriday) + 2 * 86_400_000).toISOString()
  const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN })
  const reference = (date: string, quote: string) => new D(history.find((row) =>
    row.quote === quote && row.observedAt.toISOString().startsWith(date))!.rate)

  app = await buildApp({ database, config: { url, ssl: false, nodeEnv: 'test', authMode: 'development',
    devPrincipalId: owner, devAuthToken: token, host: '127.0.0.1', port: 3001, corsOrigins: [] } })
  async function request(method: 'GET' | 'POST', path: string, payload?: object) {
    const result = await app!.inject({ method, url: '/v1' + path, headers: { authorization: 'Bearer ' + token },
      ...(payload ? { payload } : {}) })
    assert(result.statusCode < 400, method + ' ' + path + ' returned ' + result.statusCode + ' ' + result.body)
    return result.json()
  }

  const read = (base: string, currency: string, asOf?: string, mode?: string) => request('GET', '/fx/reference?' +
    new URLSearchParams({ base, currency, ...(asOf ? { asOf } : {}), ...(mode ? { mode } : {}) }))
  const direct = await read('EUR', 'USD')
  const currentDate = new Date(direct.legs[0].observedAt).toISOString().slice(0, 10)
  assert([last, daily[0]!.observedAt.toISOString().slice(0, 10)].includes(currentDate))
  const inverse = await read('USD', 'EUR')
  const cross = await read('USD', 'GBP')
  assert.equal(direct.rate, reference(currentDate, 'USD').toFixed())
  assert.equal(inverse.rate, new D(1).div(reference(currentDate, 'USD')).toFixed())
  assert.equal(cross.rate, new D(inverse.rate).mul(reference(currentDate, 'GBP')).toFixed())
  assert.equal(cross.legs.length, 2)

  const retrospective = await read('EUR', 'GBP', from, 'retrospective')
  const knowledge = await read('EUR', 'GBP', from, 'knowledge')
  assert.equal(retrospective.rate, reference(first, 'GBP').toFixed())
  assert.equal(knowledge.rate, null)
  const weekend = await read('EUR', 'GBP', sunday, 'retrospective')
  assert.equal(weekend.rate, reference(recentFriday, 'GBP').toFixed())
  assert.equal(weekend.legs[0].observedAt.slice(0, 10), recentFriday)
  const { collection } = await request('POST', '/simulations')
  const path = '/simulations/' + collection.id + '/replays'
  const begin = performance.now()
  const preview = await request('POST', path + '/evaluate', { version: 1, from, through, currency: 'GBP',
    buckets: [{ id: 'virtual', venue: 'kalshi', asset: 'USD', capital: '100' }], positions: [] })
  const evaluationMs = Math.round(performance.now() - begin)
  const expectedEnding = new D(1).div(reference(last, 'USD')).mul(reference(last, 'GBP')).mul(100)
  assert.equal(preview.result.summary.ending, expectedEnding.toFixed())
  const saved = await request('POST', path, { name: 'ECB-only validation', previewToken: preview.previewToken })
  const frozen = await request('GET', path + '/' + saved.id)
  assert.deepEqual(frozen.result.summary, preview.result.summary)

  process.stdout.write(JSON.stringify({ source: 'European Central Bank', derivedValues: true, requests,
    archive: { rows: history.length, days: days.length, first, last }, direct: direct.rate, inverse: inverse.rate, cross: cross.rate,
    retrospective: retrospective.rate, knowledge: knowledge.rate,
    weekend: { cutoff: sunday, observationDate: recentFriday, rate: weekend.rate }, virtualCashReplay: {
      currency: 'GBP', nativeOpening: '100 USD', starting: preview.result.summary.starting, ending: preview.result.summary.ending,
      points: preview.result.history.length, evaluationMs, frozenReadback: true,
    },
  }, null, 2) + '\n')
} finally {
  await app?.close()
  await pool.end()
  await socket.stop()
  await pg.close()
}

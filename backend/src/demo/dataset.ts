import { open } from 'node:fs/promises'
import { z } from 'zod'
import { digest } from '../accounting/decisions.js'
import { decimalTextSchema } from '../domain/model.js'
import { Decimal } from 'decimal.js'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString())
const nonnegative = decimalTextSchema.refine((value) => new Decimal(value).gte(0))
const positive = nonnegative.refine((value) => new Decimal(value).gt(0))
const asset = z.enum(['USD', 'USDC', 'PUSD'])
const provider = z.enum(['kalshi', 'polymarket'])
const scope = z.object({ provider, asset })
const market = scope.extend({
  nativeMarket: id, nativeEvent: id, publicLink: z.url().max(2048).optional(), title: z.string().min(1).max(500), eventTitle: z.string().min(1).max(500), category: z.string().max(100).nullable(),
  lifecycle: z.enum(['open', 'closed', 'resolved']), tradingOpensAt: instant.nullable().optional(), tradingClosesAt: instant.nullable().optional(), resolvesAt: instant.nullable(), retrievedAt: instant,
  source: z.enum(['kalshi_trade_api', 'polymarket_gamma', 'authorized_capture']),
  outcomes: z.array(z.object({ instrument: id, name: z.enum(['YES', 'NO']) }).strict()).length(2),
  feeSchedule: z.object({ version: z.literal('kalshi-centicent-quadratic-v1'), rate: nonnegative, makerRate: nonnegative,
    retrievedAt: instant, source: z.enum(['kalshi_series', 'kalshi_event_override']), denomination: z.literal('USD') }).strict().optional(),
  resolution: z.object({ knownAt: instant, winningInstrument: id, unitPayout: z.literal('1'), simulatedPayoutAt: instant.optional(), evidence: z.object({ source: z.literal('reviewed_provider_evidence'), reference: z.string().min(1).max(500), verifiedAt: instant }).strict().optional() }).strict().optional(),
}).strict()
const quote = z.object({
  provider, nativeMarket: id, instrument: id, price: nonnegative.refine((value) => new Decimal(value).lte(1)),
  method: z.enum(['historical_close', 'book_midpoint', 'last_trade']),
  source: z.enum(['kalshi_candlesticks', 'kalshi_book', 'polymarket_clob', 'polymarket_price_history', 'authorized_capture']),
  observedAt: instant.nullable(), retrievedAt: instant,
}).strict()
export const demoDatasetSchema = z.object({
  evidenceKind: z.enum(['authorized_capture', 'fixture']), capturedAt: instant,
  markets: z.array(market).min(1).max(50), quotes: z.array(quote).min(1).max(2000),
  capital: z.array(scope.extend({ openedAt: instant, amount: positive }).strict()).min(1).max(3),
  trades: z.array(z.object({ id, quoteIndex: z.number().int().min(0).max(1999), quantity: positive,
    direction: z.enum(['buy', 'sell']), executionAt: instant.optional(), assumedFee: nonnegative.nullable() }).strict()).min(1).max(100),
}).strict()
export type DemoDataset = z.infer<typeof demoDatasetSchema>
export const accountKey = ({ provider: venue, asset: denomination }: { provider: string; asset: string }) => venue + ':' + denomination
export const marketKey = ({ provider: venue, nativeMarket }: { provider: string; nativeMarket: string }) => venue + ':' + nativeMarket
export const availableAt = (quote: DemoDataset['quotes'][number]) => quote.method === 'historical_close' && quote.observedAt
  ? quote.observedAt : quote.retrievedAt

export const executionAt = (trade: DemoDataset['trades'][number], quote: DemoDataset['quotes'][number]) =>
  trade.executionAt ?? availableAt(quote)

export function demoMarketFingerprint({ retrievedAt: _retrievedAt, feeSchedule, ...row }: DemoDataset['markets'][number]) {
  const { retrievedAt: _feeRetrievedAt, ...fee } = feeSchedule ?? {}
  return digest([row, fee])
}

export function parseDemoDataset(value: unknown, allowFixture = false) {
  const manifest = demoDatasetSchema.parse(value)
  if (manifest.evidenceKind === 'fixture' && !allowFixture) throw new Error('fixture_demo_forbidden')
  if ((!allowFixture && Date.parse(manifest.capturedAt) > Date.now())
    || manifest.capital.some((row) => row.openedAt > manifest.capturedAt)) throw new Error('invalid_demo_capture_time')
  const markets = new Map(manifest.markets.map((row) => [marketKey(row), row]))
  const capital = new Map(manifest.capital.map((row) => [accountKey(row), row]))
  if (markets.size !== manifest.markets.length || capital.size !== manifest.capital.length
    || new Set(manifest.trades.map((trade) => trade.id)).size !== manifest.trades.length) throw new Error('duplicate_demo_identity')
  for (const row of manifest.markets) {
    if (row.retrievedAt > manifest.capturedAt || !capital.has(accountKey(row)) || (row.provider === 'kalshi' && row.asset !== 'USD')
      || (row.provider === 'polymarket' && row.asset === 'USD') || row.nativeMarket.startsWith('demo:')
      || new Set(row.outcomes.map((leg) => leg.instrument)).size !== 2 || new Set(row.outcomes.map((leg) => leg.name)).size !== 2
      || (row.feeSchedule && (row.provider !== 'kalshi' || row.feeSchedule.retrievedAt > manifest.capturedAt))
      || (row.tradingOpensAt && row.tradingClosesAt && row.tradingOpensAt >= row.tradingClosesAt)
      || (row.resolution && (row.lifecycle !== 'resolved' || row.resolution.knownAt > row.retrievedAt
        || (row.provider === 'polymarket' && manifest.evidenceKind === 'authorized_capture' && !row.resolution.evidence)
        || (row.resolution.evidence && (row.resolution.evidence.verifiedAt < row.resolution.knownAt || row.resolution.evidence.verifiedAt > row.retrievedAt))
        || (row.resolution.simulatedPayoutAt !== undefined && row.resolution.simulatedPayoutAt < row.resolution.knownAt)
        || !row.outcomes.some((leg) => leg.instrument === row.resolution!.winningInstrument)))) throw new Error('invalid_demo_market_scope')
  }
  for (const row of manifest.quotes) {
    const source = markets.get(marketKey(row))
    if (!source || !source.outcomes.some((leg) => leg.instrument === row.instrument) || row.retrievedAt > manifest.capturedAt
      || (row.observedAt && row.observedAt > row.retrievedAt) || (row.method === 'historical_close' && !row.observedAt)) {
      throw new Error('invalid_demo_quote_scope')
    }
  }
  for (const row of manifest.trades) {
    const price = manifest.quotes[row.quoteIndex]
    const source = price && markets.get(marketKey(price))
    if (!price || !source || price.method === 'last_trade' || !new Decimal(price.price).gt(0)) throw new Error('invalid_demo_execution_reference')
    const time = executionAt(row, price)
    if (time < availableAt(price) || time > manifest.capturedAt || time < capital.get(accountKey(source))!.openedAt
      || (source.tradingOpensAt && time < source.tradingOpensAt) || (source.tradingClosesAt && time >= source.tradingClosesAt)
      || (source.lifecycle !== 'open' && time >= source.retrievedAt)
      || (source.resolution && time >= source.resolution.knownAt)) throw new Error('invalid_demo_execution_reference')
  }
  return { manifest, revision: digest(manifest) }
}

export async function readDemoDataset(path: string, allowFixture = false) {
  const file = await open(path, 'r')
  try {
    const size = 2_000_000
    const buffer = Buffer.alloc(size + 1)
    const info = await file.stat()
    if (!info.isFile() || info.size > size) throw new Error('demo_dataset_size')
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== info.size) throw new Error('demo_dataset_changed')
    return parseDemoDataset(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), allowFixture)
  } finally { await file.close() }
}


export function demoMarketAt(capture: { revision: string; catalogRevision?: string; dataset: DemoDataset; priorMarkets?: DemoDataset['markets'] },
  provider: string, market: string, cutoff: string) {
  const prefix = 'simulation:' + (capture.catalogRevision ?? capture.revision) + ':'
  if (!market.startsWith(prefix)) return null
  const matches = (row: DemoDataset['markets'][number]) => row.provider === provider && prefix + row.nativeMarket === market
  const active = capture.dataset.markets.find(matches)
  if (!active) return null
  const prior = active.retrievedAt <= cutoff ? active : (capture.priorMarkets ?? [])
    .filter((row) => matches(row) && row.retrievedAt <= cutoff).sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt))[0]
  const resolutionKnown = active.resolution && active.resolution.knownAt <= cutoff
  const lifecycle = resolutionKnown ? 'resolved' : prior?.lifecycle === 'open' && prior.tradingClosesAt && cutoff >= prior.tradingClosesAt
    ? 'closed' : prior?.lifecycle ?? 'unknown'
  return { identity: active, asOf: prior, lifecycle,
    tradingAvailability: lifecycle === 'closed' || lifecycle === 'resolved' ? 'closed'
      : prior?.lifecycle === 'open' && prior.tradingOpensAt && cutoff >= prior.tradingOpensAt ? 'open' : 'unverified' }
}

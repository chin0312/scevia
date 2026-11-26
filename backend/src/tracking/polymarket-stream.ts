import { setTimeout as delay } from 'node:timers/promises'
import { and, asc, desc, eq, exists, inArray, or } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { digest } from '../accounting/decisions.js'
import type { Database } from '../db/client.js'
import { automaticMarketWatches, instruments, markets, marketTracking, marketWatches, sharedMarketObservations } from '../db/schema.js'

const endpoint = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
type Subscription = { id: string; market: string; token: string }
const numberText = z.string().regex(/^(?:0|1)(?:\.\d{1,18})?$/)
const edge = z.object({ price: numberText })
const frame = z.object({ asset_id: z.string(), market: z.string(), timestamp: z.string().regex(/^\d{13}$/),
  event_type: z.enum(['book', 'best_bid_ask']),
  bids: z.array(edge).max(500).optional(), asks: z.array(edge).max(500).optional(),
  best_bid: numberText.optional(), best_ask: numberText.optional() })

export function streamBook(data: unknown, subscriptions: Map<string, Subscription>, now: Date) {
  const parsed = frame.safeParse(data)
  if (!parsed.success) return null
  const row = parsed.data
  const instrument = subscriptions.get(row.asset_id)
  const time = Number(row.timestamp)
  if (instrument?.market.toLowerCase() !== row.market.toLowerCase()
    || time > now.getTime() || time < now.getTime() - 120_000) return null
  const bid = row.event_type === 'book' && row.bids?.length ? Decimal.max(...row.bids.map((level) => level.price))
    : row.best_bid !== undefined ? new Decimal(row.best_bid) : null
  const ask = row.event_type === 'book' && row.asks?.length ? Decimal.min(...row.asks.map((level) => level.price))
    : row.best_ask !== undefined ? new Decimal(row.best_ask) : null
  if (bid === null || ask === null || bid.gt(ask) || ask.gt(1)) return null
  return { instrumentId: instrument.id, price: bid.plus(ask).div(2).toFixed(), observedAt: new Date(time), retrievedAt: now }
}

export function startPolymarketStream(db: Database, signal: AbortSignal, state: {
  status: string; heartbeatAt: string | null
}, connect = (url: string) => new WebSocket(url)) {
  return run()
  async function run() {
    let failures = 0
    while (!signal.aborted) {
      try {
        const tokens = await loadRoster()
        if (tokens.size) {
          const connected = await session(tokens)
          failures = connected ? 0 : failures + 1
        } else state.status = 'idle'
      } catch { failures += 1 }
      if (!signal.aborted) {
        state.status = failures ? 'reconnecting' : state.status === 'idle' ? 'idle' : 'reconciling'
        await delay(Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)) + Math.floor(Math.random() * 500),
          undefined, { signal }).catch(() => undefined)
      }
    }
    state.status = 'stopped'
  }

  async function loadRoster() {
    const roster = await db.select({ id: instruments.id, market: markets.externalId, token: instruments.externalId })
      .from(instruments).innerJoin(markets, eq(instruments.marketId, markets.id))
      .innerJoin(marketTracking, eq(marketTracking.marketId, markets.id))
      .where(and(eq(markets.providerCode, 'polymarket'), eq(markets.settlementAssetCode, 'USDC'),
        eq(instruments.settlementAssetCode, 'USDC'), eq(marketTracking.lifecycle, 'open'),
        or(exists(db.select({ id: marketWatches.portfolioId }).from(marketWatches).where(eq(marketWatches.marketId, markets.id))),
          exists(db.select({ id: automaticMarketWatches.portfolioId }).from(automaticMarketWatches).where(eq(automaticMarketWatches.marketId, markets.id))))))
      .orderBy(asc(markets.id), asc(instruments.id)).limit(100)
    const eligible = roster.filter((row) => /^\d{1,78}$/.test(row.token) && /^0x[0-9a-f]{64}$/i.test(row.market))
    return new Map(eligible.filter((row) => eligible.filter((other) => other.token === row.token).length === 1)
      .map((row) => [row.token, row]))
  }

  async function session(tokens: Map<string, Subscription>) {
    const socket = connect(endpoint)
    const pending = new Map<string, NonNullable<ReturnType<typeof streamBook>>>()
    const clocks = new Map<string, number>()
    const snapshots = new Set<string>()
    let closed = false
    let received = false
    let heartbeat = Date.now()
    socket.addEventListener('open', () => {
      state.status = 'awaiting_snapshot'
      socket.send(JSON.stringify({ assets_ids: [...tokens.keys()], type: 'market', custom_feature_enabled: true }))
    })
    socket.addEventListener('close', () => { closed = true })
    socket.addEventListener('error', () => { closed = true })
    socket.addEventListener('message', (event) => {
      if (event.data === 'PONG') {
        heartbeat = Date.now()
        state.heartbeatAt = new Date(heartbeat).toISOString()
        return
      }
      if (typeof event.data !== 'string' || event.data.length > 256_000) return
      try {
        const payload: unknown = JSON.parse(event.data)
        for (const item of (Array.isArray(payload) ? payload.slice(0, 500) : [payload])) {
          const quote = streamBook(item, tokens, new Date())
          if (!quote || (clocks.get(quote.instrumentId) ?? 0) >= quote.observedAt.getTime()) continue
          if (item !== null && typeof item === 'object' && 'event_type' in item && item.event_type === 'book') snapshots.add(quote.instrumentId)
          if (!snapshots.has(quote.instrumentId)) continue
          clocks.set(quote.instrumentId, quote.observedAt.getTime())
          pending.set(quote.instrumentId, quote)
          received = true
        }
      } catch { /* Ignore invalid application frames. */ }
    })
    let tick = 0
    try {
      while (!signal.aborted && !closed && Date.now() - heartbeat < 30_000) {
        await delay(5000, undefined, { signal }).catch(() => undefined)
        if (signal.aborted || closed) break
        if (++tick % 2 === 0 && socket.readyState === WebSocket.OPEN) socket.send('PING')
        if (tick % 12 === 0) {
          const wanted = await loadRoster()
          if (wanted.size !== tokens.size || [...wanted.keys()].some((key) => wanted.get(key)?.id !== tokens.get(key)?.id)) return true
        }
        const quotes = [...pending.values()]
        pending.clear()
        if (quotes.length) {
          const table = sharedMarketObservations
          const stored = await db.selectDistinctOn([table.instrumentId], { instrument: table.instrumentId, time: table.effectiveAt })
            .from(table).where(and(eq(table.source, 'polymarket_clob_ws'), inArray(table.instrumentId, quotes.map((quote) => quote.instrumentId))))
            .orderBy(table.instrumentId, desc(table.effectiveAt))
          const newer = quotes.filter((quote) => !stored.some((row) => row.instrument === quote.instrumentId && row.time >= quote.observedAt))
          if (newer.length) await db.insert(sharedMarketObservations).values(newer.map((quote) => ({ ...quote, asset: 'USDC',
            source: 'polymarket_clob_ws', method: 'book_midpoint', effectiveAt: quote.observedAt,
            revision: digest(['polymarket_clob_ws', quote.instrumentId, quote.observedAt.toISOString()]) }))).onConflictDoNothing()
          state.status = 'receiving'
        }
      }
      return received && !closed
    } finally { socket.close() }
  }
}

import { and, desc, eq, gte, inArray, lte, notLike } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { instruments, marketHistoryWindows, marketInstrumentMappings, markets, marketTracking, sharedMarketObservations } from '../db/schema.js'
import type { PolymarketMarketDataService } from '../providers/polymarket/market-data.js'
import type { KalshiMarketDataService } from '../providers/kalshi/market-data.js'
import { digest } from '../accounting/decisions.js'

const quotes = sharedMarketObservations
const iso = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString())

export function registerMarketReferences(app: FastifyInstance, db: Database,
  kalshi?: Pick<KalshiMarketDataService, 'historicalPrices'>, polymarket?: Pick<PolymarketMarketDataService, 'priceHistory'>) {
  app.get('/market-references', async (request, reply) => {
    const query = z.object({ instruments: z.string().max(1900) }).strict().safeParse(request.query)
    const ids = query.success ? [...new Set(query.data.instruments.split(','))].sort() : []
    if (!ids.length || ids.length > 50 || ids.some((id) => !z.uuid().safeParse(id).success)) {
      return reply.code(422).send({ error: { code: 'invalid_market_reference_scope' } })
    }
    const now = new Date()
    const rows = await db.select({ id: instruments.id, marketId: markets.id, nativeMarket: markets.externalId,
      nativeInstrument: instruments.externalId, asset: instruments.settlementAssetCode,
      lifecycle: markets.lifecycle, tracked: marketTracking }).from(instruments).innerJoin(markets, eq(markets.id, instruments.marketId))
      .leftJoin(marketTracking, eq(marketTracking.marketId, markets.id)).where(and(inArray(instruments.id, ids), notLike(markets.externalId, 'simulation:%')))
    const prices = await db.selectDistinctOn([quotes.instrumentId, quotes.asset]).from(quotes)
      .where(and(inArray(quotes.instrumentId, ids), lte(quotes.effectiveAt, now), lte(quotes.retrievedAt, now)))
      .orderBy(quotes.instrumentId, quotes.asset, desc(quotes.effectiveAt), desc(quotes.retrievedAt), desc(quotes.revision))
    const references = ids.map((id) => {
      const row = rows.find((entry) => entry.id === id)
      if (!row) return { instrumentId: id, availability: 'unavailable' }
      const { tracked, ...meta } = row
      const lifecycle = tracked?.lifecycle ?? row.lifecycle
      const mark = prices.find((price) => price.instrumentId === id && price.asset === row.asset)
      const terminal = Boolean(tracked?.resolution) || lifecycle === 'resolved'
      return { ...meta, lifecycle, availability: terminal ? 'terminal' : !mark ? 'unavailable'
        : now.getTime() - mark.effectiveAt.getTime() > 360_000 ? 'stale_reference' : 'recent_reference',
      acquisition: mark?.source === 'polymarket_clob_ws' ? 'stream' : mark?.method.startsWith('historical_') ? 'archive' : mark ? 'poll' : null,
      price: terminal ? null : mark?.price ?? null, method: terminal ? null : mark?.method ?? null,
      observedAt: terminal ? null : mark?.observedAt?.toISOString() ?? null,
      retrievedAt: terminal ? null : mark?.retrievedAt.toISOString() ?? null, marketRevision: mark?.revision ?? null }
    })
    const revision = digest(references)
    reply.header('etag', '"' + revision + '"').header('cache-control', 'private, no-cache')
    if (request.headers['if-none-match'] === '"' + revision + '"') return reply.code(304).send()
    return { asOf: now.toISOString(), revision, references }
  })

  app.post('/market-references/history', async (request, reply) => {
    const body = z.object({ instrumentId: z.uuid(), from: iso, through: iso, cursor: z.string().max(4096).optional() }).strict().safeParse(request.body)
    if (!body.success) return reply.code(422).send({ error: { code: 'invalid_market_history_scope' } })
    const { instrumentId, from, through, cursor } = body.data
    if (from >= through || Date.parse(through) > Date.now() || Date.parse(through) - Date.parse(from) > 366 * 86_400_000) {
      return reply.code(422).send({ error: { code: 'invalid_market_history_scope' } })
    }
    const [selected] = await db.select({ leg: instruments, market: markets, mapping: marketInstrumentMappings }).from(instruments)
      .innerJoin(markets, eq(markets.id, instruments.marketId))
      .leftJoin(marketInstrumentMappings, eq(marketInstrumentMappings.instrumentId, instruments.id))
      .where(eq(instruments.id, instrumentId)).limit(1)
    const asset = selected?.leg.settlementAssetCode
    if (!selected || !asset || selected.market.settlementAssetCode !== asset || selected.market.externalId.startsWith('simulation:')) {
      return reply.code(422).send({ error: { code: 'market_history_identity_unverified' } })
    }
    const revision = digest([instrumentId, from, through, cursor ?? null])
    const [cached] = await db.select().from(marketHistoryWindows).where(eq(marketHistoryWindows.revision, revision)).limit(1)
    let nextCursor = cached?.nextCursor ?? null
    if (!cached || Date.now() - cached.retrievedAt.getTime() > 3_600_000) {
      let points: Array<{ at: string; price: string }>
      const signal = AbortSignal.timeout(12_000)
      try {
        if (selected.market.providerCode === 'kalshi' && kalshi && asset === 'USD' && !cursor
          && (selected.leg.outcomeType === 'yes' || selected.leg.outcomeType === 'no')) {
          const side = selected.leg.outcomeType
          const result = await kalshi.historicalPrices({ marketTicker: selected.market.externalId, side, minutes: 1440,
            from: Math.floor(Date.parse(from) / 1000), through: Math.floor(Date.parse(through) / 1000) }, signal)
          points = result.items.flatMap((row) => row.price === null ? [] : [{ at: row.timestamp, price: row.price }])
        } else if (selected.market.providerCode === 'polymarket' && polymarket && selected.mapping?.asset === asset) {
          const response = await polymarket.priceHistory({ tokenId: selected.leg.externalId, interval: 'max',
            bucketSeconds: 86400, ...(cursor ? { cursor } : {}) }, signal)
          const result = z.object({ tokenId: z.literal(selected.leg.externalId), items: z.array(z.object({
            observedAt: iso, price: z.string().regex(/^(?:0|1)(?:\.\d{1,18})?$/).refine((value) => Number(value) <= 1),
          })).max(500), nextCursor: z.string().max(4096).nullable() }).parse(response)
          points = result.items.map((row) => ({ at: row.observedAt, price: row.price }))
          nextCursor = result.nextCursor
        } else return reply.code(503).send({ error: { code: 'market_history_provider_unavailable' } })
      } catch { return reply.code(502).send({ error: { code: 'market_history_acquisition_failed' } }) }
      const method = selected.market.providerCode === 'kalshi' ? 'historical_close' : 'historical_sample'
      const retrievedAt = new Date()
      await db.transaction(async (tx) => {
        const rows = points.filter((row) => row.at >= from && row.at <= through)
          .map((row) => ({ instrumentId, asset, price: row.price, observedAt: new Date(row.at), effectiveAt: new Date(row.at),
            retrievedAt, method, source: selected.market.providerCode + '_historical_reference',
            revision: digest([instrumentId, method, row.at, row.price]) }))
        if (rows.length) await tx.insert(quotes).values(rows).onConflictDoNothing()
        await tx.insert(marketHistoryWindows).values({ instrumentId, revision, retrievedAt, nextCursor })
          .onConflictDoUpdate({ target: marketHistoryWindows.revision, set: { retrievedAt, nextCursor } })
      })
    }
    const observations = await db.select().from(quotes).where(and(eq(quotes.instrumentId, instrumentId),
      inArray(quotes.method, ['historical_close', 'historical_sample']), gte(quotes.effectiveAt, new Date(from)), lte(quotes.effectiveAt, new Date(through))))
      .orderBy(desc(quotes.effectiveAt)).limit(501)
    return { instrumentId, coverage: observations.length ? 'observations_only' : 'unavailable',
      cached: Boolean(cached && Date.now() - cached.retrievedAt.getTime() <= 3_600_000), nextCursor, observations: observations.slice(0, 500),
      truncated: observations.length > 500 || nextCursor !== null }
  })
}

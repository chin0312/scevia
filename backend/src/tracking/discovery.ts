import { IdentityConflict, registerInstrumentMappings } from './instrument-mapping.js'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { events, instruments, marketLifecycleEvidence, type TrackedResolution, marketResearch, markets, marketTracking, sharedMarketObservations, users } from '../db/schema.js'
import { normalizedRecordSchema } from '../domain/model.js'
import { upsertMarket } from '../ingestion/persistence.js'
import type { PolymarketMarketDataService } from '../providers/polymarket/market-data.js'
import type { KalshiMarketDataService } from '../providers/kalshi/market-data.js'
import { conflictingResolution } from './lifecycle.js'
import { digest } from '../accounting/decisions.js'

const selection = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('kalshi'), market: z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,127}$/), follow: z.boolean().default(false) }).strict(),
  z.object({ provider: z.literal('polymarket'), market: z.string().regex(/^0x[0-9a-f]{64}$/i), follow: z.boolean().default(false) }).strict(),
])

type Choice = z.infer<typeof selection>

export function registerMarketEvidence(app: FastifyInstance, db: Database,
  kalshi?: Pick<KalshiMarketDataService, 'lookup'>, polymarket?: Pick<PolymarketMarketDataService, 'discoverCondition' | 'trackingSnapshot'>) {
  const pending = new Map<string, { expires: number; value: ReturnType<typeof acquire> }>()
  async function acquire(input: Choice) {
    const signal = AbortSignal.timeout(12_000)
    let market: ReturnType<typeof normalizedRecordSchema.parse>
    let mappings: Array<{ position: string; clobToken: string }> = []
    let generation: string | null = null
    let quotes: Array<{ id: string; price: string; retrievedAt: Date; asset: string }> = []
    let metadata: unknown
    let tradingOpensAt: Date | null = null
    let tradingClosesAt: Date | null = null
    let resolution: TrackedResolution | null = null
    if (input.provider === 'kalshi' && kalshi) {
      const row = await kalshi.lookup(input.market, signal)
      if (row.marketTicker !== input.market || row.establishedPayoutUnit !== '1') return { status: 'unsupported_contract' as const, metadata: row }
      metadata = row
      tradingOpensAt = row.tradingOpensAt ? new Date(row.tradingOpensAt) : null
      tradingClosesAt = row.tradingClosesAt ? new Date(row.tradingClosesAt) : null
      resolution = row.resolution && row.outcomes.some((leg) => leg.id === row.resolution?.winningInstrument)
        ? { ...row.resolution, source: 'kalshi_trade_api', settlementTime: row.resolution.knownAt } : null
      market = normalizedRecordSchema.parse({ kind: 'market', externalEventId: row.eventTicker, externalMarketId: row.marketTicker,
        eventName: row.eventTicker, marketTitle: row.title, marketLifecycle: row.lifecycle, eventLifecycle: 'unknown',
        eventDescription: null, resolutionRules: null, settlementRules: null, eventSourceUpdatedAt: row.retrievedAt,
        settlementAssetCode: 'USD', sourceUpdatedAt: row.retrievedAt, eventResolvesAt: row.expectedResolutionAt,
        outcomes: row.outcomes.map((leg) => ({ externalId: leg.id, name: leg.name, outcomeType: leg.side, payoutAmount: null, settlementAssetCode: 'USD' })),
        rawPayload: {} })
      if (row.lifecycle === 'open') quotes = row.outcomes.flatMap((leg) => leg.quote?.provenance.includes('midpoint')
        ? [{ id: leg.id, price: leg.quote.value, retrievedAt: new Date(leg.quote.retrievedAt), asset: 'USD' }] : [])
    } else if (input.provider === 'polymarket' && polymarket) {
      const row = await polymarket.discoverCondition(input.market, signal)
      if (row.support !== 'supported') return { status: 'unsupported_contract' as const, metadata: row }
      metadata = row
      generation = row.generation ?? null
      mappings = row.outcomes
      market = normalizedRecordSchema.parse({ kind: 'market', externalEventId: row.eventId, externalMarketId: row.conditionId,
        eventName: row.eventTitle ?? row.eventId, marketTitle: row.title, marketLifecycle: row.lifecycle, eventLifecycle: 'unknown',
        eventDescription: null, resolutionRules: null, settlementRules: null, eventSourceUpdatedAt: row.retrievedAt,
        settlementAssetCode: row.asset, sourceUpdatedAt: row.retrievedAt, eventResolvesAt: row.expectedResolutionAt,
        outcomes: row.outcomes.map((leg) => ({ externalId: leg.position, name: leg.name, outcomeType: leg.name.toLowerCase(), payoutAmount: null,
          settlementAssetCode: row.asset })), rawPayload: {} })
      if (row.lifecycle === 'open') {
        try {
          const snapshot = await polymarket.trackingSnapshot(row.conditionId, signal)
          if (snapshot.lifecycle === 'open') quotes = snapshot.quotes
        } catch { /* Valid identity remains available when the book is unavailable. */ }
      }
    } else return { status: 'provider_disabled' as const }
    if (market.kind !== 'market') throw new Error('market_evidence_invalid')
    const catalog = market
    return db.transaction(async (tx) => {
      const [previous] = await tx.select({ id: markets.id, asset: markets.settlementAssetCode, event: events.externalId }).from(markets)
        .innerJoin(events, eq(events.id, markets.eventId)).where(and(eq(markets.providerCode, input.provider),
          eq(markets.externalId, catalog.externalMarketId))).for('update')
      if (previous && (previous.asset && previous.asset !== catalog.settlementAssetCode || previous.event !== catalog.externalEventId)) {
        return { status: 'identity_conflict' as const, metadata }
      }
      await upsertMarket(tx, input.provider, catalog)
      const [entry] = await tx.select({ id: markets.id }).from(markets).where(and(eq(markets.providerCode, input.provider),
        eq(markets.externalId, catalog.externalMarketId))).limit(1)
      const legs = await tx.select().from(instruments).where(eq(instruments.marketId, entry!.id))
      if (mappings.length && generation && catalog.settlementAssetCode) {
        await registerInstrumentMappings(tx, entry!.id, catalog.settlementAssetCode, generation, mappings)
      }
      if (catalog.sourceUpdatedAt && catalog.marketLifecycle !== 'unknown') {
        const [prior] = await tx.select({ resolution: marketLifecycleEvidence.resolution }).from(marketLifecycleEvidence)
          .where(and(eq(marketLifecycleEvidence.marketId, entry!.id), sql`${marketLifecycleEvidence.resolution} is not null`))
          .orderBy(desc(marketLifecycleEvidence.retrievedAt)).limit(1)
        const conflict = conflictingResolution(prior?.resolution, resolution)
        const proof = resolution ?? prior?.resolution ?? null
        const retrievedAt = new Date(catalog.sourceUpdatedAt)
        const expectedResolutionAt = catalog.eventResolvesAt ? new Date(catalog.eventResolvesAt) : null
        await tx.insert(marketLifecycleEvidence).values({ marketId: entry!.id, retrievedAt, lifecycle: catalog.marketLifecycle,
          tradingOpensAt, tradingClosesAt, expectedResolutionAt, resolution: proof, conflict,
          revision: digest([entry!.id, retrievedAt.toISOString().slice(0, 10), catalog.marketLifecycle,
            tradingOpensAt?.toISOString(), tradingClosesAt?.toISOString(), expectedResolutionAt?.toISOString(), proof, conflict]),
        }).onConflictDoNothing()
      }
      let eligibleQuotes = 0
      for (const quote of quotes) {
        const leg = legs.find((item) => item.externalId === quote.id && item.settlementAssetCode === quote.asset)
        if (!leg) continue
        eligibleQuotes++
        const source = input.provider === 'kalshi' ? 'kalshi_book' : 'polymarket_clob'
        await tx.insert(sharedMarketObservations).values({ instrumentId: leg.id, asset: quote.asset, price: quote.price,
          method: 'book_midpoint', source, retrievedAt: quote.retrievedAt, effectiveAt: quote.retrievedAt,
          revision: digest([leg.id, quote.asset, source, quote.retrievedAt.toISOString()]) }).onConflictDoNothing()
      }
      return { status: 'identified' as const, marketId: entry!.id, metadata, outcomes: legs.map((leg) => ({
        id: leg.id, nativePosition: leg.externalId, denomination: leg.settlementAssetCode, outcome: leg.outcomeName,
      })), quoteAvailability: eligibleQuotes === 2 ? 'observed' : eligibleQuotes ? 'partial' : 'unavailable' }
    })
  }
  app.post('/market-evidence', async (request, reply) => {
    const parsed = selection.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ error: { code: 'invalid_market_evidence_request' } })
    const input = parsed.data
    const key = input.provider + ':' + input.market
    const previous = pending.get(key)
    if (!previous || previous.expires <= Date.now()) {
      if (pending.size >= 64) pending.delete(pending.keys().next().value!)
      const value = acquire(input).catch((error) => { pending.delete(key); throw error })
      pending.set(key, { value, expires: Date.now() + 30_000 })
    }
    try {
      const result = await pending.get(key)!.value
      if (result.status !== 'identified' || !input.follow) return result
      const ownerId = request.principalId!
      const expiresAt = new Date(Date.now() + 30 * 60_000)
      const followed = await db.transaction(async (tx) => {
        const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update')
        if (!owner) return false
        const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(marketResearch).where(and(
          eq(marketResearch.ownerId, ownerId), gt(marketResearch.expiresAt, new Date()), sql`${marketResearch.marketId} <> ${result.marketId}`))
        if (count!.count >= 20) return false
        await tx.insert(marketTracking).values({ marketId: result.marketId }).onConflictDoNothing()
        await tx.insert(marketResearch).values({ marketId: result.marketId, ownerId, expiresAt })
          .onConflictDoUpdate({ target: [marketResearch.ownerId, marketResearch.marketId], set: { expiresAt } })
        return true
      })
      return followed ? { ...result, researchThrough: expiresAt.toISOString() }
        : reply.code(422).send({ error: { code: 'market_research_limit' } })
    } catch (error) {
      return error instanceof IdentityConflict ? reply.code(409).send({ error: { code: 'market_identity_conflict' } })
        : reply.code(502).send({ error: { code: 'market_evidence_unavailable' } })
    }
  })
  app.delete('/market-evidence/:marketId/follow', async (request, reply) => {
    const parsed = z.object({ marketId: z.uuid() }).safeParse(request.params)
    if (!parsed.success) return reply.code(422).send({ error: { code: 'invalid_market_evidence_request' } })
    await db.delete(marketResearch).where(and(eq(marketResearch.ownerId, request.principalId!), eq(marketResearch.marketId, parsed.data.marketId)))
    return reply.code(204).send()
  })
}

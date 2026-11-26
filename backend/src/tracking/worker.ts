import { registerInstrumentMappings } from './instrument-mapping.js'
import type { PolymarketCollateralReader } from '../providers/polymarket/collateral.js'
import { conflictingResolution } from './lifecycle.js'
import { lifecycleRank } from './demand.js'
import { Decimal } from 'decimal.js'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, exists, gt, inArray, isNull, lt, lte, or } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { accountTracking, automaticMarketWatches, events, instruments, marketInstrumentMappings, markets, marketLifecycleEvidence, marketResearch, marketTracking, marketWatches, providerAccounts, sharedMarketObservations } from '../db/schema.js'
import { digest } from '../accounting/decisions.js'
import type { IngestionService } from '../ingestion/sync.js'
import type { KalshiMarketDataService } from '../providers/kalshi/market-data.js'
import type { PolymarketMarketDataService } from '../providers/polymarket/market-data.js'

type Inputs = {
  kalshi?: Pick<KalshiMarketDataService, 'lookup'> | undefined
  polymarket?: (Pick<PolymarketMarketDataService, 'trackingSnapshot'> & Partial<Pick<PolymarketMarketDataService, 'discoverCondition'>>) | undefined
  ctf?: Pick<PolymarketCollateralReader, 'standardCtfResolution'> | undefined
  accountIds: string[]
  marketIntervalMs: number
  accountIntervalMs: number
  ingestion: Pick<IngestionService, 'syncProviderAccount'>
}

const available = (now: Date, row: { nextAttemptAt: typeof marketTracking.nextAttemptAt | typeof accountTracking.nextAttemptAt; leaseUntil: typeof marketTracking.leaseUntil | typeof accountTracking.leaseUntil }) =>
  and(lte(row.nextAttemptAt, now), or(isNull(row.leaseUntil), lte(row.leaseUntil, now)))
const leaseEnd = (now: Date) => new Date(now.getTime() + 180_000)
export const nextTime = (now: Date, interval: number, failures: number, jitter = Math.random()) => {
  const qualified = failures === 0 ? interval * (1 + 0.15 * jitter)
    : Math.min(3_600_000, interval * (1 + 0.15 * jitter) * 2 ** Math.min(failures, 5))
  return new Date(now.getTime() + Math.floor(qualified))
}

export class TrackingWorker {
  constructor(private readonly db: Database, private readonly input: Inputs) {}

  async market(signal: AbortSignal, now = new Date()) {
    const providers = [...(this.input.kalshi ? ['kalshi'] : []), ...(this.input.polymarket ? ['polymarket'] : [])]
    if (signal.aborted || !providers.length) return false
    const token = randomUUID()
    const job = await this.db.transaction(async (tx) => {
      const [candidate] = await tx.select({ job: marketTracking, provider: markets.providerCode, native: markets.externalId, event: events.externalId, asset: markets.settlementAssetCode })
        .from(marketTracking).innerJoin(markets, eq(markets.id, marketTracking.marketId))
        .innerJoin(events, eq(events.id, markets.eventId))
        .where(and(available(now, marketTracking), inArray(markets.providerCode, providers), isNull(marketTracking.resolution),
          or(exists(tx.select({ id: marketWatches.portfolioId }).from(marketWatches).where(eq(marketWatches.marketId, marketTracking.marketId))),
            exists(tx.select({ id: automaticMarketWatches.portfolioId }).from(automaticMarketWatches).where(eq(automaticMarketWatches.marketId, marketTracking.marketId))),
            exists(tx.select({ id: marketResearch.ownerId }).from(marketResearch).where(and(eq(marketResearch.marketId, marketTracking.marketId),
              gt(marketResearch.expiresAt, now)))))))
        .orderBy(asc(marketTracking.nextAttemptAt), asc(marketTracking.marketId)).limit(1).for('update', { skipLocked: true })
      if (!candidate) return null
      await tx.update(marketTracking).set({ leaseToken: token, leaseUntil: leaseEnd(now), lastAttemptAt: now })
        .where(eq(marketTracking.marketId, candidate.job.marketId))
      return candidate
    })
    if (!job) return false
    const taskSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const key = and(eq(marketTracking.marketId, job.job.marketId), eq(marketTracking.leaseToken, token))
    try {
      let verifiedMapping: Awaited<ReturnType<PolymarketMarketDataService['discoverCondition']>> | undefined
      let lifecycle: string
      let metadataAt = new Date()
      let tradingOpensAt: Date | null = null
      let tradingClosesAt: Date | null = null
      let expectedResolutionAt: Date | null = null
      let resolution: typeof marketTracking.$inferSelect.resolution = null
      let quotes: Array<{ id: string; price: string; retrievedAt: Date; asset: string }>
      if (job.provider === 'kalshi' && this.input.kalshi) {
        const market = await this.input.kalshi.lookup(job.native, taskSignal, false)
        if (market.marketTicker !== job.native || market.eventTicker !== job.event || market.establishedPayoutUnit !== '1') throw new Error('tracking_market_scope')
        lifecycle = market.lifecycle
        metadataAt = new Date(market.retrievedAt)
        resolution = market.resolution ? { ...market.resolution, source: 'kalshi_trade_api', settlementTime: market.resolution.knownAt } : null
        tradingOpensAt = market.tradingOpensAt ? new Date(market.tradingOpensAt) : null
        tradingClosesAt = market.tradingClosesAt ? new Date(market.tradingClosesAt) : null
        expectedResolutionAt = market.expectedResolutionAt ? new Date(market.expectedResolutionAt) : null
        quotes = lifecycle === 'open' ? market.outcomes.flatMap((leg) => leg.quote?.provenance.includes('midpoint')
          ? [{ id: leg.id, price: leg.quote.value, retrievedAt: new Date(leg.quote.retrievedAt), asset: 'USD' }] : []) : []
      } else if (this.input.polymarket) {
        const result = await this.input.polymarket.trackingSnapshot(job.native, taskSignal, job.asset === 'USDC' ? this.input.ctf : undefined)
        lifecycle = result.lifecycle
        quotes = result.quotes
        resolution = 'resolution' in result ? result.resolution ?? null : null
        metadataAt = new Date(resolution?.knownAt ?? metadataAt)
        if (job.asset === 'PUSD' && lifecycle === 'open' && this.input.polymarket.discoverCondition) {
          const [existing] = await this.db.select({ id: marketInstrumentMappings.instrumentId }).from(marketInstrumentMappings)
            .innerJoin(instruments, eq(instruments.id, marketInstrumentMappings.instrumentId))
            .where(eq(instruments.marketId, job.job.marketId)).limit(1)
          if (!existing) {
            try {
              const candidate = await this.input.polymarket.discoverCondition(job.native, taskSignal)
              if (candidate.support === 'supported' && candidate.asset === job.asset && candidate.eventId === job.event
                && candidate.conditionId === job.native.toLowerCase() && candidate.generation === 'v2') verifiedMapping = candidate
            } catch { taskSignal.throwIfAborted() }
          }
        }
      } else throw new Error('tracking_provider_unavailable')
      taskSignal.throwIfAborted()
      await this.db.transaction(async (tx) => {
        const [claimed] = await tx.select().from(marketTracking).where(key).for('update')
        if (!claimed) return
        if (verifiedMapping?.asset && verifiedMapping.generation) {
          await registerInstrumentMappings(tx, claimed.marketId, verifiedMapping.asset, verifiedMapping.generation, verifiedMapping.outcomes)
        }
        const monotonic = (!claimed.metadataAt || metadataAt >= claimed.metadataAt)
          && lifecycleRank(lifecycle) >= lifecycleRank(claimed.lifecycle)

        const effectiveLifecycle = monotonic ? lifecycle : claimed.lifecycle
        const native = await tx.select().from(instruments).where(eq(instruments.marketId, claimed.marketId)).limit(100)
        if (resolution && !native.some((row) => row.externalId === resolution!.winningInstrument)) throw new Error('tracking_resolution_identity')
        const conflict = conflictingResolution(claimed.resolution, resolution)
        if (lifecycleRank(lifecycle) > 0 && (monotonic || conflict)) {
          const proof = conflict ? resolution : claimed.resolution ?? resolution
          const revision = digest([claimed.marketId, metadataAt.toISOString().slice(0, 10), lifecycle, tradingOpensAt?.toISOString(),
            tradingClosesAt?.toISOString(), expectedResolutionAt?.toISOString(), proof?.winningInstrument, conflict])
          await tx.insert(marketLifecycleEvidence).values({ marketId: claimed.marketId, revision, retrievedAt: metadataAt,
            lifecycle, tradingOpensAt, tradingClosesAt, expectedResolutionAt, resolution: proof, conflict }).onConflictDoNothing()
        }
        let newest = claimed.quoteAt
        const eligible = new Set<string>()
        for (const quote of effectiveLifecycle === 'open' ? quotes : []) {
          const leg = native.find((item) => item.externalId === quote.id
            && (item.settlementAssetCode ?? job.asset) === quote.asset)
          if (!leg) continue
          eligible.add(leg.id)
          if (!newest || quote.retrievedAt > newest) newest = quote.retrievedAt
          const source = job.provider === 'kalshi' ? 'kalshi_book' : 'polymarket_clob'
          const revision = digest([leg.id, quote.asset, source, quote.retrievedAt.toISOString()])
          const [existing] = await tx.select({ price: sharedMarketObservations.price }).from(sharedMarketObservations)
            .where(eq(sharedMarketObservations.revision, revision)).limit(1)
          if (existing && !new Decimal(existing.price).eq(quote.price)) throw new Error('tracking_conflicting_observation')
          await tx.insert(sharedMarketObservations).values({ instrumentId: leg.id, asset: quote.asset, method: 'book_midpoint',
            price: quote.price, observedAt: null, retrievedAt: quote.retrievedAt, effectiveAt: quote.retrievedAt, source,
            revision }).onConflictDoNothing()
        }
        const interval = effectiveLifecycle === 'open' ? this.input.marketIntervalMs : 3_600_000
        await tx.update(marketTracking).set({ lifecycle: effectiveLifecycle, failures: 0, lastSuccessAt: new Date(),
          ...(monotonic && !conflict ? { metadataAt, closedAt: claimed.closedAt ?? (lifecycle === 'closed' ? metadataAt : null), lifecycleAt: claimed.lifecycle !== lifecycle
            ? metadataAt : claimed.lifecycleAt, resolution: claimed.resolution ?? resolution } : {}),
          quoteAt: newest, quoteStatus: effectiveLifecycle !== 'open' ? 'inactive'
            : eligible.size === 0 ? 'missing' : eligible.size < native.length ? 'partial' : 'observed',
          leaseUntil: null, leaseToken: null, nextAttemptAt: nextTime(new Date(), interval, 0) }).where(key)
      })
    } catch {
      await this.db.update(marketTracking).set({ failures: job.job.failures + 1, leaseToken: null, leaseUntil: null,
        nextAttemptAt: nextTime(new Date(), this.input.marketIntervalMs, job.job.failures + 1) }).where(key)
    }
    return true
  }

  async pruneObservations(retentionDays: number, now = new Date()) {
    const expiredLeases = this.db.select({ owner: marketResearch.ownerId, market: marketResearch.marketId }).from(marketResearch)
      .where(lte(marketResearch.expiresAt, now)).limit(1000)
    const leases = await expiredLeases
    for (const lease of leases) await this.db.delete(marketResearch).where(and(eq(marketResearch.ownerId, lease.owner),
      eq(marketResearch.marketId, lease.market), lte(marketResearch.expiresAt, now)))
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000)
    const table = sharedMarketObservations
    const expired = this.db.select({ id: table.id }).from(table).where(lt(table.retrievedAt, cutoff))
      .orderBy(asc(table.retrievedAt), asc(table.id)).limit(1000)
    await this.db.delete(table).where(inArray(table.id, expired))
  }

  async account(signal: AbortSignal, now = new Date()) {
    if (signal.aborted || !this.input.accountIds.length) return false
    const token = randomUUID()
    const job = await this.db.transaction(async (tx) => {
      const [candidate] = await tx.select({ job: accountTracking }).from(accountTracking)
        .innerJoin(providerAccounts, eq(providerAccounts.id, accountTracking.accountId))
        .where(and(available(now, accountTracking), inArray(accountTracking.accountId, this.input.accountIds), isNull(providerAccounts.disabledAt)))
        .orderBy(asc(accountTracking.nextAttemptAt), asc(accountTracking.scope), asc(accountTracking.accountId)).limit(1)
        .for('update', { skipLocked: true })
      if (!candidate) return null
      const { accountId, scope } = candidate.job
      await tx.update(accountTracking).set({ leaseToken: token, leaseUntil: leaseEnd(now), lastAttemptAt: now })
        .where(and(eq(accountTracking.accountId, accountId), eq(accountTracking.scope, scope)))
      return candidate.job
    })
    if (!job) return false
    let success = false
    if (job.scope === 'current' || job.scope === 'history') {
      try { success = (await this.input.ingestion.syncProviderAccount(job.accountId, job.scope)).status === 'complete' }
      catch { /* Existing sync runs and checkpoints retain provider details. */ }
    }
    const failures = success ? 0 : job.failures + 1
    const interval = this.input.accountIntervalMs * (job.scope === 'history' ? 4 : 1)
    await this.db.update(accountTracking).set({ failures, leaseToken: null, leaseUntil: null,
      ...(success ? { lastSuccessAt: new Date() } : {}), nextAttemptAt: nextTime(new Date(), interval, failures) })
      .where(and(eq(accountTracking.accountId, job.accountId), eq(accountTracking.scope, job.scope), eq(accountTracking.leaseToken, token)))
    return true
  }
}

import { Decimal } from 'decimal.js'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, exists, inArray, isNull, lt, lte, or } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { accountTracking, instruments, markets, marketTracking, marketWatches, providerAccounts, sharedMarketObservations } from '../db/schema.js'
import { digest } from '../accounting/decisions.js'
import type { IngestionService } from '../ingestion/sync.js'
import type { KalshiMarketDataService } from '../providers/kalshi/market-data.js'
import type { PolymarketMarketDataService } from '../providers/polymarket/market-data.js'

type Inputs = {
  kalshi?: Pick<KalshiMarketDataService, 'lookup'> | undefined
  polymarket?: Pick<PolymarketMarketDataService, 'trackingSnapshot'> | undefined
  accountIds: string[]
  marketIntervalMs: number
  accountIntervalMs: number
  ingestion: Pick<IngestionService, 'syncProviderAccount'>
}

const available = (now: Date, row: { nextAttemptAt: typeof marketTracking.nextAttemptAt | typeof accountTracking.nextAttemptAt; leaseUntil: typeof marketTracking.leaseUntil | typeof accountTracking.leaseUntil }) =>
  and(lte(row.nextAttemptAt, now), or(isNull(row.leaseUntil), lte(row.leaseUntil, now)))
const leaseEnd = (now: Date) => new Date(now.getTime() + 180_000)
const nextTime = (now: Date, interval: number, failures: number) =>
  new Date(now.getTime() + Math.floor(Math.min(3_600_000, interval * 2 ** Math.min(failures, 5)) * (1 + 0.15 * Math.random())))

export class TrackingWorker {
  constructor(private readonly db: Database, private readonly input: Inputs) {}

  async market(signal: AbortSignal, now = new Date()) {
    const providers = [...(this.input.kalshi ? ['kalshi'] : []), ...(this.input.polymarket ? ['polymarket'] : [])]
    if (signal.aborted || !providers.length) return false
    const token = randomUUID()
    const job = await this.db.transaction(async (tx) => {
      const [candidate] = await tx.select({ job: marketTracking, provider: markets.providerCode, native: markets.externalId, asset: markets.settlementAssetCode })
        .from(marketTracking).innerJoin(markets, eq(markets.id, marketTracking.marketId))
        .where(and(available(now, marketTracking), inArray(markets.providerCode, providers),
          exists(tx.select({ id: marketWatches.portfolioId }).from(marketWatches).where(eq(marketWatches.marketId, marketTracking.marketId)))))
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
      let lifecycle: string
      let quotes: Array<{ id: string; price: string; retrievedAt: Date; asset: string }>
      if (job.provider === 'kalshi' && this.input.kalshi) {
        const market = await this.input.kalshi.lookup(job.native, taskSignal)
        if (market.marketTicker !== job.native || market.establishedPayoutUnit !== '1') throw new Error('tracking_market_scope')
        lifecycle = market.lifecycle
        quotes = lifecycle === 'open' ? market.outcomes.flatMap((leg) => leg.quote?.provenance.includes('midpoint')
          ? [{ id: leg.id, price: leg.quote.value, retrievedAt: new Date(leg.quote.retrievedAt), asset: 'USD' }] : []) : []
      } else if (this.input.polymarket) {
        ({ lifecycle, quotes } = await this.input.polymarket.trackingSnapshot(job.native, taskSignal))
      } else throw new Error('tracking_provider_unavailable')
      taskSignal.throwIfAborted()
      await this.db.transaction(async (tx) => {
        const interval = lifecycle === 'open' ? this.input.marketIntervalMs : 3_600_000
        const [claimed] = await tx.update(marketTracking).set({ lifecycle, failures: 0, lastSuccessAt: new Date(),
          leaseUntil: null, leaseToken: null, nextAttemptAt: nextTime(new Date(), interval, 0) }).where(key).returning()
        if (!claimed) return
        const native = await tx.select().from(instruments).where(eq(instruments.marketId, claimed.marketId)).limit(100)
        for (const quote of quotes) {
          const leg = native.find((item) => item.externalId === quote.id
            && (item.settlementAssetCode ?? job.asset) === quote.asset)
          if (!leg) continue
          const source = job.provider === 'kalshi' ? 'kalshi_book' : 'polymarket_clob'
          const revision = digest([leg.id, quote.asset, source, quote.retrievedAt.toISOString()])
          const [existing] = await tx.select({ price: sharedMarketObservations.price }).from(sharedMarketObservations)
            .where(eq(sharedMarketObservations.revision, revision)).limit(1)
          if (existing && !new Decimal(existing.price).eq(quote.price)) throw new Error('tracking_conflicting_observation')
          await tx.insert(sharedMarketObservations).values({ instrumentId: leg.id, asset: quote.asset, method: 'book_midpoint',
            price: quote.price, observedAt: null, retrievedAt: quote.retrievedAt, effectiveAt: quote.retrievedAt, source,
            revision }).onConflictDoNothing()
        }
      })
    } catch {
      await this.db.update(marketTracking).set({ failures: job.job.failures + 1, leaseToken: null, leaseUntil: null,
        nextAttemptAt: nextTime(new Date(), this.input.marketIntervalMs, job.job.failures + 1) }).where(key)
    }
    return true
  }

  async pruneObservations(retentionDays: number, now = new Date()) {
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

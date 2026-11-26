import { conflictingResolution, lifecycleAt } from './lifecycle.js'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { automaticMarketWatches, events, instruments, markets, marketTracking, portfolios } from '../db/schema.js'
import type { DemoDataset } from '../demo/dataset.js'

type Demo = NonNullable<typeof portfolios.$inferSelect.demo>

export function trackableMarket(row: { providerCode: string; externalId: string; settlementAssetCode: string | null }) {
  return (row.providerCode === 'kalshi' && /^[A-Z0-9][A-Z0-9_.-]{0,127}$/.test(row.externalId) && row.settlementAssetCode === 'USD')
    || (row.providerCode === 'polymarket' && /^0x[0-9a-f]{64}$/i.test(row.externalId) && ['USDC', 'PUSD'].includes(row.settlementAssetCode ?? ''))
}

export async function nativeDemoMarkets(db: Pick<Database, 'select'>, demo: Demo) {
  if (demo.dataset.evidenceKind !== 'authorized_capture') return []
  const rows = await db.select({ id: markets.id, providerCode: markets.providerCode, externalId: markets.externalId,
    settlementAssetCode: markets.settlementAssetCode, event: events.externalId, leg: instruments.externalId }).from(markets)
    .innerJoin(events, eq(events.id, markets.eventId))
    .innerJoin(instruments, eq(instruments.marketId, markets.id))
    .where(inArray(markets.externalId, demo.dataset.markets.map((item) => item.nativeMarket)))
  return demo.dataset.markets.flatMap((source) => {
    const matching = rows.filter((row) => row.providerCode === source.provider && row.externalId === source.nativeMarket
      && row.event === source.nativeEvent && row.settlementAssetCode === source.asset && trackableMarket(row))
    return source.outcomes.every((outcome) => matching.some((row) => row.leg === outcome.instrument))
      ? [{ id: matching[0]!.id, source }] : []
  })
}

export async function reconcileHoldingDemand(db: Database, portfolioId: string,
  load: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<{ instrumentIds: string[]; demo: Demo | null; complete: boolean }>) {
  await db.transaction(async (tx) => {
    const [portfolio] = await tx.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.id, portfolioId)).for('update')
    if (!portfolio) return
    const { instrumentIds, demo, complete } = await load(tx)
    const rows = instrumentIds.length ? await tx.select({ id: markets.id, providerCode: markets.providerCode, externalId: markets.externalId,
      settlementAssetCode: markets.settlementAssetCode, leg: instruments.externalId }).from(instruments)
      .innerJoin(markets, eq(instruments.marketId, markets.id)).where(inArray(instruments.id, instrumentIds)) : []
    const ids = new Set(rows.filter(trackableMarket).map((row) => row.id))
    if (demo) {
      const prefix = 'simulation:' + (demo.catalogRevision ?? demo.revision) + ':'
      for (const { id, source } of await nativeDemoMarkets(tx, demo)) {
        if (rows.some((row) => row.providerCode === source.provider && row.externalId === prefix + source.nativeMarket
          && row.settlementAssetCode === source.asset && source.outcomes.some((leg) => prefix + leg.instrument === row.leg))) ids.add(id)
      }
    }
    const existing = await tx.select().from(automaticMarketWatches).where(eq(automaticMarketWatches.portfolioId, portfolioId))
    const before = new Set(existing.map((row) => row.marketId))
    const removed = complete ? [...before].filter((id) => !ids.has(id)) : []
    if (removed.length) await tx.delete(automaticMarketWatches).where(and(eq(automaticMarketWatches.portfolioId, portfolioId),
      inArray(automaticMarketWatches.marketId, removed)))
    const added = [...ids].filter((id) => !before.has(id)).sort()
    if (!added.length) return
    await tx.insert(marketTracking).values(added.map((marketId) => ({ marketId }))).onConflictDoNothing()
    await tx.insert(automaticMarketWatches).values(added.map((marketId) => ({ portfolioId, marketId }))).onConflictDoNothing()
  }, { isolationLevel: 'repeatable read' })
}

type Market = DemoDataset['markets'][number]
export const lifecycleRank = (value: string | null | undefined) => ({ open: 1, closed: 2, resolved: 3 }[value ?? ''] ?? 0)
export type TrackedDemo = Demo & {
  trackingCoverage: Array<{ provider: string; nativeMarket: string; asset: string; lifecycleThrough: string;
    quoteThrough: string | null; resolutionStatus: 'verified' | 'unverified' | 'conflict' | 'pending'; resolutionObservedAt: string | null; providerSettlementAt: string | null; simulatedPayoutAt: string | null }>
}

export async function trackedDemoCapture(db: Pick<Database, 'select'>, capture: Demo, cutoff: string): Promise<TrackedDemo> {
  const native = await nativeDemoMarkets(db, capture)
  const ids = native.map((item) => item.id)
  const checks = ids.length ? await db.select().from(marketTracking).where(inArray(marketTracking.marketId, ids)) : []
  const journal = await lifecycleAt(db, ids, cutoff)
  const trackingCoverage: TrackedDemo['trackingCoverage'] = []
  const history = [...(capture.priorMarkets ?? [])]
  const markets = capture.dataset.markets.map((market): Market => {
    const identity = native.find((row) => row.source === market)
    const status = checks.find((row) => row.marketId === identity?.id)
    const observations = identity ? journal.get(identity.id) ?? [] : []
    const available = observations.filter((row) => !row.conflict)
    const latest = available.at(-1)
    const latestCheck = status?.metadataAt?.toISOString()
    const checkedAt = latestCheck && latestCheck <= cutoff ? latestCheck : latest?.retrievedAt.toISOString()
    const proof = available.find((row) => row.resolution)?.resolution ?? (
      latestCheck && latestCheck <= cutoff && !available.length ? status?.resolution : null)
    const observedAt = available.find((row) => row.resolution)?.retrievedAt.toISOString() ?? (proof ? latestCheck : null)
    const conflict = observations.some((row) => row.conflict) || conflictingResolution(market.resolution, proof)
    const candidate = [...available].reverse().find((row) => lifecycleRank(row.lifecycle) >= lifecycleRank(market.lifecycle))
    const lifecycle = candidate?.lifecycle ?? (checkedAt && checkedAt <= cutoff ? status?.lifecycle : null)
    const resolution = market.resolution ?? (!conflict && proof && observedAt && observedAt <= cutoff
      && market.outcomes.some((leg) => leg.instrument === proof.winningInstrument)
      ? { winningInstrument: proof.winningInstrument, unitPayout: proof.unitPayout, knownAt: observedAt } : undefined)
    const storedThrough = capture.dataset.capturedAt <= cutoff ? capture.dataset.capturedAt : market.retrievedAt
    trackingCoverage.push({ provider: market.provider, nativeMarket: market.nativeMarket, asset: market.asset,
      lifecycleThrough: checkedAt && checkedAt > storedThrough ? checkedAt : storedThrough,
      quoteThrough: status?.quoteAt && status.quoteAt.toISOString() <= cutoff ? status.quoteAt.toISOString() : null,
      resolutionStatus: conflict ? 'conflict' : resolution ? 'verified' : lifecycle === 'resolved' || market.lifecycle === 'resolved' ? 'unverified' : 'pending',
      resolutionObservedAt: observedAt ?? null, providerSettlementAt: proof?.settlementTime ?? null,
      simulatedPayoutAt: market.resolution?.simulatedPayoutAt ?? resolution?.knownAt ?? null })
    if ((lifecycle !== 'open' && lifecycle !== 'closed' && lifecycle !== 'resolved')
      || lifecycleRank(lifecycle) < lifecycleRank(market.lifecycle)) return market
    const retrievedAt = candidate?.retrievedAt.toISOString() ?? checkedAt
    if (!retrievedAt || retrievedAt < market.retrievedAt) return market
    history.push(market)
    for (const row of available) if (row.lifecycle === 'closed' && row.retrievedAt.toISOString() >= market.retrievedAt) {
      history.push({ ...market, lifecycle: 'closed', retrievedAt: row.retrievedAt.toISOString(), resolution: undefined })
      break
    }
    return { ...market, lifecycle, retrievedAt, ...(resolution ? { resolution } : {}),
      tradingOpensAt: candidate?.tradingOpensAt?.toISOString() ?? market.tradingOpensAt,
      tradingClosesAt: candidate?.tradingClosesAt?.toISOString() ?? market.tradingClosesAt,
      resolvesAt: candidate?.expectedResolutionAt?.toISOString() ?? market.resolvesAt }
  })
  return { ...capture, trackingCoverage, priorMarkets: history, dataset: { ...capture.dataset, markets } }
}

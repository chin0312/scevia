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
export async function trackedDemoCapture(db: Pick<Database, 'select'>, capture: Demo, cutoff: string): Promise<Demo> {
  const native = await nativeDemoMarkets(db, capture)
  if (!native.length) return capture
  const checks = await db.select().from(marketTracking).where(inArray(marketTracking.marketId, native.map((item) => item.id)))
  const history: Market[] = []
  let through = capture.dataset.capturedAt
  const markets = capture.dataset.markets.map((market): Market => {
    const identity = native.find((row) => row.source === market)
    const status = checks.find((row) => row.marketId === identity?.id)
    const checkedAt = status?.metadataAt?.toISOString()
    if (checkedAt) {
      const supportedThrough = checkedAt < cutoff ? checkedAt : cutoff
      if (supportedThrough > through) through = supportedThrough
    }
    const transition = status?.lifecycleAt?.toISOString()
    const closed = status?.closedAt?.toISOString()
    const lifecycle = transition && transition <= cutoff ? status!.lifecycle : closed && closed <= cutoff ? 'closed' : null
    const retrievedAt = transition && transition <= cutoff ? transition : closed
    if (!retrievedAt || retrievedAt > cutoff || retrievedAt <= market.retrievedAt) return market
    if ((lifecycle !== 'open' && lifecycle !== 'closed' && lifecycle !== 'resolved')
      || lifecycleRank(lifecycle) < lifecycleRank(market.lifecycle)) return market
    const proof = lifecycle === 'resolved' ? status!.resolution : null
    const resolution = market.resolution ?? (proof && proof.knownAt <= cutoff
      && market.outcomes.some((leg) => leg.instrument === proof.winningInstrument) ? proof : undefined)
    if (lifecycle === market.lifecycle && resolution === market.resolution) return market
    history.push(market)
    return { ...market, lifecycle, retrievedAt, ...(resolution ? { resolution } : {}) }
  })
  return through === capture.dataset.capturedAt && !history.length ? capture
    : { ...capture, priorMarkets: [...(capture.priorMarkets ?? []), ...history], dataset: { ...capture.dataset, capturedAt: through, markets } }
}

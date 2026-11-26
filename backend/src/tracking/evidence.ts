import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import { canonicalInstrumentKeys, instrumentKey } from '../analytics/scope.js'
import type { Evidence } from '../accounting/model.js'
import type { Database } from '../db/client.js'
import { instruments, markets, marketTracking, sharedMarketObservations } from '../db/schema.js'

export async function sharedTrackingEvidence(db: Pick<Database, 'select' | 'selectDistinctOn'>, evidence: Evidence[], cutoff: string, from: string | undefined, demo?: { revision: string; catalogRevision?: string; dataset: import('../demo/dataset.js').DemoDataset } | null,
  reported: Array<{ instrument: string; asset: string | null }> = []) {
  const canonical = canonicalInstrumentKeys(evidence, cutoff)
  const scoped = new Map<string, Map<string, { instrument: string; asset: string; account: string; venue: string }>>()
  for (const item of evidence) {
    const { instrument, asset, account, venue, type } = item.observation
    if (!instrument || !['buy', 'sell', 'opening_position', 'split', 'merge'].includes(type)
      || item.unresolvedReason || item.observation.timestamp > cutoff || !canonical.has(instrumentKey({ venue, account }, instrument))) continue
    const scopes = scoped.get(instrument) ?? new Map()
    scopes.set(JSON.stringify([asset, venue, account]), { instrument, asset, account, venue })
    scoped.set(instrument, scopes)
  }
  const reportedMarks = new Map<string, typeof sharedMarketObservations.$inferSelect>()
  const reportedIds = reported.filter((row) => row.asset).map((row) => row.instrument)
  if (!scoped.size && !reportedIds.length) return { evidence: [], truncated: false, reportedMarks }
  if (demo) {
    const prefix = 'simulation:' + (demo.catalogRevision ?? demo.revision) + ':'
    const demoLegs = await db.select({ id: instruments.id, leg: instruments.externalId,
      provider: markets.providerCode, market: markets.externalId }).from(instruments)
      .innerJoin(markets, eq(instruments.marketId, markets.id)).where(inArray(instruments.id, [...scoped.keys()]))
    for (const row of demoLegs) {
      const source = demo.dataset.markets.find((market) => market.provider === row.provider && prefix + market.nativeMarket === row.market
        && market.outcomes.some((leg) => prefix + leg.instrument === row.leg))
      if (!source) continue
      const [native] = await db.select({ id: instruments.id }).from(instruments)
        .innerJoin(markets, eq(instruments.marketId, markets.id)).where(and(eq(markets.providerCode, row.provider),
          eq(markets.externalId, source.nativeMarket), eq(markets.settlementAssetCode, source.asset),
          eq(instruments.externalId, row.leg.slice(prefix.length)))).limit(1)
      if (native) scoped.set(native.id, scoped.get(row.id)!)
    }
  }
  const table = sharedMarketObservations
  const ids = [...new Set([...scoped.keys(), ...reportedIds])]
  const eligible = (through: string) => and(inArray(table.instrumentId, ids),
    lte(table.effectiveAt, new Date(through)), lte(table.retrievedAt, new Date(through)))
  const latestAt = (through: string) => db.selectDistinctOn([table.instrumentId, table.asset], { row: table }).from(table)
    .where(eligible(through)).orderBy(table.instrumentId, table.asset, desc(table.effectiveAt), desc(table.id)).limit(5001)
  const latest = await latestAt(cutoff)
  for (const { row } of latest) reportedMarks.set(JSON.stringify([row.instrumentId, row.asset]), row)
  const day = sql`date_trunc('day', ${table.effectiveAt} AT TIME ZONE 'UTC')`
  const daily = from && scoped.size ? await db.selectDistinctOn([table.instrumentId, table.asset, day], { row: table }).from(table)
    .where(and(eligible(cutoff), inArray(table.instrumentId, [...scoped.keys()]), gt(table.effectiveAt, new Date(from))))
    .orderBy(table.instrumentId, table.asset, day, desc(table.effectiveAt), desc(table.id)).limit(5001) : []
  const boundaries = from ? [...new Set(evidence.filter(({ observation }) => ['deposit', 'withdrawal'].includes(observation.type)
    && observation.timestamp > from && observation.timestamp <= cutoff).map(({ observation }) => observation.timestamp))] : []
  const anchors = from ? await latestAt(from) : []
  for (const boundary of boundaries.slice(0, 40)) {
    anchors.push(...await latestAt(new Date(Date.parse(boundary) - 1).toISOString()), ...await latestAt(boundary))
  }
  const rows = [...new Map([...anchors, ...daily, ...latest].map((entry) => [entry.row.id, entry])).values()]
  const projected: Evidence[] = []
  for (const { row } of rows) {
    for (const scope of (scoped.get(row.instrumentId)?.values() ?? [])) {
      if (scope.asset !== row.asset) continue
      if (projected.length === 5000) return { evidence: projected, truncated: true, reportedMarks }
      projected.push({ batchId: row.id, row: 0, marketReference: { source: row.source, method: row.method, revision: row.revision,
        retrievedAt: row.retrievedAt.toISOString(), observedAt: row.observedAt?.toISOString() ?? null }, observation: { ...scope, id: 'shared-mark:' + row.id, type: 'mark',
        timestamp: row.effectiveAt.toISOString(), sequence: null, price: new Decimal(row.price).toFixed(),
        quantity: null, amount: null, fee: null, feeAsset: null } })
    }
  }
  if (!demo && scoped.size) {
    const terminal = await db.select({ market: marketTracking, instrument: instruments.id }).from(marketTracking)
      .innerJoin(instruments, eq(instruments.marketId, marketTracking.marketId))
      .where(inArray(instruments.id, [...scoped.keys()]))
    for (const { market, instrument } of terminal) {
      const proof = market.resolution
      if (!proof || proof.knownAt > cutoff) continue
      for (const scope of scoped.get(instrument)!.values()) {
        if (projected.length === 5000) return { evidence: projected, truncated: true, reportedMarks }
        projected.push({ batchId: market.marketId, row: 0, marketReference: { source: 'kalshi_trade_api',
          method: 'verified_resolution', revision: market.marketId + ':' + proof.knownAt,
          retrievedAt: market.lifecycleAt?.toISOString() ?? proof.knownAt, observedAt: proof.knownAt }, observation: { ...scope,
          id: 'shared-terminal:' + instrument, type: 'mark', terminalMarketReference: true, timestamp: proof.knownAt,
          sequence: null, price: null, quantity: null, amount: null, fee: null, feeAsset: null } })
      }
    }
  }
  return { evidence: projected, truncated: latest.length === 5001 || daily.length === 5001 || boundaries.length > 40, reportedMarks }
}

import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import { canonicalInstrumentKeys, instrumentKey } from '../analytics/scope.js'
import type { Evidence } from '../accounting/model.js'
import type { Database } from '../db/client.js'
import { instruments, markets, sharedMarketObservations } from '../db/schema.js'

export async function sharedTrackingEvidence(db: Pick<Database, 'select' | 'selectDistinctOn'>, evidence: Evidence[], cutoff: string, from: string | undefined, demo?: { revision: string; catalogRevision?: string; dataset: import('../demo/dataset.js').DemoDataset } | null) {
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
  if (!scoped.size) return { evidence: [], truncated: false }
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
  const eligible = (through: string) => and(inArray(table.instrumentId, [...scoped.keys()]),
    lte(table.effectiveAt, new Date(through)), lte(table.retrievedAt, new Date(through)))
  const anchor = from ?? cutoff
  const latest = await db.selectDistinctOn([table.instrumentId, table.asset], { row: table }).from(table)
    .where(eligible(anchor)).orderBy(table.instrumentId, table.asset, desc(table.effectiveAt), desc(table.id)).limit(5001)
  const subsequent = from ? await db.select({ row: table }).from(table)
    .where(and(eligible(cutoff), gt(table.effectiveAt, new Date(from))))
    .orderBy(asc(table.effectiveAt), asc(table.id)).limit(5001) : []
  const rows = [...latest, ...subsequent]
  const projected: Evidence[] = []
  for (const { row } of rows) {
    for (const scope of scoped.get(row.instrumentId)!.values()) {
      if (scope.asset !== row.asset) continue
      if (projected.length === 5000) return { evidence: projected, truncated: true }
      projected.push({ batchId: row.id, row: 0, observation: { ...scope, id: 'shared-mark:' + row.id, type: 'mark',
        timestamp: row.effectiveAt.toISOString(), sequence: null, price: new Decimal(row.price).toFixed(),
        quantity: null, amount: null, fee: null, feeAsset: null } })
    }
  }
  return { evidence: projected, truncated: latest.length === 5001 || subsequent.length === 5001 }
}

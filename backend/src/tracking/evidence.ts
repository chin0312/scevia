import { lifecycleAt } from './lifecycle.js'
import { and, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import { canonicalInstrumentKeys, instrumentKey } from '../analytics/scope.js'
import type { Evidence } from '../accounting/model.js'
import type { Database } from '../db/client.js'
import { instruments, markets, marketTracking, sharedMarketObservations } from '../db/schema.js'

export async function sharedTrackingEvidence(db: Pick<Database, 'select' | 'selectDistinctOn' | 'execute'>, evidence: Evidence[], cutoff: string, from: string | undefined, demo?: { revision: string; catalogRevision?: string; dataset: import('../demo/dataset.js').DemoDataset } | null,
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
  const availability = sql`greatest(${table.effectiveAt}, ${table.retrievedAt})`
  const day = sql`date_trunc('day', ${availability} AT TIME ZONE 'UTC')`
  const daily = from && scoped.size ? await db.selectDistinctOn([table.instrumentId, table.asset, day], { row: table }).from(table)
    .where(and(eligible(cutoff), inArray(table.instrumentId, [...scoped.keys()]), gt(availability, new Date(from))))
    .orderBy(table.instrumentId, table.asset, day, desc(table.effectiveAt), desc(table.id)).limit(5001) : []
  const boundaries = from ? [...new Set(evidence.filter(({ observation }) => ['deposit', 'withdrawal'].includes(observation.type)
    && observation.timestamp > from && observation.timestamp <= cutoff).map(({ observation }) => observation.timestamp))] : []
  const anchors = from ? await latestAt(from) : []
  const boundaryLimit = boundaries.length * Math.max(scoped.size, 1) > 10_000
  if (!boundaryLimit && boundaries.length && scoped.size) {
    const times = boundaries.flatMap((value) => [new Date(Date.parse(value) - 1).toISOString(), value])
    const timeValues = sql.join(times.map((value) => sql`(${value}::timestamptz)`), sql`, `)
    const scopes = [...scoped.entries()].flatMap(([id, rows]) => [...new Set([...rows.values()].map((scope) => scope.asset))]
      .map((asset) => sql`(${id}::uuid, ${asset}::text)`))
    const scopeValues = sql.join(scopes, sql`, `)
    const exact = await db.execute<{ id: string }>(sql`
      select distinct picked.id
      from (values ${timeValues}) as cutoffs(at)
      cross join (values ${scopeValues}) as selected(instrument, asset)
      cross join lateral (
        select observation.id from ${table} observation
        where observation.instrument_id = selected.instrument and observation.asset = selected.asset
          and observation.effective_at <= cutoffs.at and observation.retrieved_at <= cutoffs.at
        order by observation.effective_at desc, observation.id desc limit 1
      ) picked limit 5001`)
    if (exact.rows.length) anchors.push(...await db.select({ row: table }).from(table)
      .where(inArray(table.id, exact.rows.map((row) => row.id))))
  }
  const rows = [...new Map([...anchors, ...daily, ...latest].map((entry) => [entry.row.id, entry])).values()]
  const projected: Evidence[] = []
  for (const { row } of rows) {
    for (const scope of (scoped.get(row.instrumentId)?.values() ?? [])) {
      if (scope.asset !== row.asset) continue
      if (projected.length === 5000) return { evidence: projected, truncated: true, reportedMarks }
      projected.push({ batchId: row.id, row: 0, marketReference: { source: row.source, method: row.method, revision: row.revision,
        retrievedAt: row.retrievedAt.toISOString(), observedAt: row.observedAt?.toISOString() ?? null }, observation: { ...scope, id: 'shared-mark:' + row.id, type: 'mark',
        timestamp: (row.retrievedAt > row.effectiveAt ? row.retrievedAt : row.effectiveAt).toISOString(), sequence: null, price: new Decimal(row.price).toFixed(),
        quantity: null, amount: null, fee: null, feeAsset: null } })
    }
  }
  if (!demo && scoped.size) {
    const terminal = await db.select({ market: marketTracking, instrument: instruments.id }).from(marketTracking)
      .innerJoin(instruments, eq(instruments.marketId, marketTracking.marketId))
      .where(inArray(instruments.id, [...scoped.keys()]))
    const journal = await lifecycleAt(db, [...new Set(terminal.map(({ market }) => market.marketId))], cutoff)
    for (const { market, instrument } of terminal) {
      const event = journal.get(market.marketId)?.find((row) => row.resolution && !row.conflict)
      const observedAt = event?.retrievedAt.toISOString() ?? market.metadataAt?.toISOString()
      const proof = event?.resolution ?? (!journal.has(market.marketId) ? market.resolution : null)
      if (!proof || !observedAt || observedAt > cutoff) continue
      for (const scope of scoped.get(instrument)!.values()) {
        if (projected.length === 5000) return { evidence: projected, truncated: true, reportedMarks }
        projected.push({ batchId: market.marketId, row: 0, marketReference: { source: proof.source ?? 'kalshi_trade_api',
          method: 'verified_resolution', revision: market.marketId + ':' + proof.knownAt,
          retrievedAt: observedAt, observedAt: proof.settlementTime ?? null }, observation: { ...scope,
          id: 'shared-terminal:' + instrument, type: 'mark', terminalMarketReference: true, timestamp: observedAt,
          sequence: null, price: null, quantity: null, amount: null, fee: null, feeAsset: null } })
      }
    }
  }
  return { evidence: projected, truncated: latest.length === 5001 || daily.length === 5001 || boundaryLimit, reportedMarks }
}

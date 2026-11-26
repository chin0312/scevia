import { and, eq, inArray, notLike, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { events, instruments, marketLifecycleEvidence, marketInstrumentMappings, markets, sharedMarketObservations } from '../db/schema.js'
import { fxAnchors } from '../fx/reference.js'
import { lifecycleAt } from '../tracking/lifecycle.js'
import { ReplayError, type ReplayConfig } from './contracts.js'

type Read = Pick<Database, 'select' | 'execute'>
const quotes = sharedMarketObservations

export function resolutionCutoffs(config: ReplayConfig, catalog: ReplayEvidence['catalog'], lifecycle: Map<string, ReplayLifecycle[]>) {
  const cutoffs = new Set<string>()
  const marketsByInstrument = new Map(catalog.map((row) => [row.instrumentId, row.marketId]))
  for (const position of config.positions) {
    const journal = lifecycle.get(marketsByInstrument.get(position.instrumentId) ?? '') ?? []
    for (const row of journal) {
      const retrieved = row.retrievedAt.toISOString()
      const terminal = ['resolved', 'settled', 'disputed', 'invalidated', 'voided'].includes(row.lifecycle)
      if (!row.resolution && !terminal && !row.conflict) continue
      const effective = row.resolution?.settlementTime ?? row.resolution?.knownAt ?? retrieved
      const disputed = row.conflict || ['disputed', 'invalidated', 'voided'].includes(row.lifecycle)
      const at = disputed || (config.mode === 'knowledge' && retrieved > effective) ? retrieved : effective
      cutoffs.add(at)
      if (row.resolution && position.redemption?.mode === 'delay') {
        cutoffs.add(new Date(Date.parse(at) + position.redemption.seconds * 1000).toISOString())
      }
    }
    if (position.redemption?.mode === 'at') cutoffs.add(position.redemption.at)
  }
  return [...cutoffs].filter((at) => at >= config.from && at <= config.through)
}

export async function replayEvidence(db: Read, config: ReplayConfig, evidenceAt: string) {
  const ids = [...new Set(config.positions.map((row) => row.instrumentId))]
  const catalog = ids.length ? await db.select({
    instrumentId: instruments.id, nativeInstrument: instruments.externalId, outcome: instruments.outcomeType,
    asset: instruments.settlementAssetCode, marketId: markets.id, nativeMarket: markets.externalId, provider: markets.providerCode,
    marketAsset: markets.settlementAssetCode,
    generation: marketInstrumentMappings.generation, mappedAsset: marketInstrumentMappings.asset,
    nativeOutcomes: sql<string[]>`array(select leg.external_id from ${instruments} leg where leg.market_id = ${markets.id})`,
    eventId: events.id, title: markets.title, eventTitle: events.name,
  }).from(instruments).innerJoin(markets, eq(markets.id, instruments.marketId)).innerJoin(events, eq(events.id, markets.eventId))
    .leftJoin(marketInstrumentMappings, eq(marketInstrumentMappings.instrumentId, instruments.id))
    .where(and(inArray(instruments.id, ids), notLike(markets.externalId, 'simulation:%'))) : []
  if (catalog.length !== ids.length) throw new ReplayError('unverified_replay_instrument')
  const lifecycle = await lifecycleAt(db, [...new Set(catalog.map((item) => item.marketId))], evidenceAt, 5001)
  if ([...lifecycle.values()].reduce((sum, rows) => sum + rows.length, 0) > 5000) throw new ReplayError('replay_lifecycle_work_limit')
  if (!ids.length) return { catalog, lifecycle, quotes: [] as Array<typeof quotes.$inferSelect> }

  const transitionTimes = resolutionCutoffs(config, catalog, lifecycle)
  const clocks = [...new Set([config.from, config.through, ...transitionTimes, ...fxAnchors(config.cashFlows.map((row) => row.at)), ...config.positions.flatMap(({ entry, exits }) => [entry.at, ...exits.map((exit) => exit.at)])])]
  if (clocks.length > 600) throw new ReplayError('replay_reference_boundary_limit')
  const instrumentList = sql.join(ids.map((id) => sql`${id}`), sql`, `)
  const clockList = sql.join(clocks.map((at) => sql`${at}`), sql`, `)
  const observations = await db.execute<{ id: string }>(sql`
    with selected as (
      select i.id, i.settlement_asset_code as asset from ${instruments} i where i.id in (${instrumentList})
    ), refs as (
      select q.id, q.instrument_id,
        case when ${config.mode === 'knowledge'} then greatest(q.effective_at, q.retrieved_at) else q.effective_at end as at,
        q.effective_at, q.retrieved_at, q.revision
      from selected s join ${quotes} q on q.instrument_id = s.id and q.asset = s.asset
      where q.retrieved_at <= ${evidenceAt}::timestamptz and q.effective_at <= ${config.through}::timestamptz
        and q.effective_at >= ${config.from}::timestamptz - interval '30 days'
        and q.observed_at <= q.effective_at and q.observed_at <= q.retrieved_at
        and q.method in ('historical_close', 'historical_sample')
    ), daily as (
      select id, rank() over (partition by instrument_id, (at at time zone 'UTC')::date order by effective_at desc) as pick
      from refs where at > ${config.from}::timestamptz and at <= ${config.through}::timestamptz
    )
    select id from daily where pick = 1
    union
    select anchor.id from selected s cross join unnest(array[${clockList}]::timestamptz[]) c(cutoff)
      cross join lateral (select id from refs where instrument_id = s.id and at <= c.cutoff
        order by effective_at desc fetch first 1 row with ties) anchor
    limit 6001
  `)
  if (observations.rows.length > 6000) throw new ReplayError('replay_market_reference_work_limit')
  const selected = observations.rows.map((row) => row.id)
  return { catalog, lifecycle, quotes: selected.length ? await db.select().from(quotes).where(inArray(quotes.id, selected)) : [] }
}

export type ReplayEvidence = Awaited<ReturnType<typeof replayEvidence>>
export type ReplayLifecycle = typeof marketLifecycleEvidence.$inferSelect

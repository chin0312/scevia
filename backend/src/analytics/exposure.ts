import { Decimal } from 'decimal.js'
import type { replayAccounting } from '../accounting/ledger.js'
import { concentration } from './performance.js'
import { settlementRisk, type BinaryGroup, type SettlementConstraint } from './settlement.js'

const D = Decimal.clone({ precision: 70 })
type Replay = ReturnType<typeof replayAccounting>
export interface MarketIdentity {
  instrument: string; market: string; event: string; outcome: string; resolvesAt: Date | null; title: string; lifecycle: string
}
export interface ReviewedRule {
  market: string; event: string; yes: string; no: string; asset: string; evidence: string; reviewedAt: Date
}

export function analyzeExposure(state: Replay, asset: string, accounts: string[], metadata: MarketIdentity[], rules: ReviewedRule[], edges: Array<{
  left: string; right: string; kind: SettlementConstraint['kind']; evidence: string
}>, graph: Set<string>, graphLimit: boolean) {
  const holdings = state.holdings.filter((holding) => holding.asset === asset && new D(holding.quantity).gt(0))
  const instruments = new Map(metadata.map((item) => [item.instrument, item]))
  const grouped = new Map<string, { knownValue: Decimal; unavailableMarks: number; holdings: number }>()
  const instrumentRows = holdings.map((holding) => {
    const identity = instruments.get(holding.instrument)
    const event = identity?.event ?? 'unmapped'
    const aggregate = grouped.get(event) ?? { knownValue: new D(0), unavailableMarks: 0, holdings: 0 }
    if (holding.marketValue !== null) aggregate.knownValue = aggregate.knownValue.plus(holding.marketValue)
    else aggregate.unavailableMarks += 1
    aggregate.holdings += 1
    grouped.set(event, aggregate)
    return { account: holding.account, venue: holding.venue, instrument: holding.instrument, market: identity?.market ?? null,
      event: identity?.event ?? null, outcome: identity?.outcome ?? null, title: identity?.title ?? null,
      lifecycle: identity?.lifecycle ?? 'unknown', quantity: holding.quantity, quantityStatus: holding.quantityStatus, basis: holding.basis,
      mark: holding.mark, markAt: holding.markAt, markStatus: holding.markStatus, knownMarketValue: holding.marketValue,
      resolvesAt: identity?.resolvesAt?.toISOString() ?? null }
  })
  function allocate(key: (row: typeof instrumentRows[number]) => string) {
    const buckets = new Map<string, Decimal>()
    for (const row of instrumentRows) {
      if (row.knownMarketValue === null) continue
      const id = key(row)
      buckets.set(id, (buckets.get(id) ?? new D(0)).plus(row.knownMarketValue))
    }
    const amounts = [...buckets.entries()]
    const weights = concentration(amounts.map(([, amount]) => amount.toFixed()))
    return {
      rows: amounts.map(([id, amount], index) => ({ id, knownValue: amount.toFixed(), weight: weights?.weights[index] ?? null })),
      concentration: weights ? { denominator: weights.denominator, hhi: weights.hhi, effectiveExposures: weights.effectiveExposures, topShares: weights.topShares } : null,
    }
  }
  const unmarkedPositions = holdings.filter((row) => row.marketValue === null).length
  const eventAllocation = [...grouped].map(([event, group]) => ({ event, holdings: group.holdings,
    knownValue: group.knownValue.toFixed(), unavailableMarks: group.unavailableMarks }))
  const supported = new Set<string>()
  const groups: BinaryGroup[] = rules.filter((rule) => rule.asset === asset && rule.reviewedAt.toISOString() <= state.asOf
    && instruments.get(rule.yes)?.market === rule.market && instruments.get(rule.no)?.market === rule.market
    && instruments.get(rule.yes)?.lifecycle === 'open'
    && metadata.filter((identity) => identity.market === rule.market).length === 2)
    .flatMap((rule) => {
      const legs = holdings.filter((holding) => [rule.yes, rule.no].includes(holding.instrument)
        && holding.quantityStatus === 'reconstructed_from_declaration')
        .map((holding) => ({ instrument: holding.instrument, account: holding.account, quantity: holding.quantity,
          mark: holding.markStatus === 'estimated' ? holding.mark : null }))
      if (!legs.length && !graph.has(rule.market)) return []
      if (legs.length) supported.add(rule.market)
      return [{ id: rule.market, yes: rule.yes, no: rule.no, legs }]
    })
  const feasibleIds = new Set(groups.map((group) => group.id))
  const eligibleRules = rules.filter((rule) => feasibleIds.has(rule.market))
  const applied = edges.filter((edge) => graph.has(edge.left) && graph.has(edge.right) && edge.evidence.trim())
  const unsupported = instrumentRows.filter((row) => row.market === null || !supported.has(row.market)
    || row.quantityStatus !== 'reconstructed_from_declaration')
  const result = graphLimit ? { status: 'unavailable' as const, reason: 'reviewed_graph_limit' }
    : groups.every((group) => group.legs.length === 0) ? { status: 'unavailable' as const, reason: 'no_supported_groups' }
      : settlementRisk(groups, applied, [...graph].filter((market) => !feasibleIds.has(market)))
  const balanceRows = state.cash.filter((row) => row.asset === asset)
  const confirmedCash = balanceRows.length && accounts.every((account) => balanceRows.some((row) => row.account === account)) && balanceRows.every((row) => row.balance !== null)
    ? balanceRows.reduce((total, row) => total.plus(row.balance!), new D(0)) : null
  const pending = state.holdings.filter((row) => row.asset === asset)
    .reduce((total, row) => total.plus(row.pending), new D(0))
  const pendingKnown = state.holdings.filter((row) => row.asset === asset)
    .every((row) => row.settlementAvailability === 'selected_entitlements_only')
  const openValue = instrumentRows.every((row) => row.knownMarketValue !== null
    && row.quantityStatus === 'reconstructed_from_declaration')
    ? instrumentRows.reduce((total, row) => total.plus(row.knownMarketValue!), new D(0)) : null
  const valueBuckets = [
    ...eventAllocation.map((row) => ({ kind: 'open_positions', id: row.event, value: row.knownValue })),
    { kind: 'cash', id: 'cash', value: confirmedCash?.toFixed() ?? null },
    { kind: 'pending_entitlements', id: 'pending', value: pendingKnown ? pending.toFixed() : null },
  ]
  // Phase 3 portfolioValue also requires an established opening inventory.
  const inventoryEstablished = confirmedCash !== null && balanceRows.every((row) => row.openingInventoryAt !== null)
  const selectedValueEligible = inventoryEstablished && balanceRows.every((row) => row.portfolioValue !== null)
  const nonnegativeCash = balanceRows.every((row) => row.balance !== null && new D(row.balance).gte(0))
  const cashWeights = selectedValueEligible && openValue !== null && confirmedCash !== null && nonnegativeCash && pendingKnown
    ? concentration(valueBuckets.map((row) => row.value!)) : null
  const knownBasis = instrumentRows.filter((row) => row.basis !== null)
  const basisWeights = concentration(knownBasis.map((row) => row.basis!))
  const cashInclusive = result.status === 'exact' && unsupported.length === 0 && inventoryEstablished && confirmedCash !== null && pendingKnown
    ? { scope: 'selected_evidence', openingCash: confirmedCash.toFixed(), pendingEntitlements: pending.toFixed(),
      worst: confirmedCash.plus(pending).plus(result.worst.payout).toFixed(),
      best: confirmedCash.plus(pending).plus(result.best.payout).toFixed() } : null
  return {
    asset, otherObservedAssets: [...new Set(state.cash.filter((row) => row.asset !== asset).map((row) => row.asset))], exposure: { instruments: instrumentRows, byEvent: eventAllocation },
    allocation: { denominatorScope: 'known_marked_open_positions_excluding_cash', unmarkedPositions,
      byInstrument: allocate((row) => row.event === null ? JSON.stringify([row.venue, row.account, row.instrument]) : row.instrument),
      byMarket: allocate((row) => row.market ?? JSON.stringify(['unmapped', row.venue, row.account, row.instrument])),
      byEvent: allocate((row) => row.event ?? JSON.stringify(['unmapped', row.venue, row.account, row.instrument])),
      byVenue: allocate((row) => row.venue), byAccount: allocate((row) => JSON.stringify([row.venue, row.account])),
    },
    allocationBases: {
      cashInclusive: { scope: 'selected_marked_positions_cash_and_pending', denominator: cashWeights?.denominator ?? null,
        reason: cashWeights ? null : !inventoryEstablished && confirmedCash !== null
          ? 'opening_inventory_unknown' : 'incomplete_nonpositive_or_negative_balance',
        rows: valueBuckets.map((row, i) => ({ ...row, weight: cashWeights?.weights[i] ?? null })) },
      acquisitionBasis: { scope: 'known_open_position_basis', denominator: basisWeights?.denominator ?? null,
        unavailable: instrumentRows.length - knownBasis.length,
        rows: knownBasis.map(({ account, venue, instrument, basis }, i) => ({
          account, venue, instrument, basis, weight: basisWeights?.weights[i] ?? null,
        })) },
    },
    pendingEntitlements: state.holdings.filter((row) => row.asset === asset && row.entitlements.length > 0)
      .map(({ account, venue, instrument, pending, settlementAvailability, entitlements }) =>
        ({ account, venue, instrument, pending, settlementAvailability, entitlements })),
    settlement: { scope: unsupported.length ? 'supported_subset' : 'supported_selected_positions',
      payoutBasis: 'gross_contractual_excluding_cash_fees_and_pending_entitlements',
      unsupported, evidenceTier: 'independently_reviewed_rule', rules: eligibleRules, constraints: applied, cashInclusive, result },
    timeline: instrumentRows.filter((row) => row.resolvesAt !== null).sort((a, b) => a.resolvesAt!.localeCompare(b.resolvesAt!)),
    resolutionExposure: { basis: 'event_catalog_schedule_hint', timingIsMarketVerified: false,
      buckets: resolutionBuckets(instrumentRows, state.asOf) },
    undatedPositions: instrumentRows.filter((row) => row.resolvesAt === null).length,
  }
}


function resolutionBuckets(rows: Array<{ resolvesAt: string | null; instrument: string; venue: string; account: string;
  quantity: string; quantityStatus: string; knownMarketValue: string | null }>, asOf: string) {
  const cutoff = Date.parse(asOf)
  const day = 86_400_000
  const buckets: Record<string, typeof rows> = { overdue: [], within7Days: [], within30Days: [], within90Days: [], later: [], unknown: [] }
  for (const row of rows) {
    const remaining = row.resolvesAt === null ? null : Date.parse(row.resolvesAt) - cutoff
    const key = remaining === null ? 'unknown' : remaining <= 0 ? 'overdue' : remaining <= 7 * day ? 'within7Days'
      : remaining <= 30 * day ? 'within30Days' : remaining <= 90 * day ? 'within90Days' : 'later'
    buckets[key]!.push(row)
  }
  return Object.entries(buckets).map(([bucket, holdings]) => ({ bucket, holdings,
    knownMarkedExposure: holdings.reduce((total, row) => total.plus(row.knownMarketValue ?? 0), new D(0)).toFixed(),
    unavailableMarks: holdings.filter((row) => row.knownMarketValue === null).length }))
}

export function connectedMarkets(seeds: string[], edges: SettlementConstraint[]) {
  const members = new Set(seeds)
  const neighbors = new Map<string, string[]>()
  for (const { left, right } of edges) {
    neighbors.set(left, [...(neighbors.get(left) ?? []), right])
    neighbors.set(right, [...(neighbors.get(right) ?? []), left])
  }
  const queue = [...members]
  for (let index = 0; index < queue.length; index += 1) {
    for (const id of neighbors.get(queue[index]!) ?? []) {
      if (!members.has(id)) { members.add(id); queue.push(id) }
    }
  }
  return members
}

interface ReportedSnapshot {
  account: string; venue: string; instrument: string; asset: string | null
  sourceRecordId: string; syncRunId: string; observedAt: Date; quantity: string; mark: string | null; markAt: Date | null
}
interface SnapshotCoverage {
  account: string; entity: string; status: string; lastSuccessfulRunId: string | null
  lastAttemptStatus: string | null; lastAttemptAt: Date | null; lastSuccessfulSyncAt: Date | null
}
export function analyzeReportedExposure(snapshots: ReportedSnapshot[], coverage: SnapshotCoverage[], asOf: string,
  asset: string, metadata: MarketIdentity[], rules: ReviewedRule[], edges: SettlementConstraint[], graphLimit: boolean) {
  const cutoff = Date.parse(asOf)
  const index = new Map(metadata.map((item) => [item.instrument, item]))
  const rows = snapshots.filter((row) => row.asset === asset && row.observedAt.getTime() <= cutoff).map((row) => {
    const scope = coverage.find((entry) => entry.entity === 'positions' && entry.account === row.account)
    const recent = cutoff - row.observedAt.getTime() <= 86_400_000
    const member = scope?.lastSuccessfulRunId === row.syncRunId && scope.lastAttemptStatus === 'complete'
      && scope.lastSuccessfulSyncAt !== null && scope.lastSuccessfulSyncAt.getTime() <= cutoff
      && scope.lastAttemptAt !== null && scope.lastAttemptAt.getTime() <= cutoff
    const usableMark = row.mark !== null && row.markAt !== null && row.markAt.getTime() <= cutoff
      && cutoff - row.markAt.getTime() <= 86_400_000
    return { ...row, market: index.get(row.instrument)?.market ?? null, freshness: recent ? 'recent' : 'stale',
      membership: member ? 'seen_in_latest_usable_refresh' : 'uncertain',
      providerCoverage: scope?.status ?? 'unknown',
      eligibleQuantity: recent && member && !new D(row.quantity).isNegative(),
      referenceMark: usableMark ? row.mark : null,
      observedMarketValue: recent && member && usableMark ? new D(row.quantity).mul(row.mark!).toFixed() : null }
  })
  const eligibleRules = rules.filter((rule) => rule.asset === asset && rule.reviewedAt.toISOString() <= asOf
    && index.get(rule.yes)?.market === rule.market && index.get(rule.no)?.market === rule.market
    && index.get(rule.yes)?.lifecycle === 'open' && metadata.filter((item) => item.market === rule.market).length === 2)
  const matched = rows.filter((row) => row.eligibleQuantity && new D(row.quantity).gt(0)
    && eligibleRules.some((rule) => rule.yes === row.instrument || rule.no === row.instrument))
  const connected = connectedMarkets(matched.flatMap((row) => row.market ?? []), edges)
  const groups = eligibleRules.filter((rule) => connected.has(rule.market)).map((rule) => ({
    id: rule.market, yes: rule.yes, no: rule.no,
    legs: matched.filter((row) => row.instrument === rule.yes || row.instrument === rule.no)
      .map((row) => ({ instrument: row.instrument, quantity: row.quantity, account: row.account, mark: row.referenceMark })),
  }))
  const result = graphLimit ? { status: 'unavailable' as const, reason: 'reviewed_graph_limit' }
    : settlementRisk(groups, edges.filter((edge) => connected.has(edge.left) && connected.has(edge.right)),
      [...connected].filter((market) => !groups.some((group) => group.id === market)))
  return { scope: 'provider_reported_known_components', effectivePortfolioReplacement: false,
    rows, settlement: { scope: 'eligible_observed_positions_only', unsupportedCount: rows.filter((row) => !matched.includes(row)).length,
      result } }
}

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
      concentration: weights ? { denominator: weights.denominator, hhi: weights.hhi, effectiveExposures: weights.effectiveExposures } : null,
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
  const applied = edges.filter((edge) => feasibleIds.has(edge.left) && feasibleIds.has(edge.right) && edge.evidence.trim())
  const unsupported = instrumentRows.filter((row) => row.market === null || !supported.has(row.market)
    || row.quantityStatus !== 'reconstructed_from_declaration')
  const result = graphLimit ? { status: 'unavailable' as const, reason: 'reviewed_graph_limit' }
    : groups.every((group) => group.legs.length === 0) ? { status: 'unavailable' as const, reason: 'no_supported_groups' }
      : [...graph].some((market) => !feasibleIds.has(market))
        ? { status: 'unavailable' as const, reason: 'connected_rule_unavailable' } : settlementRisk(groups, applied)
  const balanceRows = state.cash.filter((row) => row.asset === asset)
  const confirmedCash = balanceRows.length && accounts.every((account) => balanceRows.some((row) => row.account === account)) && balanceRows.every((row) => row.balance !== null)
    ? balanceRows.reduce((total, row) => total.plus(row.balance!), new D(0)) : null
  const pending = state.holdings.filter((row) => row.asset === asset)
    .reduce((total, row) => total.plus(row.pending), new D(0))
  const pendingKnown = state.holdings.filter((row) => row.asset === asset)
    .every((row) => row.settlementAvailability === 'selected_entitlements_only')
  const cashInclusive = result.status === 'exact' && unsupported.length === 0 && confirmedCash !== null && pendingKnown
    ? { scope: 'selected_evidence', openingCash: confirmedCash.toFixed(), pendingEntitlements: pending.toFixed(),
      worst: confirmedCash.plus(pending).plus(result.worst.payout).toFixed(),
      best: confirmedCash.plus(pending).plus(result.best.payout).toFixed() } : null
  return {
    asset, otherObservedAssets: [...new Set(state.cash.filter((row) => row.asset !== asset).map((row) => row.asset))], exposure: { instruments: instrumentRows, byEvent: eventAllocation },
    allocation: { denominatorScope: 'known_marked_open_positions_excluding_cash', unmarkedPositions,
      byInstrument: allocate((row) => row.event === null ? JSON.stringify([row.venue, row.account, row.instrument]) : row.instrument),
      byMarket: allocate((row) => row.market ?? 'unmapped'),
      byEvent: allocate((row) => row.event ?? 'unmapped'),
      byVenue: allocate((row) => row.venue), byAccount: allocate((row) => row.account),
    },
    pendingEntitlements: state.holdings.filter((row) => row.asset === asset && row.entitlements.length > 0)
      .map(({ account, venue, instrument, pending, settlementAvailability, entitlements }) =>
        ({ account, venue, instrument, pending, settlementAvailability, entitlements })),
    settlement: { scope: unsupported.length ? 'supported_subset' : 'supported_selected_positions',
      payoutBasis: 'gross_contractual_excluding_cash_fees_and_pending_entitlements',
      unsupported, rules: eligibleRules, constraints: applied, cashInclusive, result },
    timeline: instrumentRows.filter((row) => row.resolvesAt !== null).sort((a, b) => a.resolvesAt!.localeCompare(b.resolvesAt!)),
    undatedPositions: instrumentRows.filter((row) => row.resolvesAt === null).length,
  }
}

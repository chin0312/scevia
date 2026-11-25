import { Decimal } from 'decimal.js'
import type { Evidence, EvidenceReference, FinancialObservation } from './model.js'
export type { Evidence } from './model.js'

const Money = Decimal.clone({ precision: 70, rounding: Decimal.ROUND_HALF_EVEN })
const zero = () => new Money(0)
const financialValues = ({ canonicalInstrumentId: _association, ...values }: FinancialObservation) => values

export function replayAccounting(evidence: Evidence[], asOf: string, providerEvidencePresent = false) {
  const groups = new Map<string, Evidence[]>()
  const discrepancies: Array<{ reason: string; sources: EvidenceReference[]; scope: Pick<FinancialObservation, 'venue' | 'account' | 'asset' | 'instrument' | 'type' | 'feeAsset' | 'completeSet'> }> = []
  const sources = (items: Evidence[]): EvidenceReference[] => items.map((item) => 'batchId' in item
    ? { batchId: item.batchId, row: item.row }
    : { providerAccountId: item.providerAccountId, sourceRecordId: item.sourceRecordId, payloadSha256: item.payloadSha256 })
  const scope = ({ venue, account, asset, instrument, type, feeAsset, completeSet }: FinancialObservation) => ({ venue, account, asset, instrument, type, feeAsset, ...(completeSet ? { completeSet } : {}) })
  for (const item of evidence) {
    const event = item.observation
    if (event.timestamp > asOf) continue
    if (item.unresolvedReason || !event.id) { discrepancies.push({ reason: item.unresolvedReason ?? 'economic_id_missing', sources: sources([item]), scope: scope(event) }); continue }
    const key = JSON.stringify([event.venue, event.account, event.id])
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const events = [...groups.entries()].flatMap(([id, group]) => {
    const observation = financialValues(group[0]!.observation)
    const fingerprint = JSON.stringify(observation)
    if (group.some((item) => JSON.stringify(financialValues(item.observation)) !== fingerprint)) {
      discrepancies.push({ reason: 'conflicting_observations', sources: sources(group), scope: scope(observation) })
      return []
    }
    const authority = group.some((item) => item.authority === 'user_accepted') ? 'user_accepted'
      : group.some((item) => 'providerAccountId' in item) ? 'provider_evidence' : 'user_declared'
    return [{ ...observation, economicId: id, authority, sources: sources(group) }]
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp)
    || Number(b.type === 'opening_inventory' || b.type === 'opening_cash')
      - Number(a.type === 'opening_inventory' || a.type === 'opening_cash')
    || Number(a.feeTiming === 'execution_evidence') - Number(b.feeTiming === 'execution_evidence')
    || (a.sequence ?? 0) - (b.sequence ?? 0) || a.economicId.localeCompare(b.economicId))
  const positions = new Map<string, {
    venue: string; account: string; asset: string; instrument: string
    quantity: Decimal; basis: Decimal | null; observedInventory: boolean; declaredOpening: boolean; entitlements: Map<string, { quantity: Decimal; rate: Decimal }>; pendingQuantity: Decimal; pending: Decimal
    mark: Decimal | null; markAt: string | null; markSources: EvidenceReference[]
  }>()
  const cash = new Map<string, {
    venue: string; account: string; asset: string; delta: Decimal; opening: Decimal | null; openingAt: string | null
    contributions: Decimal; unclassifiedCashFlow: boolean; realized: Decimal; fees: Decimal; posted: boolean; inventoryOpeningAt: string | null; coverageFrom: string | null; coverageThrough: string | null; incomplete: boolean; pnlIncomplete: boolean
  }>()
  type FeeEffect = { kind: 'execution' | 'standalone' | 'funding'; amount: string | null }
  const ledger: Array<{
    eventId: string; asset: string; instrument?: string; cashDelta: string; quantityDelta: string; basisDelta: string | null; entitlementDelta: string; realized: string | null; feeEffect?: FeeEffect
  }> = []
  const getCash = (event: FinancialObservation, asset = event.asset) => {
    const key = JSON.stringify([event.venue, event.account, asset])
    let state = cash.get(key)
    if (!state) {
      state = { venue: event.venue, account: event.account, asset, delta: zero(), opening: null, openingAt: null,
        contributions: zero(), unclassifiedCashFlow: false, realized: zero(), fees: zero(), posted: false, inventoryOpeningAt: null, coverageFrom: null, coverageThrough: null, incomplete: false, pnlIncomplete: false }
      cash.set(key, state)
    }
    return state
  }
  function positionFor(event: FinancialObservation, instrument: string) {
    const key = JSON.stringify([event.venue, event.account, event.asset, instrument])
    let holding = positions.get(key)
    if (!holding) {
      holding = { venue: event.venue, account: event.account, asset: event.asset, instrument,
        quantity: zero(), basis: zero(), observedInventory: false, declaredOpening: false, entitlements: new Map(),
        pendingQuantity: zero(), pending: zero(), mark: null, markAt: null, markSources: [] }
      positions.set(key, holding)
    }
    return holding
  }
  const ordering = new Map<string, { count: number; buysOnly: boolean }>()
  const orderKey = (event: FinancialObservation, instrument = event.instrument) =>
    JSON.stringify([event.venue, event.account, instrument, event.asset, event.timestamp, event.sequence ?? 0])
  const positionKeys = (event: FinancialObservation) => event.completeSet
    ? [orderKey(event), orderKey(event, event.completeSet.counterInstrument)] : [orderKey(event)]
  const affectsPosition = (event: FinancialObservation) => event.completeSet !== undefined || ['opening_position', 'buy', 'sell', 'settlement', 'redemption'].includes(event.type)
  for (const event of events.filter(affectsPosition)) {
    for (const key of positionKeys(event)) {
      const previous = ordering.get(key)
      ordering.set(key, { count: (previous?.count ?? 0) + 1, buysOnly: event.type === 'buy' && (previous?.buysOnly ?? true) })
    }
  }
  const markGroups = new Map<string, Set<string>>()
  const markKey = (event: FinancialObservation) => JSON.stringify([event.venue, event.account, event.instrument, event.asset, event.timestamp])
  for (const event of events.filter((candidate) => candidate.type === 'mark')) {
    const key = markKey(event)
    const prices = markGroups.get(key) ?? new Set<string>()
    prices.add(event.price!)
    markGroups.set(key, prices)
  }
  const eventIndex = new Map(events.map((event) => [event.economicId, event]))
  const linkedFees = new Map<string, typeof events>()
  for (const event of events) {
    if (!event.relatedEventId || event.feeTiming !== 'execution_evidence') continue
    const key = JSON.stringify([event.venue, event.account, event.relatedEventId])
    const parent = eventIndex.get(key)
    if (!parent || !['buy', 'sell'].includes(parent.type) || parent.timestamp > event.timestamp || parent.fee !== null) continue
    const candidates = linkedFees.get(key) ?? []
    candidates.push(event)
    linkedFees.set(key, candidates)
  }
  const usedFeeEvents = new Set<string>()
  const postedEvents = new Set<string>()
  for (const [key, candidates] of linkedFees) {
    if (candidates.length !== 1) continue
    const charge = candidates[0]!
    const parent = eventIndex.get(key)!
    if (charge.asset !== (parent.feeAsset ?? parent.asset)) continue
    parent.fee = charge.type === 'rebate' ? new Money(charge.amount!).negated().toFixed() : charge.amount
    parent.sources = [...parent.sources, ...charge.sources]
    usedFeeEvents.add(charge.economicId)
  }
  for (const event of events) {
    const money = getCash(event)
    const reject = (reason: string) => discrepancies.push({ reason, sources: event.sources, scope: scope(event) })
    if (affectsPosition(event) && positionKeys(event).some((key) => { const group = ordering.get(key)!; return group.count > 1 && !group.buysOnly })) { reject('position_event_order_ambiguous'); continue }

    const amount = new Money(event.amount ?? 0)
    let feeEffect: FeeEffect | undefined
    let delta = zero()
    let quantityDelta = zero()
    let basisDelta: Decimal | null = zero()
    let entitlementDelta = zero()
    let realized: Decimal | null = null
    if (event.type === 'history_complete') {
      if (!event.coveredThrough || money.coverageFrom !== null) { reject('history_declaration_conflict'); continue }
      money.coverageFrom = event.timestamp
      money.coverageThrough = event.coveredThrough
      continue
    }
    if (event.type === 'opening_inventory') {
      if (money.inventoryOpeningAt !== null || [...positions.values()].some((holding) => holding.venue === event.venue
        && holding.account === event.account && holding.asset === event.asset && holding.observedInventory)) {
        reject('opening_inventory_conflict'); continue
      }
      money.inventoryOpeningAt = event.timestamp
      continue
    } else if (event.type === 'opening_cash') {
      if (money.opening !== null || money.posted) {
        reject('opening_cash_conflict'); continue
      }
      money.opening = amount
      money.openingAt = event.timestamp
    } else if (event.type === 'deposit' || event.type === 'withdrawal') {
      delta = event.type === 'deposit' ? amount : amount.negated()
      if (event.sources.some((item) => 'providerAccountId' in item)) {
        money.unclassifiedCashFlow = true
        feeEffect = { kind: 'funding', amount: event.fee }
        if (event.fee === null) money.incomplete = true
        else {
          delta = delta.minus(event.fee)
          money.fees = money.fees.plus(event.fee)
          realized = new Money(event.fee).negated()
        }
      } else money.contributions = money.contributions.plus(delta)
    } else if (event.type === 'fee' || event.type === 'rebate' || event.type === 'reward') {
      if (event.relatedEventId && event.feeTiming === 'execution_evidence') {
        const related = eventIndex.get(JSON.stringify([event.venue, event.account, event.relatedEventId]))
        if (!related || !['buy', 'sell'].includes(related.type) || related.timestamp > event.timestamp) {
          reject('related_fee_event_unavailable'); continue
        }
        if (!postedEvents.has(related.economicId)) { reject('execution_fee_parent_not_posted'); continue }
        if (usedFeeEvents.has(event.economicId)) continue
        if (related.fee !== null) {
          const signed = event.type === 'fee' ? amount : amount.negated()
          if ((related.feeAsset ?? related.asset) !== event.asset || !signed.eq(related.fee)) {
            reject('linked_fee_conflicts_with_attached_fee')
          }
          continue
        }
        reject('fee_allocation_to_trade_unverified')
        continue
      }
      delta = event.type === 'fee' ? amount.negated() : amount
      if (event.type !== 'reward') {
        money.fees = money.fees.minus(delta)
        feeEffect = { kind: 'standalone', amount: delta.negated().toFixed() }
      }
      realized = delta
    } else if (event.type === 'split' || event.type === 'merge') {
      const quantity = new Money(event.quantity ?? 0)
      const legs = event.completeSet
      if (!legs || !event.instrument || legs.counterInstrument === event.instrument
        || !quantity.gt(0) || !quantity.eq(amount)) { reject('complete_conversion_legs_required'); continue }
      const fraction = new Money(legs.primaryBasisFraction)
      if (fraction.lt(0) || fraction.gt(1)) { reject('complete_conversion_legs_required'); continue }
      const primary = positionFor(event, event.instrument)
      const counter = positionFor(event, legs.counterInstrument)
      const split = event.type === 'split'
      if (!split && (primary.quantity.lt(quantity) || counter.quantity.lt(quantity))) {
        reject('insufficient_complete_set_inventory'); continue
      }
      delta = split ? amount.negated() : amount
      let released: Decimal | null = zero()
      for (const [index, holding] of [primary, counter].entries()) {
        const positionDelta = split ? quantity : quantity.negated()
        const cost = split ? (index === 0 ? amount.mul(fraction) : amount.minus(amount.mul(fraction)))
          : holding.basis === null ? null : quantity.eq(holding.quantity) ? holding.basis.negated()
            : holding.basis.mul(quantity).div(holding.quantity).negated()
        holding.observedInventory = true
        holding.quantity = holding.quantity.plus(positionDelta)
        holding.basis = holding.quantity.isZero() ? zero()
          : holding.basis === null || cost === null ? null : holding.basis.plus(cost)
        released = released === null || cost === null ? null : released.minus(cost)
        ledger.push({ eventId: event.economicId, asset: event.asset, instrument: holding.instrument, cashDelta: '0',
          quantityDelta: positionDelta.toFixed(), basisDelta: cost?.toFixed() ?? null, entitlementDelta: '0', realized: null })
      }
      if (!split) {
        realized = released === null ? null : amount.minus(released)
        if (realized === null) money.pnlIncomplete = true
      }
    } else {
      const holding = positionFor(event, event.instrument!)
      const quantity = new Money(event.quantity ?? 0)
      const price = new Money(event.price ?? 0)
      const fee = new Money(event.fee ?? 0)
      const sameAsset = !event.feeAsset || event.feeAsset === event.asset
      if (event.type === 'mark') {
        holding.markSources = event.sources
        if (markGroups.get(markKey(event))!.size > 1) {
          holding.mark = null
          holding.markAt = event.timestamp
          reject('same_time_marks_conflict')
          continue
        }
        holding.mark = price
        holding.markAt = event.timestamp
        continue
      }
      if (event.type === 'redemption') {
        const candidates = [...holding.entitlements.entries()].filter(([id, entitlement]) =>
          (event.entitlementId === undefined || id === event.entitlementId)
          && entitlement.quantity.gte(quantity) && entitlement.rate.mul(quantity).eq(amount))
        if (candidates.length !== 1) { reject('redemption_entitlement_mismatch_or_ambiguity'); continue }
        const [id, entitlement] = candidates[0]!
        entitlement.quantity = entitlement.quantity.minus(quantity)
        if (entitlement.quantity.isZero()) holding.entitlements.delete(id)
        entitlementDelta = amount.negated()
        holding.pending = holding.pending.minus(amount)
        holding.pendingQuantity = holding.pendingQuantity.minus(quantity)
        delta = amount
      } else if (event.type === 'opening_position' || event.type === 'buy') {
        if (event.type === 'opening_position' && holding.observedInventory) {
          reject('opening_position_conflict'); continue
        }
        if (event.type === 'opening_position') holding.declaredOpening = true
        holding.observedInventory = true
        quantityDelta = quantity
        holding.quantity = holding.quantity.plus(quantity)
        const cost = event.type === 'opening_position' ? (event.amount === null && !quantity.isZero() ? null : amount)
          : event.fee === null || !sameAsset ? null : quantity.mul(price).plus(fee)
        basisDelta = cost
        holding.basis = holding.basis === null || cost === null ? null : holding.basis.plus(cost)
        if (event.type === 'buy') delta = quantity.mul(price).negated().minus(sameAsset ? fee : zero())
      } else {
        if (holding.quantity.lt(quantity)) { reject('insufficient_inventory'); continue }
        const released = holding.basis === null ? null : quantity.eq(holding.quantity)
          ? holding.basis : holding.basis.mul(quantity).div(holding.quantity)
        basisDelta = released?.negated() ?? null
        holding.quantity = holding.quantity.minus(quantity)
        quantityDelta = quantity.negated()
        holding.basis = holding.quantity.isZero() ? zero() : released === null ? null : holding.basis!.minus(released)
        const gross = quantity.mul(price)
        if (event.type === 'settlement') {
          holding.entitlements.set(event.id!, { quantity, rate: price })
          entitlementDelta = gross
          holding.pending = holding.pending.plus(gross)
          holding.pendingQuantity = holding.pendingQuantity.plus(quantity)
          realized = released === null ? null : gross.minus(released)
        } else {
          delta = gross.minus(sameAsset ? fee : zero())
          realized = released === null || event.fee === null || !sameAsset ? null : delta.minus(released)
        }
        if (realized === null) money.pnlIncomplete = true
      }
      if (event.type === 'buy' || event.type === 'sell') {
        if (sameAsset || event.fee === null) feeEffect = { kind: 'execution', amount: event.fee }
        if (event.fee === null) money.incomplete = true
        else {
          const feeState = getCash(event, event.feeAsset ?? event.asset)
          feeState.fees = feeState.fees.plus(fee)
          if (!sameAsset) {
            feeState.posted = true
            feeState.delta = feeState.delta.minus(fee)
            ledger.push({ eventId: event.economicId, asset: event.feeAsset!, cashDelta: fee.negated().toFixed(), quantityDelta: '0', basisDelta: '0', entitlementDelta: '0', realized: null, feeEffect: { kind: 'execution', amount: fee.toFixed() } })
          }
        }
      }
    }
    postedEvents.add(event.economicId)
    money.posted = true
    money.delta = money.delta.plus(delta)
    if (realized !== null) money.realized = money.realized.plus(realized)
    ledger.push({ eventId: event.economicId, asset: event.asset,
      ...(event.instrument && !event.completeSet ? { instrument: event.instrument } : {}), cashDelta: delta.toFixed(), quantityDelta: quantityDelta.toFixed(),
      basisDelta: basisDelta?.toFixed() ?? null, entitlementDelta: entitlementDelta.toFixed(), realized: realized?.toFixed() ?? null, ...(feeEffect ? { feeEffect } : {}) })
  }
  const affectedScopes = new Set(discrepancies.filter((issue) => issue.reason !== 'same_time_marks_conflict').flatMap(({ scope }) => [...new Set([scope.asset, scope.feeAsset].filter(Boolean))]
    .map((asset) => JSON.stringify([scope.venue, scope.account, asset]))))
  const affected = (entry: Pick<FinancialObservation, 'venue' | 'account' | 'asset'>) =>
    affectedScopes.has(JSON.stringify([entry.venue, entry.account, entry.asset]))
      || affectedScopes.has(JSON.stringify([entry.venue, entry.account, 'UNKNOWN']))
  const positionIssues = new Set(discrepancies.filter(({ scope, reason }) => scope.instrument !== null
    || reason === 'provider_activity_requires_reconciliation' || scope.type === 'opening_inventory')
    .filter(({ reason }) => reason !== 'same_time_marks_conflict')
    .flatMap(({ scope }) => [scope.type === 'unresolved_activity' ? null : scope.instrument, ...(scope.completeSet ? [scope.completeSet.counterInstrument] : [])]
      .map((instrument) => JSON.stringify([scope.venue, scope.account, scope.asset, instrument]))))
  const positionAffected = (entry: Pick<FinancialObservation, 'venue' | 'account' | 'asset' | 'instrument'>) =>
    positionIssues.has(JSON.stringify([entry.venue, entry.account, entry.asset, entry.instrument]))
      || positionIssues.has(JSON.stringify([entry.venue, entry.account, entry.asset, null]))
      || positionIssues.has(JSON.stringify([entry.venue, entry.account, 'UNKNOWN', null]))
  const staleMark = (markAt: string | null) => markAt === null || Date.parse(asOf) - Date.parse(markAt) > 86_400_000
  const partial = discrepancies.length > 0 || providerEvidencePresent
    || [...cash.values()].some((entry) => entry.opening === null || entry.inventoryOpeningAt === null || entry.incomplete || entry.pnlIncomplete)
    || [...positions.values()].some((entry) => !entry.quantity.isZero() && (entry.basis === null || entry.mark === null || staleMark(entry.markAt)))
  const inventoryValues = new Map<string, Decimal | null>()
  for (const holding of positions.values()) {
    const key = JSON.stringify([holding.venue, holding.account, holding.asset])
    const previous = inventoryValues.has(key) ? inventoryValues.get(key)! : zero()
    if (previous === null) continue
    if (holding.quantity.isZero()) inventoryValues.set(key, previous.plus(holding.pending))
    else if (holding.mark === null || staleMark(holding.markAt)) inventoryValues.set(key, null)
    else inventoryValues.set(key, previous.plus(holding.pending).plus(holding.mark.mul(holding.quantity)))
  }
  const accountBalances = [...cash.entries()].map(([key, entry]) => {
    const balance = affected(entry) || entry.opening === null || entry.incomplete ? null : entry.opening.plus(entry.delta)
    const inventory = inventoryValues.has(key) ? inventoryValues.get(key)! : zero()
    const declaredCoverage = entry.coverageFrom === null || entry.coverageThrough === null ? 'unverified'
      : asOf > entry.coverageThrough ? 'outside_declared_interval'
        : entry.openingAt !== entry.coverageFrom || entry.inventoryOpeningAt !== entry.coverageFrom ? 'opening_state_incompatible'
          : affected(entry) ? 'declared_with_unresolved_evidence' : 'user_declared_complete'
    return { venue: entry.venue, account: entry.account, asset: entry.asset,
      opening: entry.opening?.toFixed() ?? null, knownDelta: entry.delta.toFixed(), knownDeclaredContributions: entry.contributions.toFixed(),
      netContributions: entry.unclassifiedCashFlow || affected(entry) ? null : entry.contributions.toFixed(),
      knownFees: entry.fees.toFixed(), balance: balance?.toFixed() ?? null,
      balanceAvailability: affected(entry) ? 'unresolved_evidence' : entry.opening === null ? 'opening_cash_unknown'
        : entry.incomplete ? 'cash_fees_unknown' : 'reconstructed_from_declaration',
      knownRealized: entry.realized.toFixed(), realized: affected(entry) || entry.pnlIncomplete || entry.inventoryOpeningAt === null ? null : entry.realized.toFixed(),
      historyCoverage: declaredCoverage,
      openingCashAt: entry.openingAt,
      historyFrom: entry.coverageFrom,
      historyThrough: entry.coverageThrough,
      openingState: entry.inventoryOpeningAt === null ? 'inventory_unknown' : 'declared_opening_inventory',
      fullAccountValue: null,
      feeAvailability: affected(entry) || entry.incomplete ? 'known_component' : 'selected_events_only',
      realizedAvailability: affected(entry) || entry.pnlIncomplete || entry.inventoryOpeningAt === null ? 'known_component' : 'selected_events_only',
      openingInventoryAt: entry.inventoryOpeningAt,
      portfolioValue: balance === null || inventory === null || entry.inventoryOpeningAt === null
        ? null : balance.plus(inventory).toFixed(),
    }
  })
  return { asOf, method: 'weighted_average', status: partial ? 'partial' : ledger.length === 0 ? 'unavailable' : 'reconstructed',
    replayStatus: 'executed', providerEvidencePresent, events, ledger, discrepancies,
    holdings: [...positions.values()].filter((entry) => entry.observedInventory || !entry.pendingQuantity.isZero()).map((entry) => ({
      venue: entry.venue, account: entry.account, asset: entry.asset, instrument: entry.instrument, markAt: entry.markAt, markSources: entry.markSources, quantity: entry.quantity.toFixed(), basis: entry.basis?.toFixed() ?? null,
      quantityStatus: entry.declaredOpening || cash.get(JSON.stringify([entry.venue, entry.account, entry.asset]))?.inventoryOpeningAt
        ? positionAffected(entry) ? 'partial' : 'reconstructed_from_declaration' : 'known_event_component',
      basisAvailability: entry.basis === null ? 'unavailable' : positionAffected(entry) ? 'known_component'
        : entry.declaredOpening || cash.get(JSON.stringify([entry.venue, entry.account, entry.asset]))?.inventoryOpeningAt
          ? 'selected_events_only' : 'known_component',
      valueAvailability: entry.quantity.isZero() ? 'zero_selected_inventory'
        : entry.mark === null || staleMark(entry.markAt) ? 'unavailable' : 'estimated_known_quantity',
      settlementAvailability: positionAffected(entry) ? 'known_component' : 'selected_entitlements_only',
      entitlements: [...entry.entitlements.entries()].map(([id, value]) => ({
        id, quantity: value.quantity.toFixed(), rate: value.rate.toFixed(), amount: value.quantity.mul(value.rate).toFixed(),
      })),
      pendingQuantity: entry.pendingQuantity.toFixed(), pending: entry.pending.toFixed(), mark: entry.mark?.toFixed() ?? null,
      averageCost: entry.basis === null || entry.quantity.isZero() ? null : entry.basis.div(entry.quantity).toFixed(),
      markStatus: entry.mark === null ? 'unavailable' : staleMark(entry.markAt) ? 'stale' : 'estimated',
      marketValue: entry.quantity.isZero() ? '0' : entry.mark === null || staleMark(entry.markAt) ? null : entry.quantity.mul(entry.mark).toFixed(),
      unrealized: positionAffected(entry) || (!entry.declaredOpening && !cash.get(JSON.stringify([entry.venue, entry.account, entry.asset]))?.inventoryOpeningAt) || entry.mark === null || staleMark(entry.markAt) || entry.basis === null
        ? null : entry.quantity.mul(entry.mark).minus(entry.basis).toFixed(),
    })),
    cash: accountBalances,
  }
}

import { Decimal } from 'decimal.js'
import type { FinancialObservation } from './csv.js'

const Money = Decimal.clone({ precision: 70, rounding: Decimal.ROUND_HALF_EVEN })
const zero = () => new Money(0)

export interface Evidence {
  batchId: string
  row: number
  observation: FinancialObservation
}

export function replayAccounting(evidence: Evidence[], asOf: string, providerEvidencePresent = false) {
  const groups = new Map<string, Evidence[]>()
  const discrepancies: Array<{ reason: string; sources: Array<{ batchId: string; row: number }> }> = []
  const sources = (items: Evidence[]) => items.map(({ batchId, row }) => ({ batchId, row }))
  for (const item of evidence) {
    const event = item.observation
    if (event.timestamp > asOf) continue
    if (!event.id) { discrepancies.push({ reason: 'economic_id_missing', sources: sources([item]) }); continue }
    const key = JSON.stringify([event.venue, event.account, event.id])
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const events = [...groups.entries()].flatMap(([id, group]) => {
    const observation = group[0]!.observation
    if (group.some((item) => JSON.stringify(item.observation) !== JSON.stringify(observation))) {
      discrepancies.push({ reason: 'conflicting_observations', sources: sources(group) })
      return []
    }
    return [{ ...observation, economicId: id, sources: sources(group) }]
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp)
    || (a.sequence ?? 0) - (b.sequence ?? 0) || a.economicId.localeCompare(b.economicId))
  const positions = new Map<string, {
    venue: string; account: string; asset: string; instrument: string
    quantity: Decimal; basis: Decimal | null; observedInventory: boolean; pendingQuantity: Decimal; pending: Decimal
    mark: Decimal | null; markAt: string | null
  }>()
  const cash = new Map<string, {
    venue: string; account: string; asset: string; delta: Decimal; opening: Decimal | null
    contributions: Decimal; realized: Decimal; fees: Decimal; posted: boolean; incomplete: boolean; pnlIncomplete: boolean
  }>()
  const ledger: Array<{
    eventId: string; asset: string; cashDelta: string; quantityDelta: string; basisDelta: string | null; entitlementDelta: string; realized: string | null
  }> = []
  const getCash = (event: FinancialObservation, asset = event.asset) => {
    const key = JSON.stringify([event.venue, event.account, asset])
    let state = cash.get(key)
    if (!state) {
      state = { venue: event.venue, account: event.account, asset, delta: zero(), opening: null,
        contributions: zero(), realized: zero(), fees: zero(), posted: false, incomplete: false, pnlIncomplete: false }
      cash.set(key, state)
    }
    return state
  }
  const ordering = new Map<string, number>()
  const orderKey = (event: FinancialObservation) => JSON.stringify([event.venue, event.account, event.instrument, event.asset, event.timestamp, event.sequence ?? 0])
  const affectsPosition = (event: FinancialObservation) => ['opening_position', 'buy', 'sell', 'settlement', 'redemption'].includes(event.type)
  for (const event of events.filter(affectsPosition)) {
    const key = orderKey(event)
    ordering.set(key, (ordering.get(key) ?? 0) + 1)
  }
  for (const event of events) {
    const money = getCash(event)
    const reject = (reason: string) => discrepancies.push({ reason, sources: event.sources })
    if (affectsPosition(event) && ordering.get(orderKey(event))! > 1) { reject('position_event_order_ambiguous'); continue }
    if (event.type === 'split' || event.type === 'merge') { reject('complete_conversion_legs_required'); continue }
    const amount = new Money(event.amount ?? 0)
    let delta = zero()
    let quantityDelta = zero()
    let basisDelta: Decimal | null = zero()
    let entitlementDelta = zero()
    let realized: Decimal | null = null
    if (event.type === 'opening_cash') {
      if (money.opening !== null || money.posted) {
        reject('opening_cash_conflict'); continue
      }
      money.opening = amount
    } else if (event.type === 'deposit' || event.type === 'withdrawal') {
      delta = event.type === 'deposit' ? amount : amount.negated()
      money.contributions = money.contributions.plus(delta)
    } else if (event.type === 'fee' || event.type === 'rebate' || event.type === 'reward') {
      delta = event.type === 'fee' ? amount.negated() : amount
      if (event.type !== 'reward') money.fees = money.fees.minus(delta)
      realized = delta
    } else {
      const key = JSON.stringify([event.venue, event.account, event.asset, event.instrument])
      let holding = positions.get(key)
      if (!holding) {
        holding = { venue: event.venue, account: event.account, asset: event.asset, instrument: event.instrument!,
          quantity: zero(), basis: zero(), observedInventory: false, pendingQuantity: zero(), pending: zero(), mark: null, markAt: null }
        positions.set(key, holding)
      }
      const quantity = new Money(event.quantity ?? 0)
      const price = new Money(event.price ?? 0)
      const fee = new Money(event.fee ?? 0)
      const sameAsset = !event.feeAsset || event.feeAsset === event.asset
      if (event.type === 'mark') {
        holding.mark = price
        holding.markAt = event.timestamp
        continue
      }
      if (event.type === 'redemption') {
        if (!quantity.eq(holding.pendingQuantity) || !amount.eq(holding.pending)) { reject('redemption_entitlement_mismatch'); continue }
        entitlementDelta = holding.pending.negated()
        holding.pending = zero()
        holding.pendingQuantity = zero()
        delta = amount
      } else if (event.type === 'opening_position' || event.type === 'buy') {
        if (event.type === 'opening_position' && holding.observedInventory) {
          reject('opening_position_conflict'); continue
        }
        holding.observedInventory = true
        quantityDelta = quantity
        holding.quantity = holding.quantity.plus(quantity)
        const cost = event.type === 'opening_position' ? (event.amount === null ? null : amount)
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
        if (event.fee === null) money.incomplete = true
        else {
          const feeState = getCash(event, event.feeAsset ?? event.asset)
          feeState.fees = feeState.fees.plus(fee)
          if (!sameAsset) {
            feeState.posted = true
            feeState.delta = feeState.delta.minus(fee)
            ledger.push({ eventId: event.economicId, asset: event.feeAsset!, cashDelta: fee.negated().toFixed(), quantityDelta: '0', basisDelta: '0', entitlementDelta: '0', realized: null })
          }
        }
      }
    }
    money.posted = true
    money.delta = money.delta.plus(delta)
    if (realized !== null) money.realized = money.realized.plus(realized)
    ledger.push({ eventId: event.economicId, asset: event.asset, cashDelta: delta.toFixed(), quantityDelta: quantityDelta.toFixed(),
      basisDelta: basisDelta?.toFixed() ?? null, entitlementDelta: entitlementDelta.toFixed(), realized: realized?.toFixed() ?? null })
  }
  const partial = discrepancies.length > 0 || providerEvidencePresent
  const staleMark = (markAt: string | null) => markAt === null || Date.parse(asOf) - Date.parse(markAt) > 86_400_000
  const accountBalances = [...cash.values()].map((entry) => {
    const holdings = [...positions.values()].filter((holding) => holding.venue === entry.venue
      && holding.account === entry.account && holding.asset === entry.asset)
    const balance = partial || entry.opening === null || entry.incomplete ? null : entry.opening.plus(entry.delta)
    const inventory = holdings.reduce<Decimal | null>((total, holding) => {
      if (total === null) return null
      if (holding.quantity.isZero()) return total.plus(holding.pending)
      if (holding.mark === null || staleMark(holding.markAt)) return null
      return total.plus(holding.pending).plus(holding.mark.mul(holding.quantity))
    }, zero())
    return { venue: entry.venue, account: entry.account, asset: entry.asset,
      opening: entry.opening?.toFixed() ?? null, knownDelta: entry.delta.toFixed(), netContributions: entry.contributions.toFixed(),
      knownFees: entry.fees.toFixed(), balance: balance?.toFixed() ?? null,
      knownRealized: entry.realized.toFixed(), realized: partial || entry.pnlIncomplete ? null : entry.realized.toFixed(),
      portfolioValue: balance === null || inventory === null ? null : balance.plus(inventory).toFixed(),
    }
  })
  return { asOf, method: 'weighted_average', status: partial ? 'partial' : ledger.length === 0 ? 'unavailable' : 'reconstructed',
    providerEvidencePresent, events, ledger, discrepancies,
    holdings: [...positions.values()].filter((entry) => !entry.quantity.isZero() || !entry.pendingQuantity.isZero()).map((entry) => ({
      venue: entry.venue, account: entry.account, asset: entry.asset, instrument: entry.instrument, markAt: entry.markAt, quantity: entry.quantity.toFixed(), basis: entry.basis?.toFixed() ?? null,
      pendingQuantity: entry.pendingQuantity.toFixed(), pending: entry.pending.toFixed(), mark: entry.mark?.toFixed() ?? null,
      averageCost: entry.basis === null || entry.quantity.isZero() ? null : entry.basis.div(entry.quantity).toFixed(),
      markStatus: entry.mark === null ? 'unavailable' : staleMark(entry.markAt) ? 'stale' : 'estimated',
      marketValue: entry.mark === null || staleMark(entry.markAt) ? null : entry.quantity.mul(entry.mark).toFixed(),
      unrealized: partial || entry.mark === null || staleMark(entry.markAt) || entry.basis === null
        ? null : entry.quantity.mul(entry.mark).minus(entry.basis).toFixed(),
    })),
    cash: accountBalances,
  }
}

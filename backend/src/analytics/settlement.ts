import { Decimal } from 'decimal.js'

const D = Decimal.clone({ precision: 160 })
export interface SettlementLeg { instrument: string; account?: string; venue?: string; quantity: string; mark: string | null }
export interface BinaryGroup { id: string; yes: string; no: string; fixed?: 'yes' | 'no'; unitPayout?: string; asset?: string; legs: SettlementLeg[] }
export interface SettlementConstraint { left: string; right: string; kind: 'equivalent' | 'exclusive' | 'implies' }

const validIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 160 && value.trim().length > 0

function financialDecimal(value: unknown) {
  // Bound precision and magnitude before Decimal parsing and fixed-point serialization.
  return typeof value === 'string' && /^-?\d{1,40}(?:\.\d{1,30})?(?![\s\S])/.test(value) ? new D(value) : null
}

function invalidInput(groups: BinaryGroup[], constraints: SettlementConstraint[], ids: Set<string>) {
  const assets = new Set(groups.map((group) => group.asset))
  if (assets.size > 1 || [...assets].some((asset) => asset !== undefined && !validIdentity(asset))) return 'incompatible_settlement_assets'
  const instruments = new Set<string>()
  for (const group of groups) {
    if (!Array.isArray(group.legs)) return 'invalid_payoff_identity'
    if (!validIdentity(group.yes) || !validIdentity(group.no) || group.yes === group.no
      || (group.fixed !== undefined && group.fixed !== 'yes' && group.fixed !== 'no')) return 'invalid_group_outcomes'
    if (instruments.has(group.yes) || instruments.has(group.no)) return 'conflicting_instrument_assignment'
    instruments.add(group.yes)
    instruments.add(group.no)
    const payout = financialDecimal(group.unitPayout === undefined ? '1' : group.unitPayout)
    if (!payout || !payout.gt(0)) return 'invalid_payout_unit'
    for (const leg of group.legs) {
      if (!leg || ![group.yes, group.no].includes(leg.instrument)
        || (leg.account !== undefined && !validIdentity(leg.account))
        || (leg.venue !== undefined && !validIdentity(leg.venue))) return 'invalid_payoff_identity'
      const quantity = financialDecimal(leg.quantity)
      if (!quantity || quantity.lt(0)) return 'invalid_quantity'
      if (leg.mark !== null) {
        const mark = financialDecimal(leg.mark)
        if (!mark || mark.lt(0) || mark.gt(payout)) return 'invalid_reference_mark'
      }
    }
  }
  if (constraints.some((edge) => !edge || !ids.has(edge.left) || !ids.has(edge.right)
    || !['equivalent', 'exclusive', 'implies'].includes(edge.kind))) return 'invalid_constraint'
  return null
}

/** Each reviewed group pays one unit to the winning side and zero to the other. */
export function settlementRisk(groups: BinaryGroup[], constraints: SettlementConstraint[], missingRules: string[] = []) {
  if (!Array.isArray(groups) || !Array.isArray(constraints) || !Array.isArray(missingRules) || groups.some((group) => !group)) {
    return { status: 'unavailable' as const, reason: 'invalid_rule_input' }
  }
  if (!groups.length && !missingRules.length) return { status: 'unavailable' as const, reason: 'no_supported_groups' }
  const missing = new Set(missingRules)
  const marketIds = [...groups.map((group) => group.id), ...missing]
  if (marketIds.length > 256 || constraints.length > 1000) return { status: 'unavailable' as const, reason: 'joint_graph_limit' }
  const ids = new Set(marketIds)
  if (ids.size !== groups.length + missingRules.length || [...ids].some((id) => !validIdentity(id))) {
    return { status: 'unavailable' as const, reason: 'invalid_group_identity' }
  }
  const invalid = invalidInput(groups, constraints, ids)
  if (invalid) return { status: 'unavailable' as const, reason: invalid }
  const neighbors = new Map(marketIds.map((id) => [id, new Set<string>()]))
  for (const { left, right } of constraints) {
    neighbors.get(left)!.add(right)
    neighbors.get(right)!.add(left)
  }
  const unseen = new Set(neighbors.keys())
  const components: string[][] = []
  while (unseen.size) {
    const start = unseen.values().next().value!
    const queue = [start]
    unseen.delete(start)
    for (let index = 0; index < queue.length; index += 1) {
      for (const id of neighbors.get(queue[index]!)!) if (unseen.delete(id)) queue.push(id)
    }
    components.push(queue)
  }
  const byId = new Map(groups.map((group) => [group.id, group]))
  type Evaluation = Extract<ReturnType<typeof enumerateComponent>, { status: 'exact' }>
  const evaluated: Evaluation[] = []
  const coverage: Array<{ markets: string[]; status: 'exact' | 'unavailable'; reason?: string }> = []
  let budget = 32_768
  for (const component of components) {
    const members = new Set(component)
    const work = 2 ** component.length
    if (component.some((id) => missing.has(id))) {
      coverage.push({ markets: component, status: 'unavailable', reason: 'connected_rule_unavailable' })
      continue
    }
    const result = component.length > 12 || work > budget
      ? { status: 'unavailable' as const, reason: 'joint_enumeration_limit' }
      : enumerateComponent(component.map((id) => byId.get(id)!), constraints.filter((edge) => members.has(edge.left)))
    if (component.length <= 12 && work <= budget) budget -= work
    if (result.status === 'exact') {
      coverage.push({ markets: component, status: result.status })
      evaluated.push(result)
    } else {
      coverage.push({ markets: component, status: result.status, reason: result.reason })
    }
  }
  const asset = groups[0]?.asset ?? null
  const unsupported = coverage.find((component) => component.status === 'unavailable')
  if (unsupported) return { status: 'unavailable' as const, reason: unsupported.reason!, components: coverage,
    supportedSubset: evaluated.length ? combineComponents(evaluated, coverage.filter((component) => component.status === 'exact'), asset) : null }
  return { ...combineComponents(evaluated, coverage, asset), components: coverage }
}

function combineComponents(
  evaluated: Array<Extract<ReturnType<typeof enumerateComponent>, { status: 'exact' }>>,
  components: Array<{ markets: string[] }>,
  asset: string | null,
) {
  const count = evaluated.reduce((total, result) => total * BigInt(result.feasible), 1n)
  const combinedReference = evaluated.some((result) => result.reference === null) ? null :
    evaluated.reduce((total, result) => total.plus(result.reference!), new D(0))
  const combine = (key: 'best' | 'worst') => {
    const payout = evaluated.reduce((total, result) => total.plus(result[key].payout), new D(0))
    return { payout: payout.toFixed(), changeFromReference: combinedReference === null ? null : payout.minus(combinedReference).toFixed(),
      winners: evaluated.flatMap((result) => result[key].winners),
      contributions: evaluated.flatMap((result) => result[key].contributions) }
  }
  const worst = combine('worst')
  return { status: 'exact' as const, basis: 'mathematical_model' as const, asset, feasible: count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null,
    feasibleCountExact: count.toString(), componentSizes: components.map((component) => component.markets.length),
    reference: combinedReference?.toFixed() ?? null, best: combine('best'), worst,
    downside: combinedReference === null ? null : D.max(0, combinedReference.minus(worst.payout)).toFixed(),
    events: evaluated.flatMap((result) => result.events) }
}

function enumerateComponent(groups: BinaryGroup[], constraints: SettlementConstraint[]) {
  const ids = new Map(groups.map((group, index) => [group.id, index]))
  const standalone = groups.map((group) => {
    const scenarios = [group.yes, group.no].map((winner) => {
      const contributions = group.legs.map((leg) => {
        const payout = leg.instrument === winner ? new D(leg.quantity).mul(group.unitPayout ?? '1').toFixed() : '0'
        return { market: group.id, instrument: leg.instrument, account: leg.account ?? null, venue: leg.venue ?? null, payout,
          changeFromReference: leg.mark === null ? null : new D(payout).minus(new D(leg.quantity).mul(leg.mark)).toFixed() }
      })
      const payout = contributions.reduce((total, leg) => total.plus(leg.payout), new D(0))
      return { winner, contributions, payout }
    })
    const reference = group.legs.some((leg) => leg.mark === null) ? null
      : group.legs.reduce((total, leg) => total.plus(new D(leg.quantity).mul(leg.mark!)), new D(0))
    return { id: group.id, reference, scenarios }
  })
  type Outcome = { payout: Decimal; winners: string[] }
  let best: Outcome | null = null
  let worst: Outcome | null = null
  const feasibleWinners = groups.map(() => new Set<string>())
  let feasible = 0
  for (let mask = 0; mask < (1 << groups.length); mask += 1) {
    const yes = (id: string) => (mask & (1 << ids.get(id)!)) !== 0
    if (groups.some((group) => group.fixed !== undefined && yes(group.id) !== (group.fixed === 'yes'))) continue
    if (constraints.some((edge) => {
      const left = yes(edge.left)
      const right = yes(edge.right)
      return edge.kind === 'equivalent' ? left !== right : edge.kind === 'exclusive' ? left && right : left && !right
    })) continue
    feasible += 1
    const path = standalone.map((group) => group.scenarios[yes(group.id) ? 0 : 1]!)
    path.forEach((choice, index) => feasibleWinners[index]!.add(choice.winner))
    const outcome = { payout: path.reduce((total, choice) => total.plus(choice.payout), new D(0)), winners: path.map((choice) => choice.winner) }
    if (!best || outcome.payout.gt(best.payout)) best = outcome
    if (!worst || outcome.payout.lt(worst.payout)) worst = outcome
  }
  if (!best || !worst) return { status: 'unavailable' as const, reason: 'no_feasible_outcomes' }
  const reference = standalone.some((group) => group.reference === null) ? null
    : standalone.reduce((total, group) => total.plus(group.reference!), new D(0))
  const serialize = (outcome: Outcome, baseline: Decimal | null) => ({
    ...outcome, payout: outcome.payout.toFixed(), changeFromReference: baseline ? outcome.payout.minus(baseline).toFixed() : null,
    contributions: standalone.flatMap((group, index) =>
      group.scenarios.find((scenario) => scenario.winner === outcome.winners[index])!.contributions),
  })
  return { status: 'exact' as const, feasible, reference: reference?.toFixed() ?? null,
    best: serialize(best, reference), worst: serialize(worst, reference),
    downside: reference === null ? null : D.max(0, reference.minus(worst.payout)).toFixed(),
    events: standalone.map((group, index) => ({ id: group.id, reference: group.reference?.toFixed() ?? null,
      outcomes: group.scenarios.map((choice) => ({ ...choice, jointlyFeasible: feasibleWinners[index]!.has(choice.winner), payout: choice.payout.toFixed(),
        changeFromReference: group.reference ? choice.payout.minus(group.reference).toFixed() : null })) })) }
}

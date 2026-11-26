import { Decimal } from 'decimal.js'
import { digest } from '../accounting/decisions.js'
import { prepareHistoricalProjection } from '../accounting/historical-projection.js'
import type { Evidence, FinancialObservation } from '../accounting/model.js'
import { concentration } from '../analytics/performance.js'
import { consolidatePerformance } from '../fx/consolidated.js'
import { type FxOptions, type loadFx, reportAmounts } from '../fx/reference.js'
import { ReplayError, type ReplayConfig } from './contracts.js'
import type { ReplayEvidence, ReplayLifecycle } from './evidence.js'

const D = Decimal.clone({ precision: 60 })
const day = 86_400_000
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new D(0))
type Rates = Awaited<ReturnType<typeof loadFx>>
type Position = ReplayConfig['positions'][number]
type Operation = Position['entry'] | Position['exits'][number]

const settlementStates = ['resolved', 'settled', 'disputed', 'invalidated', 'voided']
const disputed = (row: ReplayLifecycle) => row.conflict || ['disputed', 'invalidated', 'voided'].includes(row.lifecycle)
const postingOrder: Record<string, number> = {
  opening_cash: 0, opening_inventory: 1, history_complete: 2, mark: 3,
  deposit: 4, settlement: 5, redemption: 6, sell: 7, withdrawal: 8, buy: 9,
}
function tradingWindow(rows: ReplayLifecycle[]) {
  const opens = [...new Set(rows.flatMap((row) => row.tradingOpensAt ? [row.tradingOpensAt.toISOString()] : []))].sort()
  const closes = [...new Set(rows.flatMap((row) => row.tradingClosesAt ? [row.tradingClosesAt.toISOString()] : []))].sort()
  const opensAt = opens.at(-1) ?? null
  const closesAt = closes[0] ?? null
  const conflict = opens.length > 1 || closes.length > 1 || Boolean(opensAt && closesAt && opensAt >= closesAt)
  return { opensAt, closesAt, status: conflict ? 'conflicting' as const : opensAt && closesAt
    ? 'verified' as const : opensAt || closesAt ? 'partial' as const : 'unavailable' as const,
  revisions: rows.filter((row) => row.tradingOpensAt || row.tradingClosesAt).map((row) => row.revision) }
}

function terminalTime(row: ReplayLifecycle, mode: ReplayConfig['mode']) {
  const retrieved = row.retrievedAt.toISOString()
  if (disputed(row)) return retrieved
  const effective = row.resolution?.settlementTime ?? row.resolution?.knownAt ?? retrieved
  return mode === 'knowledge' && effective < retrieved ? retrieved : effective
}


export function validateReplay(config: ReplayConfig, evidenceAt: string, maxDays = 365) {
  if (config.from >= config.through || config.through > evidenceAt
    || Date.parse(config.through) - Date.parse(config.from) > maxDays * day) throw new ReplayError('invalid_replay_range', { maxDays })
  if (new Set(config.buckets.map((row) => row.id)).size !== config.buckets.length
    || new Set(config.cashFlows.map((row) => row.id)).size !== config.cashFlows.length
    || new Set(config.positions.map((row) => row.id)).size !== config.positions.length) throw new ReplayError('duplicate_replay_identifier')
  for (const bucket of config.buckets) {
    if (new D(bucket.capital).gt(100_000_000) || (bucket.venue === 'kalshi') !== (bucket.asset === 'USD')) {
      throw new ReplayError('invalid_replay_funding_bucket', { bucket: bucket.id })
    }
  }
  if (config.reportingBudget) {
    const allocated = config.buckets.reduce((total, bucket) => {
      const rate = config.reportingBudget!.rates[bucket.asset] ?? (bucket.asset === config.currency ? '1' : null)
      if (rate === null) throw new ReplayError('replay_budget_rate_missing', { asset: bucket.asset })
      return total.plus(new D(bucket.capital).mul(rate))
    }, new D(0))
    if (!allocated.eq(config.reportingBudget.amount)) throw new ReplayError('replay_budget_allocation_mismatch')
  }
  for (const flow of config.cashFlows) {
    if (flow.at <= config.from || flow.at > config.through || !config.buckets.some((row) => row.id === flow.bucket)) {
      throw new ReplayError('invalid_replay_cash_flow', { flow: flow.id })
    }
  }
  for (const position of config.positions) {
    if (position.entry.at <= config.from || position.entry.at > config.through
      || position.exits.some((exit) => exit.at <= position.entry.at || exit.at > config.through)) {
      throw new ReplayError('replay_operation_outside_range', { position: position.id })
    }
  }
}

export function evaluateReplay(config: ReplayConfig & { currency: string }, data: ReplayEvidence, rates: Rates, evaluationAt: string, preference: FxOptions = {}) {
  const { from, through, currency, mode } = config
  const evidence: Evidence[] = []
  const warnings: Array<{ code: string; position?: string; at?: string }> = []
  const missing: Array<{ at: string; bucket: string; position?: string; operation?: string; reason?: string }> = []
  const buckets = new Map(config.buckets.map((row) => [row.id, row]))
  const quotes = new Map<string, Array<ReplayEvidence['quotes'][number] & { at: string }>>()
  for (const row of data.quotes) {
    const effective = row.effectiveAt.toISOString()
    const retrieved = row.retrievedAt.toISOString()
    const at = mode === 'knowledge' && retrieved > effective ? retrieved : effective
    const existing = quotes.get(row.instrumentId) ?? []
    existing.push({ ...row, at })
    quotes.set(row.instrumentId, existing)
  }
  for (const rows of quotes.values()) rows.sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime()
    || a.at.localeCompare(b.at) || a.revision.localeCompare(b.revision))
  const post = (bucket: ReplayConfig['buckets'][number], input: Pick<FinancialObservation, 'id' | 'timestamp' | 'type'> & Partial<FinancialObservation>,
    marketReference?: Evidence['marketReference']) => {
    evidence.push({ batchId: 'hypothetical-replay', row: evidence.length + 1, ...(marketReference ? { marketReference } : {}), observation: {
      venue: bucket.venue, account: bucket.id, asset: bucket.asset, sequence: evidence.length + 1,
      instrument: null, price: null, quantity: null, amount: null, fee: null, feeAsset: null, ...input,
    } })
  }
  for (const bucket of buckets.values()) {
    post(bucket, { id: 'cash:' + bucket.id, timestamp: from, type: 'opening_cash', amount: bucket.capital })
    post(bucket, { id: 'inventory:' + bucket.id, timestamp: from, type: 'opening_inventory' })
    post(bucket, { id: 'history:' + bucket.id, timestamp: from, type: 'history_complete', coveredThrough: through })
  }
  for (const flow of config.cashFlows) post(buckets.get(flow.bucket)!, {
    id: 'flow:' + flow.id, timestamp: flow.at, type: flow.kind, amount: flow.amount, fee: '0',
  })
  const identities = new Map(data.catalog.map((row) => [row.instrumentId, row]))
  const positionResults = []
  const scheduled = new Set<string>()
  const quoteInfo = (row: ReplayEvidence['quotes'][number]) => ({ source: row.source, method: row.method, revision: row.revision,
    retrievedAt: row.retrievedAt.toISOString(), observedAt: row.observedAt?.toISOString() ?? null })
  const usedLifecycle = new Set<string>()

  for (const position of config.positions) {
    const identity = identities.get(position.instrumentId)
    const bucket = buckets.get(position.bucket)
    if (!identity || !bucket || bucket.asset !== identity.asset || identity.asset !== identity.marketAsset
      || bucket.venue !== identity.provider || !['yes', 'no'].includes((identity.outcome ?? '').toLowerCase())
      || identity.nativeOutcomes.length !== 2
      || (identity.provider === 'kalshi' && identity.nativeInstrument !== identity.nativeMarket + ':' + identity.outcome)
      || (identity.provider === 'polymarket' && (identity.mappedAsset !== identity.asset
        || identity.generation !== (identity.asset === 'PUSD' ? 'v2' : 'v1')))) {
      throw new ReplayError('incompatible_replay_instrument', { position: position.id })
    }
    const journal = data.lifecycle.get(identity.marketId) ?? []
    const availableAt = (at: string) => journal.filter((row) => mode === 'retrospective' || row.retrievedAt.toISOString() <= at)
    const terminal = journal.filter((row) => settlementStates.includes(row.lifecycle) || row.resolution || row.conflict)
      .map((row) => ({ row, at: terminalTime(row, mode) })).sort((a, b) => a.at.localeCompare(b.at))
    const firstTerminal = terminal.find(({ at }) => at <= through)
    const relevant = terminal.filter(({ at }) => mode === 'retrospective' || at <= through)
    const verification = (row: ReplayLifecycle) => row.resolution?.unitPayout === '1'
      && (row.resolution.source === 'kalshi_trade_api' && identity.provider === 'kalshi' && identity.asset === 'USD'
        || row.resolution.source === 'polygon_ctf' && row.resolution.finalizedBlockHash && identity.provider === 'polymarket' && identity.asset === 'USDC')
    const firstProof = relevant.find(({ row, at }) => verification(row) && !disputed(row) && at <= through)
    const conflictEvidence = relevant.filter(({ row }) => disputed(row)
      || (firstProof && row.resolution && row.resolution.winningInstrument !== firstProof.row.resolution!.winningInstrument))
    const conflicting = conflictEvidence.length > 0
    const knowledgeConflictAt = conflicting && mode === 'knowledge'
      ? conflictEvidence.map(({ row }) => row.retrievedAt.toISOString()).sort()[0]! : null
    const verified = !conflicting || (knowledgeConflictAt && firstProof && firstProof.at < knowledgeConflictAt) ? firstProof : undefined
    for (const { row } of conflictEvidence) usedLifecycle.add(row.revision)
    const winner = verified?.row.resolution?.winningInstrument
    const binaryIdentity = identity.provider === 'kalshi'
      ? winner === identity.nativeMarket + ':yes' || winner === identity.nativeMarket + ':no'
      : winner !== undefined && identity.nativeOutcomes.includes(winner)
    const supported = verified && binaryIdentity ? verified : undefined
    const rows = quotes.get(position.instrumentId) ?? []
    const group = JSON.stringify([bucket.id, position.instrumentId])
    if (!scheduled.has(group)) {
      scheduled.add(group)
      let latestObserved = Number.NEGATIVE_INFINITY
      for (const at of [...new Set(rows.map((row) => row.at))].sort()) {
        if (firstTerminal && at >= firstTerminal.at) break
        const latest = rows.find((row) => row.at === at)!
        const effective = latest.effectiveAt.getTime()
        if (effective < latestObserved) continue
        latestObserved = effective
        for (const row of rows.filter((item) => item.effectiveAt.getTime() === effective && item.at <= at)) {
          post(bucket, { id: 'mark:' + digest([group, at, row.revision]), type: 'mark', timestamp: at,
            instrument: position.instrumentId, price: new D(row.price).toFixed() }, quoteInfo(row))
        }
      }
      if (firstTerminal) {
        usedLifecycle.add(firstTerminal.row.revision)
        post(bucket, { id: 'terminal:' + digest(group), timestamp: firstTerminal.at, type: 'mark',
          instrument: position.instrumentId, terminalMarketReference: true })
      }
    }
    function execution(operation: Operation, operationId: string) {
      const window = tradingWindow(availableAt(operation.at))
      for (const revision of window.revisions) usedLifecycle.add(revision)
      const known = journal.filter((row) => row.retrievedAt.toISOString() <= operation.at).at(-1)
      if ((window.opensAt && operation.at < window.opensAt) || (window.closesAt && operation.at >= window.closesAt)
        || (firstTerminal && operation.at >= firstTerminal.at)
        || (known && ['closed', ...settlementStates].includes(known.lifecycle))) {
        throw new ReplayError('replay_operation_outside_trading_window', { position: position.id, at: operation.at, window })
      }
      if (window.status === 'conflicting' || (window.status !== 'verified' && !position.allowUnverifiedWindow)) {
        const code = window.status === 'conflicting' ? 'conflicting_trading_window' : 'missing_trading_window'
        warnings.push({ code, position: position.id, at: operation.at })
        missing.push({ at: operation.at, bucket: position.bucket, position: position.id, operation: operationId, reason: code })
        return null
      }
      if (window.status !== 'verified') warnings.push({ code: 'assumed_trading_window', position: position.id, at: operation.at })
      if (operation.execution.mode === 'assumed') return { price: operation.execution.price, basis: 'explicit_hypothetical_price' as const, window }
      const row = rows.find((candidate) => candidate.at <= operation.at)
      const age = row ? Date.parse(operation.at) - row.effectiveAt.getTime() : Number.POSITIVE_INFINITY
      const conflict = row && rows.some((other) => other.effectiveAt.getTime() === row.effectiveAt.getTime()
        && other.at <= operation.at && !new D(other.price).eq(row.price))
      if (!row || age > operation.execution.maxAgeSeconds * 1000 || conflict) {
        const code = conflict ? 'conflicting_execution_reference' : 'missing_execution_reference'
        warnings.push({ code, position: position.id, at: operation.at })
        missing.push({ at: operation.at, bucket: position.bucket, position: position.id, operation: operationId, reason: code })
        return null
      }
      return { price: new D(row.price).toFixed(), basis: age ? 'prior_historical_reference' as const : 'exact_historical_reference' as const,
        reference: quoteInfo(row), window }
    }
    function trade(operation: Operation, quantity: Decimal, price: NonNullable<ReturnType<typeof execution>>, id: string, type: 'buy' | 'sell') {
      const assumption = operation.fee
      const gross = quantity.mul(price.price)
      const fee = assumption.mode === 'unknown' || assumption.mode === 'provider' ? null : assumption.mode === 'fixed' ? assumption.amount
        : assumption.mode === 'rate' ? gross.mul(assumption.rate).toFixed() : '0'
      if (fee === null) warnings.push({ code: assumption.mode === 'provider' ? 'historical_provider_fee_unverified' : 'unknown_hypothetical_fee', position: position.id, at: operation.at })
      post(bucket!, { id, timestamp: operation.at, type, instrument: position.instrumentId,
        quantity: quantity.toFixed(), price: price.price, fee, feeAsset: bucket!.asset }, price.reference)
      return { id, type, at: operation.at, timing: operation.timing, quantity: quantity.toFixed(), gross: gross.toFixed(), fee, feeAssumption: assumption, ...price }
    }
    const exits = [...position.exits].sort((a, b) => a.at.localeCompare(b.at) || digest(a).localeCompare(digest(b)))
    const basis = execution(position.entry, 'entry:' + position.id)
    if (!basis) {
      exits.forEach((exit, index) => missing.push({ at: exit.at, bucket: position.bucket, position: position.id,
        operation: 'exit:' + position.id + ':' + index, reason: 'entry_not_constructed' }))
      positionResults.push({ id: position.id, bucket: position.bucket, identity, tradingWindow: tradingWindow(availableAt(through)),
        status: 'missing_entry_evidence', operations: [] })
      continue
    }
    const size = position.entry.size
    if (size.mode !== 'quantity' && new D(basis.price).isZero()) throw new ReplayError('zero_price_requires_quantity', { position: position.id })
    const quantity = size.mode === 'quantity' ? new D(size.value) : (size.mode === 'weight'
      ? new D(bucket.capital).mul(size.value) : new D(size.value)).div(basis.price).toDecimalPlaces(12, Decimal.ROUND_DOWN)
    if (quantity.lte(0) || quantity.gt(100_000_000)) throw new ReplayError('replay_quantity_limit', { position: position.id })
    let remaining = quantity
    const requestedNotional = size.mode === 'quantity' ? quantity.mul(basis.price)
      : new D(size.value).mul(size.mode === 'weight' ? bucket.capital : 1)
    const sizing = { requested: size, evaluatedQuantity: quantity.toFixed(), requestedNotional: requestedNotional.toFixed(),
      evaluatedNotional: quantity.mul(basis.price).toFixed(), roundingResidual: requestedNotional.minus(quantity.mul(basis.price)).toFixed(),
      quantityBasis: 'hypothetical_decimal_not_verified_provider_precision' }
    const operations = [trade(position.entry, quantity, basis, 'entry:' + position.id, 'buy')]
    let exitMissing = false
    for (const [index, exit] of exits.entries()) {
      const volume = new D(exit.quantity)
      if (volume.gt(remaining)) throw new ReplayError('replay_insufficient_position_quantity', { position: position.id })
      const price = execution(exit, 'exit:' + position.id + ':' + index)
      if (!price) {
        exitMissing = true
        exits.slice(index + 1).forEach((later, offset) => missing.push({ at: later.at, bucket: position.bucket,
          position: position.id, operation: 'exit:' + position.id + ':' + (index + offset + 1), reason: 'prior_exit_not_constructed' }))
        break
      }
      remaining = remaining.minus(volume)
      operations.push(trade(exit, volume, price, 'exit:' + position.id + ':' + index, 'sell'))
    }
    let redemptionTiming = null
    let status = remaining.isZero() ? 'exited' : exitMissing ? 'missing_exit_evidence' : 'open_reference'
    if (firstTerminal && remaining.gt(0) && !exitMissing) {
      if (supported) {
        usedLifecycle.add(supported.row.revision)
        const id = 'entitlement:' + position.id
        const payout = identity.nativeInstrument === winner ? '1' : '0'
        const settlement = { instrument: position.instrumentId, quantity: remaining.toFixed() }
        post(bucket, { ...settlement, id, timestamp: supported.at, type: 'settlement', price: payout })
        status = 'settled_pending_hypothetical_redemption'
        const assumption = position.redemption ?? { mode: position.remainder === 'settle' ? 'immediate' : 'hold' } as const
        const redeemAt = assumption.mode === 'hold' ? null : assumption.mode === 'at' ? assumption.at
          : assumption.mode === 'delay' ? new Date(Date.parse(supported.at) + assumption.seconds * 1000).toISOString() : supported.at
        if (redeemAt && redeemAt < supported.at) throw new ReplayError('redemption_precedes_entitlement', { position: position.id })
        const canRedeem = redeemAt !== null && redeemAt <= through && (!knowledgeConflictAt || redeemAt < knowledgeConflictAt)
        redemptionTiming = { assumption, hypotheticalRedemptionAt: redeemAt, hypotheticalCashAvailableAt: canRedeem ? redeemAt : null }
        if (canRedeem) {
          post(bucket, { ...settlement, id: 'redemption:' + position.id, entitlementId: id, timestamp: redeemAt, type: 'redemption',
            amount: remaining.mul(payout).toFixed() })
          if (assumption.mode === 'immediate') warnings.push({ code: 'hypothetical_immediate_redemption', position: position.id, at: redeemAt })
          status = 'hypothetically_redeemed'
        }
        remaining = new D(0)
      } else {
        status = conflicting ? 'conflicting_payout_evidence' : 'unsupported_payout'
        warnings.push({ code: status, position: position.id, at: firstTerminal.at })
      }
    }
    if (remaining.gt(0) && firstTerminal && !supported) missing.push({ at: firstTerminal.at, bucket: position.bucket, position: position.id,
      operation: 'entitlement:' + position.id, reason: status })
    if (knowledgeConflictAt) {
      missing.push({ at: knowledgeConflictAt, bucket: position.bucket, position: position.id, reason: 'payout_evidence_disputed' })
      warnings.push({ code: 'payout_evidence_disputed', position: position.id, at: knowledgeConflictAt })
    }
    positionResults.push({ id: position.id, sizing, redemption: redemptionTiming, tradingWindow: tradingWindow(availableAt(through)), bucket: bucket.id, identity, status, operations, remainingQuantity: remaining.toFixed(),
      lifecycle: availableAt(through).at(-1) ?? null,
      priceCoverage: { selectedObservations: rows.length, earliest: rows.at(-1)?.effectiveAt ?? null,
        latest: rows[0]?.effectiveAt ?? null, continuityEstablished: false },
      resolution: supported ? { effectiveAt: supported.at, providerSettlementAt: supported.row.resolution?.settlementTime ?? null,
        evidenceAvailableAt: supported.row.retrievedAt.toISOString(), evidence: supported.row } : null })
  }
  // Within a hypothetical timestamp, apply stable category and operation ordering.
  evidence.sort(({ observation: a }, { observation: b }) => a.timestamp.localeCompare(b.timestamp)
    || postingOrder[a.type]! - postingOrder[b.type]! || a.id!.localeCompare(b.id!))
  evidence.forEach(({ observation }, index) => { observation.sequence = index + 1 })
  const financialCount = evidence.filter(({ observation }) => observation.type !== 'mark' || observation.terminalMarketReference).length
  const valuePointsUpperBound = Math.ceil((Date.parse(through) - Date.parse(from)) / day) + financialCount + missing.length + 2 * config.cashFlows.length + 2
  if (valuePointsUpperBound * (financialCount + config.positions.length + config.buckets.length) > 275_000
    || evidence.length > 8000 || evidence.length * valuePointsUpperBound > 4_000_000) throw new ReplayError('replay_projection_work_limit')
  const projectAt = prepareHistoricalProjection(evidence)
  const final = projectAt(through)
  const requestedByRow = new Map(evidence.filter(({ observation }) => observation.type !== 'mark')
    .flatMap((item) => 'row' in item ? [[item.row, item.observation] as const] : []))
  for (const issue of final.discrepancies) for (const source of issue.sources) {
    const operation = 'row' in source ? requestedByRow.get(source.row) : undefined
    if (operation) missing.push({ at: operation.timestamp, bucket: operation.account, ...(operation.id ? { operation: operation.id } : {}), reason: issue.reason })
  }
  const byEvent = new Map(final.events.map((item) => [item.economicId, item]))
  const funding = new Map(config.buckets.map((bucket) => [bucket.id, { cash: new D(bucket.capital), minimum: new D(bucket.capital),
    known: true, shortfalls: [] as Array<{ at: string; required: string }> }]))
  for (const row of final.ledger) {
    const event = byEvent.get(row.eventId)
    if (!event || event.type === 'mark') continue
    const state = funding.get(event.account)!
    if (row.feeEffect?.amount === null) state.known = false
    state.cash = state.cash.plus(row.cashDelta)
    if (missing.some((item) => item.bucket === event.account && item.at <= event.timestamp)) state.known = false
    if (state.known && state.cash.lt(state.minimum)) state.minimum = state.cash
    if (state.known && (event.type === 'buy' || event.type === 'withdrawal' || event.type === 'sell') && state.cash.lt(0)) state.shortfalls.push({ at: event.timestamp, required: state.cash.negated().toFixed() })
  }
  const bucketFunding = config.buckets.map((bucket) => {
    const state = funding.get(bucket.id)!
    const unknown = !state.known || missing.some((item) => item.bucket === bucket.id)
    return { ...bucket, closingCash: unknown ? null : state.cash.toFixed(),
      minimumKnownCash: state.minimum.toFixed(), knownAdditionalCapital: D.max(0, state.minimum.negated()).toFixed(),
      unknown, shortfalls: state.shortfalls }
  })
  const fundingStatus = bucketFunding.some((row) => row.shortfalls.length) ? 'unfunded' : bucketFunding.some((row) => row.unknown) ? 'unknown' : 'funded'
  const options = { ...preference, mode }
  const report = (items: Array<{ asset: string; value: string | null }>, at: string) =>
    reportAmounts(rates, items, currency, at, options, config.assumedUsdPerUnit)
  const assets = [...new Set(config.buckets.map((row) => row.asset))]
  const usable = (at: string) => missing.every((item) => item.at > at)
  const bucketUsable = (bucket: string, at: string) => missing.every((item) => item.bucket !== bucket || item.at > at)
  const ledgerByEvent = new Map<string, typeof final.ledger>()
  for (const row of final.ledger) {
    const group = ledgerByEvent.get(row.eventId) ?? []
    group.push(row)
    ledgerByEvent.set(row.eventId, group)
  }
  const schedule = final.events.filter((event) => event.type !== 'mark' && event.type !== 'history_complete' && event.type !== 'opening_inventory')
    .map((event) => ({ id: event.id, at: event.timestamp, asset: event.asset, bucket: event.account, type: event.type,
      quantity: event.quantity, price: event.price, amount: event.amount, fee: event.fee, posted: ledgerByEvent.has(event.economicId), entitlementId: event.entitlementId,
      reporting: event.type === 'opening_cash' ? report([{ asset: event.asset, value: event.amount }], event.timestamp)
        : report((ledgerByEvent.get(event.economicId) ?? [])
        .map((row) => ({ asset: row.asset, value: row.feeEffect?.amount === null ? null : row.cashDelta })), event.timestamp),
      feeReporting: event.type === 'buy' || event.type === 'sell' ? report([{ asset: event.asset, value: event.fee }], event.timestamp) : null }))
  const cutoffs = [...new Set([...schedule.map((event) => event.at), ...missing.map((item) => item.at),
    ...evidence.filter(({ observation }) => observation.terminalMarketReference).map(({ observation }) => observation.timestamp)]
    .filter((at) => at >= from && at <= through))]
  const nonFlowTimes = new Set(evidence.filter(({ observation }) => observation.type !== 'deposit' && observation.type !== 'withdrawal')
    .map(({ observation }) => observation.timestamp))
  const mixedFlowTimes = new Set(config.cashFlows.map((row) => row.at).filter((at) => nonFlowTimes.has(at)))
  const reporting = consolidatePerformance(evidence, rates, assets, currency, from, through, mode,
    false, usable, preference, usable, { cutoffs, assumedUsdPerUnit: config.assumedUsdPerUnit, projectAt, mixedFlowTimes })
  const history = reporting.history.map((point) => {
    const snapshot = projectAt(point.asOf)
    const cash = snapshot.cash.map((row) => ({ asset: row.asset, bucket: row.account, venue: row.venue,
      value: bucketUsable(row.account, point.asOf) ? row.balance : null }))
    const positions = snapshot.holdings.filter((row) => new D(row.quantity).gt(0) || new D(row.pendingQuantity).gt(0)).map((row) => ({
      instrument: row.instrument, market: identities.get(row.instrument)?.marketId, event: identities.get(row.instrument)?.eventId,
      bucket: row.account, venue: row.venue, quantity: row.quantity, asset: row.asset, mark: row.mark, markAt: row.markAt,
      valuationQualification: row.referenceMarketValue !== null && row.marketReference?.observedAt
        && Date.parse(point.asOf) - Date.parse(row.marketReference.observedAt) > day
        ? 'historical_stale_reference' : row.valuationQualification, reference: row.marketReference,
      value: !bucketUsable(row.account, point.asOf) || row.referenceMarketValue === null ? null : new D(row.referenceMarketValue).plus(row.pending).toFixed(),
    }))
    const projectedKnown = report([...cash.map(({ asset, value }) => ({ asset, value })),
      ...positions.map(({ asset, value }) => ({ asset, value }))], point.asOf)
    return { ...point, knownComponentsSubtotal: projectedKnown.knownSubtotal, cash, positions }
  })
  const closing = reporting.ending?.completeValue ?? null
  const starting = reporting.opening.completeValue
  const convertedFlows = reporting.cashFlowBoundaries.map((flow) => flow.converted.completeValue)
  const netFlows = convertedFlows.some((amount) => amount === null) ? null : sum(convertedFlows as string[])
  const gain = closing === null || starting === null || netFlows === null ? null : new D(closing).minus(starting).minus(netFlows)
  const feeAmounts = schedule.flatMap((row) => row.feeReporting ? [row.feeReporting.completeValue] : [])
  const feeTotal = feeAmounts.some((amount) => amount === null) ? null : sum(feeAmounts as string[]).toFixed()
  const endingPoint = history.at(-1)!
  const allocationRows = [...endingPoint.cash.map((row) => ({ ...row, event: null, kind: 'cash' as const })),
    ...endingPoint.positions.map((row) => ({ ...row, kind: 'position' as const }))]
  const endingAllocation = report(allocationRows, through)
  const allocation = (keyOf: (row: typeof allocationRows[number]) => string | null | undefined) => {
    const totals = new Map<string, { subtotal: Decimal; missing: boolean }>()
    for (const [index, row] of allocationRows.entries()) {
      const key = keyOf(row)
      if (!key) continue
      const value = endingAllocation.components[index]?.reportingValue ?? null
      const group = totals.get(key) ?? { subtotal: new D(0), missing: false }
      if (value === null) group.missing = true
      else group.subtotal = group.subtotal.plus(value)
      totals.set(key, group)
    }
    const denominator = endingPoint.completeValue
    return [...totals].map(([id, { subtotal, missing }]) => ({
      id, knownValue: subtotal.toFixed(), value: missing ? null : subtotal.toFixed(),
      weight: missing || !denominator || new D(denominator).lte(0) ? null : subtotal.div(denominator).toFixed(),
    }))
  }
  const eventExposure = allocation((row) => row.event)
  const pooledAttribution = final.holdings.map((holding) => {
    const rows = final.ledger.filter((row) => {
      const event = byEvent.get(row.eventId)
      return event?.account === holding.account && row.asset === holding.asset && row.instrument === holding.instrument
    })
    const classified = (kind: string) => rows.filter((row) => byEvent.get(row.eventId)?.type === kind)
    const buys = classified('buy')
    const sales = classified('sell')
    const settlements = classified('settlement')
    const tradeRows = [...buys, ...sales]
    const complete = bucketUsable(holding.account, through)
    const aggregate = (parts: Array<string | null | undefined>) => {
      const known = sum(parts.flatMap((value) => value == null ? [] : [value])).toFixed()
      return { known, value: complete && parts.every((value) => value != null) ? known : null }
    }
    return { bucket: holding.account, asset: holding.asset, instrument: holding.instrument,
      market: identities.get(holding.instrument)?.marketId, event: identities.get(holding.instrument)?.eventId,
      basisMethod: 'pooled_weighted_average', requestedOperationsComplete: complete,
      acquisitionCost: aggregate(buys.map((row) => row.basisDelta)),
      grossSaleProceeds: aggregate(sales.map((row) => {
        const event = byEvent.get(row.eventId)!
        return new D(event.quantity!).mul(event.price!).toFixed()
      })),
      fees: aggregate(tradeRows.map((row) => row.feeEffect?.amount)),
      realized: aggregate([...sales, ...settlements].map((row) => row.realized)),
      settlementContribution: aggregate(settlements.map((row) => row.realized)),
      pendingEntitlement: complete ? holding.pending : null, remainingInventory: complete ? holding.quantity : null,
      remainingCostBasis: complete ? holding.basis : null,
      unrealized: complete && holding.referenceMarketValue !== null && holding.basis !== null
        ? new D(holding.referenceMarketValue).minus(holding.basis).toFixed() : null,
    }
  })
  const metricEligible = fundingStatus === 'funded' && gain !== null
  const metricAvailability = { starting: starting !== null, ending: closing !== null, investmentGain: metricEligible,
    twr: metricEligible && reporting.twr !== null, drawdown: metricEligible && reporting.maximumDrawdown !== null,
    totalReturn: metricEligible && !config.cashFlows.length && new D(starting!).gt(0), fees: usable(through) && feeTotal !== null }
  const completeness = { requestedOperationsComplete: usable(through), missingOperations: missing,
    financialCoverage: reporting.ending?.financialCoverage ?? 'partial_or_unavailable',
    fxCoverage: reporting.ending?.fxCoverage ?? 'partial_or_unavailable', metrics: metricAvailability }
  return { evaluationAt, configurationRevision: digest(config), requestedRange: { from, through }, effectiveRange: { from, through },
    methodology: { mode, time: 'UTC', execution: 'hypothetical', valuation: 'canonical_instrument_locf', funding: 'isolated_native_buckets',
      qualification: mode === 'knowledge' ? 'acquisition_clock_selection_is_not_unbiased_backtesting' : 'retrospective_hindsight_analysis' },
    status: fundingStatus === 'unfunded' ? 'unfunded' : !metricAvailability.twr || !metricAvailability.drawdown || history.some((point) => point.completeValue === null) ? 'partial' : 'evaluated',
    completeness,
    summary: { currency, starting, ending: closing, knownSubtotal: endingPoint.knownComponentsSubtotal,
      reportingAttribution: { availability: 'native_only', reason: 'market_and_fx_contributions_not_decomposed' },
      investmentGain: metricEligible ? gain.toFixed() : null, twr: metricEligible ? reporting.twr : null,
      totalReturn: metricEligible && !config.cashFlows.length && new D(starting!).gt(0) ? gain.div(starting!).toFixed() : null,
      maximumDrawdown: metricEligible ? reporting.maximumDrawdown : null,
      fees: { reportingValue: usable(through) ? feeTotal : null, native: final.cash.map((row) => ({
        asset: row.asset, bucket: row.account, knownFees: row.knownFees, availability: bucketUsable(row.account, through) ? row.feeAvailability : 'known_component',
      })) },
      realized: final.cash.map((row) => ({ bucket: row.account, asset: row.asset, value: bucketUsable(row.account, through) ? row.realized : null, knownRealized: row.knownRealized })),
      settlementRealized: final.ledger.filter((row) => byEvent.get(row.eventId)?.type === 'settlement'),
      unrealized: final.holdings.map((row) => ({ instrument: row.instrument, bucket: row.account, asset: row.asset,
        value: !bucketUsable(row.account, through) || row.referenceMarketValue === null || row.basis === null ? null : new D(row.referenceMarketValue).minus(row.basis).toFixed(),
        qualification: row.valuationQualification })),
      cash: final.cash.map((row) => bucketUsable(row.account, through) ? row
        : { ...row, balance: null, realized: null, portfolioValue: null, referencePortfolioValue: null, requestedOperationsComplete: false }),
      holdings: final.holdings.map((row) => ({ ...row, requestedOperationsComplete: bucketUsable(row.account, through) })) },
    funding: { status: fundingStatus, buckets: bucketFunding }, positions: positionResults, attribution: pooledAttribution,
    native: reporting.native.map((row) => {
      const complete = config.buckets.filter((bucket) => bucket.asset === row.asset).every((bucket) => bucketUsable(bucket.id, through))
      const eligible = complete && config.buckets.filter((bucket) => bucket.asset === row.asset)
        .every((bucket) => bucketFunding.find((item) => item.id === bucket.id && !item.unknown && !item.shortfalls.length))
      return { ...row, requestedOperationsComplete: complete,
        ending: complete ? row.ending : { ...row.ending, value: null, knownValue: null, returnEligible: false, valuationQuality: 'unavailable' as const },
        returns: eligible ? row.returns : null }
    }), history: metricEligible ? history : history.map((point) => ({ ...point, index: null, twr: null, drawdown: null })),
    evidenceRevision: digest([data.catalog, data.quotes.map((row) => row.revision).sort(), [...usedLifecycle].sort(), rates.map((row) => row.revision).sort(), preference]),
    evidence: { market: data.quotes.map((row) => ({ ...quoteInfo(row), instrument: row.instrumentId, asset: row.asset,
      price: new D(row.price).toFixed(), effectiveAt: row.effectiveAt.toISOString() })),
      lifecycleRevisions: [...usedLifecycle].sort(),
      lifecycle: [...data.lifecycle.values()].flatMap((rows) => rows.filter((row) => usedLifecycle.has(row.revision))),
      fx: rates, fxWorkLimit: rates.truncated ?? false, preference }, schedule,
    risk: { endingAllocation: { ...endingAllocation, completeValue: closing === null ? null : endingAllocation.completeValue },
      coverage: closing === null ? 'known_components_only' : 'selected_complete', eventExposure, venueAllocation: allocation((row) => row.venue),
      denominationAllocation: allocation((row) => row.asset), cashAndPositionAllocation: allocation((row) => row.kind),
      concentration: !usable(through) || eventExposure.some((row) => row.value === null)
        ? null : concentration(eventExposure.map((row) => row.value!)) },
    warnings, discrepancies: final.discrepancies,
  }
}

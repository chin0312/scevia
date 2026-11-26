import { Decimal } from 'decimal.js'
import { digest } from '../accounting/decisions.js'
import { replayAccounting } from '../accounting/ledger.js'
import type { Evidence, FinancialObservation } from '../accounting/model.js'
import { concentration } from '../analytics/performance.js'
import { consolidatePerformance } from '../fx/consolidated.js'
import { type FxOptions, type loadFx, reportAmounts } from '../fx/reference.js'
import { ReplayError, type ReplayConfig } from './contracts.js'
import type { ReplayEvidence } from './evidence.js'

const D = Decimal.clone({ precision: 60 })
const day = 86_400_000
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new D(0))
type Rates = Awaited<ReturnType<typeof loadFx>>
type Position = ReplayConfig['positions'][number]
type Operation = Position['entry'] | Position['exits'][number]

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
  const missing: Array<{ at: string; bucket: string }> = []
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
    const terminal = journal.filter((row) => ['resolved', 'settled', 'disputed'].includes(row.lifecycle) || row.resolution)
      .flatMap((row) => {
        const historicalTime = row.resolution?.settlementTime ?? row.resolution?.knownAt ?? row.retrievedAt.toISOString()
        const at = mode === 'knowledge' && row.retrievedAt.toISOString() > historicalTime ? row.retrievedAt.toISOString() : historicalTime
        return at <= through ? [{ row, at }] : []
      }).sort((a, b) => a.at.localeCompare(b.at))
    const firstTerminal = terminal[0]
    const conflicting = terminal.some(({ row }) => row.conflict)
      || new Set(terminal.flatMap(({ row }) => row.resolution ? [row.resolution.winningInstrument] : [])).size > 1
    const verified = !conflicting ? terminal.find(({ row }) => row.resolution?.unitPayout === '1'
      && (row.resolution.source === 'kalshi_trade_api' && identity.provider === 'kalshi' && identity.asset === 'USD'
        || row.resolution.source === 'polygon_ctf' && row.resolution.finalizedBlockHash && identity.provider === 'polymarket' && identity.asset === 'USDC')
      && Boolean(row.resolution.settlementTime || row.resolution.knownAt)) : undefined
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
    function execution(operation: Operation) {
      const metadata = availableAt(operation.at).at(-1)
      if (metadata) usedLifecycle.add(metadata.revision)
      const opens = metadata?.tradingOpensAt?.toISOString()
      const closes = metadata?.tradingClosesAt?.toISOString()
      const known = journal.filter((row) => row.retrievedAt.toISOString() <= operation.at).at(-1)
      if ((opens && operation.at < opens) || (closes && operation.at >= closes) || (firstTerminal && operation.at >= firstTerminal.at)
        || (known && ['closed', 'resolved', 'settled', 'disputed'].includes(known.lifecycle))) {
        throw new ReplayError('replay_operation_outside_trading_window', { position: position.id, at: operation.at })
      }
      if (!opens || !closes) {
        if (!position.allowUnverifiedWindow) {
          warnings.push({ code: 'missing_trading_window', position: position.id, at: operation.at })
          missing.push({ at: operation.at, bucket: position.bucket })
          return null
        }
        warnings.push({ code: 'assumed_trading_window', position: position.id, at: operation.at })
      }
      if (operation.execution.mode === 'assumed') return { price: operation.execution.price, basis: 'explicit_hypothetical_price' as const }
      const row = rows.find((candidate) => candidate.at <= operation.at)
      const age = row ? Date.parse(operation.at) - row.effectiveAt.getTime() : Number.POSITIVE_INFINITY
      const conflict = row && rows.some((other) => other.effectiveAt.getTime() === row.effectiveAt.getTime()
        && other.at <= operation.at && !new D(other.price).eq(row.price))
      if (!row || age > operation.execution.maxAgeSeconds * 1000 || conflict) {
        warnings.push({ code: conflict ? 'conflicting_execution_reference' : 'missing_execution_reference', position: position.id, at: operation.at })
        missing.push({ at: operation.at, bucket: position.bucket })
        return null
      }
      return { price: new D(row.price).toFixed(), basis: age ? 'prior_historical_reference' as const : 'exact_historical_reference' as const,
        reference: quoteInfo(row) }
    }
    function trade(operation: Operation, quantity: Decimal, price: NonNullable<ReturnType<typeof execution>>, id: string, type: 'buy' | 'sell') {
      const assumption = operation.fee
      const gross = quantity.mul(price.price)
      const fee = assumption.mode === 'unknown' || assumption.mode === 'provider' ? null : assumption.mode === 'fixed' ? assumption.amount
        : assumption.mode === 'rate' ? gross.mul(assumption.rate).toFixed() : '0'
      if (fee === null) warnings.push({ code: assumption.mode === 'provider' ? 'historical_provider_fee_unverified' : 'unknown_hypothetical_fee', position: position.id, at: operation.at })
      post(bucket!, { id, timestamp: operation.at, type, instrument: position.instrumentId,
        quantity: quantity.toFixed(), price: price.price, fee, feeAsset: bucket!.asset }, price.reference)
      return { id, type, at: operation.at, quantity: quantity.toFixed(), gross: gross.toFixed(), fee, feeAssumption: assumption, ...price }
    }
    const basis = execution(position.entry)
    if (!basis) {
      positionResults.push({ id: position.id, identity, status: 'missing_entry_evidence', operations: [] })
      continue
    }
    const size = position.entry.size
    if (size.mode !== 'quantity' && new D(basis.price).isZero()) throw new ReplayError('zero_price_requires_quantity', { position: position.id })
    const quantity = size.mode === 'quantity' ? new D(size.value) : (size.mode === 'weight'
      ? new D(bucket.capital).mul(size.value) : new D(size.value)).div(basis.price).toDecimalPlaces(12, Decimal.ROUND_DOWN)
    if (quantity.lte(0) || quantity.gt(100_000_000)) throw new ReplayError('replay_quantity_limit', { position: position.id })
    let remaining = quantity
    const operations = [trade(position.entry, quantity, basis, 'entry:' + position.id, 'buy')]
    let exitMissing = false
    for (const [index, exit] of [...position.exits].sort((a, b) => a.at.localeCompare(b.at)).entries()) {
      const volume = new D(exit.quantity)
      if (volume.gt(remaining)) throw new ReplayError('replay_insufficient_position_quantity', { position: position.id })
      const price = execution(exit)
      if (!price) { exitMissing = true; break }
      remaining = remaining.minus(volume)
      operations.push(trade(exit, volume, price, 'exit:' + position.id + ':' + index, 'sell'))
    }
    let status = remaining.isZero() ? 'exited' : exitMissing ? 'missing_exit_evidence' : 'open_reference'
    if (firstTerminal && remaining.gt(0) && !exitMissing) {
      if (supported) {
        usedLifecycle.add(supported.row.revision)
        const id = 'entitlement:' + position.id
        const payout = identity.nativeInstrument === winner ? '1' : '0'
        const settlement = { instrument: position.instrumentId, quantity: remaining.toFixed() }
        post(bucket, { ...settlement, id, timestamp: supported.at, type: 'settlement', price: payout })
        status = 'settled_pending_hypothetical_redemption'
        if (position.remainder === 'settle') {
          post(bucket, { ...settlement, id: 'redemption:' + position.id, entitlementId: id, timestamp: supported.at, type: 'redemption',
            amount: remaining.mul(payout).toFixed() })
          warnings.push({ code: 'hypothetical_cash_available_at_resolution_evidence', position: position.id, at: supported.at })
          status = 'hypothetically_redeemed'
        }
        remaining = new D(0)
      } else {
        status = conflicting ? 'conflicting_payout_evidence' : 'unsupported_payout'
        warnings.push({ code: status, position: position.id, at: firstTerminal.at })
      }
    }
    positionResults.push({ id: position.id, bucket: bucket.id, identity, status, operations, remainingQuantity: remaining.toFixed(),
      lifecycle: availableAt(through).at(-1) ?? null,
      priceCoverage: { selectedObservations: rows.length, earliest: rows.at(-1)?.effectiveAt ?? null,
        latest: rows[0]?.effectiveAt ?? null, continuityEstablished: false },
      resolution: supported ? { effectiveAt: supported.at, evidence: supported.row } : null })
  }
  // Canonical same-time ordering places settlement and simulated cash before ordinary trades.
  for (const { observation } of evidence) {
    if (observation.type === 'settlement' || observation.type === 'redemption') {
      observation.sequence = observation.sequence! - (observation.type === 'settlement' ? 2 : 1) * (evidence.length + 1)
    }
  }
  const final = replayAccounting(evidence, through)
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
      quantity: event.quantity, price: event.price, amount: event.amount, fee: event.fee, entitlementId: event.entitlementId,
      reporting: event.type === 'opening_cash' ? report([{ asset: event.asset, value: event.amount }], event.timestamp)
        : report((ledgerByEvent.get(event.economicId) ?? [])
        .map((row) => ({ asset: row.asset, value: row.feeEffect?.amount === null ? null : row.cashDelta })), event.timestamp),
      feeReporting: event.type === 'buy' || event.type === 'sell' ? report([{ asset: event.asset, value: event.fee }], event.timestamp) : null }))
  const cutoffs = [...new Set([...schedule.map((event) => event.at),
    ...evidence.filter(({ observation }) => observation.terminalMarketReference).map(({ observation }) => observation.timestamp)]
    .filter((at) => at >= from && at <= through))]
  const reporting = consolidatePerformance(evidence, rates, assets, currency, from, through, mode,
    false, usable, preference, usable, { cutoffs, assumedUsdPerUnit: config.assumedUsdPerUnit })
  if (evidence.length * reporting.history.length > 2_000_000) throw new ReplayError('replay_projection_work_limit')
  const history = reporting.history.map((point) => {
    const snapshot = replayAccounting(evidence, point.asOf)
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
  const metricEligible = fundingStatus === 'funded' && gain !== null
  return { evaluationAt, configurationRevision: digest(config), requestedRange: { from, through }, effectiveRange: { from, through },
    methodology: { mode, time: 'UTC', execution: 'hypothetical', valuation: 'canonical_instrument_locf', funding: 'isolated_native_buckets',
      qualification: mode === 'knowledge' ? 'acquisition_clock_selection_is_not_unbiased_backtesting' : 'retrospective_hindsight_analysis' },
    status: fundingStatus === 'unfunded' ? 'unfunded' : !metricEligible || history.some((point) => point.completeValue === null) ? 'partial' : 'evaluated',
    summary: { currency, starting, ending: closing, knownSubtotal: reporting.ending?.knownSubtotal ?? null,
      investmentGain: metricEligible ? gain.toFixed() : null, twr: metricEligible ? reporting.twr : null,
      totalReturn: metricEligible && !config.cashFlows.length && new D(starting!).gt(0) ? gain.div(starting!).toFixed() : null,
      maximumDrawdown: metricEligible ? reporting.maximumDrawdown : null,
      fees: { reportingValue: usable(through) ? feeTotal : null, native: final.cash.map((row) => ({
        asset: row.asset, bucket: row.account, knownFees: row.knownFees, availability: row.feeAvailability,
      })) },
      realized: final.cash.map((row) => ({ bucket: row.account, asset: row.asset, value: row.realized })),
      settlementRealized: final.ledger.filter((row) => byEvent.get(row.eventId)?.type === 'settlement'),
      unrealized: final.holdings.map((row) => ({ instrument: row.instrument, bucket: row.account, asset: row.asset,
        value: !bucketUsable(row.account, through) || row.referenceMarketValue === null || row.basis === null ? null : new D(row.referenceMarketValue).minus(row.basis).toFixed(),
        qualification: row.valuationQualification })),
      cash: final.cash.map((row) => bucketUsable(row.account, through) ? row
        : { ...row, balance: null, realized: null, portfolioValue: null, referencePortfolioValue: null, requestedOperationsComplete: false }),
      holdings: final.holdings.map((row) => ({ ...row, requestedOperationsComplete: bucketUsable(row.account, through) })) },
    funding: { status: fundingStatus, buckets: bucketFunding }, positions: positionResults,
    native: reporting.native.map((row) => ({ ...row, requestedOperationsComplete: usable(through) })), history: metricEligible ? history : history.map((point) => ({ ...point, index: null, twr: null, drawdown: null })),
    evidenceRevision: digest([data.catalog, data.quotes.map((row) => row.revision).sort(), [...usedLifecycle].sort(), rates.map((row) => row.revision).sort(), preference]),
    evidence: { market: data.quotes.map((row) => ({ ...quoteInfo(row), instrument: row.instrumentId, asset: row.asset,
      price: new D(row.price).toFixed(), effectiveAt: row.effectiveAt.toISOString() })),
      lifecycleRevisions: [...usedLifecycle].sort(),
      lifecycle: [...data.lifecycle.values()].flatMap((rows) => rows.filter((row) => usedLifecycle.has(row.revision))),
      fx: rates, fxWorkLimit: rates.truncated ?? false, preference }, schedule,
    risk: { endingAllocation, eventExposure, venueAllocation: allocation((row) => row.venue),
      denominationAllocation: allocation((row) => row.asset), cashAndPositionAllocation: allocation((row) => row.kind),
      concentration: !usable(through) || eventExposure.some((row) => row.value === null)
        ? null : concentration(eventExposure.map((row) => row.value!)) },
    warnings, discrepancies: final.discrepancies,
  }
}

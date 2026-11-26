import type { evaluateReplay } from './engine.js'

type ReplayResult = ReturnType<typeof evaluateReplay>

export function freezeReplay(result: ReplayResult) {
  const snapshots = result.history.map(({ asOf, cash, positions, components }) => ({
    asOf,
    cash,
    positions: positions.map(({ market: _market, event: _event, reference, ...holding }) => ({
      ...holding, referenceRevision: reference?.revision ?? null,
    })),
    fx: components.map(({ asset, value, reportingValue, reference }) => ({
      asset, value, reportingValue, availability: reference.availability, rate: reference.rate,
      revisions: reference.legs.map(({ revision, inverted }) => ({ revision, inverted })),
      ...('assumedUsdPerUnit' in reference ? { assumedUsdPerUnit: reference.assumedUsdPerUnit } : {}),
      ...('fallback' in reference ? { fallback: reference.fallback } : {}),
      ...('lastKnown' in reference ? { lastKnownRevision: reference.lastKnown?.revision } : {}),
    })),
  }))
  const history = result.history.map(({ asOf, completeValue, knownComponentsSubtotal, index, twr, drawdown, financialCoverage, fxCoverage }) => ({
    asOf, completeValue, knownComponentsSubtotal, index, twr, drawdown, financialCoverage, fxCoverage,
  }))
  return { ...result, history, snapshots }
}

export type FrozenReplayResult = ReturnType<typeof freezeReplay> | ReplayResult

function expandSnapshot(result: ReturnType<typeof freezeReplay>, snapshot: ReturnType<typeof freezeReplay>['snapshots'][number]) {
  const positions = result.positions.map(({ identity }) => identity)
  return { ...snapshot, positions: snapshot.positions.map(({ referenceRevision, ...row }) => {
    const identity = positions.find(({ instrumentId }) => instrumentId === row.instrument)
    const reference = result.evidence.market.find(({ revision }) => revision === referenceRevision)
    return { ...row, market: identity?.marketId, event: identity?.eventId, reference: reference ?? null }
  }) }
}

export function presentReplay(result: FrozenReplayResult, detail: boolean) {
  if (detail) {
    if (!('snapshots' in result)) return result
    const { snapshots, history, ...rest } = result
    return { ...rest, history: history.map((point, index) => ({ ...point, ...expandSnapshot(result, snapshots[index]!) })) }
  }
  const { evidence: _evidence, schedule: _schedule, ...stored } = result
  if ('snapshots' in stored) {
    const { snapshots: _snapshots, ...primary } = stored
    return primary
  }
  return { ...stored, history: stored.history.map(({ asOf, completeValue, knownComponentsSubtotal, index, twr, drawdown, financialCoverage, fxCoverage }) => ({
    asOf, completeValue, knownComponentsSubtotal, index, twr, drawdown, financialCoverage, fxCoverage,
  })) }
}

export function replaySnapshot(result: FrozenReplayResult, asOf: string) {
  if (!('snapshots' in result)) return result.history.find((point) => point.asOf === asOf) ?? null
  const row = result.snapshots.find((point) => point.asOf === asOf)
  if (!row) return null
  const snapshot = expandSnapshot(result, row)
  return { ...snapshot, fx: snapshot.fx.map((reference) => ({
    ...reference, legs: reference.revisions.flatMap(({ revision, inverted }) => {
      const evidence = result.evidence.fx.find((leg) => leg.revision === revision)
      return evidence ? [{ ...evidence, inverted }] : []
    }),
  })) }
}

// Different markets are compatible. A changed shared observation on an identical
// instrument/time/source is relevant to comparison, even if other evidence differs.
export function sharedEvidenceChanges(results: FrozenReplayResult[]) {
  const revisions = new Map<string, Set<string>>()
  const resultChanges = new Set<string>()
  for (const result of results) {
    const current = new Map<string, Set<string>>()
    const add = (key: string, revision: string) => {
      const seen = current.get(key) ?? new Set<string>()
      seen.add(revision)
      current.set(key, seen)
    }
    for (const row of result.evidence.market) add(JSON.stringify(['market', row.instrument, row.source, row.method, row.effectiveAt]), row.price)
    for (const row of result.evidence.fx) add(JSON.stringify(['fx', row.base, row.quote, row.source, row.methodology, new Date(row.observedAt).toISOString()]), row.rate)
    for (const row of result.evidence.lifecycle) if (row.resolution || row.conflict) {
      add(JSON.stringify(['payout', row.marketId]), JSON.stringify([row.lifecycle === 'disputed' || row.conflict,
        row.resolution?.winningInstrument, row.resolution?.settlementTime ?? row.resolution?.knownAt]))
    }
    for (const [key, seen] of current) {
      const prior = revisions.get(key)
      if (prior && (prior.size !== seen.size || [...seen].some((value) => !prior.has(value)))) resultChanges.add(key)
      if (!prior) revisions.set(key, seen)
    }
  }
  return [...resultChanges].sort().map((key) => JSON.parse(key) as string[])
}

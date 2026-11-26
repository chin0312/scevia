import type { evaluateReplay } from './engine.js'

type ReplayResult = ReturnType<typeof evaluateReplay>
type ReplayPoint = ReplayResult['history'][number]
type LegacyQuality<T> = Omit<T, 'referenceQuality'> & Partial<Pick<ReplayPoint, 'referenceQuality'>>
type LegacySummary = Omit<ReplayResult['summary'], 'performanceQuality' | 'endingReferenceQuality'>
  & Partial<Pick<ReplayResult['summary'], 'performanceQuality' | 'endingReferenceQuality'>>

export function compactReplayPoint({ asOf, completeValue, knownComponentsSubtotal, index, twr, drawdown,
  financialCoverage, fxCoverage, referenceQuality }: (Pick<ReplayPoint, 'asOf' | 'completeValue' | 'knownComponentsSubtotal'
    | 'index' | 'twr' | 'drawdown' | 'financialCoverage' | 'fxCoverage'>
    & { referenceQuality?: ReplayPoint['referenceQuality'] | null })) {
  return { asOf, completeValue, knownComponentsSubtotal, index, twr, drawdown, financialCoverage, fxCoverage,
    referenceQuality: referenceQuality ?? null }
}

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
  const history = result.history.map(compactReplayPoint)
  return { ...result, history, snapshots }
}

type CompactResult = ReturnType<typeof freezeReplay>
type StoredCompactResult = Omit<CompactResult, 'history' | 'summary'> & {
  history: Array<Omit<CompactResult['history'][number], 'referenceQuality'> & { referenceQuality?: ReplayPoint['referenceQuality'] | null }>
  summary: LegacySummary
}
type StoredExpandedResult = Omit<ReplayResult, 'history' | 'summary'> & { history: Array<LegacyQuality<ReplayPoint>>; summary: LegacySummary }
export type FrozenReplayResult = StoredCompactResult | StoredExpandedResult

function expandSnapshot(result: StoredCompactResult, snapshot: ReturnType<typeof freezeReplay>['snapshots'][number]) {
  const positions = result.positions.map(({ identity }) => identity)
  return { ...snapshot, positions: snapshot.positions.map(({ referenceRevision, ...row }) => {
    const identity = positions.find(({ instrumentId }) => instrumentId === row.instrument)
    const reference = result.evidence.market.find(({ revision }) => revision === referenceRevision)
    return { ...row, market: identity?.marketId, event: identity?.eventId, reference: reference ?? null }
  }) }
}

export const replaySummary = (result: FrozenReplayResult) => ({
  ...result.summary, performanceQuality: result.summary.performanceQuality ?? null,
  endingReferenceQuality: result.summary.endingReferenceQuality ?? null,
})

export function presentReplay(result: FrozenReplayResult, detail: boolean) {
  const summary = replaySummary(result)
  if (detail) {
    if (!('snapshots' in result)) return { ...result, summary,
      history: result.history.map((point) => ({ ...point, ...compactReplayPoint(point) })) }
    const { snapshots, history, ...rest } = result
    return { ...rest, summary, history: history.map((point, index) => ({ ...compactReplayPoint(point), ...expandSnapshot(result, snapshots[index]!) })) }
  }
  const { evidence: _evidence, schedule: _schedule, ...stored } = result
  const history = stored.history.map(compactReplayPoint)
  if ('snapshots' in stored) {
    const { snapshots: _snapshots, ...primary } = stored
    return { ...primary, summary, history }
  }
  return { ...stored, summary, history }
}

export function replaySnapshot(result: FrozenReplayResult, asOf: string) {
  const point = result.history.find((item) => item.asOf === asOf)
  if (!point) return null
  if (!('snapshots' in result)) return { ...point, ...compactReplayPoint(point) }
  const row = result.snapshots.find((point) => point.asOf === asOf)
  if (!row) return null
  const snapshot = expandSnapshot(result, row)
  return { ...compactReplayPoint(point), ...snapshot, fx: snapshot.fx.map((reference) => ({
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


// Compare applied sources only where replays share a market/asset and a
// timestamp. Source and fallback differences qualify otherwise comparable data.
export function comparisonEvidenceQualifications(results: FrozenReplayResult[], grid: string[]) {
  const atGrid = new Set(grid)
  const sources = new Map<string, Set<string>>()
  const differing = { marketSources: new Set<string>(), fxSources: new Set<string>(), fallback: new Set<string>(), coverage: new Set<string>() }
  for (const result of results) {
    const used = new Map<string, Set<string>>()
    const add = (kind: keyof typeof differing, asOf: string, subject: string, values: unknown) => {
      const key = JSON.stringify([kind, asOf, subject])
      const entries = used.get(key) ?? new Set()
      entries.add(JSON.stringify(values))
      used.set(key, entries)
    }
    const market = new Map(result.evidence.market.map((row) => [row.revision, row]))
    const fx = new Map(result.evidence.fx.map((row) => [row.revision, row]))
    for (const row of result.history) if (atGrid.has(row.asOf)) {
      add('coverage', row.asOf, '', [row.financialCoverage, row.fxCoverage, row.referenceQuality?.marketPriceCoverage ?? 'not_recorded'])
    }
    if ('snapshots' in result) {
      for (const point of result.snapshots) {
        if (!atGrid.has(point.asOf)) continue
        for (const holding of point.positions) {
          if (holding.quantity === '0') continue
          const row = holding.referenceRevision ? market.get(holding.referenceRevision) : undefined
          add('marketSources', point.asOf, holding.instrument, row ? [row.source, row.method, row.effectiveAt] : null)
        }
        for (const row of point.fx) {
          add('fxSources', point.asOf, row.asset, [row.availability, row.rate, row.revisions.map(({ revision, inverted }) => {
            const leg = fx.get(revision)
            return leg ? [leg.source, leg.methodology, leg.observedAt, inverted] : [revision, inverted]
          })])
          add('fallback', point.asOf, row.asset, 'fallback' in row ? row.fallback ?? false : false)
        }
      }
    } else {
      for (const point of result.history) {
        if (!atGrid.has(point.asOf)) continue
        for (const holding of point.positions) if (holding.quantity !== '0') {
          const row = holding.reference
          const stored = row ? market.get(row.revision) : undefined
          add('marketSources', point.asOf, holding.instrument, row ? [row.source, row.method, stored?.effectiveAt ?? row.observedAt] : null)
        }
        for (const { asset, reference } of point.components) {
          add('fxSources', point.asOf, asset, [reference.availability, reference.rate,
            reference.legs.map((leg) => [leg.source, leg.methodology, leg.observedAt, leg.inverted])])
          add('fallback', point.asOf, asset, 'fallback' in reference ? reference.fallback ?? false : false)
        }
      }
    }
    for (const [key, values] of used) {
      const prior = sources.get(key)
      if (!prior) sources.set(key, values)
      else if (prior.size !== values.size || [...values].some((value) => !prior.has(value))) {
        const [kind, asOf] = JSON.parse(key) as [keyof typeof differing, string, string]
        differing[kind].add(asOf)
      }
    }
  }
  return { marketSourcePoints: differing.marketSources.size, fxSourcePoints: differing.fxSources.size,
    fallbackPoints: differing.fallback.size, coveragePoints: differing.coverage.size }
}

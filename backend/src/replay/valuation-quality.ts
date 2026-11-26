type Reference = {
  quantity: string
  mark: string | null
  observedAt: string | null | undefined
}

const day = 86_400_000

export function replayValuationQuality(positions: Reference[], asOf: string) {
  let observedReferenceCount = 0
  let carriedForwardReferenceCount = 0
  let staleReferenceCount = 0
  let missingReferenceCount = 0
  let unknownObservationAgeCount = 0
  let oldestObservationAt: string | null = null
  for (const row of positions) {
    if (row.quantity === '0') continue
    if (row.mark === null) { missingReferenceCount++; continue }
    const observed = row.observedAt
    if (!observed) { unknownObservationAgeCount++; continue }
    const age = Date.parse(asOf) - Date.parse(observed)
    if (!Number.isFinite(age) || age < 0) { unknownObservationAgeCount++; continue }
    if (oldestObservationAt === null || observed < oldestObservationAt) oldestObservationAt = observed
    if (age > day) staleReferenceCount++
    else if (age > 0) carriedForwardReferenceCount++
    else observedReferenceCount++
  }
  const priced = observedReferenceCount + carriedForwardReferenceCount + staleReferenceCount + unknownObservationAgeCount
  const marketPriceCoverage = missingReferenceCount ? priced ? 'partial' : 'missing' : priced ? 'covered' : 'not_required'
  const valuationQuality = missingReferenceCount ? priced ? 'partial_reference_coverage' : 'missing_references'
    : unknownObservationAgeCount ? 'unknown_observation_age' : staleReferenceCount ? 'stale_reference_estimate'
      : carriedForwardReferenceCount ? 'carry_forward_reference_estimate' : priced ? 'observed_references' : 'no_open_market_exposure'
  return { valuationQuality, marketPriceCoverage, oldestObservationAt, observedReferenceCount, carriedForwardReferenceCount,
    staleReferenceCount, missingReferenceCount, unknownObservationAgeCount }
}

export type ReplayValuationQuality = ReturnType<typeof replayValuationQuality>

export function performanceValuationQuality(points: ReplayValuationQuality[], eligible: boolean) {
  if (!eligible) return 'unavailable'
  if (points.some((point) => point.unknownObservationAgeCount)) return 'unknown_observation_age'
  if (points.some((point) => point.staleReferenceCount)) return 'stale_reference_estimate'
  if (points.some((point) => point.carriedForwardReferenceCount)) return 'carry_forward_reference_estimate'
  return 'supported_reference_valuation'
}

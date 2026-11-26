const text = { type: 'string' }
const nullableText = { type: ['string', 'null'] }
const timestamp = { type: 'string', format: 'date-time' }
const natural = { type: 'integer', minimum: 0 }
const list = (items: object) => ({ type: 'array', items })
const model = (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({
  type: 'object', additionalProperties: true, properties, required,
})

const context = model({ asOf: timestamp, asset: text, accounts: list(text), evidenceRevision: text, coverageRevision: text,
  accountIdentities: list(model({ venue: text, account: text, knownAssets: list(text), selectedAssetEvidence: { enum: ['observed', 'unknown'] } })),
  accountingScope: { enum: ['user_selected', 'available_evidence'] }, fullAccountCoverage: { const: 'unverified' } })
const metric = model({ value: nullableText, availability: { enum: ['calculated', 'unavailable'] }, reason: nullableText })
const quality = { enum: ['unavailable', 'carry_forward_reference_estimate', 'reconstructed_selected_value'] }
const qualityMetric = model({ ...metric.properties, quality })
const valuation = model({ asOf: timestamp, knownValue: nullableText, value: nullableText,
  accounts: natural, oldestReferenceMarkAt: nullableText, staleReferenceCount: natural, returnEligible: { type: 'boolean' }, valuationQuality: { enum: [
    'unavailable', 'carry_forward_reference_estimate', 'reconstructed_selected_value',
  ] } })
const historyPoint = model({ ...valuation.properties, returnIndex: nullableText, dailyReturn: nullableText, drawdown: nullableText,
  indexQuality: quality, knownCumulativeNetContributions: text, knownIntervalExternalFlows: nullableText, investmentGainSinceOpening: nullableText })
const contribution = model({ market: text, instrument: text, account: nullableText, venue: nullableText,
  payout: text, changeFromReference: nullableText })
const extremum = model({ payout: text, changeFromReference: nullableText, winners: list(text), contributions: list(contribution) })
const component = { anyOf: [
  model({ markets: list(text), status: { const: 'exact' } }),
  model({ markets: list(text), status: { const: 'unavailable' }, reason: text }),
] }
const exactFields = {
  status: { const: 'exact' }, basis: { const: 'mathematical_model' }, asset: nullableText, feasibleCountExact: text, reference: nullableText,
  downside: nullableText, best: extremum, worst: extremum,
  events: list(model({ id: text, reference: nullableText, outcomes: list(model({ winner: text, jointlyFeasible: { type: 'boolean' },
    payout: text, changeFromReference: nullableText, contributions: list(contribution) })) })),
}
export const settlementResult = { anyOf: [
  model({ ...exactFields, components: list(component) }),
  model({ status: { const: 'unavailable' }, reason: text, components: list(component),
    supportedSubset: { anyOf: [model(exactFields), { type: 'null' }] } }, ['status', 'reason']),
] }
const allocation = model({ denominator: nullableText, availability: { enum: ['unavailable', 'known_subset', 'known_marked_scope'] },
  mappingCoverage: model({ identifiedHoldings: natural, unmappedHoldings: natural, unmappedKnownValue: text, identifiedKnownValue: text }),
  rows: list(model({ id: text, weight: nullableText, knownValue: text })),
  concentration: { anyOf: [model({ denominator: text, hhi: text, effectiveExposures: text,
    topShares: list(model({ count: natural, weight: text })) }), { type: 'null' }] } })
const period = model({ from: timestamp, through: timestamp, openingValue: nullableText, endingValue: nullableText,
  partial: { type: 'boolean' }, knownNetExternalFlows: text, twr: qualityMetric,
  trading: model({ fills: natural, buys: natural, sells: natural, grossNotional: text }),
  fees: model({ netExecutionFees: text, unknownEffects: natural, observedZeroEffects: natural }) })

export const performanceResponse = model({
  context, catalogRevision: text, from: timestamp, sampling: { enum: ['daily', 'weekly', 'monthly'] }, opening: valuation, ending: valuation,
  history: list(historyPoint), periodicReturns: model({ daily: list(period), weekly: list(period), monthly: list(period) }),
  returns: model({ twr: qualityMetric, annualizedMwr: qualityMetric,
    annualizedVolatility: qualityMetric, maximumDrawdown: qualityMetric }),
  trading: model({ grossNotional: text, netExecutionFeeToNotional: metric }),
  fees: model({ asset: text, netExecutionFees: text, unknownEffects: natural }),
})

export const exposureResponse = model({
  context, asset: text, metadataBasis: text, settlementEvidenceRevision: text, catalogRevision: text, snapshotRevision: text,
  allocation: model({ byInstrument: allocation, byMarket: allocation, byEvent: allocation }),
  allocationBases: model({ cashInclusive: model({ scope: text, denominator: nullableText,
    availability: { enum: ['calculated', 'unavailable'] }, reason: nullableText,
    rows: list(model({ id: text, kind: text, value: nullableText, weight: nullableText })) }),
    acquisitionBasis: model({ scope: text, denominator: nullableText, unavailable: natural,
      rows: list(model({ account: text, venue: text, instrument: text, basis: text, weight: nullableText })) }) }),
  settlement: model({ scope: text, evidenceTier: text, result: settlementResult,
    cashInclusive: { anyOf: [model({ scope: text, openingCash: text, pendingEntitlements: text, worst: text, best: text }),
      { type: 'null' }] } }),
  reportedExposure: model({ scope: text, effectivePortfolioReplacement: { const: false },
    cash: list(model({ account: text, venue: text, sourceRecordId: text, observedAt: text, balance: text,
      availability: { enum: ['eligible', 'uncertain', 'stale'] } })),
    knownCashSubtotal: nullableText, knownPositionSubtotal: nullableText, knownCombinedSubtotal: nullableText,
    portfolioNav: { type: 'null' }, valuationScope: { const: 'known_components_only' },
    eventAllocation: model({ denominator: nullableText, hhi: nullableText,
      rows: list(model({ id: text, value: text, weight: text })) }),
    rows: list(model({ sourceRecordId: text, quantity: text, observedMarketValue: nullableText })),
    settlement: model({ result: settlementResult }) }),
})

export const conditionalSettlementResponse = model({ context, scope: text, quantityCoverage: { enum: ['unavailable', 'reconstructed_from_declaration', 'known_partial_quantities'] }, result: settlementResult })

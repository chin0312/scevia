const text = { type: 'string' }
const nullableText = { type: ['string', 'null'] }
const timestamp = { type: 'string', format: 'date-time' }
const natural = { type: 'integer', minimum: 0 }
const list = (items: object) => ({ type: 'array', items })
const model = (properties: Record<string, object>, required: string[] = Object.keys(properties)) => ({
  type: 'object', additionalProperties: true, properties, required,
})

const context = model({ asOf: timestamp, asset: text, accounts: list(text), evidenceRevision: text,
  accountingScope: { enum: ['user_selected', 'available_evidence'] }, fullAccountCoverage: { const: 'unverified' } })
const metric = model({ value: nullableText, availability: { enum: ['calculated', 'unavailable'] }, reason: nullableText })
const valuation = model({ asOf: timestamp, knownValue: nullableText, value: nullableText,
  accounts: natural, returnEligible: { type: 'boolean' }, valuationQuality: { enum: [
    'unavailable', 'carry_forward_reference_estimate', 'reconstructed_selected_value',
  ] } })
const historyPoint = model({ ...valuation.properties, returnIndex: nullableText, dailyReturn: nullableText, drawdown: nullableText })
const settlement = model({ status: { enum: ['exact', 'unavailable'] }, reason: text, feasibleCountExact: text, reference: nullableText }, ['status'])

export const performanceResponse = model({
  context, from: timestamp, sampling: { enum: ['daily', 'weekly', 'monthly'] }, opening: valuation, ending: valuation,
  history: list(historyPoint), returns: model({ twr: metric, annualizedMwr: metric,
    annualizedVolatility: metric, maximumDrawdown: metric }),
  fees: model({ asset: text, netExecutionFees: text, unknownEffects: natural }),
})

export const exposureResponse = model({
  context, asset: text, metadataBasis: text, settlementEvidenceRevision: text,
  settlement: model({ scope: text, evidenceTier: text, result: settlement }),
  reportedExposure: model({ scope: text, effectivePortfolioReplacement: { const: false },
    rows: list(model({ sourceRecordId: text, quantity: text, observedMarketValue: nullableText })),
    settlement: model({ result: settlement }) }),
})

export const conditionalSettlementResponse = model({ context, scope: text, result: settlement })

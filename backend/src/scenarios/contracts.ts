import { settlementResult } from '../analytics/contracts.js'

const text = { type: 'string' }
const numberText = { type: ['string', 'null'] }
const list = (items: object) => ({ type: 'array', items })
const model = (properties: Record<string, object>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: true,
})
const revisions = { type: 'object', additionalProperties: text }
const observation = { anyOf: [model({ sourceRecordId: text, asOf: text }), { type: 'null' }] }
const mode = { type: 'string', enum: ['actual', 'scratch'] }
const range = { anyOf: [model({ best: text, worst: text }), { type: 'null' }] }
const modeled = model({ authority: text, coverage: text, unsupported: list(text), result: { anyOf: [...settlementResult.anyOf, model({ status: { const: 'no_open_exposure' }, grossPayout: { const: '0' } })] },
  declaredPayouts: list(model({ id: text, yes: text, no: text, unitPayout: text, asset: text,
    authority: { enum: ['conditional_established_unit', 'conditional_abstract_unit'] } })), cashInclusive: range, basisRelative: range })
const concentration = { anyOf: [model({ denominator: text, hhi: text, weights: list(text) }), { type: 'null' }] }
const dimension = model({ metrics: concentration, unmapped: text, availability: { type: 'string', enum: ['unavailable', 'known_subset', 'known_marked_scope'] },
  identifiedHoldings: { type: 'integer' }, unmappedHoldings: { type: 'integer' }, rows: list(model({ id: text, value: text, weight: numberText })) })
const inclusive = model({ denominator: numberText,
  rows: list(model({ id: text, kind: text, value: numberText, weight: numberText })) })
const allocation = model({ instrument: dimension, market: dimension, event: dimension, account: dimension, venue: dimension,
  cashInclusive: concentration, acquisitionBasis: concentration, cashInclusiveMarket: inclusive, cashInclusiveEvent: inclusive,
  acquisitionBasisRows: model({ denominator: numberText, unavailable: { type: 'integer' },
    rows: list(model({ id: text, bucket: text, instrument: text, value: numberText, weight: numberText })) }),
  resolutionExposure: list(model({ id: text, positions: { type: 'integer' }, knownValue: text })) })
export const evaluationResponse = model({
  methodology: text, status: { type: 'string', enum: ['calculated', 'partial', 'underfunded'] }, asset: text, mode,
  baselineAsOf: text, revisions, fundingOrder: text, weightBudget: numberText, additionalCapitalRequired: numberText, knownPending: numberText,
  hypotheticalRealized: numberText, knownAdditionalCapitalRequired: text, valuationBasis: text,
  availability: model({ funding: text, underfunded: { type: 'boolean' }, quantities: text, valuation: text, basis: text,
    realized: text, unrealized: text, fees: text, settlement: text }),
  bridge: model({ evidenceStartingValue: numberText, startingValue: numberText, addedCapital: text, withdrawnCapital: text, executionEffect: numberText,
    fees: numberText, remarkEffect: numberText, endingValue: numberText, normalizedChange: numberText, unexplained: numberText }),
  funding: list(model({ bucket: text, venue: text, account: text, asset: text, actualOrScratchStartingCash: numberText, cashObservation: observation,
    assumedStartingCash: numberText, hypotheticalStartingCapital: numberText, additionalCapital: text, addedCapital: text, withdrawnCapital: text, grossSales: text, purchases: text, fees: numberText, endingCash: numberText, shortfall: numberText })),
  operations: list(model({ bucket: text, instrument: text, initialQuantity: text, proposedQuantity: text, executionApplicability: text, delta: text,
    notional: text, feeAmount: numberText, feeStatus: text, realized: numberText, remainingBasis: numberText, netProceeds: numberText })),
  positions: list(model({ bucket: text, instrument: text, quantity: text, initialQuantity: text, initialBasis: numberText, initialValue: numberText, initialMark: numberText, basis: numberText,
    mark: numberText, quantityObservation: observation, value: numberText, unrealized: numberText, resolvesAt: numberText })),
  allocation: model({ before: allocation, after: allocation }),
  settlement: model({ before: modeled, verified: modeled, conditional: modeled }),
})
const boolean = { type: 'boolean' }
export const comparisonResponse = model({ compatibility: model({ sameAsset: boolean, sameBaseline: boolean,
  sameAssumptions: boolean, sameActualValuationReferences: boolean, sameFeeAssumptions: boolean, sameFinancialBaseline: boolean, sameAccountScope: boolean, sameValuationAssumptions: boolean,
  sameCapitalBudget: boolean, sameFundingAssumptions: boolean, sameFeeMethodology: boolean, sameSettlementScope: boolean, conversion: text }),
items: list(model({ id: text, name: text, revision: { type: 'integer' }, result: evaluationResponse })) })

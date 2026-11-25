import { settlementResult } from '../analytics/contracts.js'

const text = { type: 'string' }
const numberText = { type: ['string', 'null'] }
const list = (items: object) => ({ type: 'array', items })
const model = (properties: Record<string, object>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: true,
})
const revisions = { type: 'object', additionalProperties: text }
const mode = { type: 'string', enum: ['actual', 'scratch'] }
const range = { anyOf: [model({ best: text, worst: text }), { type: 'null' }] }
const modeled = model({ authority: text, unsupported: list(text), result: settlementResult, cashInclusive: range, basisRelative: range })
const concentration = { anyOf: [model({ denominator: text, hhi: text, weights: list(text) }), { type: 'null' }] }
const dimension = model({ metrics: concentration, unmapped: text, availability: { type: 'string', enum: ['unavailable', 'known_subset', 'known_marked_scope'] },
  identifiedHoldings: { type: 'integer' }, unmappedHoldings: { type: 'integer' }, rows: list(model({ id: text, value: text, weight: numberText })) })
const allocation = model({ instrument: dimension, market: dimension, event: dimension, account: dimension, venue: dimension,
  cashInclusive: concentration, acquisitionBasis: concentration })
export const evaluationResponse = model({
  methodology: text, status: { type: 'string', enum: ['calculated', 'partial', 'underfunded'] }, asset: text, mode,
  baselineAsOf: text, revisions, fundingOrder: text, weightBudget: numberText, additionalCapitalRequired: numberText, knownPending: numberText,
  hypotheticalRealized: numberText,
  bridge: model({ evidenceStartingValue: numberText, startingValue: numberText, addedCapital: text, withdrawnCapital: text, executionEffect: numberText,
    fees: numberText, remarkEffect: numberText, endingValue: numberText, normalizedChange: numberText, unexplained: numberText }),
  funding: list(model({ bucket: text, venue: text, account: text, asset: text, actualOrScratchStartingCash: numberText,
    assumedStartingCash: numberText, addedCapital: text, withdrawnCapital: text, grossSales: text, purchases: text, fees: numberText, endingCash: numberText, shortfall: numberText })),
  operations: list(model({ bucket: text, instrument: text, initialQuantity: text, proposedQuantity: text, delta: text,
    notional: text, feeAmount: numberText, feeStatus: text, realized: numberText, remainingBasis: numberText, netProceeds: numberText })),
  positions: list(model({ bucket: text, instrument: text, quantity: text, initialQuantity: text, initialBasis: numberText, initialValue: numberText, initialMark: numberText, basis: numberText,
    mark: numberText, value: numberText, unrealized: numberText, resolvesAt: numberText })),
  allocation: model({ before: allocation, after: allocation }),
  settlement: model({ before: modeled, verified: modeled, conditional: modeled }),
})
export const comparisonResponse = model({ compatibility: model({ sameAsset: { type: 'boolean' }, sameBaseline: { type: 'boolean' },
  sameAssumptions: { type: 'boolean' }, conversion: text }),
items: list(model({ id: text, name: text, revision: { type: 'integer' }, result: evaluationResponse })) })

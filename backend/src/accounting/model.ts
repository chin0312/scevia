export const financialEventTypes = ['opening_cash', 'opening_inventory', 'history_complete', 'opening_position', 'buy', 'sell', 'deposit', 'withdrawal', 'fee', 'rebate', 'reward', 'settlement', 'redemption', 'mark', 'split', 'merge'] as const

export interface FinancialObservation {
  venue: string
  account: string
  id: string | null
  timestamp: string
  sequence: number | null
  type: typeof financialEventTypes[number] | 'unresolved_activity'
  instrument: string | null
  canonicalInstrumentId?: string
  asset: string
  quantity: string | null
  price: string | null
  amount: string | null
  fee: string | null
  feeAsset: string | null
  coveredThrough?: string
  entitlementId?: string
  relatedEventId?: string
  feeTiming?: 'execution_evidence' | 'separate_cash_flow'
  completeSet?: { counterInstrument: string; primaryBasisFraction: string }
}

export type EvidenceReference =
  | { batchId: string; row: number }
  | { providerAccountId: string; sourceRecordId: string; payloadSha256: string }

export type Evidence = EvidenceReference & {
  observation: FinancialObservation
  unresolvedReason?: string
  instrumentMetadata?: { market: string; event: string; title: string; instrument: string }
  providerActivity?: {
    type: string; classification: string; occurredAt: string | null; transactionHash: string | null
    externalId: string; market: string | null; instrument: string | null; side: string | null
    largestObservedRunCount: number | null; identityKind: string; reason: string | null
  }
  acquisition?: 'manual' | 'demo'
  linkedSourceRecordId?: string
  originalObservation?: FinancialObservation
  authority?: "user_accepted"
}

export type LegacyPortfolioDecision = {
  action: 'include' | 'distinct' | 'exclude' | 'correct' | 'duplicate'
  evidenceRevision: string
  correction?: FinancialObservation
  duplicateOf?: string
  duplicateRevision?: string
}

export interface ComposedDecision {
  membership?: 'included' | 'excluded'
  membershipRevision?: string
  identity?: { mode: 'include' | 'distinct'; revision: string }
  financial?: { values: FinancialObservation; revision: string }
  duplicate?: { target: string; revision: string; sourceRevision?: string }
}
export type PortfolioDecision = LegacyPortfolioDecision | ComposedDecision

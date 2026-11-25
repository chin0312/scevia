export const financialEventTypes = ['opening_cash', 'opening_inventory', 'opening_position', 'buy', 'sell', 'deposit', 'withdrawal', 'fee', 'rebate', 'reward', 'settlement', 'redemption', 'mark', 'split', 'merge'] as const

export interface FinancialObservation {
  venue: string
  account: string
  id: string | null
  timestamp: string
  sequence: number | null
  type: typeof financialEventTypes[number]
  instrument: string | null
  asset: string
  quantity: string | null
  price: string | null
  amount: string | null
  fee: string | null
  feeAsset: string | null
  entitlementId?: string
  relatedEventId?: string
  completeSet?: { counterInstrument: string; primaryBasisFraction: string }
}

export type EvidenceReference =
  | { batchId: string; row: number }
  | { providerAccountId: string; sourceRecordId: string; payloadSha256: string }

export type Evidence = EvidenceReference & {
  observation: FinancialObservation
  unresolvedReason?: string
}

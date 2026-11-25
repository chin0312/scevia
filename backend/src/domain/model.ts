import { Decimal } from 'decimal.js'
import { z } from 'zod'

export type CapabilityState = 'supported' | 'unsupported'
export type CoverageState = 'complete' | 'partial' | 'unavailable' | 'unknown'
export type CoverageEntity =
  | 'markets'
  | 'fills'
  | 'activity'
  | 'cash_movements'
  | 'settlements'
  | 'positions'
  | 'cash_balances'
  | 'prices'

export type ProviderSyncStream = {
  name: string
  entities: CoverageEntity[]
  referenceEntities?: CoverageEntity[]
  auxiliaryEntities?: CoverageEntity[]
  strategy: 'full_refresh' | 'provider_checkpoint'
  snapshotSemantics: Partial<Record<'positions' | 'cash_balances', 'complete' | 'incremental'>>
}

export interface EntityCoverageReport {
  status: CoverageState
  coverageStart?: string | null
  coverageEnd?: string | null
  sourceAsOf?: string | null
  reasonCode?: string | null
}

export interface ProviderCapabilities {
  providerCode: string
  displayName: string
  adapterKind: 'fixture' | 'production'
  accountKinds: Array<'public_wallet' | 'authenticated_account' | 'file_import' | 'fixture'>
  operations: Record<CoverageEntity, CapabilityState>
  streams: ProviderSyncStream[]
  pagination: CapabilityState
  incrementalSync: CapabilityState
}

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const POSTGRES_NUMERIC_INTEGER_DIGITS = 20
const POSTGRES_NUMERIC_SCALE = 18

function fitsPostgresNumeric38_18(value: string): boolean {
  const unsigned = value.startsWith('-') ? value.slice(1) : value
  const [integer = '', fractional = ''] = unsigned.split('.')
  const significantIntegerDigits = integer.replace(/^0+/, '').length
  if (significantIntegerDigits > POSTGRES_NUMERIC_INTEGER_DIGITS) return false
  return fractional.length <= POSTGRES_NUMERIC_SCALE || !/[1-9]/.test(fractional.slice(POSTGRES_NUMERIC_SCALE))
}

const sensitivePayloadKey = /(?:authorization|auth[_-]?header|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|private[_-]?key|seed[_-]?phrase|mnemonic|password|session[_-]?(?:id|key|token|cookie))/i

function containsSensitivePayloadKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.some((child) => containsSensitivePayloadKey(child, seen))
  return Object.entries(value).some(([key, child]) => sensitivePayloadKey.test(key) || containsSensitivePayloadKey(child, seen))
}

export const decimalTextSchema = z
  .string()
  .max(80)
  .regex(decimalPattern)
  .refine((value) => new Decimal(value).isFinite(), 'Expected a finite decimal string')
  .refine(fitsPostgresNumeric38_18, 'Value exceeds PostgreSQL NUMERIC(38,18) precision')

const utcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

const feeFieldsSchema = z.object({
  feeAmount: decimalTextSchema.nullable(),
  feeStatus: z.enum(['reported', 'estimated', 'unavailable']),
})

const rawPayloadSchema = z.record(z.string(), z.unknown()).refine((value) => {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= 64_000
  } catch {
    return false
  }
}, 'Source record is invalid or larger than 64 KB').refine(
  (value) => !containsSensitivePayloadKey(value),
  'Source payload contains a disallowed sensitive field',
)

const normalizedMarketSchema = z.object({
  kind: z.literal('market'),
  externalEventId: z.string().min(1).max(256),
  eventIdentityKind: z.enum(['provider_native', 'provider_slug', 'market_scoped_fallback', 'unknown']).optional(),
  eventName: z.string().min(1).max(500),
  eventDescription: z.string().max(10_000).nullable(),
  resolutionRules: z.string().max(20_000).nullable(),
  eventLifecycle: z.string().min(1).max(64),
  eventResolvesAt: utcTimestampSchema.nullable(),
  externalMarketId: z.string().min(1).max(256),
  marketTitle: z.string().min(1).max(500),
  marketLifecycle: z.string().min(1).max(64),
  settlementRules: z.string().max(20_000).nullable(),
  settlementAssetCode: z.string().min(1).max(32).nullable(),
  eventSourceUpdatedAt: utcTimestampSchema.nullable(),
  sourceUpdatedAt: utcTimestampSchema.nullable(),
  outcomes: z.array(z.object({
    externalId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    outcomeType: z.string().min(1).max(64),
    payoutAmount: decimalTextSchema.nullable().refine((value) => value === null || new Decimal(value).greaterThanOrEqualTo(0)),
    settlementAssetCode: z.string().min(1).max(32).nullable(),
  }).strict()).min(2).max(128),
  rawPayload: rawPayloadSchema,
}).strict()

const normalizedFillSchema = z.object({
  kind: z.literal('fill'),
  externalId: z.string().min(1).max(256),
  identityKind: z.enum(['provider_native', 'source_fingerprint']).optional(),
  externalMarketId: z.string().min(1).max(256),
  externalInstrumentId: z.string().min(1).max(256),
  direction: z.enum(['buy', 'sell']),
  occurredAt: utcTimestampSchema,
  quantity: decimalTextSchema.refine((value) => new Decimal(value).greaterThan(0)),
  price: decimalTextSchema.refine((value) => new Decimal(value).greaterThanOrEqualTo(0)),
  feeAmount: feeFieldsSchema.shape.feeAmount,
  feeStatus: feeFieldsSchema.shape.feeStatus,
  settlementAssetCode: z.string().min(1).max(32),
  finality: z.string().min(1).max(64),
  rawPayload: rawPayloadSchema,
}).strict()

const normalizedCashMovementSchema = z.object({
  kind: z.literal('cash_movement'),
  externalId: z.string().min(1).max(256),
  movementKind: z.enum(['deposit', 'withdrawal', 'transfer', 'adjustment']),
  occurredAt: utcTimestampSchema,
  signedAmount: decimalTextSchema,
  assetCode: z.string().min(1).max(32),
  feeAmount: feeFieldsSchema.shape.feeAmount,
  feeStatus: feeFieldsSchema.shape.feeStatus,
  rawPayload: rawPayloadSchema,
}).strict().superRefine((record, context) => {
  const amount = new Decimal(record.signedAmount)
  if (record.movementKind === 'deposit' && !amount.greaterThan(0)) {
    context.addIssue({ code: 'custom', path: ['signedAmount'], message: 'Deposits must be positive' })
  }
  if (record.movementKind === 'withdrawal' && !amount.lessThan(0)) {
    context.addIssue({ code: 'custom', path: ['signedAmount'], message: 'Withdrawals must be negative' })
  }
})

const normalizedSettlementSchema = z.object({
  kind: z.literal('settlement'),
  externalId: z.string().min(1).max(256),
  externalMarketId: z.string().min(1).max(256),
  externalInstrumentId: z.string().min(1).max(256),
  settledAt: utcTimestampSchema,
  quantity: decimalTextSchema.refine((value) => new Decimal(value).greaterThan(0)),
  payoutAmount: decimalTextSchema.refine((value) => new Decimal(value).greaterThanOrEqualTo(0)),
  assetCode: z.string().min(1).max(32),
  feeAmount: feeFieldsSchema.shape.feeAmount,
  feeStatus: feeFieldsSchema.shape.feeStatus,
  rawPayload: rawPayloadSchema,
}).strict()

const normalizedPositionSchema = z.object({
  kind: z.literal('position'),
  externalId: z.string().min(1).max(256),
  externalMarketId: z.string().min(1).max(256),
  externalInstrumentId: z.string().min(1).max(256),
  observedAt: utcTimestampSchema,
  quantity: decimalTextSchema,
  averageCostPrice: decimalTextSchema.nullable(),
  markPrice: decimalTextSchema.nullable(),
  markAt: utcTimestampSchema.nullable(),
  settlementAssetCode: z.string().min(1).max(32).nullable(),
  origin: z.enum(['provider_reported', 'reconstructed']),
  reconciliationStatus: z.enum(['not_started', 'pending', 'matched', 'difference']),
  providerStatus: z.string().min(1).max(64).nullable().optional(),
  redeemable: z.boolean().nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  archived: z.boolean().nullable().optional(),
  providerReported: z.object({
    currentValue: decimalTextSchema.nullable(),
    realizedPnl: decimalTextSchema.nullable(),
    unrealizedPnl: decimalTextSchema.nullable(),
    totalPnl: decimalTextSchema.nullable(),
    entryCost: decimalTextSchema.nullable(),
    entryFees: decimalTextSchema.nullable(),
    totalCost: decimalTextSchema.nullable(),
    totalSize: decimalTextSchema.nullable(),
    percentPnl: decimalTextSchema.nullable(),
  }).strict().optional(),
  rawPayload: rawPayloadSchema,
}).strict()

const normalizedActivityFactSchema = z.object({
  kind: z.literal('activity_fact'),
  externalId: z.string().min(1).max(256),
  identityKind: z.enum(['provider_native', 'source_fingerprint']).optional(),
  classification: z.enum(['unreconciled', 'unresolved', 'overlap_candidate']).optional(),
  resolutionReason: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable().optional(),
  sourceEndpoint: z.enum(['activity', 'trades', 'positions']).optional(),
  activityType: z.string().min(1).max(64),
  occurredAt: utcTimestampSchema.nullable(),
  transactionHash: z.string().max(128).nullable(),
  externalMarketId: z.string().max(256).nullable(),
  externalInstrumentId: z.string().max(256).nullable(),
  side: z.string().max(16).nullable(),
  quantity: decimalTextSchema.nullable(),
  price: decimalTextSchema.nullable().optional(),
  amount: decimalTextSchema.nullable(),
  assetCode: z.string().min(1).max(32).nullable(),
  rawPayload: rawPayloadSchema,
}).strict()

const normalizedCashBalanceSchema = z.object({
  kind: z.literal('cash_balance'),
  externalId: z.string().min(1).max(256),
  observedAt: utcTimestampSchema,
  balance: decimalTextSchema,
  assetCode: z.string().min(1).max(32),
  rawPayload: rawPayloadSchema,
}).strict()

const normalizedPriceSchema = z.object({
  kind: z.literal('price'),
  externalId: z.string().min(1).max(256),
  externalMarketId: z.string().min(1).max(256),
  externalInstrumentId: z.string().min(1).max(256),
  observedAt: utcTimestampSchema,
  price: decimalTextSchema.refine((value) => new Decimal(value).greaterThanOrEqualTo(0)),
  priceKind: z.string().min(1).max(64),
  assetCode: z.string().min(1).max(32),
  rawPayload: rawPayloadSchema,
}).strict()

const normalizedRecordUnion = z.discriminatedUnion('kind', [
  normalizedMarketSchema,
  normalizedFillSchema,
  normalizedCashMovementSchema,
  normalizedSettlementSchema,
  normalizedPositionSchema,
  normalizedCashBalanceSchema,
  normalizedPriceSchema,
  normalizedActivityFactSchema,
])

export const normalizedRecordSchema = normalizedRecordUnion.superRefine((record, context) => {
  if ('feeAmount' in record) {
    const hasAmount = record.feeAmount !== null
    const amountExpected = record.feeStatus !== 'unavailable'
    if (hasAmount !== amountExpected) {
      context.addIssue({ code: 'custom', path: ['feeAmount'], message: 'Fee amount and availability status do not agree' })
    }
  }
})

export type NormalizedRecord = z.infer<typeof normalizedRecordSchema>
export type NormalizedMarket = Extract<NormalizedRecord, { kind: 'market' }>
export type NormalizedFill = Extract<NormalizedRecord, { kind: 'fill' }>
export type NormalizedCashMovement = Extract<NormalizedRecord, { kind: 'cash_movement' }>
export type NormalizedSettlement = Extract<NormalizedRecord, { kind: 'settlement' }>
export type NormalizedPosition = Extract<NormalizedRecord, { kind: 'position' }>
export type NormalizedCashBalance = Extract<NormalizedRecord, { kind: 'cash_balance' }>
export type NormalizedPrice = Extract<NormalizedRecord, { kind: 'price' }>
export type NormalizedActivityFact = Extract<NormalizedRecord, { kind: 'activity_fact' }>

export const normalizedAtUtc = (value: string): string => new Date(value).toISOString()

export function assertFeeIsExplicit(record: { feeAmount: string | null; feeStatus: string }): void {
  const amountAvailable = record.feeAmount !== null
  const amountExpected = record.feeStatus !== 'unavailable'
  if (amountAvailable !== amountExpected) {
    throw new Error('Fee amount and availability status do not agree')
  }
}

import { Decimal } from 'decimal.js'
import { z } from 'zod'

export type CapabilityState = 'supported' | 'unsupported'
export type CoverageState = 'complete' | 'partial' | 'unavailable'
export type CoverageEntity =
  | 'markets'
  | 'fills'
  | 'cash_movements'
  | 'settlements'
  | 'positions'
  | 'cash_balances'
  | 'prices'

export interface ProviderCapabilities {
  providerCode: string
  displayName: string
  adapterKind: 'fixture' | 'production'
  accountKinds: Array<'public_wallet' | 'authenticated_account' | 'file_import' | 'fixture'>
  operations: Record<CoverageEntity, CapabilityState>
  pagination: CapabilityState
  incrementalSync: CapabilityState
}

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
export const decimalTextSchema = z
  .string()
  .max(80)
  .regex(decimalPattern)
  .refine((value) => new Decimal(value).isFinite(), 'Expected a finite decimal string')

const utcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

const feeFieldsSchema = z.object({
  feeAmount: decimalTextSchema.nullable(),
  feeStatus: z.enum(['reported', 'estimated', 'unavailable']),
})

const rawPayloadSchema = z.record(z.string(), z.unknown()).refine((value) => {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  return bytes <= 64_000
}, 'Source record is larger than 64 KB')

const normalizedMarketSchema = z.object({
  kind: z.literal('market'),
  externalEventId: z.string().min(1).max(256),
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
  sourceUpdatedAt: utcTimestampSchema.nullable(),
  outcomes: z.array(z.object({
    externalId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    outcomeType: z.string().min(1).max(64),
    payoutAmount: decimalTextSchema.nullable(),
    settlementAssetCode: z.string().min(1).max(32).nullable(),
  }).strict()).min(2).max(128),
  rawPayload: rawPayloadSchema,
}).strict()

const normalizedFillSchema = z.object({
  kind: z.literal('fill'),
  externalId: z.string().min(1).max(256),
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
  signedAmount: decimalTextSchema.refine((value) => !new Decimal(value).isZero()),
  assetCode: z.string().min(1).max(32),
  feeAmount: feeFieldsSchema.shape.feeAmount,
  feeStatus: feeFieldsSchema.shape.feeStatus,
  rawPayload: rawPayloadSchema,
}).strict()

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

export const normalizedRecordSchema = z.discriminatedUnion('kind', [
  normalizedMarketSchema,
  normalizedFillSchema,
  normalizedCashMovementSchema,
  normalizedSettlementSchema,
  normalizedPositionSchema,
  normalizedCashBalanceSchema,
  normalizedPriceSchema,
])

export type NormalizedRecord = z.infer<typeof normalizedRecordSchema>
export type NormalizedMarket = Extract<NormalizedRecord, { kind: 'market' }>
export type NormalizedFill = Extract<NormalizedRecord, { kind: 'fill' }>
export type NormalizedCashMovement = Extract<NormalizedRecord, { kind: 'cash_movement' }>
export type NormalizedSettlement = Extract<NormalizedRecord, { kind: 'settlement' }>
export type NormalizedPosition = Extract<NormalizedRecord, { kind: 'position' }>
export type NormalizedCashBalance = Extract<NormalizedRecord, { kind: 'cash_balance' }>
export type NormalizedPrice = Extract<NormalizedRecord, { kind: 'price' }>

export const normalizedAtUtc = (value: string): string => new Date(value).toISOString()

export function assertFeeIsExplicit(record: { feeAmount: string | null; feeStatus: string }): void {
  const amountAvailable = record.feeAmount !== null
  const amountExpected = record.feeStatus !== 'unavailable'
  if (amountAvailable !== amountExpected) {
    throw new Error('Fee amount and availability status do not agree')
  }
}

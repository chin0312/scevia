import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { reportingCurrency } from '../fx/reference.js'

export const replayAsset = z.enum(['USD', 'USDC', 'PUSD'])
const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/)
const decimal = z.string().regex(/^\d{1,9}(?:\.\d{1,12})?$/)
const positive = decimal.refine((value) => new Decimal(value).gt(0))
const price = decimal.refine((value) => new Decimal(value).lte(1))
const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString())
const execution = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('assumed'), price }).strict(),
  z.object({ mode: z.literal('reference'), maxAgeSeconds: z.number().int().min(0).max(604800).default(0) }).strict(),
])
const fee = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('zero') }).strict(),
  z.object({ mode: z.literal('fixed'), amount: decimal }).strict(),
  z.object({ mode: z.literal('rate'), rate: price }).strict(),
  z.object({ mode: z.literal('unknown') }).strict(),
  z.object({ mode: z.literal('provider') }).strict(),
])
const operation = z.object({ at: z.union([z.iso.datetime({ offset: true }), z.iso.date()]), execution, fee,
  timing: z.enum(['exact_utc', 'hypothetical_utc_day_end']).optional() })
const executionTime = <T extends z.infer<typeof operation>>(row: T) => {
  const calendar = row.at.length === 10
  return { ...row, at: new Date(calendar ? row.at + 'T23:59:59.999Z' : row.at).toISOString(),
    timing: calendar ? 'hypothetical_utc_day_end' as const : row.timing ?? 'exact_utc' as const }
}
const redemption = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('immediate') }).strict(),
  z.object({ mode: z.literal('at'), at: time }).strict(),
  z.object({ mode: z.literal('delay'), seconds: z.number().int().min(1).max(366 * 86400) }).strict(),
  z.object({ mode: z.literal('hold') }).strict(),
])
export const replayConfig = z.object({
  version: z.literal(1),
  from: time, through: time,
  mode: z.enum(['retrospective', 'knowledge']).default('retrospective'),
  currency: reportingCurrency.optional(),
  reportingBudget: z.object({ amount: positive, rates: z.partialRecord(replayAsset, positive) }).strict().optional(),
  assumedUsdPerUnit: z.partialRecord(z.enum(['USDC', 'PUSD']), positive).optional(),
  buckets: z.array(z.object({ id: key, venue: z.enum(['polymarket', 'kalshi']), asset: replayAsset, capital: decimal }).strict()).min(1).max(12),
  cashFlows: z.array(z.object({ id: key, bucket: key, at: time, kind: z.enum(['deposit', 'withdrawal']), amount: positive }).strict()).max(32).default([]),
  positions: z.array(z.object({
    id: key, bucket: key, instrumentId: z.uuid(),
    entry: operation.extend({ size: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('quantity'), value: positive }).strict(),
      z.object({ mode: z.literal('amount'), value: positive }).strict(),
      z.object({ mode: z.literal('weight'), value: price.refine((value) => new Decimal(value).gt(0)) }).strict(),
    ]) }).strict().transform(executionTime),
    exits: z.array(operation.extend({ quantity: positive }).strict().transform(executionTime)).max(8).default([]),
    redemption: redemption.optional(),
    remainder: z.enum(['hold', 'settle']).default('hold'),
    allowUnverifiedWindow: z.boolean().default(false),
  }).strict()).max(20),
}).strict()

export type ReplayConfig = z.infer<typeof replayConfig>
export class ReplayError extends Error {
  constructor(readonly code: string, readonly details?: unknown) { super(code) }
}

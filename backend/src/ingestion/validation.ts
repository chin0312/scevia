import { z } from 'zod'
import {
  normalizedRecordSchema,
  type CoverageEntity,
  type EntityCoverageReport,
  type NormalizedRecord,
  type ProviderSyncStream,
} from '../domain/model.js'
import type { ProviderPage } from '../providers/adapter.js'
import { IngestionError } from './errors.js'

const coverageEntitySchema = z.enum([
  'markets', 'fills', 'activity', 'cash_movements', 'settlements', 'positions', 'cash_balances', 'prices',
])

const coverageReportSchema = z.object({
  status: z.enum(['complete', 'partial', 'unavailable', 'unknown']),
  coverageStart: z.string().datetime({ offset: true }).nullable().optional(),
  coverageEnd: z.string().datetime({ offset: true }).nullable().optional(),
  sourceAsOf: z.string().datetime({ offset: true }).nullable().optional(),
  reasonCode: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable().optional(),
}).strict().superRefine((report, context) => {
  if (report.coverageStart && report.coverageEnd && new Date(report.coverageStart) > new Date(report.coverageEnd)) {
    context.addIssue({ code: 'custom', path: ['coverageEnd'], message: 'Coverage end precedes its start' })
  }
})

const providerPageSchema = z.object({
  payload: z.unknown(),
  nextCursor: z.string().min(1).max(4096).nullable(),
  checkpoint: z.string().min(1).max(4096).nullable(),
  coverage: z.partialRecord(coverageEntitySchema, coverageReportSchema),
  diagnostics: z.object({
    upstreamRowsReceived: z.number().int().min(0).max(100_000).optional(),
    sourceRowsRetained: z.number().int().min(0).max(100_000).optional(),
    invalidRecords: z.number().int().min(0).max(100_000).optional(),
    excludedRecords: z.number().int().min(0).max(100_000).optional(),
  }).strict().optional(),
}).strict()

const entityForKind: Record<NormalizedRecord['kind'], CoverageEntity> = {
  market: 'markets',
  fill: 'fills',
  activity_fact: 'activity',
  cash_movement: 'cash_movements',
  settlement: 'settlements',
  position: 'positions',
  cash_balance: 'cash_balances',
  price: 'prices',
}

export const MAX_RECORDS_PER_PAGE = 500
export const MAX_RECORDS_PER_STREAM = 10_000
export const MAX_SYNC_DURATION_MS = 25_000
export const MAX_PROVIDER_PAGE_BYTES = 5_000_000

export function validateProviderPage(value: unknown, stream: ProviderSyncStream): ProviderPage {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, 'payload')
    || (value as Record<string, unknown>).payload === undefined) {
    throw new IngestionError('invalid_provider_page_metadata')
  }
  try {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_PROVIDER_PAGE_BYTES) {
      throw new IngestionError('provider_page_payload_limit_reached')
    }
  } catch (error) {
    if (error instanceof IngestionError) throw error
    throw new IngestionError('invalid_provider_page_metadata')
  }
  const parsed = providerPageSchema.safeParse(value)
  if (!parsed.success) throw new IngestionError('invalid_provider_page_metadata')
  for (const entity of Object.keys(parsed.data.coverage) as CoverageEntity[]) {
    if (!stream.entities.includes(entity)) throw new IngestionError('provider_reported_unconfigured_coverage')
  }
  const coverage = Object.fromEntries(Object.entries(parsed.data.coverage).map(([entity, report]) => [
    entity,
    {
      ...report,
      coverageStart: report.coverageStart ? new Date(report.coverageStart).toISOString() : null,
      coverageEnd: report.coverageEnd ? new Date(report.coverageEnd).toISOString() : null,
      sourceAsOf: report.sourceAsOf ? new Date(report.sourceAsOf).toISOString() : null,
      reasonCode: report.reasonCode ?? null,
    },
  ])) as Partial<Record<CoverageEntity, EntityCoverageReport>>
  const { diagnostics, ...page } = parsed.data
  const validatedDiagnostics = diagnostics === undefined ? undefined : {
    ...(diagnostics.upstreamRowsReceived === undefined ? {} : { upstreamRowsReceived: diagnostics.upstreamRowsReceived }),
    ...(diagnostics.sourceRowsRetained === undefined ? {} : { sourceRowsRetained: diagnostics.sourceRowsRetained }),
    ...(diagnostics.invalidRecords === undefined ? {} : { invalidRecords: diagnostics.invalidRecords }),
    ...(diagnostics.excludedRecords === undefined ? {} : { excludedRecords: diagnostics.excludedRecords }),
  }
  return { ...page, coverage, ...(validatedDiagnostics ? { diagnostics: validatedDiagnostics } : {}) }
}

export function validateNormalizedRecords(value: unknown, stream: ProviderSyncStream): NormalizedRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS_PER_PAGE) {
    throw new IngestionError('provider_record_limit_reached')
  }
  const records: NormalizedRecord[] = []
  for (const candidate of value) {
    let parsed: ReturnType<typeof normalizedRecordSchema.safeParse>
    try {
      parsed = normalizedRecordSchema.safeParse(candidate)
    } catch {
      throw new IngestionError('invalid_normalized_provider_record')
    }
    if (!parsed.success) throw new IngestionError('invalid_normalized_provider_record')
    const entity = entityForKind[parsed.data.kind]
    const isSharedMarketReference = parsed.data.kind === 'market' && stream.referenceEntities?.includes('markets') === true
    const isRetainedAuxiliaryFact = stream.auxiliaryEntities?.includes(entity) === true
    if (!stream.entities.includes(entity) && !isSharedMarketReference && !isRetainedAuxiliaryFact) {
      throw new IngestionError('provider_record_outside_stream')
    }
    records.push(parsed.data)
  }
  return records
}

export function entityForRecord(record: NormalizedRecord): CoverageEntity {
  return entityForKind[record.kind]
}

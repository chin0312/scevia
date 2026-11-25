import { describe, expect, it } from 'vitest'
import { decimalTextSchema, normalizedRecordSchema } from '../src/domain/model.js'
import { validateNormalizedRecords, validateProviderPage } from '../src/ingestion/validation.js'

const cashMovement = (patch: Record<string, unknown> = {}) => ({
  kind: 'cash_movement',
  externalId: 'movement-1',
  movementKind: 'deposit',
  occurredAt: '2026-11-24T00:00:00Z',
  signedAmount: '1',
  assetCode: 'USD',
  feeAmount: null,
  feeStatus: 'unavailable',
  rawPayload: { amount: '1' },
  ...patch,
})

describe('canonical financial value validation', () => {
  it('accepts the NUMERIC(38,18) boundary and zero-only excess scale', () => {
    expect(decimalTextSchema.safeParse('99999999999999999999.123456789012345678').success).toBe(true)
    expect(decimalTextSchema.safeParse('1.1234567890123456780000').success).toBe(true)
    expect(decimalTextSchema.safeParse('0').success).toBe(true)
  })

  it('rejects integer overflow and nonzero precision beyond the database scale', () => {
    expect(decimalTextSchema.safeParse('100000000000000000000').success).toBe(false)
    expect(decimalTextSchema.safeParse('1.1234567890123456781').success).toBe(false)
  })

  it('enforces signed cash movement meaning while allowing signed transfers and zero adjustments', () => {
    expect(normalizedRecordSchema.safeParse(cashMovement()).success).toBe(true)
    expect(normalizedRecordSchema.safeParse(cashMovement({ movementKind: 'withdrawal', signedAmount: '-1' })).success).toBe(true)
    expect(normalizedRecordSchema.safeParse(cashMovement({ movementKind: 'withdrawal', signedAmount: '0' })).success).toBe(false)
    expect(normalizedRecordSchema.safeParse(cashMovement({ movementKind: 'transfer', signedAmount: '-2' })).success).toBe(true)
    expect(normalizedRecordSchema.safeParse(cashMovement({ movementKind: 'adjustment', signedAmount: '0' })).success).toBe(true)
  })

  it('keeps reported zero fees distinct from unavailable fees and rejects sensitive payload keys', () => {
    expect(normalizedRecordSchema.safeParse(cashMovement({ feeAmount: '0', feeStatus: 'reported' })).success).toBe(true)
    expect(normalizedRecordSchema.safeParse(cashMovement({ feeAmount: null, feeStatus: 'reported' })).success).toBe(false)
    expect(normalizedRecordSchema.safeParse(cashMovement({ rawPayload: { authorization: 'Bearer secret' } })).success).toBe(false)
  })

  it('validates provider metadata and normalized records centrally against the configured stream', () => {
    const fillsOnly = {
      name: 'fills',
      entities: ['fills'] as const,
      strategy: 'full_refresh' as const,
      snapshotSemantics: {},
    }
    expect(() => validateProviderPage({ nextCursor: null, checkpoint: null, coverage: {} }, fillsOnly))
      .toThrow('invalid_provider_page_metadata')
    expect(() => validateProviderPage({ payload: undefined, nextCursor: null, checkpoint: null, coverage: {} }, fillsOnly))
      .toThrow('invalid_provider_page_metadata')
    expect(() => validateNormalizedRecords([cashMovement()], fillsOnly)).toThrow('provider_record_outside_stream')
    expect(() => validateNormalizedRecords([{ kind: 'fill', rawPayload: {} }], fillsOnly))
      .toThrow('invalid_normalized_provider_record')
    expect(() => validateNormalizedRecords(Array.from({ length: 501 }, () => null), fillsOnly))
      .toThrow('provider_record_limit_reached')
  })
})

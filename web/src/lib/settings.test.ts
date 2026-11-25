import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, readSettings } from './settings'

describe('settings', () => {
  it('malformed stored settings fall back field by field, never to invalid values', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS)
    const s = readSettings({ defaultScope: 'pm', defaultPeriod: 'nope', guardrail: 99, labSize: 'amount', alerts: { resolvingWithin: -3, priceMove: 250, feeEstimates: 'yes' } })
    expect(s).toEqual({ ...DEFAULT_SETTINGS, defaultScope: 'pm', labSize: 'amount', alerts: { ...DEFAULT_SETTINGS.alerts, priceMove: 250 } })
  })
})

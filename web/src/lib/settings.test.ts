import { describe, expect, it } from 'vitest'
import { POSITIONS } from './fixtureFinance'
import { FIXTURE } from './fixtureFinance'
import { deriveNotifications } from './notifications'
import { DEFAULT_SETTINGS, readSettings, resetSection } from './settings'

describe('settings', () => {
  it('malformed stored settings fall back field by field, never to invalid values', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS)
    const s = readSettings({ defaultScope: 'pm', defaultPeriod: 'nope', guardrail: 99, labSize: 'amount', alerts: { resolvingWithin: -3, priceMove: 250, imports: 'yes' } })
    expect(s).toEqual({ ...DEFAULT_SETTINGS, defaultScope: 'pm', labSize: 'amount', alerts: { ...DEFAULT_SETTINGS.alerts, priceMove: 250 } })
  })
  it('restoring one section leaves the others untouched', () => {
    const s = { ...DEFAULT_SETTINGS, defaultScope: 'ks' as const, guardrail: 30, alerts: { ...DEFAULT_SETTINGS.alerts, resolvingWithin: 0 } }
    expect(resetSection(s, 'Notifications')).toEqual({ ...s, alerts: DEFAULT_SETTINGS.alerts })
    expect(resetSection(s, 'Risk')).toEqual({ ...s, guardrail: 15 })
  })
})

describe('notifications', () => {
  it('have stable, unique ids; one per event; follow the preferences', () => {
    const a = deriveNotifications(FIXTURE, DEFAULT_SETTINGS, [], []), b = deriveNotifications(FIXTURE, DEFAULT_SETTINGS, [], [])
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id))
    expect(new Set(a.map((n) => n.id)).size).toBe(a.length)
    expect(a.filter((n) => n.id.startsWith('resolve:fed')).length).toBeLessThanOrEqual(1) // two Fed contracts, one event
    const off = deriveNotifications(FIXTURE, { ...DEFAULT_SETTINGS, alerts: { resolvingWithin: 0, priceMove: 0, concentration: false, settlements: false, dataQuality: false, imports: false } }, [], [])
    expect(off).toEqual([])
  })
  it('every position moving past the threshold is listed (position-level), not just the largest', () => {
    const moves = deriveNotifications(FIXTURE, { ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts, priceMove: 1 } }, [], []).filter((n) => n.category === 'activity')
    expect(moves.length).toBe(POSITIONS.filter((p) => Math.abs((p.mark - p.markAtLastVisit) * p.shares) >= 1).length)
    expect(moves.every((n) => n.scope === 'position')).toBe(true)
  })
})

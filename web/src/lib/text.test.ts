import { describe, expect, it } from 'vitest'
import { capitalize, count, joinList, phrase, sentences } from './text'
import { fixtureFx, rateWarning, sourceName, type FxReference } from './fx'

const day = (iso: string) => iso.slice(0, 10)

describe('text built from data', () => {
  it('counts zero, one and many with the right plural', () => {
    expect([0, 1, 2, 1234].map((n) => count(n, 'position'))).toEqual(['0 positions', '1 position', '2 positions', '1,234 positions'])
    expect(count(1, 'day')).toBe('1 day')
    expect(count(3, 'entry', 'entries')).toBe('3 entries')
    expect(count(1, 'resolved trade')).toBe('1 resolved trade')
  })
  it('joins lists naturally and drops missing items', () => {
    expect(joinList([])).toBe('')
    expect(joinList(['Polymarket'])).toBe('Polymarket')
    expect(joinList(['Polymarket', 'Kalshi'])).toBe('Polymarket and Kalshi')
    expect(joinList(['A', null, '', 'B', undefined, 'C'])).toBe('A, B and C')
    expect(joinList(['USDC', 'pUSD'], 'or')).toBe('USDC or pUSD')
  })
  it('assembles sentences from optional parts without stray punctuation or spaces', () => {
    expect(sentences()).toBe('')
    expect(sentences('Latest prices are unavailable for 2 positions', false, 'The results stay as they are.')).toBe('Latest prices are unavailable for 2 positions. The results stay as they are.')
    expect(sentences('  Trailing comma, ', 'Double  space')).toBe('Trailing comma. Double space.')
    expect(sentences('Is it?', null)).toBe('Is it?')
  })
  it('joins optional phrases with commas and never leads with one', () => {
    expect(phrase(undefined, 'Nov 24, 2026')).toBe('Nov 24, 2026')
    expect(phrase('Main account', null, 'Nov 24, 2026')).toBe('Main account, Nov 24, 2026')
    expect(phrase()).toBe('')
    expect(capitalize('pUSD balance')).toBe('PUSD balance')
    expect(capitalize('')).toBe('')
  })
  it('keeps long user-entered names intact', () => {
    const long = 'Q4 hedge: rates, crypto & elections (draft 3)'
    expect(joinList([long, 'B'])).toBe(`${long} and B`)
    expect(phrase(long, 'Saved')).toBe(`${long}, Saved`)
  })
})

describe('exchange-rate presentation comes from the reference, not from hard-coded providers', () => {
  const ref = (o: Partial<FxReference>): FxReference => ({ base: 'USD', quote: 'EUR', rate: 0.9, kind: 'fiat', source: 'src_x', methodology: 'm', observedAt: '2026-11-24', retrievedAt: null, freshness: 'last_known', revision: null, ...o })
  it('shows the service’s provider name, or the source id when it has none', () => {
    expect(sourceName(ref({ sourceName: 'Any Provider' }))).toBe('Any Provider')
    expect(sourceName(ref({}))).toBe('src_x')
    // The development fixture names its own sources; a combined leg names both.
    expect(sourceName(fixtureFx().reference('USDC', 'EUR'))).toBe('Kraken and ECB')
  })
  it('words a missing fiat leg and a missing asset leg differently, and says nothing for a usable rate', () => {
    expect(rateWarning(ref({ rate: null, freshness: 'unavailable' }), day)).toBe('No USD to EUR rate is available, so values are shown in USD.')
    expect(rateWarning(ref({ base: 'PUSD', quote: 'USD', kind: 'stablecoin', rate: null, freshness: 'unavailable' }), day)).toBe('No pUSD to USD rate is available, so totals that include pUSD can’t be converted.')
    expect(rateWarning(ref({ quote: 'GBP', freshness: 'stale', observedAt: '2026-10-01' }), day)).toBe('The USD to GBP rate is out of date (last observed 2026-10-01).')
    expect(rateWarning(ref({ freshness: 'stale', observedAt: null }), day)).toBe('The USD to EUR rate is out of date.')
    expect(rateWarning(ref({}), day)).toBeNull()
  })
  it('handles every reporting currency and native asset from an injected table', () => {
    const fx = fixtureFx('2026-11-24', undefined, { EUR: { rate: 0.9, observedAt: '2026-11-24' } })
    for (const a of ['USD', 'USDC', 'PUSD']) {
      expect(fx.reference(a, 'EUR').rate).not.toBeNull()
      expect(fx.reference(a, 'GBP').rate).toBeNull()
    }
    expect(rateWarning(fx.reference('USD', 'GBP'), day)).toBe('No USD to GBP rate is available, so values are shown in USD.')
    expect(rateWarning(fx.reference('USD', 'USD'), day)).toBeNull()
  })
})

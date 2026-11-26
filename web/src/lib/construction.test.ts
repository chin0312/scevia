import { describe, expect, it } from 'vitest'
import { SAMPLE_MARKET_CATALOG, SAMPLE_MARKET_EVENTS } from '../data/sampleMarkets'
import { eventPnl, holdingsAllocation, scenarioMetrics, type Adjustment, type InstrumentRef } from './finance'
import { POS_BY_ID, account, baseHoldings, sourceRelations, simulate } from './fixtureFinance'
import { instrumentFrom, parseMarketLink } from './markets'
import * as SC from './scenarios'
import { DEFAULT_FEES } from './fees'
import { diff } from '../pages/lab/model'

const close = (a: number | null | undefined, b: number, eps = 0.01) => { expect(a).toEqual(expect.any(Number)); expect(Math.abs((a as number) - b)).toBeLessThan(eps) }
const ev = (marketId: string) => SAMPLE_MARKET_EVENTS.find((e) => e.markets.some((m) => m.marketId === marketId))!
const inst = (marketId: string, o: 'YES' | 'NO' = 'YES'): InstrumentRef => { const e = ev(marketId), m = e.markets.find((x) => x.marketId === marketId)!; return instrumentFrom(e, m, m.outcomes.find((x) => x.outcome === o)!, 'sample') }
const row = (i: InstrumentRef, to: number | null, price: number | null): Adjustment => ({ id: `${i.provider}:${i.marketId}:${i.outcome}`, to, price, instrument: i })
const rels = sourceRelations()

describe('starting portfolios and added capital', () => {
  it('a scratch portfolio starts empty: no holdings, no cash, no inherited value', () => {
    const s = simulate([], { fees: DEFAULT_FEES, baseline: 'scratch' })
    expect(Object.keys(s.holdings)).toHaveLength(0)
    expect(s.cash).toEqual({ pm: 0, ks: 0 })
    const m = scenarioMetrics(s, rels)
    expect(m.totalValue).toBe(0); expect(m.committed).toBe(0); expect(m.worstValue).toBe(0)
  })
  it('added capital is contributed capital: it raises cash and value equally on both sides, never as a gain', () => {
    const opts = { fees: { mode: 'excluded' as const }, baseline: 'scratch' as const, funding: { pm: 5000 } }
    const i = inst('pm-eth-5k'), start = scenarioMetrics(simulate([], opts), rels), after = scenarioMetrics(simulate([row(i, 10000, 0.18)], opts), rels)
    close(start.totalValue, 5000)
    close(after.cash, 5000 - 1800)
    close(after.totalValue! - start.totalValue!, 0) // bought at the reference price, no fees: no value change
    expect(after.realized).toBe(0)
  })
  it('invalid or negative funding is ignored by the engine (and flagged in the UI), never added', () => {
    const s = simulate([], { fees: DEFAULT_FEES, baseline: 'scratch', funding: { pm: -100, ks: Number.NaN } })
    expect(s.cash).toEqual({ pm: 0, ks: 0 })
  })
  it('cash is not moved between platforms: a Kalshi purchase funded only on Polymarket is a Kalshi shortfall', () => {
    const s = simulate([row(inst('ks-unemp-45'), 1000, 0.22)], { fees: { mode: 'excluded' as const }, baseline: 'scratch', funding: { pm: 10000 } })
    close(s.shortfall.ks, 220); expect(s.shortfall.pm).toBe(0)
  })
})

describe('hypothetical new instruments', () => {
  it('a new market is bought from zero, valued at its reference price, and never touches actual holdings', () => {
    const before = JSON.stringify(baseHoldings())
    const i = inst('pm-gdp-q4'), s = simulate([row(i, 2000, 0.5)], { fees: { mode: 'excluded' as const } })
    const h = s.holdings[`pm:pm-gdp-q4:YES`]
    expect(h.isNew).toBe(true); expect(h.shares).toBe(2000); close(h.cost, 1000); close(h.mark!, 0.55)
    close(s.cash.pm, account('pm').cash - 1000)
    expect(JSON.stringify(baseHoldings())).toBe(before)
  })
  it('an opposing position on a held event offsets its settlement exposure', () => {
    const btc = POS_BY_ID.btc, no = inst('pm-btc-150k', 'NO')
    expect(no.eventId).toBe('btc')
    const s = simulate([row(no, btc.shares, 0.72)], { fees: { mode: 'excluded' as const } })
    const hs = Object.values(s.holdings)
    close(eventPnl(hs, 'btc', 'YES'), btc.shares - btc.cost - btc.shares * 0.72)
    close(eventPnl(hs, 'btc', 'NO'), btc.shares - btc.cost - btc.shares * 0.72) // fully hedged: same either way
  })
  it('missing quantity or price excludes the row instead of trading zero', () => {
    const i = inst('pm-sol-500')
    const s = simulate([row(i, null, 0.12), { ...row(inst('pm-lakers-2027'), 100, null) }], { fees: DEFAULT_FEES })
    expect(Object.keys(s.errors)).toHaveLength(2)
    expect(Object.values(s.holdings).some((h) => h.isNew)).toBe(false)
    expect(simulate([row(i, 1.555, 0.12)], { fees: DEFAULT_FEES }).errors[row(i, 0, 0).id]).toMatch(/2 decimals/)
    expect(simulate([row(i, 1.5, 0.12)], { fees: DEFAULT_FEES }).errors).toEqual({}) // fractional quantities are allowed
  })
  it('a position without a reference price makes market value unavailable, not zero', () => {
    const i = inst('ks-wti-90'), s = simulate([row(i, 100, 0.4)], { fees: { mode: 'excluded' as const } })
    const m = scenarioMetrics(s, rels)
    expect(m.positionsValue).toBeNull(); expect(m.totalValue).toBeNull()
    close(m.committed, account('all').committed + 40)
    expect(holdingsAllocation(Object.values(s.holdings), 'category').total).toBeNull()
  })
})

describe('allocation of hypothetical holdings', () => {
  it('segments partition open-position value and shares sum to 1 for every grouping', () => {
    const s = simulate([row(inst('pm-eth-5k'), 1000, 0.18), row(inst('ks-fedjan-cut'), 500, 0.31)], { fees: { mode: 'excluded' as const } })
    const hs = Object.values(s.holdings)
    for (const by of ['category', 'platform', 'event'] as const) {
      const a = holdingsAllocation(hs, by)
      close(a.segments.reduce((x, g) => x + (g.share ?? 0), 0), 1, 1e-9)
      close(a.total, hs.reduce((x, h) => x + h.shares * h.mark!, 0))
      expect(a.segments.flatMap((g) => g.ids).sort()).toEqual(hs.filter((h) => h.shares > 0).map((h) => h.id).sort())
    }
  })
  it('an empty portfolio has no allocation shares (null), not 0%', () => {
    const a = holdingsAllocation([], 'category')
    expect(a.total).toBe(0); expect(a.segments).toEqual([])
  })
})

describe('comparison arithmetic', () => {
  it('a change with an unavailable side is unavailable, never a number', () => {
    expect(diff(null, 5)).toBeNull(); expect(diff(5, null)).toBeNull(); expect(diff(Number.NaN, 1)).toBeNull()
    expect(diff(7, 5)).toBe(2)
  })
})

describe('scenario model', () => {
  it('older stored scenarios migrate to the current portfolio with shared assumptions', () => {
    const r = SC.sanitize([{ key: 'a', name: 'Old', adjs: [{ id: 'btc', to: 10, price: 0.3 }], saved: { name: 'Old', adjs: [{ id: 'btc', to: 10, price: 0.3 }] }, savedAt: 'x', color: 'c', start: [{ id: 'btc', to: 10, price: 0.3 }] }], (id) => !!POS_BY_ID[id])!
    const s = r.scenarios[0]
    expect(s.baseline).toBe('portfolio'); expect(s.funding).toEqual({}); expect(s.assumptions).toEqual({})
    expect(SC.status(s)).toBe('saved')
  })
  it('new-instrument rows survive restore without an actual position id; malformed ones are dropped', () => {
    const i = inst('pm-eth-5k')
    const r = SC.sanitize([{ key: 'a', name: 'N', baseline: 'scratch', funding: { pm: 100 }, assumptions: { fees: { mode: 'excluded' as const }, crypto: 'mutex' }, adjs: [row(i, null, null), { id: 'x', to: 1, price: 0.5, instrument: { provider: 'zz' } }], saved: null }], () => false)!
    expect(r.scenarios[0].adjs).toHaveLength(1); expect(r.dropped).toBe(1)
    expect(r.scenarios[0].assumptions).toEqual({ fees: { mode: 'excluded' }, constraints: [{ a: 'btc', b: 'eth', cls: 'mutex' }] }) // a legacy BTC × ETH override migrates to a hypothetical constraint
  })
  it('setup changes are part of the saved state; duplicate and reset keep them', () => {
    const s = SC.save(SC.create('k', 'c', 'A', 'scratch'), 'now')
    const changed = SC.configure(s, { funding: { pm: 1000 } })
    expect(SC.status(changed)).toBe('modified')
    expect(SC.revert(changed).funding).toEqual({})
    const dup = SC.duplicate(changed, 'd', 'c')
    expect(dup.baseline).toBe('scratch'); expect(dup.funding).toEqual({ pm: 1000 })
    expect(SC.canRevert(dup)).toBe(false)
    expect(SC.revert({ ...dup, funding: {} }).funding).toEqual({ pm: 1000 })
  })
  it('examples start unsaved and reset to the example, not to empty', () => {
    const ex = SC.fromExample('e', 'c', { name: 'Ex', adjs: [{ id: 'btc', to: 1, price: 0.3 }], baseline: 'portfolio' })
    expect(SC.status(ex)).toBe('new')
    expect(SC.revert({ ...ex, adjs: [] }).adjs).toHaveLength(1)
  })
})

describe('market links (no fetching)', () => {
  it('recognises supported providers and rejects everything else', () => {
    expect(parseMarketLink('not a link')).toMatchObject({ ok: false, res: { status: 'invalid' } })
    expect(parseMarketLink('ftp://polymarket.com/x')).toMatchObject({ ok: false, res: { status: 'invalid' } })
    expect(parseMarketLink('https://example.com/event/x')).toMatchObject({ ok: false, res: { status: 'unsupported', host: 'example.com' } })
    expect(parseMarketLink('https://www.polymarket.com/event/abc/')).toMatchObject({ ok: true, provider: 'pm', path: '/event/abc' })
    expect(parseMarketLink('https://kalshi.com/markets/X')).toMatchObject({ ok: true, provider: 'ks' })
  })
  it('the sample catalog resolves only its own links and reports other states honestly', async () => {
    expect((await SAMPLE_MARKET_CATALOG.resolveLink('https://polymarket.com/event/some-real-market')).status).toBe('not-found')
    expect((await SAMPLE_MARKET_CATALOG.resolveLink('https://kalshi.com/markets/kxdelisted-26')).status).toBe('unavailable')
    const r = await SAMPLE_MARKET_CATALOG.resolveLink('https://kalshi.com/markets/kxfeddecision-27jan')
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.event.markets).toHaveLength(2)
    expect(SAMPLE_MARKET_CATALOG.live).toBe(false)
    expect((await SAMPLE_MARKET_CATALOG.search('ethereum')).map((e) => e.eventTitle)).toEqual(['Ethereum above $5,000 on Dec 31'])
    expect((await SAMPLE_MARKET_CATALOG.search('', { provider: 'ks' })).every((e) => e.provider === 'ks' && e.available)).toBe(true)
  })
})

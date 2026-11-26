/* Workspace boundary, freshness, LOCF history and Historical Replay. */
import { describe, expect, it } from 'vitest'
import { DEMO_ID, FIXTURE_ID, bundledService, demoStreams, fixtureSnapshot, readDecimal, readDemo, readPortfolioList } from '../data/workspace'
import { SAMPLE_MARKET_EVENTS } from '../data/sampleMarkets'
import { ago, classifyAge, summaryState, type StreamStatus } from './freshness'
import { maxDrawdown, priceAt, seriesQuality, valueSeries } from './history'
import { compareReplays, replayMarketFrom, runReplay, sanitizeReplays, validateReplay, type Replay, type ReplayAccount } from './replay'
import { periodAvailable, periodRange } from './finance'

const NOW = Date.parse('2026-11-24T12:00:00Z')

describe('workspace boundary', () => {
  it('keeps fixture, demo and actual portfolios apart when reading the backend list', () => {
    const l = readPortfolioList({ items: [
      { id: 'a', name: 'Demo', mode: 'demo', providerAccountCount: 0 },
      { id: 'b', name: 'Mine', mode: 'actual', providerAccountCount: 2 },
      { id: 'c', name: 'Seed', mode: 'fixture' },
      { id: 'd', name: 'Odd', mode: 'live' },
    ] })!
    expect(l.map((x) => [x.id, x.mode])).toEqual([['a', 'demo'], ['b', 'actual'], ['c', 'fixture']])
    expect(readPortfolioList({ nope: 1 })).toBeNull()
  })
  it('reads the demo contract without falling back to a fixture', () => {
    expect(readDemo({ status: 'unavailable', reason: 'authorized_demo_dataset_unavailable' })).toEqual({ status: 'unavailable', reason: 'authorized_demo_dataset_unavailable' })
    expect(readDemo({ status: 'initialization_required' }).status).toBe('initialization_required')
    expect(readDemo({ status: 'weird' }).status).toBe('unavailable')
    const d = readDemo({ status: 'available', portfolioId: 'p', mode: 'demo', revision: 'r', capturedAt: '2026-11-20T00:00:00Z', marketEvidence: 'captured',
      quotes: [{ retrievedAt: '2026-11-20T00:00:00Z', effectiveAt: '2026-11-19T23:00:00Z', freshness: 'stale_capture' }] })
    expect(d.status).toBe('available')
    if (d.status !== 'available') return
    const s = demoStreams(d, '2026-11-24T00:00:00Z')
    // A captured snapshot is never "streaming"; a stale capture is reported as stale.
    expect(s.find((x) => x.id === 'market')!.state).toBe('stale')
    expect(s.some((x) => x.state === 'streaming')).toBe(false)
  })
  it('reads decimal strings and keeps invalid values unavailable', () => {
    expect(readDecimal('12.50')).toBe(12.5)
    expect(readDecimal('-0.0001')).toBe(-0.0001)
    expect(readDecimal(null)).toBeNull()
    expect(readDecimal('')).toBeNull()
    expect(readDecimal('1e5')).toBeNull()
    expect(readDecimal('NaN')).toBeNull()
  })
  it('loads asynchronously; the demo is unavailable and the fixture refresh reports no change', async () => {
    const svc = bundledService({ latencyMs: 0, now: () => '2026-11-24T12:00:00Z' })
    expect((await svc.list()).map((x) => x.mode)).toEqual(['fixture', 'demo'])
    const demo = await svc.load(DEMO_ID)
    expect(demo.status).toBe('unavailable')
    expect(demo.reason).toBe('authorized_demo_dataset_unavailable')
    expect(demo.financialRevision).toBeNull()
    const fx = await svc.load(FIXTURE_ID)
    const r = await svc.refresh(fx)
    expect(r.changed).toBe(false)
    expect(r.snapshot.financialRevision).toBe(fx.financialRevision)
    expect(r.snapshot.checkedAt).toBe('2026-11-24T12:00:00Z')
    await expect(svc.load('missing')).rejects.toThrow()
  })
  it('labels every fixture stream as fixed sample or unavailable, never live', () => {
    const s = fixtureSnapshot()
    expect(s.summary.mode).toBe('fixture')
    expect(s.streams.every((x) => ['fixture', 'unavailable'].includes(x.state))).toBe(true)
    expect(summaryState(s.streams)).toBe('fixture')
    expect(s.accounts.map((a) => a.denomination)).toEqual(['USDC', 'USD'])
  })
})

describe('freshness', () => {
  const st = (id: StreamStatus['id'], state: StreamStatus['state']): StreamStatus => ({ id, state, asOf: null, checkedAt: null, detail: '' })
  it('classifies by age, and unknown time is unavailable', () => {
    expect(classifyAge('2026-11-24T11:58:00Z', NOW, 'market')).toBe('recent')
    expect(classifyAge('2026-11-24T11:30:00Z', NOW, 'market')).toBe('delayed')
    expect(classifyAge('2026-11-24T09:00:00Z', NOW, 'market')).toBe('stale')
    expect(classifyAge('2026-11-24T09:00:00Z', NOW, 'account')).toBe('delayed')
    expect(classifyAge(null, NOW, 'market')).toBe('unavailable')
    expect(classifyAge('garbage', NOW, 'market')).toBe('unavailable')
  })
  it('reports streams independently: one current stream never hides a stale one', () => {
    expect(summaryState([st('market', 'streaming'), st('account', 'stale'), st('valuation', 'recent')])).toBe('stale')
    expect(summaryState([st('market', 'streaming'), st('account', 'streaming'), st('valuation', 'streaming')])).toBe('streaming')
    expect(summaryState([st('market', 'recent'), st('account', 'import_only'), st('valuation', 'recent'), st('sync', 'disconnected')])).toBe('import_only')
    expect(summaryState([])).toBe('unavailable')
  })
  it('formats relative times', () => {
    expect(ago('2026-11-24T11:59:50Z', NOW)).toBe('just now')
    expect(ago('2026-11-24T11:00:00Z', NOW)).toBe('1 h ago')
    expect(ago(null, NOW)).toBe('never')
  })
})

describe('LOCF history', () => {
  const h = { key: 'x', observations: [{ at: '2026-01-05', price: 0.4 }, { at: '2026-01-20', price: 0.6 }, { at: '2026-01-01', price: 2 }] }
  it('carries the last eligible observation forward with its original time and never fills backward', () => {
    expect(priceAt(h, '2026-01-04').basis).toBe('unavailable')
    expect(priceAt(h, '2026-01-05')).toMatchObject({ price: 0.4, basis: 'observed', observedAt: '2026-01-05' })
    expect(priceAt(h, '2026-01-08')).toMatchObject({ price: 0.4, basis: 'carried', ageDays: 3 })
    expect(priceAt(h, '2026-01-15')).toMatchObject({ price: 0.4, basis: 'stale', ageDays: 10 })
    expect(priceAt(h, '2026-01-21')).toMatchObject({ price: 0.6, basis: 'carried', observedAt: '2026-01-20' })
  })
  it('never carries a price across settlement', () => {
    const s = { ...h, settledAt: '2026-01-25', settlementValue: 0 as const }
    expect(priceAt(s, '2026-01-24').price).toBe(0.6)
    expect(priceAt(s, '2026-01-26')).toMatchObject({ price: 0, basis: 'settled' })
  })
  it('values instruments before the portfolio, keeps partial points partial, and applies cash at its own time', () => {
    const pts = valueSeries(['2026-01-04', '2026-01-06', '2026-01-21'], [h], (_, d) => (d >= '2026-01-03' ? 100 : 0), (d) => (d >= '2026-01-21' ? 50 : 0))
    expect(pts[0]).toMatchObject({ value: null, known: 0, missing: 1 })
    expect(pts[1]).toMatchObject({ value: 40, carried: 1 })
    expect(pts[2]).toMatchObject({ value: 110, cash: 50 })
    expect(seriesQuality(pts).complete).toBe(false)
    expect(seriesQuality(pts.slice(1)).qualified).toBe(false)
    expect(maxDrawdown(pts)).toEqual({ amount: 0, from: '2026-01-06', to: '2026-01-06' })
  })
})

describe('periods', () => {
  it('derives YTD from the data date and marks periods the history doesn’t cover', () => {
    expect(periodRange('YTD').start).toBe('2025-12-31')
    expect(periodRange('1W').start).toBe('2026-11-17')
    expect(periodAvailable('1Y')).toBe(true)
    expect(periodRange({ start: '2026-01-01', end: '2026-03-01' }).start).toBe('2026-01-01')
  })
})

describe('Historical Replay', () => {
  const ACCTS: ReplayAccount[] = [{ id: 'pm-main', venue: 'pm', label: 'Wallet', denomination: 'USDC' }, { id: 'ks-main', venue: 'ks', label: 'Main', denomination: 'USD' }]
  const find = (id: string) => { const ev = SAMPLE_MARKET_EVENTS.find((e) => e.markets.some((m) => m.marketId === id))!; return replayMarketFrom(ev, ev.markets.find((m) => m.marketId === id)!) }
  const base = (): Replay => ({
    key: 'r1', name: 'Test', color: '', start: '2026-03-01', end: '2026-11-24', capital: { 'pm-main': 1000, 'ks-main': 500 }, fees: { mode: 'excluded' }, basis: 'retrospective', createdAt: '',
    positions: [
      { id: 'p1', market: find('pm-mayor'), outcome: 'YES', accountId: 'pm-main', entryDate: '2026-03-02', entryPrice: 0.6, size: { mode: 'amount', value: 300 }, exit: { kind: 'settle' } },
      { id: 'p2', market: find('ks-fedjan-cut'), outcome: 'NO', accountId: 'ks-main', entryDate: '2026-06-01', entryPrice: 0.5, size: { mode: 'weight', value: 40 }, exit: { kind: 'settle' } },
    ],
  })
  it('enforces the period and the market lifecycle', () => {
    const r = base()
    expect(validateReplay(r, '2026-11-24', ACCTS)).toEqual({ period: null, capital: null, positions: {} })
    r.positions[1].entryDate = '2026-04-01'
    expect(validateReplay(r, '2026-11-24', ACCTS).positions.p2).toMatch(/wasn’t listed until 2026-05-01/)
    r.positions[1].entryDate = '2026-06-01'
    r.positions[0].exit = { kind: 'date', date: '2026-11-10', price: 0.9 }
    expect(validateReplay(r, '2026-11-24', ACCTS).positions.p1).toMatch(/Trading closed on 2026-11-05/)
    expect(validateReplay({ ...r, end: '2026-12-01' }, '2026-11-24', ACCTS).period).toMatch(/on or before today/)
    expect(validateReplay({ ...r, positions: [{ ...r.positions[1], accountId: 'pm-main' }] }, '2026-11-24', ACCTS).positions.p2).toMatch(/another venue/)
  })
  it('settles at the recorded resolution, values open holdings only from recorded prices, and labels hindsight', () => {
    const res = runReplay(base(), ACCTS, '2026-11-24')
    const [won, open] = res.lines
    expect(won).toMatchObject({ end: 'settled', shares: 500, proceeds: 500, pnl: 200, realized: true })
    // Open at the end: the only recorded price is the sample reference on 2026-11-24, so the end value is known.
    expect(open.end).toBe('open')
    expect(open.shares).toBe(400)
    expect(open.endValue).toBeCloseTo(400 * 0.7)
    expect(res.hindsight).toBe(true)
    // Two denominations: native totals first; combined only as an indicative sum.
    expect(res.byDenomination.map((d) => d.denomination)).toEqual(['USDC', 'USD'])
    expect(res.combined?.assumed).toBe(true)
    // No recorded history before the end date: value over time is partial, so drawdown is unavailable.
    expect(res.quality.complete).toBe(false)
    expect(res.drawdown).toBeNull()
    expect(res.evidence.find((e) => e.marketId === 'pm-mayor')!.resolution).toBe(true)
  })
  it('keeps an open holding unavailable when the replay ends before any recorded price', () => {
    const r = { ...base(), end: '2026-10-01' }
    const res = runReplay(r, ACCTS, '2026-11-24')
    expect(res.lines[0].end).toBe('open')
    expect(res.lines[0].endValue).toBeNull()
    expect(res.combined).toBeNull()
  })
  it('reports a funding shortfall per account', () => {
    const r = base(); r.positions[0].size = { mode: 'amount', value: 1500 }
    const res = runReplay(r, ACCTS, '2026-11-24')
    expect(res.accounts.find((a) => a.account.id === 'pm-main')!.shortfall).toBeCloseTo(500)
    expect(res.accounts.find((a) => a.account.id === 'ks-main')!.shortfall).toBe(0)
  })
  it('compares only on a common basis and lists each difference', () => {
    const a = runReplay(base(), ACCTS, '2026-11-24')
    const b = runReplay({ ...base(), key: 'r2', capital: { 'pm-main': 2000, 'ks-main': 500 }, fees: { mode: 'provider', role: 'taker' } }, ACCTS, '2026-11-24')
    const c = compareReplays([a, b])
    expect(c.pnlComparable).toBe(false)
    expect(c.differences.filter((d) => d.differs).map((d) => d.key)).toEqual(['capital', 'fees'])
  })
  it('drops malformed stored replays and positions', () => {
    const r = base()
    const out = sanitizeReplays([r, { key: 1 }, { ...r, key: 'r3', positions: [{ id: 'bad' }, r.positions[0]] }])!
    expect(out.map((x) => x.key)).toEqual(['r1', 'r3'])
    expect(out[1].positions.map((p) => p.id)).toEqual(['p1'])
    expect(sanitizeReplays('x')).toBeNull()
  })
})

describe('frozen vs. latest scenario references', () => {
  it('reports moved references and updates only the frozen reference, never the assumed price', async () => {
    const { refStatus, applyLatestRefs } = await import('./scenarios')
    expect(refStatus(0.4, 0.4)).toBe('same')
    expect(refStatus(0.4, 0.45)).toBe('moved')
    expect(refStatus(0.4, null)).toBe('no-latest')
    expect(refStatus(null, 0.3)).toBe('no-frozen')
    const inst = { provider: 'pm' as const, eventId: 'e', eventTitle: 'E', marketId: 'm', marketTitle: 'M', outcome: 'YES' as const, category: 'Crypto' as const, resolves: '2026-12-31', refPrice: 0.4, refAsOf: '2026-11-01', source: 'sample' as const, fee: null }
    const adjs = [{ id: 'new:pm:m:YES', to: 100, price: 0.38, instrument: inst }, { id: 'held', to: 5, price: null }]
    const out = applyLatestRefs(adjs, [{ id: 'new:pm:m:YES', frozen: 0.4, frozenAt: '2026-11-01', latest: 0.45, latestAt: '2026-11-24', assumed: 0.38, status: 'moved' }])
    expect(out[0].instrument).toMatchObject({ refPrice: 0.45, refAsOf: '2026-11-24' })
    expect(out[0].price).toBe(0.38)
    expect(out[0].to).toBe(100)
    expect(out[1]).toBe(adjs[1])
  })
})

/* Workspace boundary, freshness, LOCF history and Historical Replay. */
import { describe, expect, it } from 'vitest'
import { DEMO_ID, FIXTURE_ID, bundledService, demoStreams, fixtureSnapshot, readDecimal, readDemo, readPortfolioList } from '../data/workspace'
import { SAMPLE_MARKET_EVENTS } from '../data/sampleMarkets'
import { ago, classifyAge, summaryState, type StreamStatus } from './freshness'
import { maxDrawdown, priceAt, seriesQuality, valueSeries } from './history'
import { bucketId, compareReplays, coverShortfall, replayMarketFrom, runReplay, sanitizeReplays, tradingWindow, validateReplay, type FundingBucket, type Replay, type ReplayMarket, type ReplayPosition } from './replay'
import { periodAvailable, periodRange } from './fixtureFinance'

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
    // Valuation completeness isn't inferred from a capture, and market freshness follows the oldest quote's source time.
    expect(s.find((x) => x.id === 'valuation')!.state).toBe('partial')
    const two = readDemo({ status: 'available', portfolioId: 'p', mode: 'demo', revision: 'r', capturedAt: '2026-11-20T00:00:00Z',
      quotes: [{ retrievedAt: '2026-11-20T00:00:00Z', effectiveAt: '2026-10-01T00:00:00Z', freshness: 'recent_capture' }, { retrievedAt: '2026-11-20T00:00:00Z', effectiveAt: '2026-11-19T00:00:00Z', freshness: 'recent_capture' }] })
    if (two.status === 'available') expect(demoStreams(two, '2026-11-24T00:00:00Z')[0]).toMatchObject({ state: 'cached_snapshot', asOf: '2026-10-01T00:00:00Z' })
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
    // Clock skew: a slightly future time is current; a clearly future one is invalid, never "recent".
    expect(classifyAge('2026-11-24T12:01:00Z', NOW, 'market')).toBe('recent')
    expect(classifyAge('2026-11-24T13:00:00Z', NOW, 'market')).toBe('unavailable')
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
  const find = (id: string) => { const ev = SAMPLE_MARKET_EVENTS.find((e) => e.markets.some((m) => m.marketId === id))!; return replayMarketFrom(ev, ev.markets.find((m) => m.marketId === id)!) }
  const PM: FundingBucket = { id: bucketId('pm', 'USDC'), venue: 'pm', denomination: 'USDC', capital: 1000 }
  const KS: FundingBucket = { id: bucketId('ks', 'USD'), venue: 'ks', denomination: 'USD', capital: 500 }
  const base = (): Replay => ({
    key: 'r1', name: 'Test', color: '', start: '2026-03-01', end: '2026-11-24', buckets: [{ ...PM }, { ...KS }], fees: { mode: 'excluded' }, rates: { USDC: null, PUSD: null }, basis: 'retrospective', createdAt: '',
    positions: [
      { id: 'p1', market: find('pm-mayor'), outcome: 'YES', bucketId: PM.id, entryDate: '2026-03-02', entryPrice: 0.6, size: { mode: 'amount', value: 300 }, exit: { kind: 'settle' } },
      { id: 'p2', market: find('ks-fedjan-cut'), outcome: 'NO', bucketId: KS.id, entryDate: '2026-06-01', entryPrice: 0.5, size: { mode: 'weight', value: 40 }, exit: { kind: 'settle' } },
    ],
  })
  // A market whose trading closed on Nov 20 and that resolved on Nov 23.
  const closing: ReplayMarket = { provider: 'pm', marketId: 'x-close', title: 'Closes before it resolves', eventTitle: 'X', category: 'Economics', listedAt: '2026-10-01', closesAt: '2026-11-20', expectedResolution: '2026-11-22', resolution: { outcome: 'NO', at: '2026-11-23' }, fee: null, observations: { YES: [], NO: [] } }
  const pos = (over: Partial<ReplayPosition>): ReplayPosition => ({ id: 'q', market: closing, outcome: 'NO', bucketId: PM.id, entryDate: '2026-11-10', entryPrice: 0.7, size: { mode: 'shares', value: 100 }, exit: { kind: 'settle' }, ...over })
  const with_ = (...ps: ReplayPosition[]): Replay => ({ ...base(), positions: ps })

  it('trading close governs execution; a later resolution never extends the window', () => {
    expect(validateReplay(with_(pos({ entryDate: '2026-11-20' })), '2026-11-24').positions).toEqual({})
    expect(validateReplay(with_(pos({ entryDate: '2026-11-21' })), '2026-11-24').positions.q).toBe('Trading closed on 2026-11-20; it resolved later, on 2026-11-23.')
    expect(validateReplay(with_(pos({ exit: { kind: 'date', date: '2026-11-22', price: 0.9 } })), '2026-11-24').positions.q).toMatch(/^Trading closed on 2026-11-20.*Hold to settlement instead\.$/)
    // Holding to settlement is valid and settles at the verified resolution time.
    const res = runReplay(with_(pos({})), '2026-11-24')
    expect(res.lines[0]).toMatchObject({ end: 'settled', endDate: '2026-11-23', proceeds: 100 })
    // A timestamped close: same day before the close is fine, the next day isn't.
    const ts = { ...closing, closesAt: '2026-11-20T18:00:00Z' }
    expect(tradingWindow(ts, '2026-11-20').ok).toBe(true)
    expect(tradingWindow(ts, '2026-11-21').ok).toBe(false)
  })
  it('keeps an unrecorded close unknown (a caveat), never the expected resolution', () => {
    const m = find('ks-fedjan-cut')
    expect(m.closesAt).toBeNull()
    expect(m.expectedResolution).toBe('2027-01-27')
    const v = validateReplay(base(), '2026-11-24')
    expect(v.positions).toEqual({})
    expect(v.caveats.p2).toMatch(/Trading close isn’t recorded/)
    expect(v.caveats.p1).toBeUndefined()
    expect(validateReplay({ ...base(), positions: [{ ...base().positions[1], entryDate: '2026-04-01' }] }, '2026-11-24').positions.p2).toMatch(/wasn’t listed until 2026-05-01/)
  })
  it('restores older replays without turning a resolution date into a trading close', () => {
    const legacy = [{ key: 'old', name: 'Old', start: '2026-03-01', end: '2026-11-24', capital: { 'pm-main': 700 }, positions: [{ id: 'a', accountId: 'pm-main', market: { ...find('pm-mayor'), closesAt: '2026-11-05', expectedResolution: undefined }, outcome: 'YES', entryDate: '2026-03-02', entryPrice: 0.6, size: { mode: 'amount', value: 100 }, exit: { kind: 'settle' } }] }]
    const [r] = sanitizeReplays(JSON.parse(JSON.stringify(legacy)))!
    expect(r.positions[0].market.closesAt).toBeNull()
    expect(r.buckets).toEqual([{ id: bucketId('pm', 'USDC'), venue: 'pm', denomination: 'USDC', capital: 700 }])
    expect(r.positions[0].bucketId).toBe(bucketId('pm', 'USDC'))
  })
  it('settles at the recorded resolution, values open holdings only from recorded prices, and is always hindsight', () => {
    const res = runReplay(base(), '2026-11-24')
    const [won, open] = res.lines
    expect(won).toMatchObject({ end: 'settled', shares: 500, proceeds: 500, pnl: 200, realized: true })
    expect(open).toMatchObject({ end: 'open', shares: 400 })
    expect(open.endValue).toBeCloseTo(400 * 0.7)
    expect(res.hindsight).toBe(true)
    expect(res.resolvedSelected).toBe(true)
    expect(runReplay({ ...base(), positions: [base().positions[1]] }, '2026-11-24').hindsight).toBe(true)
    expect(res.funding).toBe('funded')
    expect(res.quality.complete).toBe(false)
    expect(res.drawdown).toBeNull()
  })
  it('reports native results first; a combined USD total needs a frozen rate for each non-USD asset', () => {
    const res = runReplay(base(), '2026-11-24')
    expect(res.byDenomination.map((d) => d.denomination)).toEqual(['USDC', 'USD'])
    expect(res.combined).toBeNull()
    expect(res.combinedMissing).toBe('rate')
    const rated = runReplay({ ...base(), rates: { USDC: 0.999, PUSD: null } }, '2026-11-24')
    expect(rated.combined!.rates).toEqual({ USDC: 0.999 })
    expect(rated.combined!.endValue).toBeCloseTo(1200 * 0.999 + (500 - 200 + 280))
    // A USD-only replay needs no rate.
    const usd = runReplay({ ...base(), buckets: [{ ...KS }], positions: [base().positions[1]] }, '2026-11-24')
    expect(usd.combined).not.toBeNull()
  })
  it('separates funded, unfunded and unassessable replays per independent bucket', () => {
    const r = base(); r.positions[0].size = { mode: 'amount', value: 1500 }
    const res = runReplay(r, '2026-11-24')
    expect(res.buckets.find((b) => b.bucket.id === PM.id)).toMatchObject({ funding: 'unfunded' })
    expect(res.buckets.find((b) => b.bucket.id === PM.id)!.shortfall).toBeCloseTo(500)
    expect(res.buckets.find((b) => b.bucket.id === KS.id)).toMatchObject({ funding: 'funded', shortfall: 0 })
    expect(res.funding).toBe('unfunded')
    // Unfunded results are what-ifs: no return.
    expect(res.byDenomination.find((d) => d.denomination === 'USDC')!.ret).toBeNull()
    // Covering the shortfall adds simulated capital to that bucket only.
    const covered = runReplay(coverShortfall(r, PM.id, 500), '2026-11-24')
    expect(covered.funding).toBe('funded')
    expect(covered.replay.buckets.find((b) => b.id === KS.id)!.capital).toBe(500)
  })
  it('never treats an unknown fee as zero; an excluded fee is a valid zero', () => {
    // ks-unemp-45 has no fee parameters: with provider fees the entry fee is unknown.
    const m = find('ks-unemp-45')
    const r: Replay = { ...base(), fees: { mode: 'provider', role: 'taker' }, buckets: [{ ...KS }], positions: [
      { id: 'u1', market: m, outcome: 'YES', bucketId: KS.id, entryDate: '2026-09-01', entryPrice: 0.2, size: { mode: 'shares', value: 100 }, exit: { kind: 'settle' } },
      { id: 'u2', market: m, outcome: 'NO', bucketId: KS.id, entryDate: '2026-09-02', entryPrice: 0.75, size: { mode: 'shares', value: 100 }, exit: { kind: 'settle' } },
    ] }
    const res = runReplay(r, '2026-11-24')
    const b = res.buckets[0]
    expect(b.cashComplete).toBe(false)
    expect(b.endValue).toBeNull()
    expect(b.fees).toBeNull()
    expect(b.knownCash).toBeCloseTo(500 - 20 - 75)
    expect(b.funding).toBe('unavailable')
    expect(res.series.filter((p) => p.date >= '2026-09-01').every((p) => p.value == null && !p.cashComplete)).toBe(true)
    const excluded = runReplay({ ...r, fees: { mode: 'excluded' } }, '2026-11-24')
    expect(excluded.buckets[0]).toMatchObject({ cashComplete: true, funding: 'funded', fees: 0 })
  })
  it('allows several positions in one market and values each instrument once', () => {
    const p1 = base().positions[1]
    const r: Replay = { ...base(), buckets: [{ ...KS }], positions: [p1, { ...p1, id: 'p3', entryDate: '2026-07-01' }, { ...p1, id: 'p4', outcome: 'YES', entryPrice: 0.3, size: { mode: 'shares', value: 50 } }] }
    expect(validateReplay(r, '2026-11-24').positions).toEqual({})
    const res = runReplay(r, '2026-11-24')
    const last = res.series.at(-1)!
    expect(last.value).not.toBeNull()
    // NO: 400 + 400 shares at 0.70; YES: 50 at 0.31; cash 500 − 200 − 200 − 15.
    expect(last.value!).toBeCloseTo(500 - 200 - 200 - 15 + 800 * 0.7 + 50 * 0.31)
    expect(last.value!).toBeCloseTo(res.buckets[0].endValue!)
  })
  it('compares only on a common basis and lists each difference', () => {
    const a = runReplay(base(), '2026-11-24')
    const b = runReplay({ ...base(), key: 'r2', buckets: [{ ...PM, capital: 2000 }, { ...KS }], fees: { mode: 'provider', role: 'taker' } }, '2026-11-24')
    const c = compareReplays([a, b])
    expect(c.amountsComparable).toBe(false)
    expect(c.returnComparable).toBe(false)
    expect(c.differences.filter((d) => d.differs).map((d) => d.key)).toEqual(['capital', 'fees'])
    const unfunded = base(); unfunded.positions[0].size = { mode: 'amount', value: 1500 }
    expect(compareReplays([a, runReplay(unfunded, '2026-11-24')]).reasons).toContain('at least one replay is not funded')
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

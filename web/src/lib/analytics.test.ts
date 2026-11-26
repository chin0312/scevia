import { describe, expect, it } from 'vitest'
import { activityByMonth, byMarket, cohorts, concentration, feeBurden, holdingDays, knownSubtotal, pathContributions, pathSummary, performanceFromSeries, resolutionBuckets, returnDistribution } from './analytics'
import { createFinance, settlementRange, type SeriesPoint } from './finance'
import { SAMPLE_PORTFOLIO } from '../data/sample'
import type { ClosedTrade } from '../data/types'

const pt = (date: string, deposits: number, value: number): SeriesPoint => ({ date, deposits, value, netPnl: value - deposits })
const trade = (o: Partial<ClosedTrade>): ClosedTrade => ({ id: Math.random().toString(36), market: 'M', category: 'Crypto', platform: 'pm', side: 'YES', opened: '2026-01-01', closed: '2026-01-10', shares: 100, entry: 0.5, exit: 1, fees: 1, feeKnown: true, outcome: 'Won', ...o } as ClosedTrade)

describe('flow-adjusted performance', () => {
  it('never counts a deposit as a gain', () => {
    const p = performanceFromSeries([pt('2026-01-04', 1000, 1000), pt('2026-01-11', 2000, 2000), pt('2026-01-18', 2000, 2200)])
    expect(p.index.map((x) => x.index)).toEqual([1, 1, 1.1])
    expect(p.twr.value).toBeCloseTo(0.1)
    expect(p.twr.quality).toBe('estimate')
  })
  it('tracks drawdown from the prior peak and reports the deepest one', () => {
    const p = performanceFromSeries([pt('2026-01-04', 1000, 1000), pt('2026-01-11', 1000, 1200), pt('2026-01-18', 1000, 900), pt('2026-01-25', 1000, 1300)])
    expect(p.index[2].drawdown).toBeCloseTo(-0.25)
    expect(p.maximumDrawdown.value).toBeCloseTo(-0.25)
    expect(p.index[3].drawdown).toBe(0)
  })
  it('breaks the chain at a nonpositive base instead of patching it', () => {
    const p = performanceFromSeries([pt('2026-01-04', 0, 0), pt('2026-01-11', 1000, 1000), pt('2026-01-18', 1000, 1100)])
    expect(p.twr.availability).toBe('unavailable')
    expect(p.twr.value).toBeNull()
    expect(p.index.slice(1).every((x) => x.index == null)).toBe(true)
    expect(p.monthly[0].value).toBeNull()
  })
  it('is unavailable with too little history, and says why volatility and MWR are unavailable', () => {
    expect(performanceFromSeries([]).twr.reason).toBe('Needs at least two valuations in the period')
    expect(performanceFromSeries([pt('2026-01-04', 1000, 1000)]).maximumDrawdown.availability).toBe('unavailable')
    const p = performanceFromSeries([pt('2026-01-04', 1000, 1000), pt('2026-01-11', 1000, 1010)])
    expect(p.annualizedVolatility).toMatchObject({ value: null, reason: 'Needs daily valuations' })
    expect(p.annualizedMwr.value).toBeNull()
  })
  it('compounds calendar months and marks the first and last as partial', () => {
    const p = performanceFromSeries([pt('2026-01-25', 1000, 1000), pt('2026-02-01', 1000, 1100), pt('2026-02-08', 1000, 1210), pt('2026-03-01', 1000, 1210)])
    expect(p.monthly.map((m) => m.period)).toEqual(['2026-02', '2026-03'])
    expect(p.monthly[0].value).toBeCloseTo(0.21)
    expect(p.monthly.map((m) => m.partial)).toEqual([true, true])
  })
  it('matches the bundled portfolio history without inventing values', () => {
    const F = createFinance(SAMPLE_PORTFOLIO)
    const p = performanceFromSeries(F.series('all'))
    expect(p.index.length).toBe(F.series('all').length)
    expect(p.twr.availability).toBe('calculated')
  })
})

describe('trade cohorts', () => {
  const ts = [trade({ entry: 0.1, outcome: 'Lost', exit: 0 }), trade({ entry: 0.15, outcome: 'Won' }), trade({ entry: 0.7, outcome: 'Closed early', exit: 0.8 }), trade({ entry: 0.7, side: 'NO', outcome: 'Won', platform: 'ks' })]
  it('keeps resolved win rates separate from exits before resolution', () => {
    const c = cohorts(ts, 'Entry price')
    expect(c.map((x) => x.label)).toEqual(['Under $0.20', '$0.60 to under $0.80'])
    expect(c[1]).toMatchObject({ n: 2, resolved: 1, wins: 1, winRate: 1 })
    expect(c[0].impliedWinRate).toBeCloseTo(0.125)
    const exit = cohorts(ts, 'Exit type')
    expect(exit.find((x) => x.key === 'Closed early')).toMatchObject({ n: 1, resolved: 0, winRate: null })
  })
  it('groups by side, platform, holding period and size, with empty input giving no cohorts', () => {
    expect(cohorts(ts, 'Side').map((x) => [x.label, x.n])).toEqual([['YES', 3], ['NO', 1]])
    expect(cohorts(ts, 'Platform').map((x) => x.label)).toEqual(['Polymarket', 'Kalshi'])
    expect(cohorts([trade({ opened: '2026-01-01', closed: '2026-06-01' })], 'Holding period')[0].label).toBe('Over 90 days')
    expect(cohorts([trade({ shares: 20000, entry: 0.5 })], 'Position size')[0].label).toBe('5,000 and above')
    expect(cohorts([], 'Category')).toEqual([])
    expect(cohorts(ts, 'Entry price')[0].impliedWinRate).not.toBeNull()
    expect(cohorts(ts, 'Side')[0].impliedWinRate).toBeNull()
  })
  it('reports return on entry, gains and losses, and distribution bins that add up', () => {
    const c = cohorts([trade({ entry: 0.5, exit: 1, fees: 0 }), trade({ entry: 0.5, exit: 0, outcome: 'Lost', fees: 0 })], 'Side')[0]
    expect(c.returnOnEntry).toBeCloseTo(0)
    expect(c.avgGain).toBe(50); expect(c.avgLoss).toBe(-50)
    const d = returnDistribution(ts)
    expect(d.bins.reduce((a, b) => a + b.n, 0) + d.excluded).toBe(ts.length)
    expect(activityByMonth(ts)[0]).toMatchObject({ month: '2026-01', n: 4 })
  })
  it('labels fee burden as an estimate when any fee was estimated, and unavailable without trades', () => {
    expect(feeBurden([trade({ fees: 5 })])).toMatchObject({ value: 0.1, quality: 'reconstructed' })
    expect(feeBurden([trade({ fees: 5, feeKnown: false })]).reason).toBe('Includes estimated fees')
    expect(feeBurden([]).availability).toBe('unavailable')
  })
})

describe('concentration and settlement paths', () => {
  it('computes HHI, effective exposures and top shares, counting missing values instead of zeroing them', () => {
    const c = concentration([{ value: 60 }, { value: 20 }, { value: 20 }, { value: null }])!
    expect(c.hhi).toBeCloseTo(0.44)
    expect(c.effective).toBeCloseTo(1 / 0.44)
    expect(c.top.map((t) => t.weight)).toEqual([0.6, 1, 1])
    expect(c.missing).toBe(1)
    expect(concentration([])).toBeNull()
    expect(concentration([{ value: null }])).toBeNull()
  })
  it('splits the worst feasible portfolio outcome into contributions from that same path', () => {
    const F = createFinance(SAMPLE_PORTFOLIO)
    const range = settlementRange(Object.values(F.baseHoldings()), F.sourceRelations())!
    const parts = pathContributions(F.exposures('all'), range.argmin)
    expect(parts.reduce((a, p) => a + p.pnl, 0)).toBeCloseTo(range.min, 6)
    // Same path, not each event's own worst case.
    for (const p of parts) expect(p.outcome).toBe(range.argmin[p.e.event.id])
    const worst = pathSummary(Object.values(F.baseHoldings()), range.argmin), best = pathSummary(Object.values(F.baseHoldings()), range.argmax)
    expect(worst.pnl).toBeCloseTo(range.min, 6)
    expect(best.pnl).toBeCloseTo(range.max, 6)
    expect(worst.payout).toBeLessThanOrEqual(best.payout)
    expect(worst.unsupported).toBe(0)
    // A holding without a mark leaves the change from current value unavailable, never zero.
    expect(pathSummary([{ eventId: 'e', side: 'YES', shares: 10, cost: 4, mark: null }], { e: 'YES' })).toMatchObject({ payout: 10, pnl: 6, change: null })
    expect(pathSummary([{ eventId: 'x', side: 'YES', shares: 10, cost: 4, mark: 0.5 }], {}).unsupported).toBe(1)
  })
  it('buckets capital by scheduled resolution, with overdue and undated kept apart', () => {
    const F = createFinance(SAMPLE_PORTFOLIO)
    const exps = F.exposures('all')
    const b = resolutionBuckets(exps, F.TODAY)
    expect(b.reduce((a, x) => a + x.n, 0)).toBe(exps.length)
    expect(b.reduce((a, x) => a + x.cost, 0)).toBeCloseTo(exps.reduce((a, e) => a + e.cost, 0))
    const later = resolutionBuckets(exps, '2030-01-01')
    expect(later.find((x) => x.label === 'Overdue')!.n).toBe(exps.length)
  })
})

describe('sampled periods, drawdown basis and broken chains', () => {
  it('flags months whose first sampled interval started in the previous month, and keeps the year', () => {
    const p = performanceFromSeries([pt('2025-12-28', 1000, 1000), pt('2026-01-04', 1000, 1010), pt('2026-01-11', 1000, 1020), pt('2026-02-01', 1000, 1030)])
    expect(p.monthly.map((m) => [m.period, m.crossesBoundary, m.intervals])).toEqual([['2026-01', true, 2], ['2026-02', true, 1]])
    expect(p.monthly[0].period.startsWith('2026')).toBe(true)
  })
  it('derives peak, trough and recovery from the same index as the maximum drawdown', () => {
    const p = performanceFromSeries([pt('2026-01-04', 1000, 1000), pt('2026-01-11', 1000, 1200), pt('2026-01-18', 1000, 900), pt('2026-01-25', 1000, 1100), pt('2026-02-01', 1000, 1300)])
    const trough = p.index.find((x) => x.date === p.drawdownDetail!.troughDate)!
    expect(trough.drawdown).toBeCloseTo(p.maximumDrawdown.value!, 9)
    expect(p.drawdownDetail).toEqual({ peakDate: '2026-01-11', troughDate: '2026-01-18', recoveredOn: '2026-02-01' })
    // No fall below an earlier peak: a confirmed zero drawdown with no detail, not unavailable.
    const flat = performanceFromSeries([pt('2026-01-04', 1000, 1000), pt('2026-01-11', 1000, 1100)])
    expect(flat.maximumDrawdown).toMatchObject({ value: 0, availability: 'calculated' })
    expect(flat.drawdownDetail).toBeNull()
  })
  it('never presents a prefix as the whole period when the chain breaks part-way', () => {
    const p = performanceFromSeries([pt('2026-01-04', 1000, 1000), pt('2026-01-11', 1000, 800), pt('2026-01-18', 1000, 0), pt('2026-01-25', 1000, 500)])
    expect(p.index[1].drawdown).toBeCloseTo(-0.2)
    expect(p.maximumDrawdown).toMatchObject({ value: null, availability: 'unavailable' })
    expect(p.twr.value).toBeNull()
    expect(p.drawdownDetail).toBeNull()
    expect(p.index[3].index).toBeNull()
  })
})

describe('missing versus zero, partial coverage and identity', () => {
  it('keeps a confirmed zero known and a missing value out of subtotals and weights', () => {
    const c = concentration([{ value: 0 }, { value: null }, { value: 10 }, { value: Number.NaN }])!
    expect(c).toMatchObject({ known: 2, missing: 2, complete: false, denominator: 10, hhi: 1 })
    expect(Number.isFinite(c.effective)).toBe(true)
    expect(knownSubtotal([5, Number.NaN, null, 0])).toEqual({ value: 5, missing: 2, complete: false })
    expect(knownSubtotal([0, 0])).toEqual({ value: 0, missing: 0, complete: true })
  })
  it('marks settlement values partial when a holding has no supported rule', () => {
    const s = pathSummary([{ eventId: 'a', side: 'YES', shares: 10, cost: 5, mark: 0.5 }, { eventId: 'b', side: 'YES', shares: 4, cost: 2, mark: 0.5 }], { a: 'YES' })
    expect(s).toMatchObject({ payout: 10, pnl: 5, unsupported: 1, complete: false })
  })
  it('keeps markets with the same title distinct by platform or canonical id', () => {
    const ms = byMarket([trade({ market: 'Fed cut?', platform: 'pm' }), trade({ market: 'Fed cut?', platform: 'ks' }), trade({ market: 'Fed cut?', platform: 'pm', marketId: 'x1' }), trade({ market: 'Fed cut?', platform: 'pm', marketId: 'x1' })])
    expect(ms.length).toBe(3)
    expect(ms.find((m) => m.key === 'pm:x1')!.n).toBe(2)
  })
  it('never turns unknown dates into a zero-day holding period', () => {
    const t = trade({ opened: '', closed: '2026-01-10' })
    expect(holdingDays(t)).toBeNull()
    expect(holdingDays(trade({ opened: '2026-02-01', closed: '2026-01-10' }))).toBeNull()
    expect(cohorts([t], 'Holding period')[0].label).toBe('Unknown dates')
    expect(holdingDays(trade({ opened: '2026-01-10', closed: '2026-01-10' }))).toBe(0)
  })
})

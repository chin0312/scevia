import { describe, expect, it } from 'vitest'
import { CASH_FLOWS, CLOSED_TRADES, OPEN_POSITIONS, TODAY } from '../data/portfolio'
import { sampleFeeSchedule } from '../data/sampleFees'
import { DEFAULT_FEES } from './fees'
import {
  MAX_JOINT_EVENTS, POSITIONS, POS_BY_ID, account, allocation, derivePosition, eventExposureOf, opposite, outcomeLabel, attribution, baseHoldings, entryBuckets, eventPnl, eventRelations, groupPnl, insights, isFeasible, jointOutcomes,
  exposures, netPnlAt, outcomeRange, periodRange, periodStats, sourceRelations, withConstraints, scenarioMetrics, series, settlementRange, positionsFor, settlementRangeFor, simulate, tradesIn,
  type Outcome, type PlatformFilter,
} from './finance'

const close = (a: number | null | undefined, b: number | null | undefined, eps = 0.01) => { expect(a).toEqual(expect.any(Number)); expect(b).toEqual(expect.any(Number)); expect(Math.abs((a as number) - (b as number))).toBeLessThan(eps) }
// Ranges are nullable (too many events); the sample is small enough that they always exist.
const sr = (...a: Parameters<typeof settlementRange>) => settlementRange(...a)!
const or = (...a: Parameters<typeof outcomeRange>) => outcomeRange(...a)!
const F: PlatformFilter[] = ['all', 'pm', 'ks']
// Published formulas, written out independently of lib/fees.ts.
const kalshiFee = (q: number, p: number) => Math.ceil(0.07 * q * p * (1 - p) * 100 - 1e-9) / 100
const pmFee = (rate: number, q: number, p: number) => Math.round(rate * q * p * (1 - p) * 1e5) / 1e5
const FEES = { fees: DEFAULT_FEES }, NOFEES = { fees: { mode: 'excluded' as const } }
/** The old sample assumption (BTC × ETH mutually exclusive), now an explicit hypothetical constraint. */
const MUTEX = withConstraints(sourceRelations(), [{ a: 'btc', b: 'eth', cls: 'mutex' }])

describe('account identities', () => {
  it.each(F)('value − net deposits = net P&L (%s)', (f) => {
    const a = account(f)
    close(a.totalValue - a.netDeposits, a.netPnl)
    close(a.totalValue, a.cash + a.positionsValue)
    close(a.netPnl, a.realized + a.unrealized) // open-fill fees are inside cost basis, so inside unrealized
    close(a.fees, a.closedFees + a.openFees)
  })
  it('platform accounts add up to the total', () => {
    const [all, pm, ks] = F.map(account)
    for (const k of ['netDeposits', 'cash', 'positionsValue', 'totalValue', 'committed', 'unrealized', 'realized', 'fees', 'netPnl'] as const) close(all[k], pm[k] + ks[k])
    expect(all.wins).toBe(pm.wins + ks.wins)
    expect(all.resolved).toBe(pm.resolved + ks.resolved)
  })
  it('no platform has negative cash', () => {
    expect(account('pm').cash).toBeGreaterThan(0)
    expect(account('ks').cash).toBeGreaterThan(0)
  })
  it('realized P&L is net of each trade’s fees, counted once', () => {
    close(account('all').realized, CLOSED_TRADES.reduce((s, t) => s + t.shares * (t.exit - t.entry) - t.fees, 0))
  })
  it('positions derive average cost from fills', () => {
    for (const p of POSITIONS) {
      const raw = OPEN_POSITIONS.find((x) => x.id === p.id)!
      close(p.cost, raw.fills.reduce((s, f) => s + f.shares * f.price + f.fee, 0)) // weighted average incl. acquisition fees (backend convention)
      close(p.fees, raw.fills.reduce((s, f) => s + f.fee, 0))
      close(p.avg * p.shares, p.cost)
      close(p.ifWin, p.shares - p.cost)
      close(p.ifLose, -p.cost)
    }
  })
})

describe('history', () => {
  it.each(F)('series ends exactly at today’s account (%s)', (f) => {
    const pts = series(f), a = account(f)
    expect(pts.at(-1)!.date).toBe(TODAY)
    close(pts.at(-1)!.netPnl, a.netPnl)
    close(pts.at(-1)!.value, a.totalValue)
  })
  it('platform histories are real per-platform series that sum to the total (not scaled copies)', () => {
    const all = series('all'), pm = series('pm'), ks = series('ks')
    all.forEach((p, i) => close(p.value, pm[i].value + ks[i].value))
    const ratio = pm.map((p, i) => p.value / all[i].value)
    expect(Math.max(...ratio) - Math.min(...ratio)).toBeGreaterThan(0.05)
  })
  it('deposits and withdrawals never move net P&L', () => {
    for (const c of CASH_FLOWS) {
      const before = new Date(Date.parse(`${c.date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
      const jump = netPnlAt(c.platform, c.date) - netPnlAt(c.platform, before)
      expect(Math.abs(jump)).toBeLessThan(Math.abs(c.amount))
    }
  })
})

describe('periods and analytics', () => {
  it('period ranges and prior availability', () => {
    expect(periodRange('6M').prior).not.toBeNull()
    expect(periodRange('All').prior).toBeNull()
    expect(periodRange('YTD').prior).toBeNull() // sample history starts after Jan 1 2025
  })
  it('consecutive periods partition trades (no double counting)', () => {
    const r = periodRange('6M'), p = r.prior!
    const both = tradesIn('all', p.start, r.end).length
    expect(tradesIn('all', p.start, p.end).length + tradesIn('all', r.start, r.end).length).toBe(both)
  })
  it.each(['1M', '3M', '6M', 'YTD', 'All'] as const)('period %s: attribution and buckets reconcile', (period) => {
    for (const f of F) {
      const s = periodStats(f, periodRange(period))
      close(attribution(s.trades, 'category').reduce((a, x) => a + x.net, 0), s.realized)
      close(attribution(s.trades, 'platform').reduce((a, x) => a + x.net, 0), s.realized)
      expect(entryBuckets(s.trades).reduce((a, b) => a + b.n, 0)).toBe(s.resolved)
      expect(s.wins + s.losses).toBe(s.resolved)
      close(s.months.reduce((a, m) => a + m.realized, 0), s.realized)
    }
  })
  it.each(['1M', '3M', '6M', 'YTD', 'All'] as const)('period %s: realized + change in unrealized (after new-fill fees) = net', (period) => {
    for (const f of F) {
      const s = periodStats(f, periodRange(period))
      close(s.realized + s.unrealizedChange, s.netPnl)
      close(s.fees, s.trades.reduce((a, t) => a + t.fees, 0) + s.openFillFees)
    }
  })
  it('a trade carried into the period counts fully in realized; its earlier P&L is offset in unrealized change', () => {
    const r = periodRange('3M')
    const carried = CLOSED_TRADES.find((t) => t.opened <= r.start && t.closed > r.start && t.closed <= r.end)!
    expect(carried).toBeTruthy()
    expect(tradesIn(carried.platform, r.start, r.end).map((t) => t.id)).toContain(carried.id)
    const s = periodStats('all', r)
    close(s.realized + s.unrealizedChange, netPnlAt('all', r.end) - netPnlAt('all', r.start))
  })
  it('All-period net P&L equals the account’s net P&L', () => {
    close(periodStats('all', periodRange('All')).netPnl, account('all').netPnl - netPnlAt('all', periodRange('All').start))
  })
  it('the strongest-category insight matches attribution', () => {
    const s = periodStats('all', periodRange('6M')), ins = insights(s.trades)
    const row = attribution(s.trades, 'category').find((a) => a.key === ins.strongest?.c)
    expect(ins.strongest).not.toBeNull()
    close(ins.strongest!.net, row!.net)
  })
  it('insights return null instead of guessing on small samples', () => {
    const ins = insights(tradesIn('all', '2026-11-10', TODAY))
    expect(ins.longshots).toBeNull()
    expect(ins.earlyExits).toBeNull()
  })
})

describe('relationships and feasible outcomes', () => {
  it('mutually exclusive outcomes forbid both YES; equivalent ones must match', () => {
    expect(isFeasible({ a: 'YES', b: 'YES' }, [{ a: 'a', b: 'b', cls: 'mutex', provenance: 'verified' as const }])).toBe(false)
    expect(isFeasible({ a: 'YES', b: 'NO' }, [{ a: 'a', b: 'b', cls: 'mutex', provenance: 'verified' as const }])).toBe(true)
    expect(isFeasible({ a: 'NO', b: 'NO' }, [{ a: 'a', b: 'b', cls: 'mutex', provenance: 'verified' as const }])).toBe(true)
    expect(isFeasible({ a: 'YES', b: 'NO' }, [{ a: 'a', b: 'b', cls: 'equivalent', provenance: 'verified' as const }])).toBe(false)
    for (const cls of ['related', 'unknown'] as const) expect(isFeasible({ a: 'YES', b: 'YES' }, [{ a: 'a', b: 'b', cls, provenance: 'verified' }])).toBe(true)
  })
  it('excludes impossible combinations instead of adjusting afterwards', () => {
    const ids = ['x', 'y', 'z']
    const r = or(ids, [{ a: 'x', b: 'y', cls: 'mutex', provenance: 'verified' as const }], (o) => (o.x === 'YES' ? 10 : 0) + (o.y === 'YES' ? 7 : 0) + (o.z === 'YES' ? 1 : 0))
    expect(r.excluded).toBe(2)
    expect(r.max).toBe(11) // x YES, y NO, z YES — not 18
    expect(r.min).toBe(0)
  })
  it('portfolio best case under mutex equals a brute-force search of feasible outcomes', () => {
    const hs = Object.values(baseHoldings()), rels = MUTEX
    const ids = [...new Set(hs.map((h) => h.eventId))]
    let brute = -Infinity
    for (const o of jointOutcomes(ids)) if (isFeasible(o, rels)) brute = Math.max(brute, ids.reduce((s, id) => s + eventPnl(hs, id, o[id]), 0))
    const r = sr(hs, rels)
    close(r.max, brute)
    expect(r.max).toBeLessThan(sr(hs, sourceRelations()).max)
    close(r.min, -account('all').committed) // everything against you is still possible
  })
  it('related and unknown relationships don’t constrain outcomes', () => {
    const hs = Object.values(baseHoldings())
    const a = sr(hs, sourceRelations()), b = sr(hs, sourceRelations())
    close(a.max, b.max); close(a.min, b.min); expect(a.excluded).toBe(0)
  })
})

describe('risk scope', () => {
  const rels = MUTEX
  const all = Object.values(baseHoldings())
  it('portfolio range is the same as the range over every event', () => {
    const r = sr(all, rels), f = settlementRangeFor(exposures().map((e) => e.event.id), rels)!
    close(f.min, r.min); close(f.max, r.max); expect(f.excluded).toBe(r.excluded)
  })
  it('a subset range is local and leaves the portfolio range untouched', () => {
    const before = sr(all, rels)
    const hot = exposures().find((e) => e.event.id === 'hot')!
    const sub = settlementRangeFor(['hot'], rels)!
    close(sub.min, hot.pnl.NO); close(sub.max, hot.pnl.YES)
    const after = sr(all, rels)
    close(after.min, before.min); close(after.max, before.max)
    expect(sub.min).toBeGreaterThan(before.min)
  })
  it('an empty subset has no range (null), not a zero-risk range', () => {
    expect(settlementRangeFor([], rels)).toBeNull()
  })
  it('relationships still apply inside a subset', () => {
    expect(settlementRangeFor(['btc', 'eth'], rels)!.excluded).toBe(1)
    expect(settlementRangeFor(['btc', 'hot'], rels)!.excluded).toBe(0)
  })
})

describe('scenario simulation', () => {
  const rels = sourceRelations()
  const base = scenarioMetrics(simulate([], FEES), rels)
  it('the unchanged scenario matches the account', () => {
    const a = account('all')
    close(base.cash, a.cash); close(base.totalValue, a.totalValue); close(base.committed, a.committed)
    expect(base.realized).toBe(0)
  })
  it('a purchase never creates profit: cash moves into contracts, value changes only by spread and fees', () => {
    const p = POS_BY_ID.fedk, d = 1000, px = 0.66
    const sim = simulate([{ id: 'fedk', to: p.shares + d, price: px }], FEES)
    const m = scenarioMetrics(sim, rels), fee = kalshiFee(d, px)
    expect(sim.realized).toBe(0)
    close(m.cash, base.cash - d * px - fee)
    close(m.committed, base.committed + d * px + fee) // the buy fee enters cost basis
    close(m.totalValue! - base.totalValue!, d * (p.mark - px) - fee)
    close(m.bestValue! - base.bestValue!, d * (1 - px) - fee) // only settlement can pay out
  })
  it('buying at the mark with fees off leaves portfolio value unchanged', () => {
    const p = POS_BY_ID.cel
    const m = scenarioMetrics(simulate([{ id: 'cel', to: p.shares + 500, price: p.mark }], NOFEES), rels)
    close(m.totalValue, base.totalValue)
  })
  it('a partial sale realizes P&L against average cost, after fees', () => {
    const p = POS_BY_ID.btc, q = 3000, px = 0.3
    const sim = simulate([{ id: 'btc', to: p.shares - q, price: px }], FEES)
    const fee = pmFee(0.01, q, px) // Polymarket Crypto rate
    close(sim.realized, q * (px - p.avg) - fee)
    close(sim.holdings.btc.cost, p.cost * (1 - q / p.shares))
    close(sim.cash.pm, account('pm').cash + q * px - fee)
  })
  it('a full exit leaves no shares or cost basis', () => {
    const p = POS_BY_ID.hot
    const sim = simulate([{ id: 'hot', to: 0, price: 0.9 }], FEES)
    expect(sim.holdings.hot.shares).toBe(0)
    expect(sim.holdings.hot.cost).toBe(0)
    close(sim.realized, p.shares * (0.9 - p.avg) - kalshiFee(p.shares, 0.9))
  })
  it('fees can be excluded', () => {
    expect(simulate([{ id: 'hot', to: 0, price: 0.9 }], NOFEES).fees).toBe(0)
  })
  it('a funding shortfall is reported, not treated as invalid input, and the trade stays in the results', () => {
    const eth = POS_BY_ID.eth, add = 200000 - eth.shares, px = 0.5
    const sim = simulate([{ id: 'eth', to: 200000, price: px }], FEES)
    const m = scenarioMetrics(sim, rels)
    expect(sim.errors).toEqual({})
    expect(m.valid).toBe(true)
    expect(sim.holdings.eth.shares).toBe(200000)
    const needed = add * px + kalshiFee(add, px) - account('ks').cash
    close(sim.shortfall.ks, needed)
    expect(sim.shortfall.pm).toBe(0)
    close(m.shortfall, needed)
    close(m.cash, account('all').cash - add * px - kalshiFee(add, px)) // cash goes negative by the shortfall
  })
  it('within available cash there is no shortfall', () => {
    const sim = simulate([{ id: 'fedk', to: POS_BY_ID.fedk.shares + 100, price: 0.65 }], FEES)
    expect(sim.shortfall).toEqual({ pm: 0, ks: 0 })
  })
  it('an invalid price is excluded and never creates a shortfall', () => {
    const sim = simulate([{ id: 'eth', to: 200000, price: 7 }], FEES)
    expect(sim.errors.eth).toBeTruthy()
    expect(sim.shortfall.ks).toBe(0)
    expect(sim.holdings.eth.shares).toBe(POS_BY_ID.eth.shares)
  })
  it.each([0, 1, 1.5, -0.2, Number.NaN])('rejects invalid price %s and ignores that adjustment', (px) => {
    const sim = simulate([{ id: 'cpi', to: 0, price: px }], FEES)
    expect(sim.errors.cpi).toBeTruthy()
    expect(sim.holdings.cpi.shares).toBe(POS_BY_ID.cpi.shares)
    expect(sim.realized).toBe(0)
  })
  it('a no-op adjustment changes nothing', () => {
    const m = scenarioMetrics(simulate([{ id: 'rec', to: POS_BY_ID.rec.shares, price: 0.5 }], FEES), rels)
    close(m.totalValue, base.totalValue); close(m.worstValue, base.worstValue); close(m.bestValue, base.bestValue)
  })
  it('worst/best values use the same feasible outcomes as Risk', () => {
    const mutex = MUTEX
    const m = scenarioMetrics(simulate([], FEES), mutex)
    const r = sr(Object.values(baseHoldings()), mutex)
    const a = account('all')
    close(m.bestValue, a.cash + a.committed + r.max)
    close(m.worstValue, a.cash + a.committed + r.min)
  })
  it('group P&L with no trades equals event P&L', () => {
    const sim = simulate([], FEES), hs = Object.values(sim.holdings)
    for (const o of ['YES', 'NO'] as Outcome[]) close(groupPnl(sim, ['fed'], { fed: o }), eventPnl(hs, 'fed', o))
  })
  it('group P&L of a sold-out position is its realized P&L', () => {
    const sim = simulate([{ id: 'chf', to: 0, price: 0.12 }], FEES)
    close(groupPnl(sim, ['chf'], { chf: 'YES' }), sim.realized)
    close(groupPnl(sim, ['chf'], { chf: 'NO' }), sim.realized)
    close(sim.realized, tradeNetLike(POS_BY_ID.chf.shares, 0.12, POS_BY_ID.chf.avg) - pmFee(0.05, POS_BY_ID.chf.shares, 0.12)) // Polymarket Sports rate
  })
})
const tradeNetLike = (q: number, px: number, avg: number) => q * (px - avg)


describe('allocation drill-down', () => {
  for (const f of F) for (const by of ['category', 'platform'] as const) {
    it(`${f} by ${by}: shares sum to 1 and segments partition the open positions`, () => {
      const { total, segments } = allocation(f, by)
      const pos = positionsFor(f)
      close(total, pos.reduce((a, p) => a + p.value, 0))
      close(segments.reduce((a, s) => a + s.share, 0), 1, 1e-9)
      const ids = segments.flatMap((s) => s.positions.map((x) => x.p.id))
      expect(ids.sort()).toEqual(pos.map((p) => p.id).sort())
      for (const s of segments) {
        close(s.positions.reduce((a, x) => a + x.shareOfSegment, 0), 1, 1e-9)
        close(s.positions.reduce((a, x) => a + x.shareOfOpen, 0), s.share, 1e-9)
        for (const x of s.positions) expect(by === 'category' ? x.p.category : x.p.platform).toBe(s.key)
      }
      expect(segments.map((s) => s.value)).toEqual([...segments.map((s) => s.value)].sort((a, b) => b - a))
    })
  }
  it('excludes cash: the basis is open-position market value only', () => {
    const { total } = allocation('all', 'category')
    close(total, account('all').positionsValue)
  })
  it('platform scope only contains that platform', () => {
    expect(allocation('ks', 'platform').segments.map((s) => s.key)).toEqual(['ks'])
  })
})

describe('event details', () => {
  it('an event exposure includes every contract across platforms', () => {
    const fed = exposures('all').find((e) => e.event.id === 'fed')!
    expect(fed.positions.map((p) => p.id).sort()).toEqual(['fedk', 'fedp'])
    expect(fed.platforms.sort()).toEqual(['ks', 'pm'])
  })
  it('eventRelations reports class and provenance', () => {
    expect(eventRelations('btc', MUTEX).map((r) => [r.other.id, r.cls, r.provenance])).toContainEqual(['eth', 'mutex', 'hypothetical'])
    expect(eventRelations('btc', sourceRelations())).toEqual([]) // nothing recorded: no constraint, not "independent"
    expect(eventRelations('fed', sourceRelations()).every((r) => r.cls === 'related' && r.provenance === 'annotation')).toBe(true)
  })
})

describe('event exposure with each holding’s own side', () => {
  const ev = { id: 'x', name: 'Binary event', short: 'X', category: 'Economics' as const }
  const pos = (id: string, side: 'YES' | 'NO', shares: number, price: number, platform: 'pm' | 'ks' = 'pm') =>
    derivePosition({ id, market: id, marketId: id, accountId: `${platform}-main`, feeSchedule: sampleFeeSchedule(platform, 'Economics'), eventId: 'x', category: 'Economics', platform, side, mark: price, markAtLastVisit: price, resolves: '2026-12-31', fills: [{ date: '2026-11-01', shares, price, fee: 0 }] })
  const holdings = (ps: ReturnType<typeof pos>[]) => ps.map((p) => ({ id: p.id, eventId: p.eventId, platform: p.platform, side: p.side, shares: p.shares, cost: p.cost, mark: p.mark as number | null, category: p.category, title: p.market, eventTitle: 'Binary event', marketId: p.marketId, resolves: p.resolves, accountId: p.accountId as string | null }))

  it('opposing YES and NO holdings offset at settlement; committed capital stays gross', () => {
    const e = eventExposureOf(ev, [pos('y', 'YES', 100, 0.6), pos('n', 'NO', 60, 0.4, 'ks')], 84)
    close(e.cost, 84)
    close(e.pnl.YES, 16)  // $100 payout − $84
    close(e.pnl.NO, -24)  // $60 payout − $84
    expect(e.side).toBe('Mixed')
    expect(e.best.outcome).toBe('YES'); expect(e.worst.outcome).toBe('NO')
    close(e.maxLoss, 24)
    expect(outcomeLabel(e, 'YES')).toBe('If YES') // no misleading "for you" when both sides are held
  })
  it('a balanced position has no settlement gain or loss', () => {
    const e = eventExposureOf(ev, [pos('y', 'YES', 100, 0.5), pos('n', 'NO', 100, 0.5)], 100)
    close(e.pnl.YES, 0); close(e.pnl.NO, 0); close(e.maxLoss, 0)
  })
  it('single-sided exposure is unchanged: held side pays shares − cost, the other loses the cost', () => {
    for (const e of exposures('all')) {
      if (e.side === 'Mixed') continue
      const shares = e.positions.reduce((a, p) => a + p.shares, 0)
      close(e.pnl[e.side], shares - e.cost); close(e.pnl[opposite(e.side)], -e.cost)
      expect(e.best.outcome).toBe(e.side); close(e.maxLoss, e.cost)
      expect(outcomeLabel(e, e.side)).toContain('for you')
    }
  })
  it('event exposure matches the settlement engine used for portfolio ranges', () => {
    const hs = Object.values(baseHoldings())
    for (const e of exposures('all')) for (const o of ['YES', 'NO'] as const) close(e.pnl[o], eventPnl(hs, e.event.id, o))
    const ps = [pos('y', 'YES', 100, 0.6), pos('n', 'NO', 60, 0.4)], e = eventExposureOf(ev, ps, 84)
    for (const o of ['YES', 'NO'] as const) close(e.pnl[o], eventPnl(holdings(ps), 'x', o))
    const r = sr(holdings(ps), [])
    close(r.min, -24); close(r.max, 16)
  })
  it('largest single-event loss nets opposing holdings', () => {
    const ps = [pos('y', 'YES', 100, 0.6), pos('n', 'NO', 60, 0.4)]
    const sim = { holdings: Object.fromEntries(holdings(ps).map((h) => [h.id, h])), cash: { pm: 0, ks: 0 }, realized: 0, fees: 0, errors: {}, shortfall: { pm: 0, ks: 0 }, realizedBy: {}, feesBy: {}, feeStatusBy: {}, feesUnavailable: [], targets: {}, trades: {}, startValue: null }
    close(scenarioMetrics(sim, []).largestEventLoss, 24)
  })
})

describe('joint-outcome enumeration bounds', () => {
  it('reports ranges as unavailable beyond the exact-enumeration cap instead of approximating', () => {
    const ids = Array.from({ length: MAX_JOINT_EVENTS + 1 }, (_, i) => `e${i}`)
    expect(outcomeRange(ids, [], () => 0)).toBeNull()
    expect(() => jointOutcomes(ids).next()).toThrow(RangeError)
    expect(outcomeRange(ids.slice(0, 3), [], () => 1)?.feasible).toBe(8)
  })
})

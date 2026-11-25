import { describe, expect, it } from 'vitest'
import { CASH_FLOWS, CLOSED_TRADES, FEE_RATE, OPEN_POSITIONS, TODAY } from '../data/portfolio'
import {
  POSITIONS, POS_BY_ID, account, allocation, attribution, baseHoldings, entryBuckets, eventPnl, eventRelations, groupPnl, insights, isFeasible, jointOutcomes,
  exposures, netPnlAt, outcomeRange, periodRange, periodStats, relationsFor, scenarioMetrics, series, settlementRange, positionsFor, settlementRangeFor, simulate, tradesIn,
  type Outcome, type PlatformFilter,
} from './finance'

const close = (a: number, b: number, eps = 0.01) => expect(Math.abs(a - b)).toBeLessThan(eps)
const F: PlatformFilter[] = ['all', 'pm', 'ks']

describe('account identities', () => {
  it.each(F)('value − net deposits = net P&L (%s)', (f) => {
    const a = account(f)
    close(a.totalValue - a.netDeposits, a.netPnl)
    close(a.totalValue, a.cash + a.positionsValue)
    close(a.netPnl, a.realized + a.unrealized - a.openFees)
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
      close(p.cost, raw.fills.reduce((s, f) => s + f.shares * f.price, 0))
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
  it.each(['1M', '3M', '6M', 'YTD', 'All'] as const)('period %s: realized + change in unrealized − new-fill fees = net', (period) => {
    for (const f of F) {
      const s = periodStats(f, periodRange(period))
      close(s.realized + s.unrealizedChange - s.openFillFees, s.netPnl)
      close(s.fees, s.trades.reduce((a, t) => a + t.fees, 0) + s.openFillFees)
    }
  })
  it('a trade carried into the period counts fully in realized; its earlier P&L is offset in unrealized change', () => {
    const r = periodRange('3M')
    const carried = CLOSED_TRADES.find((t) => t.opened <= r.start && t.closed > r.start && t.closed <= r.end)!
    expect(carried).toBeTruthy()
    expect(tradesIn(carried.platform, r.start, r.end).map((t) => t.id)).toContain(carried.id)
    const s = periodStats('all', r)
    close(s.realized + s.unrealizedChange - s.openFillFees, netPnlAt('all', r.end) - netPnlAt('all', r.start))
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
    expect(isFeasible({ a: 'YES', b: 'YES' }, [{ a: 'a', b: 'b', cls: 'mutex' }])).toBe(false)
    expect(isFeasible({ a: 'YES', b: 'NO' }, [{ a: 'a', b: 'b', cls: 'mutex' }])).toBe(true)
    expect(isFeasible({ a: 'NO', b: 'NO' }, [{ a: 'a', b: 'b', cls: 'mutex' }])).toBe(true)
    expect(isFeasible({ a: 'YES', b: 'NO' }, [{ a: 'a', b: 'b', cls: 'equivalent' }])).toBe(false)
    for (const cls of ['related', 'unknown'] as const) expect(isFeasible({ a: 'YES', b: 'YES' }, [{ a: 'a', b: 'b', cls }])).toBe(true)
  })
  it('excludes impossible combinations instead of adjusting afterwards', () => {
    const ids = ['x', 'y', 'z']
    const r = outcomeRange(ids, [{ a: 'x', b: 'y', cls: 'mutex' }], (o) => (o.x === 'YES' ? 10 : 0) + (o.y === 'YES' ? 7 : 0) + (o.z === 'YES' ? 1 : 0))
    expect(r.excluded).toBe(2)
    expect(r.max).toBe(11) // x YES, y NO, z YES — not 18
    expect(r.min).toBe(0)
  })
  it('portfolio best case under mutex equals a brute-force search of feasible outcomes', () => {
    const hs = Object.values(baseHoldings()), rels = relationsFor('mutex')
    const ids = [...new Set(hs.map((h) => h.eventId))]
    let brute = -Infinity
    for (const o of jointOutcomes(ids)) if (isFeasible(o, rels)) brute = Math.max(brute, ids.reduce((s, id) => s + eventPnl(hs, id, o[id]), 0))
    const r = settlementRange(hs, rels)
    close(r.max, brute)
    expect(r.max).toBeLessThan(settlementRange(hs, relationsFor('unknown')).max)
    close(r.min, -account('all').committed) // everything against you is still possible
  })
  it('related and unknown relationships don’t constrain outcomes', () => {
    const hs = Object.values(baseHoldings())
    const a = settlementRange(hs, relationsFor('unknown')), b = settlementRange(hs, relationsFor('related'))
    close(a.max, b.max); close(a.min, b.min); expect(a.excluded).toBe(0)
  })
})

describe('risk scope', () => {
  const rels = relationsFor('mutex')
  const all = Object.values(baseHoldings())
  it('portfolio range is the same as the range over every event', () => {
    const r = settlementRange(all, rels), f = settlementRangeFor(exposures().map((e) => e.event.id), rels)!
    close(f.min, r.min); close(f.max, r.max); expect(f.excluded).toBe(r.excluded)
  })
  it('a subset range is local and leaves the portfolio range untouched', () => {
    const before = settlementRange(all, rels)
    const hot = exposures().find((e) => e.event.id === 'hot')!
    const sub = settlementRangeFor(['hot'], rels)!
    close(sub.min, hot.pnlAgainst); close(sub.max, hot.pnlFor)
    const after = settlementRange(all, rels)
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
  const rels = relationsFor('unknown')
  const base = scenarioMetrics(simulate([], { includeFees: true }), rels)
  it('the unchanged scenario matches the account', () => {
    const a = account('all')
    close(base.cash, a.cash); close(base.totalValue, a.totalValue); close(base.committed, a.committed)
    expect(base.realized).toBe(0)
  })
  it('a purchase never creates profit: cash moves into contracts, value changes only by spread and fees', () => {
    const p = POS_BY_ID.fedk, d = 1000, px = 0.66
    const sim = simulate([{ id: 'fedk', to: p.shares + d, price: px }], { includeFees: true })
    const m = scenarioMetrics(sim, rels), fee = d * px * FEE_RATE.ks
    expect(sim.realized).toBe(0)
    close(m.cash, base.cash - d * px - fee)
    close(m.committed, base.committed + d * px)
    close(m.totalValue - base.totalValue, d * (p.mark - px) - fee)
    close(m.bestValue - base.bestValue, d * (1 - px) - fee) // only settlement can pay out
  })
  it('buying at the mark with fees off leaves portfolio value unchanged', () => {
    const p = POS_BY_ID.cel
    const m = scenarioMetrics(simulate([{ id: 'cel', to: p.shares + 500, price: p.mark }], { includeFees: false }), rels)
    close(m.totalValue, base.totalValue)
  })
  it('a partial sale realizes P&L against average cost, after fees', () => {
    const p = POS_BY_ID.btc, q = 3000, px = 0.3
    const sim = simulate([{ id: 'btc', to: p.shares - q, price: px }], { includeFees: true })
    const fee = q * px * FEE_RATE.pm
    close(sim.realized, q * (px - p.avg) - fee)
    close(sim.holdings.btc.cost, p.cost * (1 - q / p.shares))
    close(sim.cash.pm, account('pm').cash + q * px - fee)
  })
  it('a full exit leaves no shares or cost basis', () => {
    const p = POS_BY_ID.hot
    const sim = simulate([{ id: 'hot', to: 0, price: 0.9 }], { includeFees: true })
    expect(sim.holdings.hot.shares).toBe(0)
    expect(sim.holdings.hot.cost).toBe(0)
    close(sim.realized, p.shares * (0.9 - p.avg) - p.shares * 0.9 * FEE_RATE.ks)
  })
  it('fees can be excluded', () => {
    expect(simulate([{ id: 'hot', to: 0, price: 0.9 }], { includeFees: false }).fees).toBe(0)
  })
  it('a funding shortfall is reported, not treated as invalid input, and the trade stays in the results', () => {
    const eth = POS_BY_ID.eth, add = 200000 - eth.shares, px = 0.5
    const sim = simulate([{ id: 'eth', to: 200000, price: px }], { includeFees: true })
    const m = scenarioMetrics(sim, rels)
    expect(sim.errors).toEqual({})
    expect(m.valid).toBe(true)
    expect(sim.holdings.eth.shares).toBe(200000)
    const needed = add * px * (1 + FEE_RATE.ks) - account('ks').cash
    close(sim.shortfall.ks, needed)
    expect(sim.shortfall.pm).toBe(0)
    close(m.shortfall, needed)
    close(m.cash, account('all').cash - add * px * (1 + FEE_RATE.ks)) // cash goes negative by the shortfall
  })
  it('within available cash there is no shortfall', () => {
    const sim = simulate([{ id: 'fedk', to: POS_BY_ID.fedk.shares + 100, price: 0.65 }], { includeFees: true })
    expect(sim.shortfall).toEqual({ pm: 0, ks: 0 })
  })
  it('an invalid price is excluded and never creates a shortfall', () => {
    const sim = simulate([{ id: 'eth', to: 200000, price: 7 }], { includeFees: true })
    expect(sim.errors.eth).toBeTruthy()
    expect(sim.shortfall.ks).toBe(0)
    expect(sim.holdings.eth.shares).toBe(POS_BY_ID.eth.shares)
  })
  it.each([0, 1, 1.5, -0.2, Number.NaN])('rejects invalid price %s and ignores that adjustment', (px) => {
    const sim = simulate([{ id: 'cpi', to: 0, price: px }], { includeFees: true })
    expect(sim.errors.cpi).toBeTruthy()
    expect(sim.holdings.cpi.shares).toBe(POS_BY_ID.cpi.shares)
    expect(sim.realized).toBe(0)
  })
  it('a no-op adjustment changes nothing', () => {
    const m = scenarioMetrics(simulate([{ id: 'rec', to: POS_BY_ID.rec.shares, price: 0.5 }], { includeFees: true }), rels)
    close(m.totalValue, base.totalValue); close(m.worstValue, base.worstValue); close(m.bestValue, base.bestValue)
  })
  it('worst/best values use the same feasible outcomes as Risk', () => {
    const mutex = relationsFor('mutex')
    const m = scenarioMetrics(simulate([], { includeFees: true }), mutex)
    const r = settlementRange(Object.values(baseHoldings()), mutex)
    const a = account('all')
    close(m.bestValue, a.cash + a.committed + r.max)
    close(m.worstValue, a.cash + a.committed + r.min)
  })
  it('group P&L with no trades equals event P&L', () => {
    const sim = simulate([], { includeFees: true }), hs = Object.values(sim.holdings)
    for (const o of ['YES', 'NO'] as Outcome[]) close(groupPnl(sim, ['fed'], { fed: o }), eventPnl(hs, 'fed', o))
  })
  it('group P&L of a sold-out position is its realized P&L', () => {
    const sim = simulate([{ id: 'chf', to: 0, price: 0.12 }], { includeFees: true })
    close(groupPnl(sim, ['chf'], { chf: 'YES' }), sim.realized)
    close(groupPnl(sim, ['chf'], { chf: 'NO' }), sim.realized)
    close(sim.realized, tradeNetLike(POS_BY_ID.chf.shares, 0.12, POS_BY_ID.chf.avg))
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
  it('eventRelations follows the shared classification', () => {
    expect(eventRelations('btc', relationsFor('mutex')).map((r) => [r.other.id, r.cls])).toContainEqual(['eth', 'mutex'])
    expect(eventRelations('btc', relationsFor('related')).map((r) => r.cls)).toContain('related')
  })
})

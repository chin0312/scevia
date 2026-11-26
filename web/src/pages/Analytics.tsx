import { useMemo, useRef, useState } from 'react'
import { PeriodControl, type PeriodValue } from '../components/PeriodControl'
import { useSettings } from '../lib/settings'
import { useWidth } from '../components/charts'
import { useDetails } from '../components/details'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, Delta, Legend, PageHead, Pills, Seg, Tabs, cx } from '../components/ui'
import { PLATFORM_NAME } from '../data/labels'
import type { Platform } from '../data/types'
import { attribution, entryBuckets, fmtDate, insights, tradeNet, type PeriodStats, type PlatformFilter } from '../lib/finance'
import { fmt, kfmt, pct, sfmt } from '../lib/format'
import type { ClosedTrade } from '../data/types'
import { useFinance } from '../lib/financeContext'
import { ReportingNote, WorkspaceLabel } from '../components/Workspace'

const RAIL: RailSection[] = [
  { id: 'summary', label: 'Summary', icon: 'home', children: [{ id: 'highlights', label: 'Highlights' }] },
  { id: 'performance', label: 'Performance', icon: 'trend', children: [{ id: 'pnl', label: 'P&L over time' }, { id: 'attribution', label: 'Attribution' }] },
  { id: 'patterns', label: 'Patterns', icon: 'spark' },
  { id: 'detail', label: 'Entry price & metrics', icon: 'table', children: [{ id: 'entry', label: 'Entry price' }, { id: 'metrics', label: 'Metrics table' }] },
]
const PLATFORM_FILTER = ['All', 'Polymarket', 'Kalshi'] as const
type PlatformLabel = (typeof PLATFORM_FILTER)[number]
const toFilter = (l: PlatformLabel): PlatformFilter => (l === 'Polymarket' ? 'pm' : l === 'Kalshi' ? 'ks' : 'all')
const monthLabel = (m: string) => fmtDate(`${m}-01`, { month: 'short' })

function PnlChart({ f, start, end, prior, stats, tab, onMonth }: { f: PlatformFilter; start: string; end: string; prior: { start: string; end: string } | null; stats: PeriodStats; tab: 'Net' | 'Realized' | 'By platform'; onMonth: (m: string) => void }) {
  const { series } = useFinance()
  const [wrap, W] = useWidth<HTMLDivElement>(760)
  const H = 400, P = { l: 52, r: 12, t: 16, b: 26 }
  const base = (pts: { netPnl: number }[]) => pts.map((p) => p.netPnl - pts[0].netPnl)
  const cur = useMemo(() => base(series(f, start, end)), [f, start, end])
  const pri = useMemo(() => (prior ? base(series(f, prior.start, prior.end)) : null), [f, prior])
  const byPlat = useMemo(() => (['pm', 'ks'] as Platform[]).map((p) => base(series(p, start, end))), [start, end])
  const realizedCum = stats.months.reduce<number[]>((a, m) => [...a, (a.at(-1) ?? 0) + m.realized], [])
  const lines = tab === 'Net' ? [cur, ...(pri ? [pri] : [])] : tab === 'By platform' ? byPlat : [realizedCum]
  const all = [0, ...lines.flat(), ...(tab === 'By platform' ? [] : stats.months.map((m) => m.realized))]
  const step = Math.max(500, Math.ceil((Math.max(...all) - Math.min(...all)) / 5 / 500) * 500)
  const min = Math.floor(Math.min(...all) / step) * step, max = Math.ceil(Math.max(...all) / step) * step
  const y = (v: number) => P.t + (1 - (v - min) / (max - min || 1)) * (H - P.t - P.b)
  const xOf = (i: number, n: number) => P.l + (i / Math.max(1, n - 1)) * (W - P.l - P.r)
  const months = stats.months, bw = (W - P.l - P.r) / Math.max(1, months.length)
  const path = (d: number[]) => d.map((v, i) => `${i ? 'L' : 'M'}${xOf(i, d.length).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const ticks: number[] = []
  for (let t = min; t <= max; t += step) ticks.push(t)
  const end1 = cur.at(-1) ?? 0
  return (
    <div className="chart" ref={wrap}>
      <svg ref={ref} role="group" aria-label={`Cumulative ${tab === 'Realized' ? 'realized' : 'net'} P&L ${fmtDate(start)} to ${fmtDate(end)}: ${sfmt(tab === 'Realized' ? realizedCum.at(-1) ?? 0 : end1)}`} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ overflow: 'visible' }} onPointerLeave={() => setHover(null)}>
        <g className="axis">
          {ticks.map((t) => <g key={t}><line className={t ? 'grid-l' : 'zero'} x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} strokeDasharray={t ? '2 4' : undefined} /><text x={P.l - 10} y={y(t) + 4} textAnchor="end">{t ? kfmt(t) : '$0'}</text></g>)}
          {months.map((m, i) => (bw >= 34 || i % Math.ceil(34 / bw) === 0) && <text key={m.month} x={P.l + i * bw + bw / 2} y={H - 6} textAnchor="middle">{monthLabel(m.month)}</text>)}
        </g>
        {tab !== 'By platform' && months.map((m, i) => {
          const bx = P.l + i * bw + bw * 0.25, w = bw * 0.5, col = m.realized >= 0 ? 'var(--color-gain-fg)' : 'var(--color-loss-fg)'
          return (
            <g key={m.month} className="hoverable step" onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} role="button" tabIndex={0}
              aria-label={`${fmtDate(`${m.month}-01`, { month: 'long', year: 'numeric' })}: ${sfmt(m.realized)} realized. View trades closed that month`}
              onClick={() => onMonth(m.month)} onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onMonth(m.month))}>
              <rect x={P.l + i * bw} y={P.t} width={bw} height={H - P.t - P.b} className="hit" />
              <rect x={bx} y={Math.min(y(m.realized), y(0))} width={w} height={Math.max(1, Math.abs(y(m.realized) - y(0)))} rx={4} style={{ fill: col }} opacity={hover === i ? 0.5 : 0.28} />
              {months.length <= 12 && bw >= 44 && <text className="lbl" x={bx + w / 2} y={m.realized >= 0 ? y(m.realized) - 6 : y(m.realized) + 14} textAnchor="middle" style={{ fill: col }}>{sfmt(m.realized)}</text>}
            </g>
          )
        })}
        {tab === 'Net' && pri && <path d={path(pri)} fill="none" style={{ stroke: 'var(--color-text-tertiary)' }} strokeDasharray="4 4" strokeWidth={1.3} />}
        {tab === 'Net' && <path d={path(cur)} fill="none" style={{ stroke: 'var(--color-text-primary)' }} strokeWidth={2.2} strokeLinejoin="round" />}
        {tab === 'Realized' && <path d={realizedCum.map((v, i) => `${i ? 'L' : 'M'}${P.l + i * bw + bw / 2},${y(v)}`).join('')} fill="none" style={{ stroke: 'var(--color-text-primary)' }} strokeWidth={2.2} />}
        {tab === 'By platform' && <>
          <path d={path(byPlat[0])} fill="none" style={{ stroke: 'var(--color-platform-polymarket)' }} strokeWidth={2.2} />
          <path d={path(byPlat[1])} fill="none" style={{ stroke: 'var(--color-platform-kalshi)' }} strokeWidth={2.2} />
        </>}
      </svg>
      {hover != null && tab !== 'By platform' && months[hover] && (
        <div className="tip" style={{ left: `${((P.l + hover * bw + bw / 2) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}>
          <div className="t3">{fmtDate(`${months[hover].month}-01`, { month: 'long', year: 'numeric' })}</div><b className={months[hover].realized >= 0 ? 'gain' : 'loss'}>{sfmt(months[hover].realized, 2)}</b> realized<div className="t3">Select for its trades</div>
        </div>
      )}
    </div>
  )
}

export default function Analytics() {
  const { ACCOUNTS, HISTORY_START, TODAY, periodAvailable, periodRange, periodStats } = useFinance()
  useHashScroll()
  const [plat, setPlat] = useState<PlatformLabel>('All')
  const [chosen, setPeriod] = useState<PeriodValue>(useSettings().settings.defaultPeriod)
  const period: PeriodValue = typeof chosen === 'string' && !periodAvailable(chosen) ? 'All' : chosen
  const [compareOn, setCompareOn] = useState(true)
  const [tab, setTab] = useState<'Net' | 'Realized' | 'By platform'>('Net')
  const [attrBy, setAttrBy] = useState<'Category' | 'Platform'>(useSettings().settings.defaultGrouping === 'platform' ? 'Platform' : 'Category')
  const details = useDetails()
  const [hotBucket, setHotBucket] = useState<number | null>(null)

  const f = toFilter(plat)
  const range = periodRange(period)
  const stats = useMemo(() => periodStats(f, periodRange(period)), [f, period])
  const prior = useMemo(() => { const p = periodRange(period).prior; return p ? periodStats(f, p) : null }, [f, period])
  const compare = compareOn && prior !== null
  const attr = attribution(stats.trades, attrBy === 'Category' ? 'category' : 'platform').map((a) => ({ ...a, label: attrBy === 'Platform' ? PLATFORM_NAME[a.key as Platform] : a.key }))
  const ins = useMemo(() => insights(stats.trades), [stats])
  const buckets = useMemo(() => entryBuckets(stats.trades), [stats])
  const top = attr[0], worst = [...attr].sort((a, b) => a.net - b.net)[0]
  const gains = attr.filter((a) => a.net > 0).reduce((s, a) => s + a.net, 0)
  const worstMonth = [...stats.months].sort((a, b) => a.realized - b.realized)[0]
  const attrMax = Math.max(1, ...attr.map((a) => Math.abs(a.net)))
  const scope = f === 'all' ? 'all platforms' : plat
  const fmtOpt = (v: number | null, f: (x: number) => string) => (v == null ? '—' : f(v))

  const metrics: [string, (s: PeriodStats) => string, ((a: PeriodStats, b: PeriodStats) => { text: string; good: boolean } | null) | null][] = [
    ['Net P&L (after fees)', (s) => sfmt(s.netPnl), (a, b) => ({ text: sfmt(a.netPnl - b.netPnl), good: a.netPnl >= b.netPnl })],
    ['Realized P&L (closed trades)', (s) => sfmt(s.realized), (a, b) => ({ text: sfmt(a.realized - b.realized), good: a.realized >= b.realized })],
    ['Fees paid', (s) => fmt(s.fees, 2), (a, b) => ({ text: sfmt(a.fees - b.fees, 2), good: a.fees <= b.fees })],
    ['Closed trades', (s) => String(s.trades.length), null],
    ['Win rate (resolved)', (s) => (s.winRate == null ? 'No data' : `${pct(s.winRate * 100, 0)} of ${s.resolved}`), (a, b) => (a.winRate == null || b.winRate == null ? null : { text: `${((a.winRate - b.winRate) * 100).toFixed(0)} pts`, good: a.winRate >= b.winRate })],
    ['Average win / loss', (s) => `${fmtOpt(s.avgWin, (v) => fmt(v))} / ${fmtOpt(s.avgLoss, (v) => fmt(v))}`, null],
    ['Profit factor', (s) => fmtOpt(s.profitFactor, (v) => v.toFixed(2)), null],
    ['Largest drawdown (weekly)', (s) => (s.drawdown ? sfmt(-s.drawdown.amount) : 'none'), (a, b) => ({ text: sfmt((b.drawdown?.amount ?? 0) - (a.drawdown?.amount ?? 0)), good: (a.drawdown?.amount ?? 0) <= (b.drawdown?.amount ?? 0) })],
    ['Best month (realized)', (s) => { const m = [...s.months].sort((x, y) => y.realized - x.realized)[0]; return m ? `${monthLabel(m.month)} ${sfmt(m.realized)}` : '—' }, null],
    ['Worst month (realized)', (s) => { const m = [...s.months].sort((x, y) => x.realized - y.realized)[0]; return m ? `${monthLabel(m.month)} ${sfmt(m.realized)}` : '—' }, null],
  ]
  // Drill-downs keep the page's period and platform scope and say so in the panel subtitle.
  const openTrades = (title: string, trades: ClosedTrade[]) => details.open({ kind: 'trades', title, sub: `${range.label}, ${scope}, worst first`, trades: [...trades].sort((a, b) => tradeNet(a) - tradeNet(b)) })
  const openMonth = (m: string) => openTrades(`Trades closed in ${fmtDate(`${m}-01`, { month: 'long', year: 'numeric' })}`, stats.trades.filter((t) => t.closed.startsWith(m)))

  return (
    <div className="shell">
      <SectionRail title="Analytics" sections={RAIL}>
        <div className="rail-card"><b>Definitions</b>Net P&amp;L = realized + change in unrealized (after fees on new purchases). Deposits and withdrawals never count as performance. <span className="t3">History uses weekly snapshots.</span></div>
      </SectionRail>
      <main>
        <PageHead caption={f === 'all' ? range.label : `${range.label}, ${scope}`} title="Portfolio performance"
          actions={<>
            <Pills label="Platform" options={PLATFORM_FILTER} value={plat} onChange={setPlat} />
            <Button icon="compare" variant={compare ? undefined : 'ghost'} disabled={!prior} title={prior ? undefined : 'Your history doesn’t cover a full prior period'} onClick={() => setCompareOn((c) => !c)}>{!prior ? 'No prior period' : compare ? 'Comparing to prior' : 'Compare to prior'}</Button>
          </>} />

        <div className="period-row"><PeriodControl value={period} onChange={setPeriod} />
          <div className="asof"><span>History from <b>{fmtDate(HISTORY_START, { month: 'short', day: 'numeric', year: 'numeric' })}</b>, prices as of {fmtDate(TODAY)}</span><ReportingNote denominations={ACCOUNTS.map((a) => a.denomination)} /></div></div>
        <p className="summary">
          Over this period you made <b className={stats.netPnl >= 0 ? 'gain' : 'loss'}>{sfmt(stats.netPnl, 2)}</b> net{compare && prior ? <>, <b>{sfmt(stats.netPnl - prior.netPnl)}</b> vs. the prior period</> : ''}: <b>{sfmt(stats.realized)}</b> realized on {stats.trades.length} trades closed in the period, and <b>{sfmt(stats.unrealizedChange)}</b> change in unrealized P&amp;L{stats.openFillFees ? <> (after <b>{fmt(stats.openFillFees, 2)}</b> fees on new purchases)</> : ''}.
          {top && top.net > 0 && <> <a href="#attribution">{top.label}</a> made {gains > 0 ? pct((top.net / gains) * 100, 0) : '—'} of realized gains.</>}
          {worst && worst.net < 0 && <> The weakest group was <a href="#attribution">{worst.label}</a> ({sfmt(worst.net)}).</>}
          {worstMonth && worstMonth.realized < 0 && <> Worst month: {monthLabel(worstMonth.month)} ({sfmt(worstMonth.realized)}).</>}
        </p>

        <Card id="highlights">
          <CardHeader title="Highlights" sub={compare ? 'Compared with the prior period' : prior ? undefined : 'No earlier period to compare with'} />
          <div className="card-b hl">
            <div className="hl-group"><h5 className="caps">Return</h5>
              <div className={cx('hl-tile', stats.netPnl >= 0 ? 'good' : 'bad')}><div className="l">Net P&amp;L</div><div className={cx('v', stats.netPnl >= 0 ? 'gain' : 'loss')}>{sfmt(stats.netPnl)}</div><div className="f">{compare && prior ? `${stats.netPnl >= prior.netPnl ? '▲' : '▼'} ${sfmt(stats.netPnl - prior.netPnl)} vs prior` : 'after fees, deposits excluded'}</div></div>
              <div className={cx('hl-tile', stats.realized >= 0 ? 'good' : 'bad')}><div className="l">Realized (closed trades)</div><div className={cx('v', stats.realized >= 0 ? 'gain' : 'loss')}>{sfmt(stats.realized)}</div><div className="f">{stats.trades.length} trades, {fmt(stats.fees)} fees</div></div>
            </div>
            <div className="hl-group"><h5 className="caps">Risk</h5>
              <div className={cx('hl-tile', stats.drawdown ? 'bad' : 'neutral')}><div className="l">Largest drawdown</div><div className={cx('v', stats.drawdown && 'loss')}>{stats.drawdown ? sfmt(-stats.drawdown.amount) : 'None'}</div><div className="f">{stats.drawdown ? `${fmtDate(stats.drawdown.from)} – ${fmtDate(stats.drawdown.to)}, ${stats.drawdown.recoveredOn ? `recovered ${fmtDate(stats.drawdown.recoveredOn)}` : 'not yet recovered'}` : 'No fall below an earlier peak'}</div></div>
              <div className="hl-tile neutral"><div className="l">Win rate</div><div className="v">{stats.winRate == null ? 'No data' : pct(stats.winRate * 100, 0)}</div><div className="f">{stats.resolved} resolved trades{stats.resolved < 30 ? '. Limited sample size' : `, profit factor ${fmtOpt(stats.profitFactor, (v) => v.toFixed(2))}`}</div></div>
            </div>
          </div>
        </Card>

        <div className="grid g-21 anchor" id="performance">
          <Card id="pnl">
            <CardHeader title="Cumulative P&L" sub="Cumulative over the period, with realized P&L by month" right={<Tabs label="Chart view" options={['Net', 'Realized', 'By platform'] as const} value={tab} onChange={setTab} />} />
            <div className="card-b">
              <PnlChart f={f} start={range.start} end={range.end} prior={compare ? range.prior : null} stats={stats} tab={tab} onMonth={openMonth} />
              <div style={{ marginTop: 'var(--space-3)' }}>
                <Legend items={tab === 'By platform'
                  ? [{ label: 'Polymarket', color: 'var(--color-platform-polymarket)', kind: 'ln' }, { label: 'Kalshi', color: 'var(--color-platform-kalshi)', kind: 'ln' }]
                  : [{ label: tab === 'Net' ? 'Cumulative net P&L' : 'Cumulative realized', color: 'var(--color-text-primary)', kind: 'ln' }, { label: 'Realized gain month', color: 'var(--color-gain-fg)' }, { label: 'Realized loss month', color: 'var(--color-loss-fg)' }, ...(compare && tab === 'Net' ? [{ label: 'Prior period', kind: 'dash' as const }] : [])]} />
              </div>
            </div>
          </Card>
          <Card id="attribution">
            <CardHeader title="Attribution" sub="Realized P&L of closed trades, after fees" right={<Seg label="Group by" options={['Category', 'Platform'] as const} value={attrBy} onChange={setAttrBy} />} />
            <div className="card-b">
              {attr.length === 0 && <div className="empty"><p>No trades closed in this period.</p></div>}
              {attr.map((a) => (
                <button type="button" className="attr attr-btn hoverable" key={a.key} aria-label={`${a.label}: ${sfmt(a.net)} across ${a.n} trades. View trades`}
                  onClick={() => openTrades(`${a.label} closed trades`, stats.trades.filter((t) => (attrBy === 'Category' ? t.category : t.platform) === a.key))}>
                  <span>{a.label}</span>
                  <div className="ng">{a.net < 0 && <i style={{ width: `${(-a.net / attrMax) * 100}%` }} />}</div>
                  <div className="ps">{a.net > 0 && <i style={{ width: `${(a.net / attrMax) * 100}%` }} />}</div>
                  <span className={cx('r', a.net >= 0 ? 'gain' : 'loss')}>{sfmt(a.net)}</span><span className="r t3">{a.n}</span>
                </button>
              ))}
              <div className="attr" style={{ fontWeight: 'var(--font-weight-semibold)' }}><span>Realized</span><span /><span /><span className={cx('r', stats.realized >= 0 ? 'gain' : 'loss')}>{sfmt(stats.realized)}</span><span className="r t3">{stats.trades.length}</span></div>
              <div className="attr t2"><span title={stats.openFillFees > 0 ? `Includes −${fmt(stats.openFillFees, 2)} fees on new purchases` : undefined}>Change in unrealized</span><span /><span /><span className={cx('r', stats.unrealizedChange >= 0 ? 'gain' : 'loss')}>{sfmt(stats.unrealizedChange)}</span><span className="r t3">—</span></div>
              <div className="attr" style={{ fontWeight: 'var(--font-weight-semibold)' }}><span>Net P&amp;L</span><span /><span /><span className={cx('r', stats.netPnl >= 0 ? 'gain' : 'loss')}>{sfmt(stats.netPnl)}</span><span className="r t3" /></div>
              <p className="t3" style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-3)' }}>Change in unrealized is after fees on new purchases (they’re part of cost basis). Realized counts each trade closed in this period in full, including gains or losses that built up before the period began. That earlier part is reversed in “Change in unrealized”, so the rows add up to the period’s net P&amp;L.</p>
            </div>
          </Card>
        </div>

        <section id="patterns" className="anchor grid g-3">
          <div className="card insight"><Chip tone={ins.longshots && ins.longshots.net < 0 ? 'no' : 'info'}>Longshots</Chip>
            {ins.longshots ? (<>
              <h4>Resolved contracts bought under $0.25: <span className={ins.longshots.net >= 0 ? 'gain' : 'loss'}>{sfmt(ins.longshots.net)}</span></h4>
              <p>You won {ins.longshots.wins} of {ins.longshots.n} ({pct((ins.longshots.wins / ins.longshots.n) * 100, 0)}). Their entry prices implied about {pct(ins.longshots.implied * 100, 0)}.{ins.longshots.worstCategory && ` The weakest category here was ${ins.longshots.worstCategory}.`}</p>
              <div className="meta"><span>{ins.longshots.n} trades{ins.longshots.n < 30 ? ', limited sample size' : ''}</span><button type="button" className="link" onClick={() => openTrades('Longshot trades (entry < $0.25)', ins.longshots!.trades)}>See trades →</button></div>
            </>) : <p className="unavailable">Fewer than 5 resolved longshot trades in this period, so there’s nothing reliable to say.</p>}
          </div>
          <div className="card insight"><Chip tone="info">Early exits</Chip>
            {ins.earlyExits ? (<>
              <h4>{ins.earlyExits.missed} of {ins.earlyExits.n} early exits later resolved in your favour</h4>
              <p>In hindsight, holding those would have paid about <b className="gain">{fmt(ins.earlyExits.leftOnTable)}</b> more. The other {ins.earlyExits.n - ins.earlyExits.missed} exits kept about <b>{fmt(ins.earlyExits.avoided)}</b> that went to $0. Outcomes weren’t known when you exited, so this measures opportunity cost, not whether the exits were mistakes.</p>
              <div className="meta"><span>{ins.earlyExits.n} early exits, in hindsight</span><button type="button" className="link" onClick={() => openTrades('Positions sold before resolution', ins.earlyExits!.trades)}>Review exits →</button></div>
            </>) : <p className="unavailable">Fewer than 5 early exits in this period.</p>}
          </div>
          <div className="card insight"><Chip tone="yes">Largest contributor</Chip>
            {ins.strongest ? (<>
              <h4>{ins.strongest.c} contributed the most: <span className="gain">{sfmt(ins.strongest.net)}</span></h4>
              <p>{ins.strongest.n} closed trades. {pct(ins.strongest.winRate * 100, 0)} of the {ins.strongest.resolved} that resolved went your way. The single best trade is {pct(Math.min(1, ins.strongest.topShare) * 100, 0)} of the category’s result{ins.strongest.topShare > 0.5 ? ', so one outcome drives most of it' : ''}.</p>
              <div className="meta"><span>{ins.strongest.n} trades{ins.strongest.n < 30 ? ', limited sample size' : ''}</span><button type="button" className="link" onClick={() => openTrades(`${ins.strongest!.c} trades`, ins.strongest!.trades)}>Open category →</button></div>
            </>) : <p className="unavailable">No category has 5+ closed trades with a positive result in this period.</p>}
          </div>
        </section>

        <div className="grid g-2 anchor" id="detail">
          <Card id="entry">
            <CardHeader title="Entry price vs. outcome" sub="How often your resolved trades won, compared with what the entry price implied" />
            <div className="card-b">
              <div className="bucket t3" style={{ fontSize: 'var(--font-size-xs)', paddingTop: 0 }}><span>Entry price</span><span>Your win rate vs. implied</span><span className="r">Trades</span><span className="r">Net P&amp;L</span></div>
              {buckets.map((b, i) => (
                <button type="button" key={b.label} className="bucket bucket-btn hoverable" disabled={!b.n} style={{ opacity: hotBucket != null && hotBucket !== i ? 0.45 : 1 }}
                  onMouseEnter={() => setHotBucket(i)} onMouseLeave={() => setHotBucket(null)} onFocus={() => setHotBucket(i)} onBlur={() => setHotBucket(null)}
                  aria-label={b.n ? `Entry ${b.label}: ${b.n} resolved trades. View trades` : `Entry ${b.label}: no resolved trades`}
                  onClick={() => openTrades(`Resolved trades entered at ${b.label}`, b.trades)}>
                  <span className="mono">{b.label}</span>
                  {b.n ? <div className="cal"><div className="a" style={{ width: `${(b.winRate ?? 0) * 100}%` }} /><div className="m" style={{ left: `${(b.implied ?? 0) * 100}%` }} /><span>{pct((b.winRate ?? 0) * 100, 0)} <span className="t3">vs {pct((b.implied ?? 0) * 100, 0)}</span></span></div> : <span className="unavailable">no resolved trades</span>}
                  <span className="r">{b.n}</span><span className={cx('r', b.net >= 0 ? 'gain' : 'loss')}>{b.n ? sfmt(b.net) : '—'}</span>
                </button>
              ))}
              <div style={{ marginTop: 'var(--space-3)' }}>
                {hotBucket != null && buckets[hotBucket].n
                  ? <Callout>In this bucket you won {pct((buckets[hotBucket].winRate ?? 0) * 100, 0)} of {buckets[hotBucket].n} resolved trades; the average entry price implied {pct((buckets[hotBucket].implied ?? 0) * 100, 0)}.</Callout>
                  : <Callout tone="warn">Buckets with fewer than 30 trades can differ from the implied rate by chance. Treat gaps as something to watch, not a verdict.</Callout>}
              </div>
            </div>
          </Card>
          <Card id="metrics" flush>
            <CardHeader pad title="Metrics" sub={compare ? 'This period and the prior period' : prior ? undefined : 'No earlier period to compare with'} />
            <div className="dt-wrap"><table className="dt cmp">
              <thead><tr><th scope="col">Metric</th><th scope="col" className="r">This period</th>{compare && <><th scope="col" className="r">Prior period</th><th scope="col" className="r">Change</th></>}</tr></thead>
              <tbody>{metrics.map(([k, val, diff]) => {
                const d = compare && prior && diff ? diff(stats, prior) : null
                return <tr key={k}><td>{k}</td><td className="r">{val(stats)}</td>{compare && prior && <><td className="r t3">{val(prior)}</td><td className="r">{d ? <Delta tone={d.good ? 'gain' : 'loss'}>{d.text}</Delta> : <span className="t3">—</span>}</td></>}</tr>
              })}</tbody>
            </table></div>
          </Card>
        </div>

        <div className="footer-note"><span>Analytics describe past results. They don’t predict future ones and aren’t investment advice.</span><span><WorkspaceLabel /></span></div>
      </main>

    </div>
  )
}

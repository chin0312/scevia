import { useMemo, useRef, useState } from 'react'
import { PeriodControl, type PeriodValue } from '../components/PeriodControl'
import { useSettings } from '../lib/settings'
import { useWidth } from '../components/charts'
import { useDetails } from '../components/details'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Card, CardHeader, Delta, Legend, PageHead, Pills, Tabs, cx } from '../components/ui'
import { PLATFORM_NAME } from '../data/labels'
import type { Platform } from '../data/types'
import { attribution, fmtDate, tradeNet, type PeriodStats, type PlatformFilter } from '../lib/finance'
import { performanceFromSeries, type QualityMetric } from '../lib/analytics'
import { AttributionCard, MetricValue, MonthlyReturns, PatternExplorer, ReturnsCard, TradeAnalysis } from './analytics/sections'
import { fmt, kfmt, pct, sfmt } from '../lib/format'
import type { ClosedTrade } from '../data/types'
import { useFinance } from '../lib/financeContext'
import { DataIssues } from '../components/Workspace'
import { count } from '../lib/text'

const RAIL: RailSection[] = [
  { id: 'performance', label: 'Performance', icon: 'trend', children: [{ id: 'highlights', label: 'Highlights' }, { id: 'pnl', label: 'P&L over time' }, { id: 'returns', label: 'Returns' }, { id: 'metrics', label: 'Period comparison' }] },
  { id: 'attribution', label: 'Attribution', icon: 'bars' },
  { id: 'patterns', label: 'Trading patterns', icon: 'spark' },
  { id: 'trades', label: 'Trade analysis', icon: 'table', children: [{ id: 'largest', label: 'Largest results' }, { id: 'by-market', label: 'By market' }, { id: 'activity', label: 'Activity' }] },
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
  const { ACCOUNTS, HISTORY_START, periodAvailable, periodRange, periodStats, series } = useFinance()
  useHashScroll()
  const [plat, setPlat] = useState<PlatformLabel>('All')
  const [chosen, setPeriod] = useState<PeriodValue>(useSettings().settings.defaultPeriod)
  const period: PeriodValue = typeof chosen === 'string' && !periodAvailable(chosen) ? 'All' : chosen
  const [compareOn, setCompareOn] = useState(true)
  const [tab, setTab] = useState<'Net' | 'Realized' | 'By platform'>('Net')
  const details = useDetails()

  const f = toFilter(plat)
  const range = periodRange(period)
  const stats = useMemo(() => periodStats(f, periodRange(period)), [f, period])
  const perf = useMemo(() => performanceFromSeries(series(f, range.start, range.end)), [f, range.start, range.end])
  const priorPerf = useMemo(() => (range.prior ? performanceFromSeries(series(f, range.prior.start, range.prior.end)) : null), [f, range.prior?.start, range.prior?.end])
  const prior = useMemo(() => { const p = periodRange(period).prior; return p ? periodStats(f, p) : null }, [f, period])
  const compare = compareOn && prior !== null
  const attr = attribution(stats.trades, 'category')
  const top = attr[0], worst = [...attr].sort((a, b) => a.net - b.net)[0]
  const gains = attr.filter((a) => a.net > 0).reduce((s, a) => s + a.net, 0)
  const worstMonth = [...stats.months].sort((a, b) => a.realized - b.realized)[0]
  const scope = f === 'all' ? 'all platforms' : plat
  const fmtOpt = (v: number | null, f: (x: number) => string) => (v == null ? '—' : f(v))

  const metrics: [string, (s: PeriodStats) => string, ((a: PeriodStats, b: PeriodStats) => { text: string; good: boolean } | null) | null][] = [
    ['Net P&L (after fees)', (s) => sfmt(s.netPnl), (a, b) => ({ text: sfmt(a.netPnl - b.netPnl), good: a.netPnl >= b.netPnl })],
    ['Realized P&L (closed trades)', (s) => sfmt(s.realized), (a, b) => ({ text: sfmt(a.realized - b.realized), good: a.realized >= b.realized })],
    ['Fees paid', (s) => fmt(s.fees, 2), (a, b) => ({ text: sfmt(a.fees - b.fees, 2), good: a.fees <= b.fees })],
    ['Closed trades', (s) => String(s.trades.length), null],
    ['Resolved win rate', (s) => (s.winRate == null ? 'No data' : `${pct(s.winRate * 100, 0)} (${count(s.resolved, 'resolved trade')})`), (a, b) => (a.winRate == null || b.winRate == null ? null : { text: `${((a.winRate - b.winRate) * 100).toFixed(0)} pts`, good: a.winRate >= b.winRate })],
    ['Average win / loss', (s) => `${fmtOpt(s.avgWin, (v) => fmt(v))} / ${fmtOpt(s.avgLoss, (v) => fmt(v))}`, null],
    ['Profit factor', (s) => fmtOpt(s.profitFactor, (v) => v.toFixed(2)), null],
    ['P&L drawdown (weekly)', (s) => (s.drawdown ? sfmt(-s.drawdown.amount) : 'none'), (a, b) => ({ text: sfmt((b.drawdown?.amount ?? 0) - (a.drawdown?.amount ?? 0)), good: (a.drawdown?.amount ?? 0) <= (b.drawdown?.amount ?? 0) })],
    ['Best month (realized)', (s) => { const m = [...s.months].sort((x, y) => y.realized - x.realized)[0]; return m ? `${monthLabel(m.month)} ${sfmt(m.realized)}` : '—' }, null],
    ['Worst month (realized)', (s) => { const m = [...s.months].sort((x, y) => x.realized - y.realized)[0]; return m ? `${monthLabel(m.month)} ${sfmt(m.realized)}` : '—' }, null],
  ]
  // Drill-downs keep the page's period and platform scope and say so in the panel subtitle.
  const openTrades = (title: string, trades: ClosedTrade[]) => details.open({ kind: 'trades', title, sub: `${range.label}, ${scope}, worst first`, trades: [...trades].sort((a, b) => tradeNet(a) - tradeNet(b)) })
  const openMonth = (m: string) => openTrades(`Trades closed in ${fmtDate(`${m}-01`, { month: 'long', year: 'numeric' })}`, stats.trades.filter((t) => t.closed.startsWith(m)))

  return (
    <div className="shell">
      <SectionRail title="Analytics" sections={RAIL}>
      </SectionRail>
      <main>
        <PageHead caption={f === 'all' ? range.label : `${range.label}, ${scope}`} title="Portfolio performance"
          actions={<>
            <Pills label="Platform" options={PLATFORM_FILTER} value={plat} onChange={setPlat} />
            <Button icon="compare" variant={compare ? undefined : 'ghost'} disabled={!prior} title={prior ? undefined : 'Your history doesn’t cover a full prior period'} onClick={() => setCompareOn((c) => !c)}>{!prior ? 'No prior period' : compare ? 'Comparing to prior' : 'Compare to prior'}</Button>
          </>} />

        <div className="period-row"><PeriodControl value={period} onChange={setPeriod} />
          <span className="t3 history-from">History from {fmtDate(HISTORY_START, { month: 'short', day: 'numeric', year: 'numeric' })}</span><DataIssues denominations={ACCOUNTS.map((a) => a.denomination)} /></div>
        <p className="summary">
          Over this period you made <b className={stats.netPnl >= 0 ? 'gain' : 'loss'}>{sfmt(stats.netPnl, 2)}</b> net{compare && prior ? <>, <b>{sfmt(stats.netPnl - prior.netPnl)}</b> vs. the prior period</> : ''}: <b>{sfmt(stats.realized)}</b> realized on {count(stats.trades.length, 'trade')} closed in the period, and <b>{sfmt(stats.unrealizedChange)}</b> change in unrealized P&amp;L{stats.openFillFees ? <> (after <b>{fmt(stats.openFillFees, 2)}</b> fees on new purchases)</> : ''}.
          {top && top.net > 0 && <> <a href="#attribution">{top.key}</a> made {gains > 0 ? pct((top.net / gains) * 100, 0) : '—'} of realized gains.</>}
          {worst && worst.net < 0 && <> The weakest group was <a href="#attribution">{worst.key}</a> ({sfmt(worst.net)}).</>}
          {worstMonth && worstMonth.realized < 0 && <> Worst month: {monthLabel(worstMonth.month)} ({sfmt(worstMonth.realized)}).</>}
        </p>

        <section className="anchor section-stack" id="performance" aria-label="Performance">
        <Card id="highlights">
          <CardHeader title="Highlights" sub={compare ? 'Compared with the prior period' : prior ? undefined : 'No earlier period to compare with'} />
          <div className="card-b hl hl-4">
            <div className={cx('hl-tile', stats.netPnl >= 0 ? 'good' : 'bad')}><div className="l">Net P&amp;L</div><div className={cx('v', stats.netPnl >= 0 ? 'gain' : 'loss')}>{sfmt(stats.netPnl)}</div><div className="f">{compare && prior ? `${stats.netPnl >= prior.netPnl ? '▲' : '▼'} ${sfmt(stats.netPnl - prior.netPnl)} vs. prior` : `${sfmt(stats.realized)} realized`}</div></div>
            <div className="hl-tile neutral"><div className="l">Time-weighted return</div><div className={cx('v', (perf.twr.value ?? 0) > 0 && 'gain', (perf.twr.value ?? 0) < 0 && 'loss')}><MetricValue m={perf.twr} f={(v) => `${v >= 0 ? '+' : '−'}${pct(Math.abs(v) * 100)}`} /></div><div className="f">{perf.twr.value == null ? perf.twr.reason : 'Deposits and withdrawals excluded'}</div></div>
            <div className={cx('hl-tile', (perf.maximumDrawdown.value ?? 0) < 0 ? 'bad' : 'neutral')}><div className="l">Maximum drawdown <small className="t3">sampled</small></div><div className={cx('v', (perf.maximumDrawdown.value ?? 0) < 0 && 'loss')}><MetricValue m={perf.maximumDrawdown} f={(v) => (v < 0 ? `−${pct(Math.abs(v) * 100)}` : 'None')} /></div><div className="f">{perf.drawdownDetail ? `${fmtDate(perf.drawdownDetail.peakDate)} to ${fmtDate(perf.drawdownDetail.troughDate)}, ${perf.drawdownDetail.recoveredOn ? `recovered ${fmtDate(perf.drawdownDetail.recoveredOn)}` : 'not yet recovered'}` : perf.maximumDrawdown.value == null ? perf.maximumDrawdown.reason : 'No fall below an earlier peak'}</div></div>
            <div className="hl-tile neutral"><div className="l">Resolved win rate</div><div className="v">{stats.winRate == null ? 'No data' : pct(stats.winRate * 100, 0)}</div><div className="f">{count(stats.resolved, 'resolved trade')}{stats.resolved < 30 ? '. Limited sample size' : `, profit factor ${fmtOpt(stats.profitFactor, (v) => v.toFixed(2))}`}</div></div>
          </div>
        </Card>

        <Card id="pnl">
          <CardHeader title="Cumulative P&L" right={<Tabs label="Chart view" options={['Net', 'Realized', 'By platform'] as const} value={tab} onChange={setTab} />} />
          <div className="card-b">
            <PnlChart f={f} start={range.start} end={range.end} prior={compare ? range.prior : null} stats={stats} tab={tab} onMonth={openMonth} />
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Legend items={tab === 'By platform'
                ? [{ label: 'Polymarket', color: 'var(--color-platform-polymarket)', kind: 'ln' }, { label: 'Kalshi', color: 'var(--color-platform-kalshi)', kind: 'ln' }]
                : [{ label: tab === 'Net' ? 'Cumulative net P&L' : 'Cumulative realized', color: 'var(--color-text-primary)', kind: 'ln' }, { label: 'Realized gain month', color: 'var(--color-gain-fg)' }, { label: 'Realized loss month', color: 'var(--color-loss-fg)' }, ...(compare && tab === 'Net' ? [{ label: 'Prior period', kind: 'dash' as const }] : [])]} />
            </div>
          </div>
        </Card>

        <div className="grid g-2 top">
          <ReturnsCard perf={perf} />
          <MonthlyReturns perf={perf} />
        </div>

        <Card id="metrics" flush>
          <CardHeader pad title="Period comparison" sub={compare ? 'This period and the prior period' : prior ? undefined : 'No earlier period to compare with'} />
          <div className="dt-wrap"><table className="dt cmp">
            <thead><tr><th scope="col">Metric</th><th scope="col" className="r">This period</th>{compare && <><th scope="col" className="r">Prior period</th><th scope="col" className="r">Change</th></>}</tr></thead>
            <tbody>{([['Time-weighted return', perf.twr, priorPerf?.twr], ['Maximum drawdown (sampled)', perf.maximumDrawdown, priorPerf?.maximumDrawdown]] as const).map(([k, cur, pri]) => {
              const show = (m: QualityMetric | undefined) => (m == null ? '—' : m.value == null ? 'Unavailable' : `${m.value >= 0 ? '+' : '−'}${pct(Math.abs(m.value) * 100)}${m.quality === 'estimate' ? ' est.' : ''}`)
              // Percentage-point change only when both periods are calculated on the same basis.
              const d = cur.value != null && pri?.value != null && cur.quality === pri.quality ? (cur.value - pri.value) * 100 : null
              return <tr key={k}><td>{k}</td><td className="r">{show(cur)}</td>{compare && prior && <><td className="r t3">{show(pri)}</td><td className="r">{d == null ? <span className="t3">—</span> : <Delta tone={d >= 0 ? 'gain' : 'loss'}>{`${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts`}</Delta>}</td></>}</tr>
            })}
            {metrics.map(([k, val, diff]) => {
              const d = compare && prior && diff ? diff(stats, prior) : null
              return <tr key={k}><td>{k}</td><td className="r">{val(stats)}</td>{compare && prior && <><td className="r t3">{val(prior)}</td><td className="r">{d ? <Delta tone={d.good ? 'gain' : 'loss'}>{d.text}</Delta> : <span className="t3">—</span>}</td></>}</tr>
            })}</tbody>
          </table></div>
        </Card>
        </section>

        <AttributionCard stats={stats} open={openTrades} initial={useSettings().settings.defaultGrouping === 'platform' ? 'Platform' : 'Category'} />
        <PatternExplorer trades={stats.trades} open={openTrades} scope={f === 'all' ? range.label : `${range.label}, ${scope}`} />
        <section className="anchor section-stack" id="trades" aria-label="Trade analysis">
          <TradeAnalysis trades={stats.trades} open={openTrades} openOne={(t) => details.open({ kind: 'trades', title: t.market, sub: `Closed on ${PLATFORM_NAME[t.platform]}, ${fmtDate(t.closed, { month: 'short', day: 'numeric', year: 'numeric' })}`, trades: [t] })} />
        </section>
      </main>

    </div>
  )
}

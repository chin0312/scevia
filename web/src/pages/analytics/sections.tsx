/* Analytics sections built on lib/analytics.ts: returns and drawdown, calendar-month returns, grouped attribution, the
   trade-pattern explorer and trade analysis. Every section keeps the page's period and platform scope, drills down to
   the trades behind a figure, and shows a metric as unavailable (with its reason) rather than estimating it. */
import { useMemo, useState } from 'react'
import { LineChart } from '../../components/charts'
import { InfoTip } from '../../components/overlays'
import { Card, CardHeader, Chip, Seg, Tabs, cx } from '../../components/ui'
import { PLATFORM_NAME } from '../../data/labels'
import type { ClosedTrade } from '../../data/types'
import { activityByMonth, byMarket, cohorts, COHORT_DIMS, feeBurden, returnDistribution, type CohortDim, type PerformanceReadModel, type QualityMetric } from '../../lib/analytics'
import { fmtDate, insights, tradeGross, tradeNet, type PeriodStats } from '../../lib/finance'
import { fmt, kfmt, pct, sfmt } from '../../lib/format'
import { HELP } from '../../lib/help'
import { count } from '../../lib/text'

type Open = (title: string, trades: ClosedTrade[]) => void
const spct = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${pct(Math.abs(v) * 100, d)}`
const SMALL = 30

/** A quality-labelled metric: its value, or "Unavailable" with the reason. Estimates say so. */
export function MetricValue({ m, f }: { m: QualityMetric; f: (v: number) => string }) {
  if (m.value == null) return <span className="t3" title={m.reason ?? undefined}>Unavailable</span>
  return <>{f(m.value)}{m.quality === 'estimate' && <small className="t3"> est.</small>}</>
}

export function ReturnsCard({ perf }: { perf: PerformanceReadModel }) {
  const [view, setView] = useState<'Return index' | 'Drawdown'>('Return index')
  const pts = perf.index
  const ok = pts.length >= 2 && pts.every((p) => p.index != null)
  const data = ok ? pts.map((p) => (view === 'Return index' ? (p.index as number) - 1 : (p.drawdown as number))) : []
  const lo = Math.min(0, ...data), hi = Math.max(0, ...data)
  const step = Math.max(0.01, Math.ceil(((hi - lo) / 4) * 100) / 100)
  const min = Math.floor(lo / step) * step, max = Math.max(min + step, Math.ceil(hi / step) * step)
  const ticks: number[] = []
  for (let t = min; t <= max + 1e-9; t += step) ticks.push(Number(t.toFixed(4)))
  const tickIdx = [0, Math.floor(pts.length / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i)
  const rows: [string, QualityMetric, (v: number) => string][] = [
    ['Time-weighted return', perf.twr, (v) => spct(v)],
    ['Maximum drawdown', perf.maximumDrawdown, (v) => spct(v)],
    ['Annualized money-weighted return', perf.annualizedMwr, (v) => spct(v)],
    ['Annualized volatility', perf.annualizedVolatility, (v) => pct(v * 100)],
  ]
  return (
    <Card id="returns">
      <CardHeader title="Returns" info={HELP.twr} right={<Tabs label="Returns view" options={['Return index', 'Drawdown'] as const} value={view} onChange={setView} />} />
      <div className="card-b">
        {ok ? <LineChart label={`${view === 'Return index' ? 'Flow-adjusted cumulative return' : 'Drawdown from prior peak'}, ${fmtDate(pts[0].date)} to ${fmtDate(pts[pts.length - 1].date)}`}
          w={560} h={200} min={min} max={max} yTicks={ticks} yFmt={(v) => spct(v, 0)}
          series={[{ data, color: view === 'Return index' ? 'var(--color-text-primary)' : 'var(--color-loss-fg)', area: view === 'Drawdown' ? 0.12 : undefined }]}
          xTicks={tickIdx.map((i) => [i, fmtDate(pts[i].date)] as [number, string])}
          tooltip={(i) => <><div className="t3">Week of {fmtDate(pts[i].date, { month: 'short', day: 'numeric', year: 'numeric' })}</div><b>{spct(data[i])}</b></>} />
          : <p className="unavailable">{perf.twr.reason ?? 'Unavailable'}</p>}
        <dl className="ret-metrics">{rows.map(([k, m, f]) => <div key={k}><dt>{k}</dt><dd><MetricValue m={m} f={f} />{m.value == null && m.reason && <small className="t3 ret-reason">{m.reason}</small>}</dd></div>)}</dl>
      </div>
    </Card>
  )
}

export function MonthlyReturns({ perf }: { perf: PerformanceReadModel }) {
  const ms = perf.monthly
  const maxAbs = Math.max(0.0001, ...ms.map((m) => Math.abs(m.value ?? 0)))
  return (
    <Card id="monthly">
      <CardHeader title="Monthly returns" sub="Flow-adjusted" />
      <div className="card-b">
        {ms.length === 0 ? <p className="unavailable">Needs at least two valuations in the period.</p> : (
          <div className="heat" role="list" aria-label="Monthly returns">
            {ms.map((m) => (
              <div key={m.period} role="listitem" className={cx('heat-c', m.value == null ? 'na' : m.value >= 0 ? 'gain' : 'loss')}
                aria-label={`${fmtDate(`${m.period}-01`, { month: 'long', year: 'numeric' })}: ${m.value == null ? 'unavailable' : spct(m.value)}${m.partial ? ', partial month' : ''}`}>
                {m.value != null && <i className="heat-fill" style={{ opacity: 0.35 + 0.65 * Math.min(1, Math.abs(m.value) / maxAbs) }} />}<span className="t3">{fmtDate(`${m.period}-01`, { month: 'short' })}{m.partial ? '*' : ''}</span><b>{m.value == null ? '—' : spct(m.value)}</b>
              </div>
            ))}
          </div>)}
        {ms.some((m) => m.partial) && <small className="t3">* Partial month</small>}
      </div>
    </Card>
  )
}

const ATTR_BY = ['Category', 'Platform', 'Market', 'Side'] as const
type AttrBy = (typeof ATTR_BY)[number]
export function AttributionCard({ stats, open, initial }: { stats: PeriodStats; open: Open; initial: AttrBy }) {
  const [by, setBy] = useState<AttrBy>(initial)
  const groups = useMemo(() => {
    const m = new Map<string, ClosedTrade[]>()
    for (const t of stats.trades) { const k = by === 'Category' ? t.category : by === 'Platform' ? PLATFORM_NAME[t.platform] : by === 'Market' ? t.market : t.side; m.set(k, [...(m.get(k) ?? []), t]) }
    return [...m.entries()].map(([label, ts]) => ({ label, trades: ts, gross: ts.reduce((a, t) => a + tradeGross(t), 0), fees: ts.reduce((a, t) => a + t.fees, 0), net: ts.reduce((a, t) => a + tradeNet(t), 0) })).sort((a, b) => b.net - a.net)
  }, [stats, by])
  const shown = by === 'Market' ? [...groups].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 12) : groups
  const maxAbs = Math.max(1, ...shown.map((g) => Math.abs(g.net)))
  const estFees = stats.trades.some((t) => !t.feeKnown)
  return (
    <Card id="attribution" flush>
      <CardHeader pad title="Attribution" info={HELP.attribution} right={<Seg label="Group by" options={ATTR_BY} value={by} onChange={setBy} />} />
      {groups.length === 0 ? <div className="empty"><p>No trades closed in this period.</p></div> : (
        <div className="dt-wrap"><table className="dt attr-t">
          <thead><tr><th scope="col">{by}</th><th scope="col" className="r">Trades</th><th scope="col" className="r">Before fees</th><th scope="col" className="r">Fees{estFees && <small className="t3"> (incl. est.)</small>}</th><th scope="col" className="r">Realized</th><th scope="col" aria-label="Share" /></tr></thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.label} className="clickable" tabIndex={0} aria-label={`${g.label}: ${sfmt(g.net)} realized across ${count(g.trades.length, 'trade')}. View trades`}
                onClick={() => open(`${g.label} closed trades`, g.trades)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open(`${g.label} closed trades`, g.trades) } }}>
                <td className="mkt">{g.label}</td><td className="r t2">{g.trades.length}</td><td className="r t2">{sfmt(g.gross)}</td><td className="r t3">{fmt(g.fees)}</td>
                <td className={cx('r', g.net >= 0 ? 'gain' : 'loss')}>{sfmt(g.net)}</td>
                <td className="attr-bar"><i className={g.net >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(g.net) / maxAbs) * 100}%` }} /></td>
              </tr>))}
            {shown.length < groups.length && <tr><td colSpan={6} className="t3">{count(groups.length - shown.length, 'smaller market')} not shown</td></tr>}
          </tbody>
          <tfoot>
            <tr><th scope="row">Realized</th><td className="r t2">{stats.trades.length}</td><td className="r t2">{sfmt(stats.realized + stats.trades.reduce((a, t) => a + t.fees, 0))}</td><td className="r t3">{fmt(stats.trades.reduce((a, t) => a + t.fees, 0))}</td><td className={cx('r', stats.realized >= 0 ? 'gain' : 'loss')}>{sfmt(stats.realized)}</td><td /></tr>
            <tr><th scope="row">Change in unrealized</th><td /><td /><td className="r t3">{stats.openFillFees > 0 ? fmt(stats.openFillFees) : ''}</td><td className={cx('r', stats.unrealizedChange >= 0 ? 'gain' : 'loss')}>{sfmt(stats.unrealizedChange)}</td><td /></tr>
            <tr><th scope="row">Net P&amp;L</th><td /><td /><td /><td className={cx('r', stats.netPnl >= 0 ? 'gain' : 'loss')}>{sfmt(stats.netPnl)}</td><td /></tr>
          </tfoot>
        </table></div>)}
    </Card>
  )
}

export function PatternExplorer({ trades, open, scope }: { trades: ClosedTrade[]; open: Open; scope: string }) {
  const [dim, setDim] = useState<CohortDim>('Entry price')
  const cs = useMemo(() => cohorts(trades, dim), [trades, dim])
  const early = dim === 'Exit type' ? insights(trades).earlyExits : null
  const small = cs.some((c) => (c.resolved || c.n) < SMALL)
  return (
    <Card id="patterns" flush>
      <CardHeader pad title="Trading patterns" info={HELP.patterns}
        right={<span className="row">{small && <Chip tone="warn">Limited sample size</Chip>}<select className="select" aria-label="Group trades by" value={dim} onChange={(e) => setDim(e.target.value as CohortDim)}>{COHORT_DIMS.map((d) => <option key={d}>{d}</option>)}</select></span>} />
      {cs.length === 0 ? <div className="empty"><p>No trades closed in this period.</p></div> : (
        <div className="dt-wrap"><table className="dt">
          <thead><tr><th scope="col">{dim}</th><th scope="col" className="r">Trades</th><th scope="col" className="r">Resolved</th><th scope="col">{dim === 'Entry price' ? 'Win rate vs. entry price' : 'Win rate'}</th><th scope="col" className="r">Return on entry</th><th scope="col" className="r">Avg gain</th><th scope="col" className="r">Avg loss</th><th scope="col" className="r">Fees</th><th scope="col" className="r">Net P&amp;L</th></tr></thead>
          <tbody>{cs.map((c) => (
            <tr key={c.key} className="clickable" tabIndex={0} aria-label={`${c.label}: ${count(c.n, 'trade')}, ${sfmt(c.net)}. View trades`}
              onClick={() => open(`${dim}: ${c.label}`, c.trades)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open(`${dim}: ${c.label}`, c.trades) } }}>
              <td className="mkt">{c.label}</td><td className="r t2">{c.n}</td><td className="r t2">{c.resolved}</td>
              <td>{c.winRate == null ? <span className="t3">No resolved trades</span> : c.impliedWinRate != null
                ? <div className="cal"><div className="a" style={{ width: `${c.winRate * 100}%` }} /><div className="m" style={{ left: `${c.impliedWinRate * 100}%` }} /><span>{pct(c.winRate * 100, 0)} <span className="t3">vs {pct(c.impliedWinRate * 100, 0)}</span></span></div>
                : pct(c.winRate * 100, 0)}</td>
              <td className="r">{c.returnOnEntry == null ? <span className="t3">—</span> : spct(c.returnOnEntry, 0)}</td>
              <td className="r t2">{c.avgGain == null ? '—' : fmt(c.avgGain)}</td><td className="r t2">{c.avgLoss == null ? '—' : fmt(c.avgLoss)}</td>
              <td className="r t3">{fmt(c.fees)}</td><td className={cx('r', c.net >= 0 ? 'gain' : 'loss')}>{sfmt(c.net)}</td></tr>))}</tbody>
        </table></div>)}
      {early && <div className="foot"><span>In hindsight, {early.missed} of {count(early.n, 'exit')} before resolution later resolved in your favour, worth about {fmt(early.leftOnTable)} more if held.</span><span>{scope}</span></div>}
    </Card>
  )
}

export function TradeAnalysis({ trades, open, openOne }: { trades: ClosedTrade[]; open: Open; openOne: (t: ClosedTrade) => void }) {
  const [side, setSide] = useState<'Largest gains' | 'Largest losses'>('Largest gains')
  const sorted = [...trades].sort((a, b) => tradeNet(b) - tradeNet(a))
  const list = (side === 'Largest gains' ? sorted.filter((t) => tradeNet(t) > 0) : sorted.reverse().filter((t) => tradeNet(t) < 0)).slice(0, 6)
  const dist = returnDistribution(trades), dmax = Math.max(1, ...dist.bins.map((b) => b.n))
  const act = activityByMonth(trades), burden = feeBurden(trades)
  const markets = byMarket(trades).slice(0, 8)
  if (!trades.length) return <Card><div className="empty"><p>No trades closed in this period.</p></div></Card>
  return (<>
    <div className="grid g-2">
      <Card id="largest">
        <CardHeader title="Largest results" right={<Tabs label="Largest results" options={['Largest gains', 'Largest losses'] as const} value={side} onChange={setSide} />} />
        <div className="card-b">{list.length === 0 ? <p className="t3">None in this period.</p> : list.map((t) => (
          <button type="button" key={t.id} className="list-row list-btn" onClick={() => openOne(t)}>
            <span className="trade-li"><b>{t.market}</b><small className="t3">{t.side}, {t.outcome === 'Closed early' ? 'sold' : t.outcome.toLowerCase()} {fmtDate(t.closed)}</small></span>
            <span className={cx('r', tradeNet(t) >= 0 ? 'gain' : 'loss')}>{sfmt(tradeNet(t), 2)}</span></button>))}</div>
      </Card>
      <Card id="distribution">
        <CardHeader title="Return distribution" sub="Return on entry per closed trade" />
        <div className="card-b">{dist.bins.map((b) => (
          <button type="button" key={b.label} className="dist-row hoverable" disabled={!b.n} onClick={() => open(`Trades returning ${b.label}`, b.trades)} aria-label={`${b.label}: ${count(b.n, 'trade')}${b.n ? '. View trades' : ''}`}>
            <span className="t2">{b.label}</span><span className="dist-bar"><i style={{ width: `${(b.n / dmax) * 100}%` }} /></span><span className="r t2">{b.n}</span><span className={cx('r', b.net >= 0 ? 'gain' : 'loss')}>{b.n ? sfmt(b.net) : ''}</span></button>))}
          {dist.excluded > 0 && <small className="t3">{count(dist.excluded, 'trade')} without an entry notional not shown</small>}
        </div>
      </Card>
    </div>
    <div className="grid g-2">
      <Card id="by-market" flush>
        <CardHeader pad title="By market" />
        <div className="dt-wrap"><table className="dt"><thead><tr><th scope="col">Market</th><th scope="col" className="r">Trades</th><th scope="col" className="r">Fees</th><th scope="col" className="r">Realized</th></tr></thead>
          <tbody>{markets.map((m) => <tr key={m.market} className="clickable" tabIndex={0} onClick={() => open(m.market, m.trades)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open(m.market, m.trades) } }}>
            <td className="mkt">{m.market}</td><td className="r t2">{m.n}</td><td className="r t3">{fmt(m.fees)}</td><td className={cx('r', m.net >= 0 ? 'gain' : 'loss')}>{sfmt(m.net)}</td></tr>)}</tbody></table></div>
      </Card>
      <Card id="activity" flush>
        <CardHeader pad title="Trading activity" right={<span className="t2 fee-burden">Fees <MetricValue m={burden} f={(v) => pct(v * 100, 2)} /> of entry notional{burden.reason === 'Includes estimated fees' && <InfoTip text="Some fees weren’t reported by the source and are estimated." />}</span>} />
        <div className="dt-wrap"><table className="dt"><thead><tr><th scope="col">Month</th><th scope="col" className="r">Closed trades</th><th scope="col" className="r">Entry notional</th><th scope="col" className="r">Fees</th><th scope="col" className="r">Realized</th></tr></thead>
          <tbody>{act.map((a) => <tr key={a.month} className="clickable" tabIndex={0} onClick={() => open(`Trades closed in ${fmtDate(`${a.month}-01`, { month: 'long', year: 'numeric' })}`, a.trades)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open(`Trades closed in ${fmtDate(`${a.month}-01`, { month: 'long', year: 'numeric' })}`, a.trades) } }}>
            <td>{fmtDate(`${a.month}-01`, { month: 'short', year: 'numeric' })}</td><td className="r t2">{a.n}</td><td className="r t2">{kfmt(a.notional)}</td><td className="r t3">{fmt(a.fees)}</td><td className={cx('r', a.net >= 0 ? 'gain' : 'loss')}>{sfmt(a.net)}</td></tr>)}</tbody></table></div>
      </Card>
    </div>
  </>)
}

import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Donut, LineChart } from '../components/charts'
import { useConnect } from '../components/ConnectSources'
import { Icon } from '../components/Icon'
import { Drawer } from '../components/overlays'
import { PositionDrawer } from '../components/PositionDrawer'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, Delta, HeroFigure, Legend, PageHead, Pills, PlatformBadge, Seg, SideChip, Tabs, Tile, cx } from '../components/ui'
import { CLOSED_TRADES, LAST_VISIT, TODAY } from '../data/portfolio'
import { CATEGORIES, CAT_COLOR, PLATFORM_NAME } from '../data/labels'
import type { Category, Platform } from '../data/types'
import { PERIODS, account, coverage, sourceOf, exposures, fmtDate, netPnlAt, periodRange, positionsFor, series, tradeNet, type Period, type PlatformFilter, type Position } from '../lib/finance'
import { fmt, int, kfmt, pct, sfmt } from '../lib/format'

const RAIL: RailSection[] = [
  { id: 'summary', label: 'Summary', icon: 'home' },
  { id: 'holdings', label: 'Holdings', icon: 'list' },
  { id: 'allocation', label: 'Allocation', icon: 'pie' },
  { id: 'upcoming', label: 'Upcoming', icon: 'cal' },
  { id: 'coverage', label: 'Data coverage', icon: 'db' },
]
const PLATFORM_FILTER = ['All', 'Polymarket', 'Kalshi'] as const
type PlatformLabel = (typeof PLATFORM_FILTER)[number]
const toFilter = (l: PlatformLabel): PlatformFilter => (l === 'Polymarket' ? 'pm' : l === 'Kalshi' ? 'ks' : 'all')
type SortKey = 'market' | 'shares' | 'cost' | 'value' | 'upl' | 'days'

export default function Overview() {
  useHashScroll()
  const nav = useNavigate()
  const connect = useConnect()
  const [plat, setPlat] = useState<PlatformLabel>('All')
  const [period, setPeriod] = useState<Period>('6M')
  const [chartTab, setChartTab] = useState<'Value' | 'Net P&L'>('Value')
  const [holdTab, setHoldTab] = useState<'Open positions' | 'Resolved' | 'Activity'>('Open positions')
  const [cat, setCat] = useState<'All categories' | Category>('All categories')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'value', dir: -1 })
  const [allocBy, setAllocBy] = useState<'Category' | 'Platform'>('Category')
  const [hotSlice, setHotSlice] = useState<string | null>(null)
  const [feeReview, setFeeReview] = useState(false)
  const [openPos, setOpenPos] = useState<Position | null>(null)

  const f = toFilter(plat)
  const acct = useMemo(() => account(f), [f])
  const pos = useMemo(() => positionsFor(f), [f])
  const exps = useMemo(() => exposures(f), [f])
  const range = periodRange(period)
  const pts = useMemo(() => series(f, range.start, range.end), [f, range.start, range.end])
  const periodChange = pts[pts.length - 1].netPnl - pts[0].netPnl
  const sinceVisit = useMemo(() => netPnlAt(f, TODAY) - netPnlAt(f, LAST_VISIT), [f])
  const counts = { All: account('all').openCount, Polymarket: account('pm').openCount, Kalshi: account('ks').openCount }

  const rows = useMemo(() => {
    const r = pos.filter((p) => cat === 'All categories' || p.category === cat)
    const get = (p: Position) => (sort.key === 'market' ? p.market : sort.key === 'days' ? p.days : p[sort.key])
    return [...r].sort((a, b) => (get(a) > get(b) ? 1 : -1) * sort.dir)
  }, [pos, cat, sort])

  const movers = useMemo(() => [...pos].map((p) => ({ p, move: (p.mark - p.markAtLastVisit) * p.shares })).sort((a, b) => Math.abs(b.move) - Math.abs(a.move)), [pos])
  const soon = exps.filter((e) => e.days <= 30)
  const soonCost = soon.reduce((a, e) => a + e.cost, 0)
  const crossPlatform = exps.find((e) => e.platforms.length > 1)

  const alloc = useMemo(() => {
    const m = new Map<string, { value: number; color: string; n: number }>()
    for (const p of pos) {
      const k = allocBy === 'Category' ? p.category : PLATFORM_NAME[p.platform]
      const color = allocBy === 'Category' ? CAT_COLOR[p.category] : p.platform === 'pm' ? 'var(--color-platform-polymarket)' : 'var(--color-platform-kalshi)'
      const g = m.get(k) ?? { value: 0, color, n: 0 }
      g.value += p.value; g.n += 1; m.set(k, g)
    }
    return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.value - a.value)
  }, [pos, allocBy])
  const allocTotal = alloc.reduce((a, s) => a + s.value, 0)
  const hot = alloc.find((s) => s.key === hotSlice)
  const singleHeavy = allocBy === 'Category' ? alloc.find((a) => a.n === 1 && a.value / allocTotal > 0.2) : undefined

  const recentClosed = useMemo(() => CLOSED_TRADES.filter((t) => f === 'all' || t.platform === f).sort((a, b) => (a.closed < b.closed ? 1 : -1)).slice(0, 8), [f])
  const activity = useMemo(() => [
    ...pos.flatMap((p) => p.fills.map((fl) => ({ date: fl.date, platform: p.platform, text: `Bought ${int(fl.shares)} ${p.side} · ${p.market} @ ${fl.price.toFixed(2)}` }))),
    ...recentClosed.map((t) => ({ date: t.closed, platform: t.platform, text: `${t.outcome === 'Closed early' ? 'Sold' : `Settled ${t.outcome === 'Won' ? 'in your favour' : 'against you'}`} · ${t.market} · ${sfmt(tradeNet(t), 2)}` })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8), [pos, recentClosed])
  const feeEstimateTrades = CLOSED_TRADES.filter((t) => !t.feeKnown && (f === 'all' || t.platform === f))

  const n = pts.length
  const tickIdx = [...new Set([0, Math.round((n - 1) * 0.25), Math.round((n - 1) * 0.5), Math.round((n - 1) * 0.75), n - 1])]
  const chartSeries = chartTab === 'Value'
    ? [{ data: pts.map((p) => p.deposits), color: 'var(--color-text-tertiary)', dash: '4 4', width: 1.4, step: true }, { data: pts.map((p) => p.value), color: 'var(--color-gain-fg)', area: 0.22, width: 2.2 }]
    : [{ data: pts.map((p) => p.netPnl), color: 'var(--color-gain-fg)', area: 0.22, width: 2.2 }]
  const all = chartSeries.flatMap((s) => s.data)
  const step = chartTab === 'Value' ? 5000 : 2000
  const yMin = Math.floor(Math.min(...(chartTab === 'Value' ? all : [0, ...all])) / step) * step, yMax = Math.ceil(Math.max(...all) / step) * step
  const yTicks: number[] = []
  for (let t = yMin; t <= yMax; t += step) yTicks.push(t)

  const th = (key: SortKey, label: string, right = true) => (
    <th scope="col" className={cx(right && 'r')} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : -1 }))}>
        {label}{sort.key === key && <span className="arr" aria-hidden="true">{sort.dir === 1 ? '↑' : '↓'}</span>}
      </button>
    </th>
  )
  const scope = f === 'all' ? 'Polymarket + Kalshi' : `${plat} only`

  return (
    <div className="shell">
      <SectionRail title="Overview" sections={RAIL}>
        <div className="rail-card">
          <b>Data sources</b>
          {(['pm', 'ks'] as Platform[]).map((p) => (
            <div className="row" key={p}><PlatformBadge p={p} />{PLATFORM_NAME[p]}<span className={cx(sourceOf(p).stale && 'stale')}>{fmtDate(sourceOf(p).asOf)}</span></div>
          ))}
          <button type="button" className="link" style={{ textAlign: 'left' }} onClick={() => connect()}>Manage data sources</button>
        </div>
      </SectionRail>

      <main>
        <PageHead caption={f === 'all' ? 'Sample portfolio · Polymarket + Kalshi' : `Sample portfolio: ${plat} only · ${plat === 'Polymarket' ? 'Kalshi' : 'Polymarket'} excluded`} title="Portfolio overview"
          actions={<><Pills label="Platform" options={PLATFORM_FILTER} value={plat} onChange={setPlat} counts={counts} /></>} />

        <div className="grid g-21">
          <div className="card hero-card">
            <div className="card-h">
              <Tabs label="Chart" options={['Value', 'Net P&L'] as const} value={chartTab} onChange={setChartTab} />
              <Seg label="Period" options={PERIODS} value={period} onChange={setPeriod} />
            </div>
            <div className="card-b">
              <div className="hero-top">
                <div>
                  <div className="caps">{chartTab === 'Value' ? `Portfolio value · ${scope}` : `Net P&L since ${fmtDate(pts[0].date, { month: 'short', year: 'numeric' })} · ${scope}`}</div>
                  <div style={{ marginTop: 'var(--space-2)' }}><HeroFigure value={chartTab === 'Value' ? acct.totalValue : periodChange} /></div>
                  <div className="hero-sub">
                    <Delta value={periodChange}>{periodChange >= 0 ? '▲' : '▼'} {sfmt(periodChange, 2)}</Delta>
                    <span>{period} net P&amp;L (deposits excluded) · all-time {sfmt(acct.netPnl, 2)} on {fmt(acct.netDeposits)} net deposits</span>
                  </div>
                </div>
                {chartTab === 'Value' && <div style={{ marginTop: 'var(--space-6)' }}><Legend items={[{ label: 'Portfolio value', color: 'var(--color-gain-fg)', kind: 'ln' }, { label: 'Net deposits', kind: 'dash' }]} /></div>}
              </div>
              <div style={{ marginTop: 'var(--space-4)' }}>
                <LineChart label={`${chartTab === 'Value' ? 'Portfolio value' : 'Cumulative net P&L'}, ${scope}, ${range.label}: from ${fmt(chartSeries[chartSeries.length - 1].data[0])} to ${fmt(chartSeries[chartSeries.length - 1].data[n - 1])}`}
                  w={820} h={250} min={yMin} max={yMax} yTicks={yTicks} yFmt={kfmt} series={chartSeries}
                  xTicks={tickIdx.map((i) => [i, fmtDate(pts[i].date)] as [number, string])}
                  tooltip={(i) => (<><div className="t3">Week of {fmtDate(pts[i].date, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                    <b>{fmt(chartTab === 'Value' ? pts[i].value : pts[i].netPnl, 2)}</b>
                    {chartTab === 'Value' && <div className="t3" style={{ marginTop: 2 }}>Net deposits {fmt(pts[i].deposits)} · net P&amp;L {sfmt(pts[i].netPnl)}</div>}</>)} />
              </div>
            </div>
          </div>

          <div className="card">
            <CardHeader title="Summary" sub={`Since your last visit · ${fmtDate(LAST_VISIT)} · ${scope}`} />
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              <p className="summary" style={{ fontSize: 'var(--font-size-md)' }}>
                Net P&amp;L {sinceVisit >= 0 ? 'rose' : 'fell'} <b className={sinceVisit >= 0 ? 'gain' : 'loss'}>{sfmt(sinceVisit)}</b> since {fmtDate(LAST_VISIT)}{movers[0] && <>, led by <Link to={`/scenario-lab?add=${movers[0].p.id}`}>{movers[0].p.market}</Link></>}. <b>{pct((acct.committed / acct.totalValue) * 100, 0)}</b> of value is committed to open contracts{soon.length ? <>, and <b>{soon.length} event{soon.length > 1 ? 's' : ''}</b> resolve within 30 days</> : ''}.
              </p>
              <ul className="changes">
                {movers.slice(0, 1).map(({ p, move }) => (
                  <li key={p.id}><span className="ic" style={{ background: move >= 0 ? 'var(--color-gain-bg)' : 'var(--color-loss-bg)', color: move >= 0 ? 'var(--color-gain-fg)' : 'var(--color-loss-fg)' }}>{move >= 0 ? '▲' : '▼'}</span>
                    <div><b>{p.market} {p.side}</b> moved {p.markAtLastVisit.toFixed(2)} → {p.mark.toFixed(2)} ({sfmt(move)}).<br /><button type="button" className="link" onClick={() => setOpenPos(p)}>View</button> <Link to={`/scenario-lab?add=${p.id}`}>Simulate a change →</Link></div></li>
                ))}
                {soon.length > 0 && <li><span className="ic" style={{ background: 'var(--color-warn-bg)', color: 'var(--color-warn-fg)' }}>!</span><div><b>{fmt(soonCost)} resolves within 30 days</b> across {soon.length} event{soon.length > 1 ? 's' : ''}, {pct((soonCost / acct.committed) * 100, 0)} of committed capital.<br /><Link to="/risk#calendar">Open in Risk →</Link></div></li>}
                {crossPlatform && <li><span className="ic" style={{ background: 'var(--color-accent-bg)', color: 'var(--color-accent-fg)' }}>⇄</span><div>Same {crossPlatform.event.short} outcome on <b>two platforms</b>. If it resolves against you: <b className="loss">{sfmt(crossPlatform.pnlAgainst)}</b> combined.<br /><Link to={`/risk?event=${crossPlatform.event.id}#rel`}>See event →</Link></div></li>}
              </ul>
            </div>
          </div>
        </div>

        <div className="tiles">
          <Tile label="Realized P&L" info="Closed trades: shares × (exit − entry) − that trade’s fees. All time." value={sfmt(acct.realized, 2)} tone={acct.realized >= 0 ? 'gain' : 'loss'} foot={`${acct.closedCount} closed · after ${fmt(acct.closedFees, 2)} fees`} />
          <Tile label="Unrealized P&L" info="Open positions at mark price minus average cost, before fees. Fees paid on open fills are subtracted once in net P&L." value={sfmt(acct.unrealized, 2)} tone={acct.unrealized >= 0 ? 'gain' : 'loss'} foot={`${acct.openCount} open · open-fill fees ${fmt(acct.openFees, 2)}`} />
          <Tile label="Capital committed" info="Cost basis of open positions: what you’d lose if every open contract resolved against you." value={fmt(acct.committed)} foot={`${pct((acct.committed / acct.totalValue) * 100, 0)} of portfolio value`} />
          <Tile label="Cash" info="Net deposits + realized P&L − cost and fees of open fills, per platform." value={fmt(acct.cash, 2)} foot={f === 'all' ? `Poly ${fmt(account('pm').cash)} · Kalshi ${fmt(account('ks').cash)}` : `${plat} balance`} />
          <Tile label="Win rate · all time" info="Resolved positions that settled in your favour ÷ all resolved positions (early exits excluded). Small samples are noisy." value={acct.resolved ? `${Math.round((acct.wins / acct.resolved) * 100)}%` : '—'} foot={`${acct.wins} of ${acct.resolved} resolved`} />
        </div>

        <Card id="holdings" flush>
          <div className="card-h" style={{ paddingBottom: 'var(--space-4)', alignItems: 'center' }}>
            <Tabs label="Holdings view" options={['Open positions', 'Resolved', 'Activity'] as const} value={holdTab} onChange={setHoldTab}
              render={(o) => (o === 'Open positions' ? `Open positions · ${pos.length}` : o === 'Resolved' ? `Latest closed · 8 of ${acct.closedCount}` : o)} />
            {holdTab === 'Open positions' && <Pills label="Category" options={['All categories', ...CATEGORIES] as const} value={cat} onChange={setCat} />}
          </div>
          {holdTab === 'Open positions' && (
            <>
              <div className="dt-wrap"><table className="dt">
                <thead><tr>{th('market', 'Market', false)}<th scope="col">Side</th>{th('shares', 'Shares')}<th scope="col" className="r">Avg → Mark</th>{th('cost', 'Cost')}{th('value', 'Value')}{th('upl', 'Unrealized')}<th scope="col">If against / for you</th>{th('days', 'Resolves', false)}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={10}><div className="empty"><p>No open {cat === 'All categories' ? '' : cat} positions{f === 'all' ? '' : ` on ${plat}`}.</p><button type="button" className="link" onClick={() => { setCat('All categories'); setPlat('All') }}>Clear filters</button></div></td></tr>}
                  {rows.map((p) => {
                    const w = (v: number) => Math.min((Math.abs(v) / 8000) * 100, 100)
                    return (
                      <tr key={p.id} className="clickable" tabIndex={0} aria-label={`${p.market}: open details`} onClick={() => setOpenPos(p)} onKeyDown={(e) => e.key === 'Enter' && setOpenPos(p)}>
                        <td className="mkt"><div className="mk"><PlatformBadge p={p.platform} /><div><b>{p.market}</b><small>{p.category} · {PLATFORM_NAME[p.platform]}</small></div></div></td>
                        <td><SideChip side={p.side} /></td>
                        <td className="r">{int(p.shares)}</td>
                        <td className="r"><span className="t3">{p.avg.toFixed(2)}</span> → {p.mark.toFixed(2)}</td>
                        <td className="r t2">{fmt(p.cost)}</td>
                        <td className="r">{fmt(p.value)}</td>
                        <td className={cx('r', p.upl >= 0 ? 'gain' : 'loss')}>{sfmt(p.upl)}</td>
                        <td><div className="row">
                          <span className="loss" style={{ width: 52, textAlign: 'right', fontSize: 'var(--font-size-xs)' }}>{kfmt(p.ifLose)}</span>
                          <div className="payoff" aria-hidden="true"><div className="n"><i style={{ width: `${w(p.cost)}%` }} /></div><div className="z" /><div className="p"><i style={{ width: `${w(p.ifWin)}%` }} /></div></div>
                          <span className="gain" style={{ fontSize: 'var(--font-size-xs)' }}>+{kfmt(p.ifWin).slice(1)}</span>
                        </div></td>
                        <td className="t2">{fmtDate(p.resolves)}</td>
                        <td className="r"><span className="row-act" onClick={(e) => e.stopPropagation()}><Button size="sm" icon="flask" onClick={() => nav(`/scenario-lab?add=${p.id}`)}>Simulate</Button></span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table></div>
              <div className="foot"><span>Mark = last traded price on the platform. Values exclude estimated exit fees. Click a row or press Enter for fills and payoff.</span><span>Sorted by {sort.key} {sort.dir === 1 ? '↑' : '↓'}</span></div>
            </>
          )}
          {holdTab === 'Resolved' && (
            <div className="dt-wrap"><table className="dt">
              <thead><tr><th scope="col">Market</th><th scope="col">Side</th><th scope="col">Outcome</th><th scope="col" className="r">Shares</th><th scope="col" className="r">Entry</th><th scope="col" className="r">Exit</th><th scope="col" className="r">Fees</th><th scope="col" className="r">Net P&amp;L</th><th scope="col">Closed</th></tr></thead>
              <tbody>{recentClosed.map((t) => (
                <tr key={t.id}><td className="mkt"><div className="mk"><PlatformBadge p={t.platform} /><div><b>{t.market}</b><small>{t.category}</small></div></div></td>
                  <td><SideChip side={t.side} /></td><td><Chip tone={t.outcome === 'Closed early' ? 'info' : undefined}>{t.outcome === 'Won' ? '✓ ' : t.outcome === 'Lost' ? '✕ ' : ''}{t.outcome}</Chip></td>
                  <td className="r">{int(t.shares)}</td><td className="r">{t.entry.toFixed(2)}</td><td className="r">{t.exit.toFixed(2)}</td>
                  <td className="r t3">{t.fees ? `${fmt(t.fees, 2)}${t.feeKnown ? '' : ' est.'}` : '—'}</td>
                  <td className={cx('r', tradeNet(t) >= 0 ? 'gain' : 'loss')}>{sfmt(tradeNet(t), 2)}</td><td className="t2">{fmtDate(t.closed)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {holdTab === 'Activity' && (
            <div className="card-b" style={{ paddingTop: 0 }}>
              {activity.map((a) => <div className="list-row" key={a.date + a.text}><PlatformBadge p={a.platform} /><span>{a.text}</span><span className="r t3">{fmtDate(a.date)}</span></div>)}
            </div>
          )}
        </Card>

        <div className="grid g-3">
          <Card id="allocation">
            <CardHeader title="Allocation" sub={`Market value of open positions · ${scope}`} right={<Seg label="Group by" options={['Category', 'Platform'] as const} value={allocBy} onChange={setAllocBy} />} />
            <div className="card-b alloc">
              <Donut parts={alloc.map((a) => ({ key: a.key, value: a.value, color: a.color }))} active={hotSlice} onHover={setHotSlice}
                center={<div><b>{fmt(hot ? hot.value : allocTotal)}</b><span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>{hot ? hot.key : `${pos.length} positions`}</span></div>} />
              <div>
                {alloc.map((a) => (
                  <div key={a.key} className="al-row hoverable" style={{ opacity: hotSlice && hotSlice !== a.key ? 0.45 : 1 }} onMouseEnter={() => setHotSlice(a.key)} onMouseLeave={() => setHotSlice(null)}>
                    <i style={{ background: a.color }} /><span>{a.key}</span><span>{fmt(a.value)}</span><span className="t3 r">{pct((a.value / allocTotal) * 100, 0)}</span>
                  </div>
                ))}
                {singleHeavy && <div style={{ marginTop: 'var(--space-3)' }}><Callout>{singleHeavy.key} is one position: <b>{pct((singleHeavy.value / allocTotal) * 100, 0)}</b> of open value rides on a single contract.</Callout></div>}
              </div>
            </div>
          </Card>

          <Card id="upcoming">
            <CardHeader title="Upcoming resolutions" sub="Next 40 days · capital at stake" right={<Link className="btn btn-sm btn-ghost" to="/risk#calendar">Calendar</Link>} />
            <div className="card-b">
              {exps.filter((e) => e.days <= 40).length === 0 && <div className="empty"><p>Nothing resolves in the next 40 days.</p></div>}
              {exps.filter((e) => e.days <= 40).sort((a, b) => a.days - b.days).map((e) => (
                <Link key={e.event.id} to={`/risk?event=${e.event.id}#payoffs`} className="tl-row">
                  <div className="date"><b>{fmtDate(e.resolves, { day: 'numeric' })}</b><span>{fmtDate(e.resolves, { month: 'short' })}</span></div>
                  <div className="t">{e.event.name} {e.positions.length > 1 && <Chip tone="accent">{e.positions.length} contracts</Chip>}<small>{e.platforms.map((p) => PLATFORM_NAME[p]).join(' + ')} · {e.side} · in {e.days} days</small></div>
                  <span>{fmt(e.cost)}</span>
                </Link>
              ))}
            </div>
          </Card>

          <Card id="coverage">
            <CardHeader title="Data coverage" sub="What these numbers are based on" />
            <div className="card-b">
              <p className="t3" style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--space-2)' }}>Sample portfolio. No account is connected.</p>
              {(['pm', 'ks'] as Platform[]).filter((p) => f === 'all' || p === f).map((p) => {
                const c = coverage(p), src = sourceOf(p)
                return <div className="cov" key={p}><PlatformBadge p={p} /><span>{c.fills} fills · {c.settlements} settlements</span><span className={src.stale ? 'stale' : 't3'} title={src.stale ? 'Older than 24 hours' : undefined}>as of {fmtDate(src.asOf)}{src.stale ? ' · stale' : ''}</span></div>
              })}
              {feeEstimateTrades.length > 0 && <div style={{ marginTop: 'var(--space-3)' }}>
                <Callout tone="warn">{feeEstimateTrades.length} Kalshi settlements have no fee detail, so their fees ({fmt(feeEstimateTrades.reduce((a, t) => a + t.fees, 0), 2)} total) are estimates. <button type="button" className="link" onClick={() => setFeeReview(true)}>Review</button></Callout>
              </div>}
            </div>
          </Card>
        </div>

        <div className="footer-note"><span>Scevia is read-only. It never places trades or holds funds. Figures are for analysis, not investment advice.</span><span>Sample portfolio · fictional data</span></div>
      </main>

      {openPos && <PositionDrawer p={openPos} onClose={() => setOpenPos(null)} />}
      {feeReview && (
        <Drawer title="Settlements with estimated fees" sub={`${sourceOf('ks').label} · as of ${fmtDate(sourceOf('ks').asOf)}`} onClose={() => setFeeReview(false)}>
          <Callout tone="warn">The source didn’t report fees for these settlements. Scevia estimates them at the platform’s fee rate and labels them “est.” everywhere.</Callout>
          {feeEstimateTrades.map((t) => (
            <div className="list-row" key={t.id}><PlatformBadge p={t.platform} /><div><b style={{ fontWeight: 'var(--font-weight-medium)' }}>{t.market}</b><div className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Settled {fmtDate(t.closed)} · estimated fee {fmt(t.fees, 2)}</div></div><span className="r t3">est.</span></div>
          ))}
          <div className="row" style={{ marginTop: 'var(--space-2)' }}><Icon name="info" size={14} /><span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>A newer export from the source replaces these estimates with the reported fees.</span></div>
        </Drawer>
      )}
    </div>
  )
}

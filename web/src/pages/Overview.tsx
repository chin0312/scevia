import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Donut, LineChart } from '../components/charts'
import { Icon } from '../components/Icon'
import { useConnect } from '../components/ConnectSources'
import { Drawer, useToast } from '../components/overlays'
import { PositionDrawer } from '../components/PositionDrawer'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, Delta, HeroFigure, Legend, PageHead, Pills, PlatformBadge, Seg, SideChip, Tabs, Tile, cx } from '../components/ui'
import { ACCOUNT, ACTIVITY, CATEGORIES, CAT_COLOR, PLATFORM_ACCOUNT, PLATFORM_NAME, POSITIONS, RESOLVED, valueSeries, type Category, type DerivedPosition, type Platform } from '../data/portfolio'
import { fmt, int, kfmt, pct, sfmt } from '../lib/format'

const RAIL: RailSection[] = [
  { id: 'summary', label: 'Summary', icon: 'home' },
  { id: 'holdings', label: 'Holdings', icon: 'list' },
  { id: 'allocation', label: 'Allocation', icon: 'pie' },
  { id: 'upcoming', label: 'Upcoming', icon: 'cal', count: 4 },
  { id: 'coverage', label: 'Data coverage', icon: 'db', flag: 2 },
]
const PERIODS = ['1M', '3M', '6M', 'YTD', 'All'] as const
const PERIOD_WEEKS: Record<(typeof PERIODS)[number], number> = { '1M': 5, '3M': 13, '6M': 27, YTD: 27, All: 27 }
const PLATFORM_FILTER = ['All', 'Polymarket', 'Kalshi'] as const
type SortKey = 'market' | 'shares' | 'value' | 'upl' | 'days'

export default function Overview() {
  useHashScroll()
  const nav = useNavigate()
  const toast = useToast()
  const [plat, setPlat] = useState<(typeof PLATFORM_FILTER)[number]>('All')
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>('6M')
  const [chartTab, setChartTab] = useState<'Value' | 'Net P&L'>('Value')
  const [holdTab, setHoldTab] = useState<'Open positions' | 'Resolved' | 'Activity'>('Open positions')
  const [cat, setCat] = useState<'All categories' | Category>('All categories')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'value', dir: -1 })
  const [allocBy, setAllocBy] = useState<'Category' | 'Platform'>('Category')
  const [hotSlice, setHotSlice] = useState<string | null>(null)
  const [coverageOpen, setCoverageOpen] = useState(false)
  const [openPos, setOpenPos] = useState<DerivedPosition | null>(null)
  const connect = useConnect()

  const platKey: Platform | null = plat === 'Polymarket' ? 'pm' : plat === 'Kalshi' ? 'ks' : null
  const scoped = useMemo(() => POSITIONS.filter((p) => !platKey || p.platform === platKey), [platKey])
  // Every headline number follows the platform filter (doc §5.1: never imply the whole portfolio when filtered).
  const pa = platKey ? PLATFORM_ACCOUNT[platKey] : null
  const posValue = scoped.reduce((a, p) => a + p.value, 0)
  const committed = scoped.reduce((a, p) => a + p.cost, 0)
  const upl = scoped.reduce((a, p) => a + p.upl, 0)
  const cash = pa ? pa.cash : ACCOUNT.cash
  const total = posValue + cash
  const realized = pa ? pa.realized : ACCOUNT.realized
  const fees = pa ? pa.fees : ACCOUNT.fees
  const wins = pa ? pa.wins : ACCOUNT.wins
  const resolved = pa ? pa.resolved : ACCOUNT.resolvedCount
  const netPnl = realized + upl
  const factor = total / ACCOUNT.totalValue
  const rows = useMemo(() => {
    const r = scoped.filter((p) => cat === 'All categories' || p.category === cat)
    const get = (p: DerivedPosition) => (sort.key === 'market' ? p.market : sort.key === 'shares' ? p.shares : sort.key === 'value' ? p.value : sort.key === 'upl' ? p.upl : p.days)
    return [...r].sort((a, b) => (get(a) > get(b) ? 1 : -1) * sort.dir)
  }, [scoped, cat, sort])

  const series = useMemo(() => {
    const s = valueSeries(), k = PERIOD_WEEKS[period], from = s.val.length - k
    const val = s.val.slice(from).map((v) => v * factor), dep = s.dep.slice(from).map((v) => v * factor)
    return { val, dep, labels: s.labels.slice(from), pnl: val.map((v, i) => v - dep[i]) }
  }, [period, factor])
  const n = series.val.length
  const tickIdx = Array.from(new Set([0, Math.round(n * 0.25), Math.round(n * 0.5), Math.round(n * 0.75), n - 1]))
  const chartSeries = chartTab === 'Value'
    ? [{ data: series.dep, color: 'var(--color-text-tertiary)', dash: '4 4', width: 1.4, step: true }, { data: series.val, color: 'var(--color-gain-fg)', area: 0.22, width: 2.2 }]
    : [{ data: series.pnl, color: 'var(--color-gain-fg)', area: 0.22, width: 2.2 }]
  const yMin = chartTab === 'Value' ? Math.floor(Math.min(...series.dep, ...series.val) / 5000) * 5000 : 0
  const yMax = chartTab === 'Value' ? Math.ceil(Math.max(...series.val) / 5000) * 5000 + 1000 : 7000
  const yTicks = chartTab === 'Value' ? Array.from({ length: (yMax - yMin) / 5000 + 1 }, (_, i) => yMin + i * 5000).filter((t) => t <= yMax) : [0, 2000, 4000, 6000]
  const periodChange = series.val[n - 1] - series.val[0] - (series.dep[n - 1] - series.dep[0])

  const alloc = useMemo(() => {
    const m = new Map<string, { value: number; color: string }>()
    scoped.forEach((p) => {
      const k = allocBy === 'Category' ? p.category : PLATFORM_NAME[p.platform]
      const color = allocBy === 'Category' ? CAT_COLOR[p.category] : p.platform === 'pm' ? 'var(--color-platform-polymarket)' : 'var(--color-platform-kalshi)'
      m.set(k, { value: (m.get(k)?.value ?? 0) + p.value, color })
    })
    return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.value - a.value)
  }, [scoped, allocBy])
  const allocTotal = alloc.reduce((a, s) => a + s.value, 0)
  const hot = alloc.find((s) => s.key === hotSlice)

  const th = (key: SortKey, label: string, right = true) => (
    <th className={cx('sortable', right && 'r')} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : -1 }))}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.key === key && <span className="arr">{sort.dir === 1 ? '↑' : '↓'}</span>}
    </th>
  )

  return (
    <div className="shell">
      <SectionRail title="Overview" sections={RAIL}>
        <div className="rail-card">
          <b>Connected sources</b>
          <div className="row"><PlatformBadge p="pm" />Polymarket<span>Live</span></div>
          <div className="row"><PlatformBadge p="ks" />Kalshi<span className="stale">CSV · 2d</span></div>
          <button type="button" className="link" style={{ textAlign: 'left' }} onClick={() => connect()}>+ Add source</button>
        </div>
      </SectionRail>

      <main>
        <PageHead caption={plat === 'All' ? 'Connected portfolio · Polymarket + Kalshi' : `Connected portfolio: ${plat} only · ${plat === 'Polymarket' ? 'Kalshi' : 'Polymarket'} excluded`} title="Good evening, Alex"
          actions={<><Pills options={PLATFORM_FILTER} value={plat} onChange={setPlat} counts={{ All: 10, Polymarket: 6, Kalshi: 4 }} /><Button icon="download" onClick={() => toast('Export prepared (prototype: no file generated)', 'info')}>Export</Button></>} />

        <div className="grid g-21">
          <div className="card hero-card">
            <div className="card-h">
              <Tabs options={['Value', 'Net P&L'] as const} value={chartTab} onChange={setChartTab} />
              <Seg label="Period" options={PERIODS} value={period} onChange={setPeriod} />
            </div>
            <div className="card-b">
              <div className="hero-top">
                <div>
                  <div className="caps" style={{ display: 'flex', alignItems: 'center' }}>{chartTab === 'Value' ? 'Total value' : 'Net P&L after fees'}</div>
                  <div style={{ marginTop: 'var(--space-2)' }}><HeroFigure value={chartTab === 'Value' ? total : netPnl} /></div>
                  <div className="hero-sub">
                    <Delta value={periodChange}>{periodChange >= 0 ? '▲' : '▼'} {sfmt(periodChange, 2)}</Delta>
                    <span>{period} change excl. deposits · all-time net P&amp;L {sfmt(netPnl, 2)}{platKey ? ` · ${plat} only` : ' (+21.8%)'}</span>
                  </div>
                </div>
                {chartTab === 'Value' && <div style={{ marginTop: 'var(--space-6)' }}><Legend items={[{ label: 'Portfolio value', color: 'var(--color-gain-fg)', kind: 'ln' }, { label: 'Net deposits', kind: 'dash' }]} /></div>}
              </div>
              <div style={{ marginTop: 'var(--space-4)' }}>
                <LineChart label={`${chartTab === 'Value' ? 'Portfolio value' : 'Net P&L'} over ${period}: from ${fmt(chartTab === 'Value' ? series.val[0] : series.pnl[0])} to ${fmt(chartTab === 'Value' ? series.val[n - 1] : series.pnl[n - 1])}`} w={820} h={250} min={yMin} max={yMax} yTicks={yTicks} yFmt={kfmt} series={chartSeries}
                  xTicks={tickIdx.map((i) => [i, series.labels[i]] as [number, string])} events={period === '6M' || period === 'YTD' || period === 'All' ? [5, 8, 12, 16, 20, 23] : undefined}
                  tooltip={(i) => (<><div className="t3">Week of {series.labels[i]}</div><b>{fmt(chartTab === 'Value' ? series.val[i] : series.pnl[i], 2)}</b>
                    {chartTab === 'Value' && <div className="t3" style={{ marginTop: 2 }}>Net deposits {fmt(series.dep[i])}</div>}</>)} />
              </div>
            </div>
          </div>

          <div className="card">
            <CardHeader title="Summary" sub={`Since your last visit · Nov 19${platKey ? " · all platforms" : ""}`} />
            <div className="card-b" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
              <p className="summary" style={{ fontSize: 'var(--font-size-md)' }}>You’re up <b className="gain">+$418</b> this week, mostly from the <Link to="/scenario-lab?add=shut">shutdown</Link> and <Link to="/risk?event=fed#payoffs">Fed</Link> positions. <b>78%</b> of your value is committed to open contracts, and <b>3 events</b> resolve before Dec 16.</p>
              <ul className="changes">
                <li><span className="ic" style={{ background: 'var(--color-gain-bg)', color: 'var(--color-gain-fg)' }}>▲</span><div><b>Shutdown YES</b> moved 0.41 → 0.47 (+$420). It’s now your 3rd-largest position.<br /><a onClick={() => setCat('Politics')} href="#holdings">View</a><Link to="/scenario-lab?add=shut">Simulate a trim →</Link></div></li>
                <li><span className="ic" style={{ background: 'var(--color-warn-bg)', color: 'var(--color-warn-fg)' }}>!</span><div><b>$7,971 resolves in 22 days</b>, 29% of committed capital.<br /><Link to="/risk#calendar">Open in Risk →</Link></div></li>
                <li><span className="ic" style={{ background: 'var(--color-accent-bg)', color: 'var(--color-accent-fg)' }}>⇄</span><div>Same Fed outcome on <b>two platforms</b>. If NO, you lose <b className="loss">−$4,266</b> combined.<br /><Link to="/risk?event=fed#rel">See event →</Link></div></li>
              </ul>
            </div>
          </div>
        </div>

        <div className="tiles">
          <Tile label="Realized P&L" info="Profit or loss locked in by resolved or sold positions, after trading fees. Excludes deposits and withdrawals." value={sfmt(realized, 2)} tone="gain" foot={`after ${fmt(fees, 2)} fees`} />
          <Tile label="Unrealized P&L" info="Open positions valued at the last traded price on each platform, minus your average cost. Changes as prices move." value={sfmt(upl, 2)} tone={upl >= 0 ? 'gain' : 'loss'} foot={`${scoped.length} open · at mark price`} />
          <Tile label="Capital committed" info="Sum of cost basis of all open positions: the most you could lose if every open contract resolved against you." value={fmt(committed)} foot={`${Math.round((committed / total) * 100)}% of ${platKey ? plat : 'total'} value`} />
          <Tile label="Cash available" info="Uninvested balance reported by each connected platform at last sync." value={fmt(cash, 2)} foot={platKey ? `${plat} balance` : 'Poly $4,102 · Kalshi $2,243'} />
          <Tile label="Win rate · all time" info="Resolved positions that settled in your favour ÷ all resolved positions, since your first trade. Analytics shows the same metric for a chosen period. Small samples are noisy." value={`${Math.round((wins / resolved) * 100)}%`} foot={`${wins} of ${resolved} resolved`} />
        </div>

        <Card id="holdings" flush>
          <div className="card-h" style={{ paddingBottom: 'var(--space-4)', alignItems: 'center' }}>
            <Tabs options={['Open positions', 'Resolved', 'Activity'] as const} value={holdTab} onChange={setHoldTab}
              render={(o) => (o === 'Open positions' ? `Open positions · ${rows.length}` : o === 'Resolved' ? `Resolved · ${ACCOUNT.resolvedCount}` : o)} />
            {holdTab === 'Open positions' && <Pills options={['All categories', ...CATEGORIES] as const} value={cat} onChange={setCat} />}
          </div>
          {holdTab === 'Open positions' && (
            <>
              <div className="dt-wrap"><table className="dt">
                <thead><tr>{th('market', 'Market', false)}<th>Side</th>{th('shares', 'Shares')}<th className="r">Avg → Mark</th><th className="r">Cost</th>{th('value', 'Value')}{th('upl', 'Unrealized')}<th>If against / for you</th>{th('days', 'Resolves', false)}<th /></tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={10}><div className="empty"><p>No open {cat} positions on {plat}.</p><button type="button" className="link" onClick={() => { setCat('All categories'); setPlat('All') }}>Clear filters</button></div></td></tr>}
                  {rows.map((p) => {
                    const w = (v: number) => Math.min((Math.abs(v) / 8000) * 100, 100)
                    return (
                      <tr key={p.id} className="clickable" tabIndex={0} aria-label={`${p.market}: open details`} onClick={() => setOpenPos(p)} onKeyDown={(e) => e.key === 'Enter' && setOpenPos(p)}>
                        <td className="mkt"><div className="mk"><PlatformBadge p={p.platform} /><div><b>{p.market}</b><small>{p.category} · {p.event}</small></div></div></td>
                        <td><SideChip side={p.side} /></td>
                        <td className="r">{int(p.shares)}</td>
                        <td className="r"><span className="t3">{p.avg.toFixed(2)}</span> → {p.mark.toFixed(2)}</td>
                        <td className="r t2">{fmt(p.cost)}</td>
                        <td className="r">{fmt(p.value)}</td>
                        <td className={cx('r', p.upl >= 0 ? 'gain' : 'loss')}>{sfmt(p.upl)}</td>
                        <td><div className="row">
                          <span className="loss" style={{ width: 52, textAlign: 'right', fontSize: 'var(--font-size-xs)' }}>{kfmt(-p.cost)}</span>
                          <div className="payoff"><div className="n"><i style={{ width: `${w(p.cost)}%` }} /></div><div className="z" /><div className="p"><i style={{ width: `${w(p.ifWin)}%` }} /></div></div>
                          <span className="gain" style={{ fontSize: 'var(--font-size-xs)' }}>{'+' + kfmt(p.ifWin).slice(1)}</span>
                        </div></td>
                        <td className="t2">{p.resolves}</td>
                        <td className="r"><span className="row-act" onClick={(e) => e.stopPropagation()}><Button size="sm" icon="flask" onClick={() => nav(`/scenario-lab?add=${p.id}`)}>Simulate</Button></span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table></div>
              <div className="foot"><span>Mark = last traded price on the source platform. Values exclude estimated exit fees. Click a row (or press Enter) for fills and payoff.</span><span>Sorted by {sort.key} {sort.dir === 1 ? '↑' : '↓'}</span></div>
            </>
          )}
          {holdTab === 'Resolved' && (
            <table className="dt">
              <thead><tr><th>Market</th><th>Side</th><th>Outcome</th><th className="r">Shares</th><th className="r">Entry</th><th className="r">Exit</th><th className="r">Fees</th><th className="r">Net P&amp;L</th><th>Closed</th></tr></thead>
              <tbody>{RESOLVED.map((t) => (
                <tr key={t.market}><td><div className="mk"><PlatformBadge p={t.platform} /><div><b>{t.market}</b><small>{t.category}</small></div></div></td>
                  <td><SideChip side={t.side} /></td><td><Chip tone={t.outcome === 'Closed early' ? 'info' : undefined}>{t.outcome === 'Won' ? '✓ ' : t.outcome === 'Lost' ? '✕ ' : ''}{t.outcome}</Chip></td>
                  <td className="r">{int(t.shares)}</td><td className="r">{t.entry.toFixed(2)}</td><td className="r">{t.exit.toFixed(2)}</td><td className="r t3">{t.fees ? fmt(t.fees, 2) : '—'}</td>
                  <td className={cx('r', t.pnl >= 0 ? 'gain' : 'loss')}>{sfmt(t.pnl, 2)}</td><td className="t2">{t.closed}</td></tr>
              ))}</tbody>
            </table>
          )}
          {holdTab === 'Activity' && (
            <div className="card-b" style={{ paddingTop: 0 }}>
              {ACTIVITY.map((a) => (
                <div className="list-row" key={a.text}><PlatformBadge p={a.platform} /><span>{a.text}</span><span className="r t3">{a.at}</span></div>
              ))}
            </div>
          )}
        </Card>

        <div className="grid g-3">
          <Card id="allocation">
            <CardHeader title="Allocation" sub={`Market value of open positions${plat === 'All' ? '' : ` · ${plat}`}`} right={<Seg label="Group by" options={['Category', 'Platform'] as const} value={allocBy} onChange={setAllocBy} />} />
            <div className="card-b alloc">
              <Donut parts={alloc.map((a) => ({ key: a.key, value: a.value, color: a.color }))} active={hotSlice} onHover={setHotSlice}
                center={<div><b>{fmt(hot ? hot.value : allocTotal)}</b><span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>{hot ? hot.key : `${scoped.length} positions`}</span></div>} />
              <div>
                {alloc.map((a) => (
                  <div key={a.key} className={cx('al-row', 'hoverable')} style={{ opacity: hotSlice && hotSlice !== a.key ? 0.45 : 1 }} onMouseEnter={() => setHotSlice(a.key)} onMouseLeave={() => setHotSlice(null)}>
                    <i style={{ background: a.color }} /><span>{a.key}</span><span>{fmt(a.value)}</span><span className="t3 r">{pct((a.value / allocTotal) * 100, 0)}</span>
                  </div>
                ))}
                {allocBy === 'Category' && plat !== 'Polymarket' && <div style={{ marginTop: 'var(--space-3)' }}><Callout>Climate is one position: <b>29%</b> of value rides on a single NOAA report.</Callout></div>}
              </div>
            </div>
          </Card>

          <Card id="upcoming">
            <CardHeader title="Upcoming resolutions" sub="Next 40 days · capital at stake" right={<Link className="btn btn-sm btn-ghost" to="/risk#calendar">Calendar</Link>} />
            <div className="card-b">
              {[...POSITIONS].filter((p) => p.days <= 40 && p.id !== 'fedp').sort((a, b) => a.days - b.days).map((p) => {
                const fed = p.id === 'fedk'
                return (
                  <Link key={p.id} to={`/risk?event=${p.eventId}#payoffs`} className="tl-row">
                    <div className="date"><b>{p.resolves.split(' ')[1]}</b><span>{p.resolves.split(' ')[0]}</span></div>
                    <div className="t">{fed ? 'Dec FOMC decision' : p.market} {fed && <Chip tone="accent">2 contracts</Chip>}<small>{fed ? 'Kalshi + Polymarket' : PLATFORM_NAME[p.platform]} · {p.side} · in {p.days} days</small></div>
                    <span>{fmt(fed ? 4266 : p.cost)}</span>
                  </Link>
                )
              })}
            </div>
          </Card>

          <Card id="coverage">
            <CardHeader title="Data coverage" sub="What these numbers are based on" />
            <div className="card-b">
              <div className="ring-wrap">
                <svg width="56" height="56" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" style={{ stroke: 'var(--color-bg-raised)' }} strokeWidth="4" /><circle cx="18" cy="18" r="15" fill="none" style={{ stroke: 'var(--color-gain-fg)' }} strokeWidth="4" strokeDasharray="92.4 94.3" transform="rotate(-90 18 18)" strokeLinecap="round" /></svg>
                <div><b>98%</b><span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>of fills fully reconciled</span></div>
              </div>
              <div className="cov"><PlatformBadge p="pm" /><span>412 fills · 41 settlements</span><span className="t3">Live · 4m</span></div>
              <div className="cov"><PlatformBadge p="ks" /><span>188 fills · 23 settlements</span><span className="stale" title="Older than 24 hours">CSV · 2d old</span></div>
              <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="link" onClick={() => connect('kalshi')}>Re-import Kalshi CSV</button></div>
              <div style={{ marginTop: 'var(--space-3)' }}>
                <Callout tone="warn">2 Kalshi settlements are missing fee detail. Net P&amp;L may be off by up to $6. <a href="#coverage" onClick={(e) => { e.preventDefault(); setCoverageOpen(true) }}>Review</a></Callout>
              </div>
            </div>
          </Card>
        </div>

        <div className="footer-note"><span>Scevia is read-only. It never places trades or holds funds. Figures are for analysis, not investment advice.</span><span>Sample portfolio · fictional data</span></div>
      </main>

      {openPos && <PositionDrawer p={openPos} onClose={() => setOpenPos(null)} />}
      {coverageOpen && (
        <Drawer title="Settlements missing fee detail" sub="Kalshi CSV import · Nov 22" onClose={() => setCoverageOpen(false)}>
          <Callout tone="warn">Kalshi’s CSV didn’t include fees for these settlements. Scevia shows them as <b>estimated</b> until you confirm.</Callout>
          {[{ m: 'Fed holds at Nov 2026 FOMC', d: 'Nov 5', est: 3.8 }, { m: 'Oct jobs report above 150k', d: 'Nov 1', est: 2.1 }].map((r) => (
            <div className="list-row" key={r.m}><PlatformBadge p="ks" /><div><b style={{ fontWeight: 'var(--font-weight-medium)' }}>{r.m}</b><div className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Settled {r.d} · estimated fee {fmt(r.est, 2)}</div></div>
              <span className="r"><Button size="sm" onClick={() => toast('Fee marked as confirmed (prototype)')}>Confirm estimate</Button></span></div>
          ))}
          <div className="row" style={{ marginTop: 'var(--space-2)' }}><Icon name="info" size={14} /><span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Re-importing a newer CSV usually fills these in automatically.</span></div>
        </Drawer>
      )}
    </div>
  )
}

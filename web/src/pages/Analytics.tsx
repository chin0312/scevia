import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Drawer, useToast } from '../components/overlays'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, Delta, Legend, PageHead, PlatformBadge, Seg, SideChip, Tabs, cx } from '../components/ui'
import { PLATFORM_NAME, RESOLVED, type Category, type Platform } from '../data/portfolio'
import { fmt, kfmt, rng, sfmt } from '../lib/format'

const RAIL: RailSection[] = [
  { id: 'summary', label: 'Summary', icon: 'home' },
  { id: 'highlights', label: 'Highlights', icon: 'grid' },
  { id: 'pnl', label: 'P&L over time', icon: 'trend' },
  { id: 'attribution', label: 'Attribution', icon: 'bars' },
  { id: 'patterns', label: 'Patterns', icon: 'spark', count: 3 },
  { id: 'entry', label: 'Entry price', icon: 'target' },
  { id: 'metrics', label: 'Metrics table', icon: 'table' },
]
const PERIODS = ['1M', '3M', '6M', 'YTD', 'All'] as const
type Period = (typeof PERIODS)[number]
const MONTHS = [{ m: 'Jun', v: 410 }, { m: 'Jul', v: 1180 }, { m: 'Aug', v: -320 }, { m: 'Sep', v: 860 }, { m: 'Oct', v: 540 }, { m: 'Nov', v: 432.35 }]
const PERIOD_MONTHS: Record<Period, number> = { '1M': 1, '3M': 3, '6M': 6, YTD: 6, All: 6 }
const ATTR = {
  Category: [['Economics', 2214.3, 14], ['Climate', 1402.1, 4], ['Politics', 976.85, 6], ['Crypto', -142.6, 8], ['Sports', -304.5, 9], ['Fees', -231.4, null]],
  Platform: [['Polymarket', 1820.4, 24], ['Kalshi', 2325.75, 17], ['Fees', -231.4, null]],
} as const
const BUCKETS = [['$0.00–0.20', 13, 14, 23, -1182], ['$0.20–0.40', 38, 31, 13, 846], ['$0.40–0.60', 58, 51, 19, 1210], ['$0.60–0.80', 77, 70, 22, 1604], ['$0.80–1.00', 91, 88, 11, 512]] as const
const METRICS = [['Net P&L after fees', '+$3,915', '+$2,709', '+$1,206', true], ['Realized P&L', '+$3,102', '+$2,240', '+$862', true], ['Fees paid', '$231', '$264', '−$33', true], ['Resolved trades', '41', '37', '+4', false], ['Win rate', '61%', '57%', '+4 pts', true], ['Average win / loss', '$318 / $224', '$296 / $251', '', false], ['Largest drawdown', '−$1,402', '−$1,980', '+$578', true], ['Best month', 'Jul +$1,180', 'Mar +$904', '', false], ['Worst month', 'Aug −$320', 'Jan −$611', '', false]] as const

type Pattern = 'longshots' | 'exits' | 'economics'
const PATTERN_TRADES: Record<Pattern, { title: string; rows: { p: Platform; m: string; side: 'YES' | 'NO'; entry: number; pnl: number; note: string }[] }> = {
  longshots: { title: 'Longshot trades under $0.25', rows: [
    { p: 'pm', m: 'Lakers win season opener vs. Warriors', side: 'YES', entry: 0.22, pnl: -550, note: 'Lost · Oct 28' },
    { p: 'pm', m: 'ETH above $5k on Oct 31', side: 'YES', entry: 0.19, pnl: -570, note: 'Lost · Oct 31' },
    { p: 'pm', m: 'Dodgers sweep NLCS', side: 'YES', entry: 0.14, pnl: 1290, note: 'Won · Oct 19' },
    { p: 'ks', m: 'Hurricane makes US landfall in Oct', side: 'YES', entry: 0.18, pnl: -360, note: 'Lost · Oct 31' },
    { p: 'pm', m: 'Chiefs lose Week 6', side: 'YES', entry: 0.23, pnl: -460, note: 'Lost · Oct 13' } ] },
  exits: { title: 'Positions sold before resolution', rows: [
    { p: 'ks', m: 'Oct jobs report above 150k', side: 'NO', entry: 0.55, pnl: 253.2, note: 'Sold 0.68 · settled NO (+$900 if held)' },
    { p: 'pm', m: 'Senate confirms Fed nominee by Oct', side: 'YES', entry: 0.48, pnl: 140, note: 'Sold 0.55 · settled YES (+$520 if held)' },
    { p: 'pm', m: 'September CPI below 3%', side: 'YES', entry: 0.61, pnl: 96, note: 'Sold 0.69 · settled NO (avoided −$610)' } ] },
  economics: { title: 'Economics trades', rows: RESOLVED.filter((t) => t.category === 'Economics').map((t) => ({ p: t.platform, m: t.market, side: t.side, entry: t.entry, pnl: t.pnl, note: `${t.outcome} · ${t.closed}` })) },
}

/* Every closed trade in the sample period (for attribution drill-down). */
const ALL_TRADES: { p: Platform; m: string; cat: Category; side: 'YES' | 'NO'; entry: number; pnl: number; note: string }[] = [
  ...RESOLVED.map((t) => ({ p: t.platform, m: t.market, cat: t.category, side: t.side, entry: t.entry, pnl: t.pnl, note: `${t.outcome} · ${t.closed}` })),
  { p: 'pm', m: 'Dodgers sweep NLCS', cat: 'Sports', side: 'YES', entry: 0.14, pnl: 1290, note: 'Won · Oct 19' },
  { p: 'pm', m: 'Chiefs lose Week 6', cat: 'Sports', side: 'YES', entry: 0.23, pnl: -460, note: 'Lost · Oct 13' },
  { p: 'ks', m: 'Hurricane makes US landfall in Oct', cat: 'Climate', side: 'YES', entry: 0.18, pnl: -360, note: 'Lost · Oct 31' },
  { p: 'pm', m: 'BTC above $120k on Sep 30', cat: 'Crypto', side: 'YES', entry: 0.41, pnl: 427.4, note: 'Won · Sep 30' },
  { p: 'ks', m: 'Fed holds at Sep 2026 FOMC', cat: 'Economics', side: 'NO', entry: 0.58, pnl: -612, note: 'Lost · Sep 17' },
  { p: 'pm', m: 'House passes CR before Oct 1', cat: 'Politics', side: 'NO', entry: 0.66, pnl: -503.15, note: 'Lost · Sep 29' },
]

function PnlChart({ months, tab, showPrior }: { months: { m: string; v: number }[]; tab: 'Net' | 'Realized' | 'By platform'; showPrior: boolean }) {
  const W = 760, H = 330, P = { l: 48, r: 12, t: 16, b: 26 }
  const wk = months.length * 4 + 1
  const data = useMemo(() => {
    const r = rng(7 + months.length), cum: number[] = [], prior: number[] = [], pm: number[] = []
    let c = 0, pc = 0, p = 0
    const target = months.reduce((a, x) => a + x.v, 0) * 1.26
    for (let i = 0; i < wk; i++) { c += (r() - 0.38) * 320; pc += (r() - 0.43) * 260; p += (r() - 0.4) * 160; cum.push(c); prior.push(pc); pm.push(p) }
    const adj = (target - cum[wk - 1]) / (wk - 1)
    const pmAdj = (target * 0.44 - pm[wk - 1]) / (wk - 1)
    return { cum: cum.map((v, i) => v + adj * i), prior, pm: pm.map((v, i) => v + pmAdj * i) }
  }, [months, wk])
  const ks = data.cum.map((v, i) => v - data.pm[i])
  const realizedCum = months.reduce<number[]>((a, m) => [...a, (a.at(-1) ?? 0) + m.v], [])
  const all = [...data.cum, ...data.prior, 0, ...months.map((m) => m.v), ...realizedCum]
  const min = Math.floor(Math.min(...all) / 1000) * 1000, max = Math.ceil(Math.max(...all) / 1000) * 1000 + 500
  const y = (v: number) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b)
  const x = (i: number) => P.l + (i / (wk - 1)) * (W - P.l - P.r)
  const bw = (W - P.l - P.r) / months.length
  const path = (d: number[]) => d.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const ticks: number[] = []
  for (let t = min; t <= max; t += 1000) ticks.push(t)
  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ overflow: 'visible' }} onPointerLeave={() => setHover(null)}>
        <g className="axis">
          {ticks.map((t) => <g key={t}><line className={t ? 'grid-l' : 'zero'} x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} strokeDasharray={t ? '2 4' : undefined} /><text x={P.l - 10} y={y(t) + 4} textAnchor="end">{t ? kfmt(t) : '$0'}</text></g>)}
          {months.map((m, i) => <text key={m.m} x={P.l + i * bw + bw / 2} y={H - 6} textAnchor="middle">{m.m}</text>)}
        </g>
        {tab !== 'By platform' && months.map((m, i) => {
          const bx = P.l + i * bw + bw * 0.25, w = bw * 0.5, col = m.v >= 0 ? 'var(--color-gain-fg)' : 'var(--color-loss-fg)'
          return (
            <g key={m.m} className="hoverable" onPointerEnter={() => setHover(i)}>
              <rect x={P.l + i * bw} y={P.t} width={bw} height={H - P.t - P.b} className="hit" />
              <rect x={bx} y={Math.min(y(m.v), y(0))} width={w} height={Math.abs(y(m.v) - y(0))} rx={4} style={{ fill: col }} opacity={hover === i ? 0.5 : 0.28} />
              <text className="lbl" x={bx + w / 2} y={m.v >= 0 ? y(m.v) - 6 : y(m.v) + 14} textAnchor="middle" style={{ fill: col }}>{sfmt(m.v)}</text>
            </g>
          )
        })}
        {showPrior && tab === 'Net' && <path d={path(data.prior)} fill="none" style={{ stroke: 'var(--color-text-tertiary)' }} strokeDasharray="4 4" strokeWidth={1.3} />}
        {tab === 'Net' && <path d={path(data.cum)} fill="none" style={{ stroke: 'var(--color-text-primary)' }} strokeWidth={2.2} strokeLinejoin="round" />}
        {tab === 'Realized' && <path d={realizedCum.map((v, i) => `${i ? 'L' : 'M'}${P.l + i * bw + bw / 2},${y(v)}`).join('')} fill="none" style={{ stroke: 'var(--color-text-primary)' }} strokeWidth={2.2} />}
        {tab === 'By platform' && <>
          <path d={path(data.pm)} fill="none" style={{ stroke: 'var(--color-platform-polymarket)' }} strokeWidth={2.2} />
          <path d={path(ks)} fill="none" style={{ stroke: 'var(--color-platform-kalshi)' }} strokeWidth={2.2} />
        </>}
      </svg>
      {hover != null && tab !== 'By platform' && (
        <div className="tip" style={{ left: `${((P.l + hover * bw + bw / 2) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}>
          <div className="t3">{months[hover].m} 2026</div><b className={months[hover].v >= 0 ? 'gain' : 'loss'}>{sfmt(months[hover].v, 2)}</b> realized
        </div>
      )}
    </div>
  )
}

export default function Analytics() {
  useHashScroll()
  const toast = useToast()
  const [period, setPeriod] = useState<Period>('6M')
  const [compare, setCompare] = useState(true)
  const [tab, setTab] = useState<'Net' | 'Realized' | 'By platform'>('Net')
  const [attrBy, setAttrBy] = useState<'Category' | 'Platform'>('Category')
  const [pattern, setPattern] = useState<Pattern | null>(null)
  const [group, setGroup] = useState<string | null>(null)
  const [hotBucket, setHotBucket] = useState<number | null>(null)
  const months = MONTHS.slice(-PERIOD_MONTHS[period])
  const realized = months.reduce((a, m) => a + m.v, 0)
  const net = period === '6M' || period === 'YTD' || period === 'All' ? 3914.75 : realized * 1.26
  const label = period === '1M' ? 'Nov 2026' : period === '3M' ? 'Sep 1 – Nov 24, 2026' : 'Jun 1 – Nov 24, 2026'

  return (
    <div className="shell">
      <SectionRail title="Analytics" sections={RAIL}>
        <div className="rail-card"><b>Definitions</b>Net P&amp;L = realized + unrealized − fees. Deposits and withdrawals never count as performance.</div>
      </SectionRail>
      <main>
        <PageHead caption={`Performance · ${label}`} title="Where your results come from"
          actions={<>
            <Seg label="Period" options={PERIODS} value={period} onChange={setPeriod} />
            <Button icon="compare" variant={compare ? undefined : 'ghost'} onClick={() => setCompare((c) => !c)}>{compare ? 'Comparing to prior' : 'Compare to prior'}</Button>
            <Button icon="download" onClick={() => toast('Export prepared (prototype: no file generated)', 'info')}>Export</Button>
          </>} />

        <p className="summary">Over this period you made <b className="gain">{sfmt(net, 2)}</b> after fees{compare && <>, <b>$1,206 more</b> than the prior period</>}. <a href="#attribution">Economics</a> produced over half of it. Your weak spot is <a href="#patterns" onClick={() => setPattern('longshots')}>longshot contracts under $0.25</a>, which lost <b className="loss">−$1,182</b> across 23 trades. Your worst stretch was August, after the <Link to="/risk?event=fed#payoffs">Fed hold</Link>.</p>

        <Card id="highlights">
          <CardHeader title="Highlights" sub={compare ? 'Compared with the prior period' : 'This period'} />
          <div className="card-b hl">
            <div className="hl-group"><h5 className="caps">Return</h5>
              <div className="hl-tile good"><div className="l">Net P&amp;L</div><div className="v gain">{sfmt(net)}</div><div className="f">{compare ? '▲ $1,206 vs prior' : 'after fees'}</div></div>
              <div className="hl-tile good"><div className="l">Return on capital deployed</div><div className="v gain">+14.4%</div><div className="f">{compare ? '▲ 3.1 pts vs prior' : 'net P&L ÷ avg committed'}</div></div>
            </div>
            <div className="hl-group"><h5 className="caps">Risk &amp; consistency</h5>
              <div className="hl-tile bad"><div className="l">Largest drawdown</div><div className="v loss">−$1,402</div><div className="f">Aug 4 – Aug 19 · recovered in 24 days</div></div>
              <div className="hl-tile neutral"><div className="l">Win rate <span className="t3">· n = 41</span></div><div className="v">61%</div><div className="f">profit factor 1.42</div></div>
            </div>
          </div>
        </Card>

        <div className="grid g-21">
          <Card id="pnl">
            <CardHeader title="Cumulative net P&L" sub="Line: cumulative · Bars: realized each month (hover for detail)" right={<Tabs options={['Net', 'Realized', 'By platform'] as const} value={tab} onChange={setTab} />} />
            <div className="card-b">
              <PnlChart months={months} tab={tab} showPrior={compare} />
              <div style={{ marginTop: 'var(--space-3)' }}>
                <Legend items={tab === 'By platform'
                  ? [{ label: 'Polymarket', color: 'var(--color-platform-polymarket)', kind: 'ln' }, { label: 'Kalshi', color: 'var(--color-platform-kalshi)', kind: 'ln' }]
                  : [{ label: tab === 'Net' ? 'Cumulative net P&L' : 'Cumulative realized', color: 'var(--color-text-primary)', kind: 'ln' }, { label: 'Realized gain month', color: 'var(--color-gain-fg)' }, { label: 'Realized loss month', color: 'var(--color-loss-fg)' }, ...(compare && tab === 'Net' ? [{ label: 'Prior period', kind: 'dash' as const }] : [])]} />
              </div>
            </div>
          </Card>
          <Card id="attribution">
            <CardHeader title="Attribution" sub="Net P&L by group, after fees · click a row for its trades" right={<Seg label="Group by" options={['Category', 'Platform'] as const} value={attrBy} onChange={setAttrBy} />} />
            <div className="card-b">
              {ATTR[attrBy].map(([k, v, n]) => (
                <div className={cx('attr', k !== 'Fees' && 'hoverable')} key={k} role={k !== 'Fees' ? 'button' : undefined} tabIndex={k !== 'Fees' ? 0 : undefined}
                  title={k !== 'Fees' ? `See ${k} trades` : undefined}
                  onClick={() => k !== 'Fees' && setGroup(k)} onKeyDown={(e) => e.key === 'Enter' && k !== 'Fees' && setGroup(k)}>
                  <span className={k === 'Fees' ? 't3' : ''}>{k}</span>
                  <div className="ng">{v < 0 && <i style={{ width: `${(-v / 2400) * 100}%` }} />}</div>
                  <div className="ps">{v > 0 && <i style={{ width: `${(v / 2400) * 100}%` }} />}</div>
                  <span className={cx('r', v >= 0 ? 'gain' : 'loss')}>{sfmt(v)}</span><span className="r t3">{n ?? '—'}</span>
                </div>
              ))}
              <div className="attr" style={{ fontWeight: 'var(--font-weight-semibold)' }}><span>Net</span><span /><span /><span className="r gain">+$3,915</span><span className="r t3">41</span></div>
              <div style={{ marginTop: 'var(--space-4)' }}><Callout>{attrBy === 'Category' ? <><b>Economics</b> made 53% of gains from 34% of trades. <a onClick={() => setPattern('economics')} href="#attribution">See Economics trades</a></> : <>Kalshi earned more from fewer trades, mostly Economics and Climate contracts.</>}</Callout></div>
            </div>
          </Card>
        </div>

        <section id="patterns" className="anchor grid g-3">
          <div className="card insight"><Chip tone="no">Losses</Chip><h4>Longshots under $0.25 cost you <span className="loss">−$1,182</span></h4><p>You won 3 of 23 (13%). Their entry prices implied about 14%. Most of these were Sports.</p><div className="meta"><span>n = 23 · moderate confidence</span><button type="button" className="link" onClick={() => setPattern('longshots')}>See trades →</button></div></div>
          <div className="card insight"><Chip tone="info">Exits</Chip><h4>Early exits left <span className="gain">+$640</span> on the table</h4><p>9 of 14 positions you sold early later settled in your favour. This is hindsight: you also avoided risk.</p><div className="meta"><span>n = 14 · hindsight view</span><button type="button" className="link" onClick={() => setPattern('exits')}>Review exits →</button></div></div>
          <div className="card insight"><Chip tone="yes">Strength</Chip><h4>Economics is your most consistent category</h4><p>71% win rate, and no single trade is more than 18% of the category’s P&amp;L. The result isn’t one lucky outcome.</p><div className="meta"><span>n = 14 · small sample</span><button type="button" className="link" onClick={() => setPattern('economics')}>Open category →</button></div></div>
        </section>

        <div className="grid g-2">
          <Card id="entry">
            <CardHeader title="Entry price vs. outcome" sub="How often you won vs. what the price implied · hover a row" />
            <div className="card-b">
              <div className="bucket t3" style={{ fontSize: 'var(--font-size-xs)', paddingTop: 0 }}><span>Entry price</span><span>Your win rate · ▏implied</span><span className="r">Trades</span><span className="r">Net P&amp;L</span></div>
              {BUCKETS.map(([l, w, im, n, p], i) => (
                <div key={l} className="bucket hoverable" style={{ opacity: hotBucket != null && hotBucket !== i ? 0.45 : 1 }} onMouseEnter={() => setHotBucket(i)} onMouseLeave={() => setHotBucket(null)}>
                  <span className="mono">{l}</span>
                  <div className="cal"><div className="a" style={{ width: `${w}%` }} /><div className="m" style={{ left: `${im}%` }} /><span>{w}% <span className="t3">vs {im}%</span></span></div>
                  <span className="r">{n}</span><span className={cx('r', p >= 0 ? 'gain' : 'loss')}>{sfmt(p)}</span>
                </div>
              ))}
              <div style={{ marginTop: 'var(--space-3)' }}>
                {hotBucket != null
                  ? <Callout>{BUCKETS[hotBucket][1] >= BUCKETS[hotBucket][2] ? 'You won slightly more often than' : 'You won less often than'} the price implied in this bucket ({BUCKETS[hotBucket][1]}% vs {BUCKETS[hotBucket][2]}%, n = {BUCKETS[hotBucket][3]}).</Callout>
                  : <Callout tone="warn">Every bucket has fewer than 30 trades, so these gaps may be noise. Treat this as something to watch, not a verdict.</Callout>}
              </div>
            </div>
          </Card>
          <Card id="metrics" flush>
            <CardHeader pad title="Metrics" sub={compare ? 'This period vs. prior period' : 'This period'} right={<Button size="sm" variant="ghost" icon="download" onClick={() => toast('CSV prepared (prototype)', 'info')}>CSV</Button>} />
            <table className="dt cmp">
              <thead><tr><th>Metric</th><th className="r">This period</th>{compare && <><th className="r">Prior period</th><th className="r">Change</th></>}</tr></thead>
              <tbody>{METRICS.map(([k, a, b, d, good]) => (
                <tr key={k}><td>{k}</td><td className="r">{a}</td>{compare && <><td className="r t3">{b}</td><td className="r">{d ? <Delta tone={good ? 'gain' : 'flat'}>{d}</Delta> : <span className="t3">—</span>}</td></>}</tr>
              ))}</tbody>
            </table>
          </Card>
        </div>

        <div className="footer-note"><span>Analytics describe past results. They don’t predict future ones and aren’t investment advice.</span><span>Sample portfolio · fictional data</span></div>
      </main>

      {group && (() => {
        const list = ALL_TRADES.filter((t) => (attrBy === 'Category' ? t.cat === group : PLATFORM_NAME[t.p] === group)).sort((a, b) => a.pnl - b.pnl)
        return (
          <Drawer title={`${group} · closed trades`} sub={`${label} · sorted worst first`} onClose={() => setGroup(null)}>
            {list.length === 0 && <div className="empty"><p>No closed trades in this group for the sample period.</p></div>}
            {list.map((r) => (
              <div className="list-row" key={r.m}><PlatformBadge p={r.p} />
                <div><b style={{ fontWeight: 'var(--font-weight-medium)' }}>{r.m}</b><div className="t3" style={{ fontSize: 'var(--font-size-xs)' }}><SideChip side={r.side} /> entry {r.entry.toFixed(2)} · {r.note}</div></div>
                <span className={cx('r', r.pnl >= 0 ? 'gain' : 'loss')}>{sfmt(r.pnl, 2)}</span>
              </div>
            ))}
            <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>A sample of the trades in this group. In the real product this lists every fill with its source.</p>
          </Drawer>
        )
      })()}
      {pattern && (
        <Drawer title={PATTERN_TRADES[pattern].title} sub="Sample trades behind this insight" onClose={() => setPattern(null)}>
          {PATTERN_TRADES[pattern].rows.map((r) => (
            <div className="list-row" key={r.m}><PlatformBadge p={r.p} />
              <div><b style={{ fontWeight: 'var(--font-weight-medium)' }}>{r.m}</b><div className="t3" style={{ fontSize: 'var(--font-size-xs)' }}><SideChip side={r.side} /> entry {r.entry.toFixed(2)} · {r.note}</div></div>
              <span className={cx('r', r.pnl >= 0 ? 'gain' : 'loss')}>{sfmt(r.pnl, 2)}</span>
            </div>
          ))}
          <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Showing {PATTERN_TRADES[pattern].rows.length} of the trades in this group. Totals: {fmt(PATTERN_TRADES[pattern].rows.reduce((a, r) => a + Math.abs(r.pnl), 0))} gross.</p>
        </Drawer>
      )}
    </div>
  )
}

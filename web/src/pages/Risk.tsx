import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Modal, useToast } from '../components/overlays'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, Legend, PageHead, PlatformBadge, Seg, Tabs, Tile, cx } from '../components/ui'
import { ACCOUNT, CAT_COLOR, COMMITTED, EVENTS, PLATFORM_NAME, POSITIONS, eventStats } from '../data/portfolio'
import { REL_TEXT, useCryptoRelation, type RelClass } from '../data/relations'
import { fmt, kfmt, sfmt } from '../lib/format'

const RAIL: RailSection[] = [
  { id: 'summary', label: 'Exposure summary', icon: 'home' },
  { id: 'conc', label: 'Concentration', icon: 'bars' },
  { id: 'ladder', label: 'Downside ladder', icon: 'ladder' },
  { id: 'payoffs', label: 'Outcome payoffs', icon: 'table', count: 9 },
  { id: 'rel', label: 'Relationships', icon: 'link', flag: 1 },
  { id: 'calendar', label: 'Resolution calendar', icon: 'cal' },
]
const EVENT_CHIP: Record<RelClass, { tone: 'yes' | 'info' | 'warn' | 'accent'; text: string }> = {
  equivalent: { tone: 'accent', text: '2 contracts' }, related: { tone: 'info', text: 'Related' }, unknown: { tone: 'warn', text: '? Unknown link' }, mutex: { tone: 'accent', text: 'Mutually exclusive' },
}

export default function Risk() {
  useHashScroll()
  const nav = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const focus = params.get('event')
  const [groupBy, setGroupBy] = useState<'By event' | 'By category' | 'By platform'>('By event')
  const [limit, setLimit] = useState(15)
  const [editLimit, setEditLimit] = useState<number | null>(null)
  const [filter, setFilter] = useState<'All events' | 'Next 30 days' | 'Over guardrail'>('All events')
  const [cryptoRel, setCryptoRel] = useCryptoRelation()
  const [classify, setClassify] = useState<RelClass | null>(null)
  const [hotStep, setHotStep] = useState<number | null>(null)
  const [hotCal, setHotCal] = useState<string | null>(null)
  const [range, setRange] = useState<'90 days' | '12 months'>('90 days')

  const events = useMemo(() => EVENTS.map((e) => {
    const s = eventStats(e)
    const relation: RelClass | undefined = e.relation === 'unk' ? cryptoRel : e.relation === 'eq' ? 'equivalent' : e.relation === 'macro' ? 'related' : undefined
    return { ...e, ...s, relation, pct: (s.cost / COMMITTED) * 100 }
  }).sort((a, b) => b.cost - a.cost), [cryptoRel])

  const groups = useMemo(() => {
    if (groupBy === 'By event') return events.map((e) => ({ key: e.id, name: e.name, cost: e.cost, platforms: e.platforms, pct: e.pct }))
    const m = new Map<string, { cost: number; platforms: Set<'pm' | 'ks'> }>()
    POSITIONS.forEach((p) => {
      const k = groupBy === 'By category' ? p.category : PLATFORM_NAME[p.platform]
      const g = m.get(k) ?? { cost: 0, platforms: new Set() }
      g.cost += p.cost; g.platforms.add(p.platform); m.set(k, g)
    })
    return [...m.entries()].map(([k, g]) => ({ key: k, name: k, cost: g.cost, platforms: [...g.platforms], pct: (g.cost / COMMITTED) * 100 })).sort((a, b) => b.cost - a.cost)
  }, [groupBy, events])
  const groupLimit = groupBy === 'By event' ? limit : groupBy === 'By category' ? 40 : 100
  const scale = Math.max(32, Math.ceil(groups[0].pct / 10) * 10 + 4)
  const over = events.filter((e) => e.pct > limit)
  const top3 = events.slice(0, 3).reduce((a, e) => a + e.cost, 0)
  const rows = events.filter((e) => filter === 'All events' || (filter === 'Next 30 days' ? e.days <= 30 : e.pct > limit))
  const ladder = events.reduce<number[]>((a, e) => [...a, (a.at(-1) ?? 0) + e.cost], [])
  // Doc §5.4: only feasible joint outcomes. If BTC and ETH are mutually exclusive, both can't resolve YES.
  const mutexCut = cryptoRel === 'mutex' && rows.some((e) => e.id === 'btc') && rows.some((e) => e.id === 'eth')
    ? Math.min(...events.filter((e) => e.id === 'btc' || e.id === 'eth').map((e) => e.win)) : 0

  return (
    <div className="shell">
      <SectionRail title="Risk" sections={RAIL}>
        <div><h6 className="caps" style={{ paddingLeft: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>Guardrails</h6>
          <ol>
            <li><a href="#conc" onClick={(e) => { e.preventDefault(); setEditLimit(limit) }}><Icon name="shield" />Event ≤ {limit}%<span className="count">edit</span></a></li>
            <li><a href="#conc" onClick={(e) => { e.preventDefault(); toast('Category guardrail editing is not in this prototype', 'info') }}><Icon name="shield" />Category ≤ 40%</a></li>
          </ol>
        </div>
        <div className="rail-card"><b>How risk is measured</b>Deterministic payoffs: what you gain or lose if each event resolves one way or the other. Scevia never assigns probabilities.</div>
      </SectionRail>

      <main>
        <PageHead caption="Risk · 10 positions across 9 events" title="What you’re exposed to"
          actions={<><Seg label="Group by" options={['By event', 'By category', 'By platform'] as const} value={groupBy} onChange={setGroupBy} /><Link className="btn btn-primary" to="/scenario-lab"><Icon name="flask" size={15} />Stress-test in Lab</Link></>} />

        <p className="summary">You have <b>{fmt(COMMITTED)}</b> committed across 9 events. {over.length > 0
          ? <><b>{over.length === 1 ? 'One event' : `${over.length} events`}</b> ({over.map((e) => e.name).join(', ')}) {over.length === 1 ? 'is' : 'are'} above your <a href="#conc" onClick={(e) => { e.preventDefault(); setEditLimit(limit) }}>{limit}% guardrail</a>.</>
          : <>No event is above your <a href="#conc" onClick={(e) => { e.preventDefault(); setEditLimit(limit) }}>{limit}% guardrail</a>.</>} If your three largest events all went against you, you’d lose <b className="loss">{sfmt(-top3)}</b> ({Math.round((top3 / ACCOUNT.totalValue) * 100)}% of your portfolio). <b>$6,396</b> resolves in a single week (Dec 10–16).</p>

        <div className="tiles">
          <Tile label="Capital committed" info="Sum of cost basis across open positions." value={fmt(COMMITTED)} foot="78% of total value" />
          <Tile label="If everything goes against you" info="Assumes every open event resolves against your side at the same time. Some events may not be independent." value={sfmt(-COMMITTED)} tone="loss" foot={`${fmt(ACCOUNT.cash)} cash would remain`} />
          <Tile label="Largest single event" info="Capital committed to one event (positions on the same outcome across platforms are combined) ÷ total committed." value={`${events[0].pct.toFixed(1)}%`} tone={events[0].pct > limit ? 'warn' : undefined} foot={events[0].pct > limit ? `over ${limit}% guardrail` : `within ${limit}% guardrail`} />
          <Tile label="Top-3 concentration" info="Share of committed capital in your three largest events." value={`${Math.round((top3 / COMMITTED) * 100)}%`} foot={`${fmt(top3)} of committed`} />
          <Tile label="Resolving ≤ 30 days" info="Capital committed to events whose resolution date is within 30 days." value="$7,971" foot="3 events · first on Dec 2" />
        </div>

        <div className="grid g-21">
          <Card id="conc">
            <CardHeader title={`${groupBy.replace('By ', '').replace(/^./, (c) => c.toUpperCase())} concentration`} sub="Capital committed · same outcome on 2 platforms counts once"
              right={<Legend items={[{ label: 'Within guardrail', color: 'var(--color-data-1)' }, { label: `Over ${groupLimit}%`, color: 'var(--color-warn-fg)' }]} />} />
            <div className="card-b">
              {groups.map((g) => (
                <div key={g.key} className={cx('conc', groupBy === 'By event' && 'hoverable')} {...(groupBy === 'By event' ? { role: 'button', tabIndex: 0, onKeyDown: (ev: React.KeyboardEvent) => ev.key === 'Enter' && nav(`/risk?event=${g.key}#payoffs`) } : {})} onClick={() => groupBy === 'By event' && nav(`/risk?event=${g.key}#payoffs`)}>
                  <span className="nm">{g.platforms.map((p) => <PlatformBadge key={p} p={p} />)}<span>{g.name}</span></span>
                  <div className="cbar"><i className={cx(g.pct > groupLimit && 'over')} style={{ width: `${(g.pct / scale) * 100}%` }} />{groupLimit < scale && <span className="lim" style={{ left: `${(groupLimit / scale) * 100}%` }} />}</div>
                  <span className="r">{fmt(g.cost)}</span><span className="r t3">{g.pct.toFixed(1)}%</span>
                </div>
              ))}
              {groupBy === 'By event' && <div style={{ marginTop: 'var(--space-3)' }}><Button size="sm" variant="ghost" onClick={() => setEditLimit(limit)}>Edit {limit}% guardrail</Button></div>}
            </div>
          </Card>
          <Card id="ladder">
            <CardHeader title="Downside ladder" sub="Loss if your N largest events all go against you · hover a step" />
            <div className="card-b">
              <svg viewBox="0 0 480 220" width="100%" style={{ overflow: 'visible' }} className="chart" role="img" aria-label={`Downside ladder: largest event ${sfmt(-events[0].cost)}, top three ${sfmt(-top3)}, all events ${sfmt(-COMMITTED)}`} onPointerLeave={() => setHotStep(null)}>
                <g className="axis">{[0, 10000, 20000, 30000].map((t) => <g key={t}><line className="grid-l" x1={48} x2={470} y1={10 + (t / 30000) * 182} y2={10 + (t / 30000) * 182} strokeDasharray="2 4" /><text x={40} y={14 + (t / 30000) * 182} textAnchor="end">{t ? `−${kfmt(t)}` : '$0'}</text></g>)}
                  {events.map((_, i) => <text key={i} x={48 + i * 46.9 + 23} y={212} textAnchor="middle">{i + 1}</text>)}</g>
                {events.map((e, i) => {
                  const bw = 46.9, x0 = 48 + i * bw, y = (v: number) => 10 + (v / 30000) * 182, prev = i ? ladder[i - 1] : 0
                  const on = hotStep == null ? i < 3 : i <= hotStep
                  return (
                    <g key={e.id} onPointerEnter={() => setHotStep(i)} className="hoverable">
                      <rect x={x0} y={10} width={bw} height={182} className="hit" />
                      <rect x={x0 + 3} y={y(0)} width={bw - 6} height={y(prev) - y(0)} rx={3} style={{ fill: 'var(--color-loss-fg)' }} opacity={0.14} />
                      <rect x={x0 + 3} y={y(prev)} width={bw - 6} height={Math.max(y(ladder[i]) - y(prev), 2)} rx={3} style={{ fill: 'var(--color-loss-fg)' }} opacity={on ? 0.9 : 0.4} />
                    </g>
                  )
                })}
              </svg>
              <div className="ministat">
                {hotStep == null ? <>
                  <div><div className="l">Largest event</div><div className="v loss">{sfmt(-events[0].cost)}</div></div>
                  <div><div className="l">Top 3 events</div><div className="v loss">{sfmt(-top3)}</div></div>
                  <div><div className="l">All macro</div><div className="v loss">−$10,346</div></div>
                </> : <>
                  <div style={{ gridColumn: 'span 2' }}><div className="l">If your top {hotStep + 1} event{hotStep ? 's' : ''} go against you</div><div className="v loss">{sfmt(-ladder[hotStep])}</div></div>
                  <div><div className="l">Adds</div><div className="v t2" style={{ fontSize: 'var(--font-size-sm)' }}>{events[hotStep].name}</div></div>
                </>}
              </div>
            </div>
          </Card>
        </div>

        <Card id="payoffs" flush>
          <CardHeader pad title="Outcome payoffs" sub="P&L at resolution vs. cost basis · fees excluded · click a row to simulate" right={<Tabs options={['All events', 'Next 30 days', 'Over guardrail'] as const} value={filter} onChange={setFilter} />} />
          <div className="po-row h"><span>Event · your side</span><span>Resolves</span><span>If it resolves for you</span><span>If it resolves against you</span><span className="r">Share</span></div>
          {rows.length === 0 && <div className="empty"><p>No events match “{filter}”.</p></div>}
          {rows.map((e) => {
            const rel = e.relation ? EVENT_CHIP[e.relation] : null
            return (
              <div key={e.id} className={cx('po-row', 'hoverable', focus === e.id && 'sel')} style={focus === e.id ? { background: 'var(--color-accent-bg)' } : undefined}
                onClick={() => nav(`/scenario-lab?add=${e.ids[0]}`)} title="Open in Scenario Lab" role="button" tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && nav(`/scenario-lab?add=${e.ids[0]}`)}>
                <div className="mk">{e.platforms.map((p) => <PlatformBadge key={p} p={p} />)}<div><b>{e.name}</b><span className="row" style={{ marginTop: 'var(--space-1)', gap: 'var(--space-1)' }}><Chip tone={e.side === 'YES' ? 'yes' : 'no'}>{e.side}</Chip>{rel && <Chip tone={rel.tone}>{rel.text}</Chip>}</span></div></div>
                <span>{e.resolves}<br /><small className="t3">in {e.days} days</small></span>
                <div className="po"><div className="bar"><i style={{ width: `${(e.win / 8000) * 100}%`, background: 'var(--color-gain-fg)' }} /></div><span className="gain">{sfmt(e.win)}</span></div>
                <div className="po"><div className="bar"><i style={{ width: `${(e.cost / 8000) * 100}%`, background: 'var(--color-loss-fg)' }} /></div><span className="loss">{sfmt(-e.cost)}</span></div>
                <span className="r" style={e.pct > limit ? { color: 'var(--color-warn-fg)' } : undefined}>{e.pct.toFixed(1)}%</span>
              </div>
            )
          })}
          <div className="po-row t"><span>{filter === 'All events' ? 'All events' : `${rows.length} events shown`}</span><span /><span className="gain r">{sfmt(rows.reduce((a, e) => a + e.win, 0) - mutexCut)} <small className="t3">best case{mutexCut ? '†' : ''}</small></span><span className="loss r">{sfmt(-rows.reduce((a, e) => a + e.cost, 0))} <small className="t3">worst case*</small></span><span className="r">{rows.reduce((a, e) => a + e.pct, 0).toFixed(0)}%</span></div>
          <div className="foot"><span>* Assumes every event can go against you at once. Some pairs may not be independent{cryptoRel === 'unknown' ? '; 1 relationship is unclassified (unmodeled dependency)' : ''}.{mutexCut ? ' † Best case excludes BTC and ETH both resolving YES (mutually exclusive).' : ''}</span></div>
        </Card>

        <div className="grid g-12">
          <Card id="rel">
            <CardHeader title="Event relationships" sub="How positions that may move together are treated" right={<Button size="sm" icon="link" onClick={() => toast('Contract mapping is not in this prototype', 'info')}>Map contracts</Button>} />
            <div className="card-b">
              <div className="rel"><div className="h"><b>Dec 2026 FOMC decision</b><Chip tone="yes">✓ Equivalent contract · confirmed</Chip></div>
                <div className="leg"><PlatformBadge p="ks" />Fed cuts rates at Dec FOMC · YES</div><div className="leg"><PlatformBadge p="pm" />Fed rate cut in December? · YES</div>
                <p>Same source and date, combined as one event. If NO: <span className="loss">−$4,266</span>.</p></div>
              <div className="rel"><div className="h"><b>US macro outlook</b><Chip tone="info">Related but non-equivalent</Chip></div>
                <p>Fed cut (YES) · Nov CPI &gt; 3% (NO) · 2027 recession (NO). These share drivers but resolve on different rules, so they aren’t combined. <Link to="/scenario-lab" style={{ color: 'var(--color-text-primary)', textDecoration: 'underline' }}>Model them together</Link></p></div>
              <div className={cx('rel', cryptoRel === 'unknown' && 'unk')}><div className="h"><b>BTC year-end · ETH ETF flows</b><Chip tone={REL_TEXT[cryptoRel].tone}>{REL_TEXT[cryptoRel].label}</Chip></div>
                <p>{cryptoRel === 'unknown' ? <>Probably correlated, but Scevia can’t confirm it. Worst-case totals treat them as independent and are marked <i>unmodeled dependency</i>.</> : `Classified by you as “${REL_TEXT[cryptoRel].label}”. Scenario Lab uses this too.`} <button type="button" className="link" onClick={() => setClassify(cryptoRel)}>{cryptoRel === 'unknown' ? 'Classify' : 'Change'}</button></p></div>
            </div>
          </Card>
          <Card id="calendar">
            <CardHeader title="Resolution calendar" sub="When capital is released or lost · circle area = capital at stake" right={<Seg label="Range" options={['90 days', '12 months'] as const} value={range} onChange={setRange} />} />
            <div className="card-b">
              <Calendar range={range} hot={hotCal} setHot={setHotCal} onPick={(id) => nav(`/risk?event=${id}#payoffs`)} />
              <div style={{ marginTop: 'var(--space-3)' }}><Callout tone="warn"><b>$6,396</b> resolves between Dec 10 and Dec 16. One bad week could cost 18% of your portfolio.</Callout></div>
            </div>
          </Card>
        </div>

        <div className="footer-note"><span>Payoffs assume each contract settles at $1 or $0 as written. Scevia does not estimate how likely each outcome is.</span><span>Sample portfolio · fictional data</span></div>
      </main>

      {editLimit != null && (
        <Modal title="Single-event guardrail" sub="Flag any event that holds more than this share of committed capital" onClose={() => setEditLimit(null)}
          footer={<><Button variant="ghost" onClick={() => setEditLimit(null)}>Cancel</Button><Button variant="primary" onClick={() => { setLimit(editLimit); setEditLimit(null); toast(`Guardrail set to ${editLimit}%`) }}>Save guardrail</Button></>}>
          <div className="row"><span className="hero-fig" style={{ fontSize: 'var(--font-size-display)' }}>{editLimit}%</span></div>
          <input className="slider" type="range" min={5} max={40} step={1} value={editLimit} onChange={(e) => setEditLimit(Number(e.target.value))} aria-label="Guardrail percent" />
          <Callout>{events.filter((e) => e.pct > editLimit).length} event(s) would be over this limit. Guardrails only flag. Scevia never trades for you.</Callout>
        </Modal>
      )}
      {classify && (
        <Modal title="Classify relationship" sub="Bitcoin above $150k (Dec 31) · ETH ETF inflows > $1B (Nov)" onClose={() => setClassify(null)}
          footer={<><Button variant="ghost" onClick={() => setClassify(null)}>Cancel</Button><Button variant="primary" onClick={() => { setCryptoRel(classify); setClassify(null); toast('Relationship saved') }}>Save</Button></>}>
          {([['related', 'They share drivers. Shown together; outcomes are never netted.'], ['mutex', 'Both can’t resolve YES. Scenario Lab and best-case totals drop that combination.'], ['unknown', 'Keep flagged as an unmodeled dependency.']] as const).map(([k, d]) => (
            <label key={k} className={cx('choice', classify === k && 'on')}><input type="radio" name="rel" checked={classify === k} onChange={() => setClassify(k)} /><span>{REL_TEXT[k].label}<small>{d}</small></span></label>
          ))}
          <label className="choice" style={{ opacity: 0.5, cursor: 'not-allowed' }}><input type="radio" name="rel" disabled /><span>{REL_TEXT.equivalent.label}<small>Not available: these contracts resolve on different rules and dates. Similar titles don’t mean the same settlement.</small></span></label>
        </Modal>
      )}
    </div>
  )
}

function Calendar({ range, hot, setHot, onPick }: { range: '90 days' | '12 months'; hot: string | null; setHot: (k: string | null) => void; onPick: (id: string) => void }) {
  const W = 560, base = 150, L = 16, R = 16, days = range === '90 days' ? 90 : 420
  const x = (d: number) => L + (d / days) * (W - L - R)
  const ticks = range === '90 days' ? [['Nov 24', 0], ['Dec 1', 7], ['Dec 15', 21], ['Jan 1', 38], ['Jan 15', 52], ['Feb 1', 69], ['Feb 15', 83]] as const : [['Nov', 0], ['Jan', 38], ['Mar', 97], ['May', 158], ['Jul', 219], ['Sep', 281], ['Nov ’27', 341], ['Jan', 403]] as const
  const evs = EVENTS.filter((e) => e.days <= days).map((e) => ({ ...e, cost: eventStats(e).cost })).sort((a, b) => a.days - b.days)
  const h = evs.find((e) => e.id === hot)
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} 200`} width="100%" style={{ overflow: 'visible' }}>
        <g className="axis">{ticks.map(([t, d]) => <g key={t + d}><line className="grid-l" x1={x(d)} x2={x(d)} y1={24} y2={base} strokeDasharray="2 4" /><text x={x(d)} y={base + 20} textAnchor="middle">{t}</text></g>)}</g>
        {range === '90 days' && <rect x={x(16)} y={24} width={x(22) - x(16)} height={base - 24} style={{ fill: 'var(--color-warn-fg)' }} opacity={0.08} />}
        <line x1={L} x2={W - R} y1={base} y2={base} style={{ stroke: 'var(--color-border-strong)' }} />
        {evs.map((e) => {
          const r = Math.sqrt(e.cost) / (range === '90 days' ? 3.3 : 4.2), cy = base - r - 3
          return <circle key={e.id} className={cx('hoverable')} cx={x(e.days)} cy={cy} r={r} style={{ fill: CAT_COLOR[e.category], stroke: 'var(--color-bg-surface)' }} strokeWidth={2} opacity={hot && hot !== e.id ? 0.35 : 0.9}
            onMouseEnter={() => setHot(e.id)} onMouseLeave={() => setHot(null)} onClick={() => onPick(e.id)} />
        })}
        <line x1={x(0)} x2={x(0)} y1={14} y2={base} style={{ stroke: 'var(--color-accent-fg)' }} strokeWidth={1.5} />
        <text className="lbl" x={x(0) + 5} y={16} style={{ fill: 'var(--color-accent-fg)' }}>TODAY</text>
      </svg>
      {h && <div className="tip" style={{ left: `${(x(h.days) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}><div className="t3">{h.resolves} · in {h.days} days</div><b>{h.name}</b><div>{kfmt(h.cost)} at stake</div></div>}
    </div>
  )
}

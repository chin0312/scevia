import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { useWidth } from '../components/charts'
import { useDetails } from '../components/details'
import { Modal, useToast } from '../components/overlays'
import { RelationshipModal } from '../components/relationships'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, Legend, PageHead, PlatformBadge, Seg, Tabs, Tile, cx } from '../components/ui'
import { TODAY } from '../data/portfolio'
import { CATEGORIES, CAT_COLOR, PLATFORM_NAME } from '../data/labels'
import { REL_TEXT, useRelations, type RelClass } from '../data/relations'
import { account, addDays, baseHoldings, exposures, fmtDate, positionsFor, settlementRange, settlementRangeFor, type EventExposure } from '../lib/finance'
import { fmt, kfmt, pct, sfmt } from '../lib/format'
import { useSessionState } from '../lib/useSessionState'

const RAIL: RailSection[] = [
  { id: 'summary', label: 'Exposure summary', icon: 'home' },
  { id: 'exposure', label: 'Exposure', icon: 'bars', children: [{ id: 'conc', label: 'Concentration' }, { id: 'ladder', label: 'Downside ladder' }] },
  { id: 'payoffs', label: 'Outcome payoffs', icon: 'table' },
  { id: 'context', label: 'Relationships & timing', icon: 'link', children: [{ id: 'rel', label: 'Event relationships' }, { id: 'calendar', label: 'Resolution calendar' }] },
]
const MACRO = ['fed', 'cpi', 'rec']

/** Largest capital resolving inside any 7-day window within `days`. */
function busiestWeek(exps: EventExposure[], days = 90) {
  const near = exps.filter((e) => e.days <= days)
  let best = { cost: 0, from: '', to: '', n: 0 }
  for (const e of near) {
    const inWin = near.filter((x) => x.resolves >= e.resolves && x.resolves <= addDays(e.resolves, 6))
    const cost = inWin.reduce((a, x) => a + x.cost, 0)
    if (cost > best.cost) best = { cost, from: e.resolves, to: inWin.reduce((m, x) => (x.resolves > m ? x.resolves : m), e.resolves), n: inWin.length }
  }
  return best
}

export default function Risk() {
  useHashScroll()
  const nav = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const focus = params.get('event')
  const { crypto, rels } = useRelations()
  const details = useDetails()
  const [groupBy, setGroupBy] = useState<'By event' | 'By category' | 'By platform'>('By event')
  const [limit, setLimit] = useSessionState('scevia-guardrail', 15)
  const [editLimit, setEditLimit] = useState<number | null>(null)
  const [filter, setFilter] = useState<'All events' | 'Next 30 days' | 'Over guardrail'>('All events')
  const [classify, setClassify] = useState(false)
  const [hotStep, setHotStep] = useState<number | null>(null)
  const [hotCal, setHotCal] = useState<string | null>(null)
  const [range, setRange] = useState<'90 days' | '12 months'>('90 days')

  const acct = account('all')
  const exps = useMemo(() => exposures('all'), [])
  const committed = acct.committed
  const relationOf = (id: string): RelClass | null => {
    if (exps.find((e) => e.event.id === id)!.positions.length > 1) return 'equivalent'
    for (const r of rels) if (r.a === id || r.b === id) return r.cls
    return null
  }
  const groups = useMemo(() => {
    if (groupBy === 'By event') return exps.map((e) => ({ key: e.event.id, name: e.event.name, cost: e.cost, platforms: e.platforms, ids: e.positions.map((p) => p.id) }))
    const keys = groupBy === 'By category' ? CATEGORIES : (['pm', 'ks'] as const)
    return keys.map((k) => {
      const ps = positionsFor('all').filter((p) => (groupBy === 'By category' ? p.category === k : p.platform === k))
      return { key: k, name: groupBy === 'By category' ? k : PLATFORM_NAME[k as 'pm' | 'ks'], cost: ps.reduce((a, p) => a + p.cost, 0), platforms: [...new Set(ps.map((p) => p.platform))], ids: ps.map((p) => p.id) }
    }).filter((g) => g.cost > 0).sort((a, b) => b.cost - a.cost)
  }, [groupBy, exps])
  const groupLimit = groupBy === 'By event' ? limit : groupBy === 'By category' ? 40 : 100
  const shareOf = (c: number) => (c / committed) * 100
  const scale = Math.max(32, Math.ceil(shareOf(groups[0].cost) / 10) * 10 + 4)
  const over = exps.filter((e) => shareOf(e.cost) > limit)
  const top3 = exps.slice(0, 3).reduce((a, e) => a + e.cost, 0)
  const rows = exps.filter((e) => filter === 'All events' || (filter === 'Next 30 days' ? e.days <= 30 : shareOf(e.cost) > limit))
  const ladder = exps.reduce<number[]>((a, e) => [...a, (a.at(-1) ?? 0) + e.cost], [])
  const ladderMax = Math.max(10000, Math.ceil((ladder.at(-1) ?? 0) / 10000) * 10000)
  const ladderTicks = Array.from({ length: ladderMax / 10000 + 1 }, (_, i) => i * 10000)
  const [ladderRef, LW] = useWidth<HTMLDivElement>(480)
  const macroCost = exps.filter((e) => MACRO.includes(e.event.id)).reduce((a, e) => a + e.cost, 0)
  const soon = exps.filter((e) => e.days <= 30)
  const week = busiestWeek(exps)

  // Portfolio scope: always every holding. Table scope: only the filtered rows. Both exclude impossible joint outcomes.
  const portfolio = settlementRange(Object.values(baseHoldings()), rels)
  const shownIds = new Set(rows.map((e) => e.event.id))
  const table = settlementRangeFor([...shownIds], rels)
  const unclassifiedPair = crypto === 'unknown' && shownIds.has('btc') && shownIds.has('eth')
  const worstValue = acct.cash + committed + portfolio.min
  const openEvent = (id: string) => details.open({ kind: 'event', id })
  // Explicit hand-off: the Lab asks which scenario and which of these holdings to add before changing anything.
  const stressIds = rows.map((e) => e.event.id)
  const stressTest = () => nav(`/scenario-lab?addEvent=${stressIds.join(',')}`)

  return (
    <div className="shell">
      <SectionRail title="Risk" sections={RAIL}>
        <div className="rail-extra"><h6 className="caps" style={{ paddingLeft: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>Guardrails</h6>
          <ol>
            <li><a href="#conc" onClick={(e) => { e.preventDefault(); setEditLimit(limit) }}><Icon name="shield" />Event ≤ {limit}%<span className="count">edit</span></a></li>
          </ol>
        </div>
        <div className="rail-card"><b>How risk is measured</b>Deterministic payoffs: what you gain or lose if each event resolves one way or the other. Scevia never assigns probabilities.</div>
      </SectionRail>

      <main>
        <PageHead caption={`Risk · ${acct.openCount} positions across ${exps.length} events`} title="What you’re exposed to"
          actions={<><Seg label="Group by" options={['By event', 'By category', 'By platform'] as const} value={groupBy} onChange={setGroupBy} /><Button variant="primary" onClick={stressTest} disabled={stressIds.length === 0} title={`Choose a scenario and which of the ${stressIds.length} events in the payoff table to add`}><Icon name="flask" size={15} />Stress-test in Lab…</Button></>} />

        <p className="summary">You have <b>{fmt(committed)}</b> committed across {exps.length} events. {over.length > 0
          ? <><b>{over.length === 1 ? 'One event' : `${over.length} events`}</b> ({over.map((e) => e.event.short).join(', ')}) {over.length === 1 ? 'is' : 'are'} above your <button type="button" className="link" onClick={() => setEditLimit(limit)}>{limit}% guardrail</button>.</>
          : <>No event is above your <button type="button" className="link" onClick={() => setEditLimit(limit)}>{limit}% guardrail</button>.</>} If your three largest events all went against you, you’d lose <b className="loss">{sfmt(-top3)}</b> ({pct((top3 / acct.totalValue) * 100, 0)} of portfolio value).{week.n > 1 && <> <b>{fmt(week.cost)}</b> resolves within one week ({fmtDate(week.from)}–{fmtDate(week.to)}).</>}</p>

        <div className="tiles">
          <Tile label="Capital committed" info="Cost basis of open positions." value={fmt(committed)} foot={`${pct((committed / acct.totalValue) * 100, 0)} of portfolio value`} />
          <Tile label="Worst feasible outcome" info="Lowest settlement P&L of the whole portfolio across joint outcomes that are possible given confirmed relationships. Unclassified pairs can go either way. Not affected by the table filter below." value={sfmt(portfolio.min)} tone="loss" foot={`You’d hold ${fmt(worstValue)} (cash + payouts)`} />
          <Tile label="Largest single event" info="Capital committed to one event (the same outcome across platforms counts once) ÷ total committed." value={pct(shareOf(exps[0].cost))} tone={shareOf(exps[0].cost) > limit ? 'warn' : undefined} foot={`${exps[0].event.short} · ${shareOf(exps[0].cost) > limit ? `over ${limit}% guardrail` : `within ${limit}%`}`} />
          <Tile label="Top-3 concentration" info="Share of committed capital in your three largest events." value={pct(shareOf(top3), 0)} foot={`${fmt(top3)} of committed`} />
          <Tile label="Resolving ≤ 30 days" info="Capital committed to events that resolve within 30 days." value={fmt(soon.reduce((a, e) => a + e.cost, 0))} foot={soon.length ? `${soon.length} events · first ${fmtDate([...soon].sort((a, b) => a.days - b.days)[0].resolves)}` : 'none'} />
        </div>

        <div className="grid g-21 anchor" id="exposure">
          <Card id="conc">
            <CardHeader title={`${groupBy.replace('By ', '').replace(/^./, (c) => c.toUpperCase())} concentration`} sub="Capital committed · the same outcome on 2 platforms counts once · select a row for details"
              right={<Legend items={[{ label: 'Within guardrail', color: 'var(--color-data-1)' }, { label: `Over ${groupLimit}%`, color: 'var(--color-warn-fg)' }]} />} />
            <div className="card-b">
              {groups.map((g) => {
                const s = shareOf(g.cost)
                const go = () => groupBy === 'By event' ? openEvent(g.key)
                  : details.open({ kind: 'group', title: g.name, sub: `${fmt(g.cost)} committed · ${s.toFixed(1)}% of committed capital`, ids: g.ids })
                return (
                  <button type="button" key={g.key} className="conc conc-btn hoverable" aria-label={`${g.name}: ${s.toFixed(1)}% of committed capital, view details`} onClick={go}>
                    <span className="nm">{g.platforms.map((p) => <PlatformBadge key={p} p={p} />)}<span>{g.name}</span></span>
                    <div className="cbar"><i className={cx(s > groupLimit && 'over')} style={{ width: `${(s / scale) * 100}%` }} />{groupLimit < scale && <span className="lim" style={{ left: `${(groupLimit / scale) * 100}%` }} />}</div>
                    <span className="r">{fmt(g.cost)}</span><span className="r t3">{s.toFixed(1)}%</span>
                  </button>
                )
              })}
              {groupBy === 'By event' && <div style={{ marginTop: 'var(--space-3)' }}><Button size="sm" variant="ghost" onClick={() => setEditLimit(limit)}>Edit {limit}% guardrail</Button></div>}
            </div>
          </Card>
          <Card id="ladder">
            <CardHeader title="Downside ladder" sub="Loss if your N largest events all go against you · hover a step, select it for the event" />
            <div className="card-b">
              <div ref={ladderRef}><svg viewBox={`0 0 ${LW} 220`} width="100%" style={{ overflow: 'visible' }} className="chart" role="group" aria-label={`Downside ladder: largest event ${sfmt(-exps[0].cost)}, top three ${sfmt(-top3)}, all events ${sfmt(-committed)}`} onPointerLeave={() => setHotStep(null)}>
                <g className="axis">{ladderTicks.map((t) => <g key={t}><line className="grid-l" x1={48} x2={LW - 10} y1={10 + (t / ladderMax) * 182} y2={10 + (t / ladderMax) * 182} strokeDasharray="2 4" /><text x={40} y={14 + (t / ladderMax) * 182} textAnchor="end">{t ? `−${kfmt(t)}` : '$0'}</text></g>)}
                  {exps.map((_, i) => <text key={i} x={48 + (i + 0.5) * ((LW - 58) / exps.length)} y={212} textAnchor="middle">{i + 1}</text>)}</g>
                {exps.map((e, i) => {
                  const bw = (LW - 58) / exps.length, x0 = 48 + i * bw, y = (v: number) => 10 + (v / ladderMax) * 182, prev = i ? ladder[i - 1] : 0
                  const on = hotStep == null ? i < 3 : i <= hotStep
                  return (
                    <g key={e.event.id} onPointerEnter={() => setHotStep(i)} onFocus={() => setHotStep(i)} onBlur={() => setHotStep(null)} className="hoverable step" role="button" tabIndex={0}
                      aria-label={`Step ${i + 1}: adds ${e.event.name}, cumulative ${sfmt(-ladder[i])}. View event exposure`} onClick={() => openEvent(e.event.id)} onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), openEvent(e.event.id))}>
                      <rect x={x0} y={10} width={bw} height={182} className="hit" />
                      <rect x={x0 + 3} y={y(0)} width={bw - 6} height={y(prev) - y(0)} rx={3} style={{ fill: 'var(--color-loss-fg)' }} opacity={0.14} />
                      <rect x={x0 + 3} y={y(prev)} width={bw - 6} height={Math.max(y(ladder[i]) - y(prev), 2)} rx={3} style={{ fill: 'var(--color-loss-fg)' }} opacity={on ? 0.9 : 0.4} />
                    </g>
                  )
                })}
              </svg></div>
              <div className="ministat">
                {hotStep == null ? <>
                  <div><div className="l">Largest event</div><div className="v loss">{sfmt(-exps[0].cost)}</div></div>
                  <div><div className="l">Top 3 events</div><div className="v loss">{sfmt(-top3)}</div></div>
                  <div><div className="l">Macro cluster (related)</div><div className="v loss">{sfmt(-macroCost)}</div></div>
                </> : <>
                  <div style={{ gridColumn: 'span 2' }}><div className="l">If your top {hotStep + 1} event{hotStep ? 's' : ''} go against you</div><div className="v loss">{sfmt(-ladder[hotStep])}</div></div>
                  <div><div className="l">Adds</div><button type="button" className="link v t2" style={{ fontSize: 'var(--font-size-sm)', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => openEvent(exps[hotStep].event.id)}>{exps[hotStep].event.name}</button></div>
                </>}
              </div>
              <p className="t3" style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-2)' }}>The ladder adds events as if they could all go against you together. It doesn’t say how likely that is.</p>
            </div>
          </Card>
        </div>

        <Card id="payoffs" flush>
          <CardHeader pad title="Outcome payoffs" sub="P&L at settlement vs. cost basis (fees already paid not included) · select a row for every contract behind the event" right={<Tabs label="Filter events" options={['All events', 'Next 30 days', 'Over guardrail'] as const} value={filter} onChange={setFilter} />} />
          <div className="po-row h"><span>Event · your side</span><span>Resolves</span><span>If it resolves for you</span><span>If it resolves against you</span><span className="r">Share</span></div>
          {rows.length === 0 && <div className="empty"><p>No events match “{filter}”. This filter only changes the table: the portfolio’s worst feasible outcome is still <b className="loss">{sfmt(portfolio.min)}</b>.</p><button type="button" className="link" onClick={() => setFilter('All events')}>Show all events</button></div>}
          {rows.map((e) => {
            const rel = relationOf(e.event.id)
            const chip = rel === 'equivalent' ? { tone: 'accent' as const, text: `${e.positions.length} contracts · equivalent` } : rel ? { tone: REL_TEXT[rel].tone, text: REL_TEXT[rel].short } : null
            return (
              <button type="button" key={e.event.id} className={cx('po-row', 'po-btn', 'hoverable', focus === e.event.id && 'sel')} style={focus === e.event.id ? { background: 'var(--color-accent-bg)' } : undefined}
                onClick={() => openEvent(e.event.id)} aria-label={`${e.event.name}, ${e.positions.length} contract${e.positions.length > 1 ? 's' : ''}: view event exposure`}>
                <div className="mk">{e.platforms.map((p) => <PlatformBadge key={p} p={p} />)}<div><b>{e.event.name}</b><span className="row" style={{ marginTop: 'var(--space-1)', gap: 'var(--space-1)' }}><Chip tone={e.side === 'YES' ? 'yes' : 'no'}>{e.side}</Chip>{chip && <Chip tone={chip.tone}>{chip.text}</Chip>}</span></div></div>
                <span>{fmtDate(e.resolves)}<br /><small className="t3">in {e.days} days</small></span>
                <div className="po"><div className="bar"><i style={{ width: `${(e.pnlFor / 8000) * 100}%`, background: 'var(--color-gain-fg)' }} /></div><span className="gain">{sfmt(e.pnlFor)}</span></div>
                <div className="po"><div className="bar"><i style={{ width: `${(e.cost / 8000) * 100}%`, background: 'var(--color-loss-fg)' }} /></div><span className="loss">{sfmt(e.pnlAgainst)}</span></div>
                <span className="r" style={shareOf(e.cost) > limit ? { color: 'var(--color-warn-fg)' } : undefined}>{shareOf(e.cost).toFixed(1)}%</span>
              </button>
            )
          })}
          {table && <div className="po-row t"><span>{filter === 'All events' ? 'Whole portfolio' : `${rows.length} event${rows.length > 1 ? 's' : ''} shown (subtotal)`} · feasible range</span><span /><span className="gain r">{sfmt(table.max)} <small className="t3">best case</small></span><span className="loss r">{sfmt(table.min)} <small className="t3">worst case</small></span><span className="r">{pct(rows.reduce((a, e) => a + shareOf(e.cost), 0), 0)}</span></div>}
          <div className="foot"><span>
            Best and worst cases search every joint outcome of the events {filter === 'All events' ? 'in the portfolio' : 'shown'} and skip impossible ones{table?.excluded ? ` (${table.excluded} combinations excluded because BTC and ETH are mutually exclusive)` : ''}.{filter !== 'All events' && ` Portfolio-wide: ${sfmt(portfolio.min)} to ${sfmt(portfolio.max)}.`}
            {unclassifiedPair ? ' BTC × ETH is unclassified, so outcomes that may be unrealistic together are still included (unmodeled dependency).' : ''} Related events are never netted against each other.
          </span></div>
        </Card>

        <div className="grid g-12 anchor" id="context">
          <Card id="rel">
            <CardHeader title="Event relationships" sub="How positions that may move together are treated" />
            <div className="card-b">
              {exps.filter((e) => e.positions.length > 1).map((e) => (
                <div className="rel" key={e.event.id}><div className="h"><button type="button" className="link" onClick={() => openEvent(e.event.id)}><b>{e.event.name}</b></button><Chip tone="yes">✓ Equivalent contract · confirmed</Chip></div>
                  {e.positions.map((p) => <div className="leg" key={p.id}><PlatformBadge p={p.platform} />{p.market} · {p.side}</div>)}
                  <p>Same source and date, combined as one event. If it resolves against you: <span className="loss">{sfmt(e.pnlAgainst)}</span>.</p></div>
              ))}
              <div className="rel"><div className="h"><b>US macro outlook</b><Chip tone="info">{REL_TEXT.related.label}</Chip></div>
                <p>{exps.filter((e) => MACRO.includes(e.event.id)).map((e) => `${e.event.short} (${e.side})`).join(' · ')}. These share drivers but settle on different rules, so all combinations stay possible and nothing is netted. <button type="button" className="link" onClick={() => nav(`/scenario-lab?addEvent=${MACRO.join(',')}`)} title="Choose a scenario and which of these holdings to add">Model them together in Scenario Lab…</button></p></div>
              <div className={cx('rel', crypto === 'unknown' && 'unk')}><div className="h"><b>BTC year-end · ETH ETF flows</b><Chip tone={REL_TEXT[crypto].tone}>{REL_TEXT[crypto].label}</Chip></div>
                <p>{crypto === 'unknown' ? <>Probably connected, but not confirmed. Totals keep every combination possible and are marked <i>unmodeled dependency</i>.</> : `Classified by you as “${REL_TEXT[crypto].label}”. Scenario Lab uses the same setting.`} <button type="button" className="link" onClick={() => setClassify(true)}>{crypto === 'unknown' ? 'Classify' : 'Change'}</button></p></div>
              <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Other event pairs are unclassified: every combination is treated as possible.</p>
            </div>
          </Card>
          <Card id="calendar">
            <CardHeader title="Resolution calendar" sub="When capital is released or lost · circle area = capital at stake" right={<Seg label="Range" options={['90 days', '12 months'] as const} value={range} onChange={setRange} />} />
            <div className="card-b">
              <Calendar exps={exps} range={range} hot={hotCal} setHot={setHotCal} onPick={openEvent} />
              {week.n > 1 && <div style={{ marginTop: 'var(--space-3)' }}><Callout tone="warn"><b>{fmt(week.cost)}</b> resolves between {fmtDate(week.from)} and {fmtDate(week.to)}. If those {week.n} events all went against you, you’d lose {pct((week.cost / acct.totalValue) * 100, 0)} of portfolio value.</Callout></div>}
            </div>
          </Card>
        </div>

        <div className="footer-note"><span>Payoffs assume each contract settles at $1 or $0 as written. Scevia does not estimate how likely each outcome is.</span><span>Sample portfolio · fictional data</span></div>
      </main>

      {editLimit != null && (
        <Modal title="Single-event guardrail" sub="Flag any event holding more than this share of committed capital" onClose={() => setEditLimit(null)}
          footer={<><Button variant="ghost" onClick={() => setEditLimit(null)}>Cancel</Button><Button variant="primary" onClick={() => { setLimit(editLimit); setEditLimit(null); toast(`Guardrail set to ${editLimit}%`) }}>Save guardrail</Button></>}>
          <div className="row"><span className="hero-fig" style={{ fontSize: 'var(--font-size-display)' }} aria-live="polite">{editLimit}%</span></div>
          <input data-autofocus className="slider" type="range" min={5} max={40} step={1} value={editLimit} onChange={(e) => setEditLimit(Number(e.target.value))} aria-label="Guardrail percent" />
          <Callout>{exps.filter((e) => shareOf(e.cost) > editLimit).length} event(s) would be over this limit. Guardrails only flag; Scevia never trades.</Callout>
        </Modal>
      )}
      {classify && <RelationshipModal current={crypto} onClose={() => setClassify(false)} />}
    </div>
  )
}

function Calendar({ exps, range, hot, setHot, onPick }: { exps: EventExposure[]; range: '90 days' | '12 months'; hot: string | null; setHot: (k: string | null) => void; onPick: (id: string) => void }) {
  const [wrap, W] = useWidth<HTMLDivElement>(560)
  const base = 150, L = 16, R = 16, days = range === '90 days' ? 90 : 420
  const x = (d: number) => L + (d / days) * (W - L - R)
  const allTicks = range === '90 days' ? [0, 7, 21, 38, 52, 69, 83] : [0, 38, 97, 158, 219, 281, 341, 403]
  const ticks = (W - L - R) / allTicks.length < 56 ? allTicks.filter((_, i) => i % 2 === 0) : allTicks
  const evs = exps.filter((e) => e.days <= days).sort((a, b) => a.days - b.days)
  const h = evs.find((e) => e.event.id === hot)
  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} 200`} width="100%" style={{ overflow: 'visible' }} role="group" aria-label={`Resolution calendar, next ${range}: ${evs.map((e) => `${e.event.short} ${fmtDate(e.resolves)} ${kfmt(e.cost)}`).join('; ')}`}>
        <g className="axis">{ticks.map((d) => <g key={d}><line className="grid-l" x1={x(d)} x2={x(d)} y1={24} y2={base} strokeDasharray="2 4" /><text x={x(d)} y={base + 20} textAnchor="middle">{fmtDate(addDays(TODAY, d), range === '90 days' ? { month: 'short', day: 'numeric' } : { month: 'short' })}</text></g>)}</g>
        <line x1={L} x2={W - R} y1={base} y2={base} style={{ stroke: 'var(--color-border-strong)' }} />
        {evs.map((e) => {
          const r = Math.sqrt(e.cost) / (range === '90 days' ? 3.3 : 4.2), cy = base - r - 3
          return <circle key={e.event.id} className="hoverable cal-dot" cx={x(e.days)} cy={cy} r={r} style={{ fill: CAT_COLOR[e.event.category], stroke: 'var(--color-bg-surface)' }} strokeWidth={2} opacity={hot && hot !== e.event.id ? 0.35 : 0.9}
            role="button" tabIndex={0} aria-label={`${e.event.name}, resolves ${fmtDate(e.resolves)}, ${kfmt(e.cost)} at stake. View event exposure`}
            onMouseEnter={() => setHot(e.event.id)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(e.event.id)} onBlur={() => setHot(null)}
            onClick={() => onPick(e.event.id)} onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onPick(e.event.id))} />
        })}
        <line x1={x(0)} x2={x(0)} y1={14} y2={base} style={{ stroke: 'var(--color-accent-fg)' }} strokeWidth={1.5} />
        <text className="lbl" x={x(0) + 5} y={16} style={{ fill: 'var(--color-accent-fg)' }}>TODAY</text>
      </svg>
      {h && <div className="tip" style={{ left: `${(x(h.days) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}><div className="t3">{fmtDate(h.resolves)} · in {h.days} days</div><b>{h.event.name}</b><div>{kfmt(h.cost)} at stake</div></div>}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { useWidth } from '../components/charts'
import { useDetails } from '../components/details'
import { handoffPath } from '../lib/handoff'
import { Modal, useToast } from '../components/overlays'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, Legend, PageHead, PlatformBadge, Seg, Tabs, Tile, cx } from '../components/ui'
import { CATEGORIES, CAT_COLOR, PLATFORM_NAME } from '../data/labels'
import { PROVENANCE_TEXT, REL_TEXT, type RelClass } from '../data/relations'
import { MAX_JOINT_EVENTS, addDays, fmtDate, outcomeLabel, rangeIssue, settlementRange, type EventExposure } from '../lib/finance'
import { count, sentences } from '../lib/text'
import { fmt, kfmt, pct, sfmt } from '../lib/format'
import { useSettings } from '../lib/settings'
import { useFinance } from '../lib/financeContext'
import { DataIssues } from '../components/Workspace'
import { HELP } from '../lib/help'

const RAIL: RailSection[] = [
  { id: 'summary', label: 'Exposure summary', icon: 'home' },
  { id: 'exposure', label: 'Exposure', icon: 'bars', children: [{ id: 'conc', label: 'Concentration' }, { id: 'ladder', label: 'Downside ladder' }] },
  { id: 'payoffs', label: 'Outcome payoffs', icon: 'table' },
  { id: 'context', label: 'Relationships & timing', icon: 'link', children: [{ id: 'rel', label: 'Event relationships' }, { id: 'calendar', label: 'Resolution calendar' }] },
]

/** Largest capital resolving inside any 7-day window within `days`. */
function busiestWeek(exps: EventExposure[], days = 90) {
  const near = exps.filter((e) => e.days <= days)
  let best = { cost: 0, loss: 0, from: '', to: '', n: 0 }
  for (const e of near) {
    const inWin = near.filter((x) => x.resolves >= e.resolves && x.resolves <= addDays(e.resolves, 6))
    const cost = inWin.reduce((a, x) => a + x.cost, 0)
    if (cost > best.cost) best = { cost, loss: inWin.reduce((a, x) => a + x.maxLoss, 0), from: e.resolves, to: inWin.reduce((m, x) => (x.resolves > m ? x.resolves : m), e.resolves), n: inWin.length }
  }
  return best
}

export default function Risk() {
  const { ACCOUNTS, account, baseHoldings, exposures, positionsFor, settlementRangeFor, sourceRelations } = useFinance()
  useHashScroll()
  const nav = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const focus = params.get('event')
  // Factual risk uses source relationships only; hypothetical constraints live in scenarios and never reach here.
  const rels = useMemo(() => sourceRelations(), [])
  const details = useDetails()
  const [groupBy, setGroupBy] = useState<'By event' | 'By category' | 'By platform'>('By event')
  const { settings, update } = useSettings()
  const limit = settings.guardrail, setLimit = (v: number) => update({ guardrail: v })
  const [editLimit, setEditLimit] = useState<number | null>(null)
  const [filter, setFilter] = useState<'All events' | 'Next 30 days' | 'Above limit'>('All events')
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
  // Shares of committed capital; only shown when something is committed (an empty portfolio has no shares, not 0%).
  const shareOf = (c: number) => (committed > 0 ? (c / committed) * 100 : 0)
  const scale = Math.max(32, Math.ceil(shareOf(groups[0]?.cost ?? 0) / 10) * 10 + 4)
  const top = exps[0]
  const over = exps.filter((e) => shareOf(e.cost) > limit)
  const top3 = exps.slice(0, 3).reduce((a, e) => a + e.cost, 0)
  // Downside uses each event's worst settlement (opposing holdings offset), ordered by that loss.
  const byLoss = [...exps].sort((a, b) => b.maxLoss - a.maxLoss)
  const top3Loss = byLoss.slice(0, 3).reduce((a, e) => a + e.maxLoss, 0)
  const rows = exps.filter((e) => filter === 'All events' || (filter === 'Next 30 days' ? e.days <= 30 : shareOf(e.cost) > limit))
  const ladder = byLoss.reduce<number[]>((a, e) => [...a, (a.at(-1) ?? 0) + e.maxLoss], [])
  const ladderMax = Math.max(10000, Math.ceil((ladder.at(-1) ?? 0) / 10000) * 10000)
  const ladderTicks = Array.from({ length: ladderMax / 10000 + 1 }, (_, i) => i * 10000)
  const [ladderRef, LW] = useWidth<HTMLDivElement>(480)
  const poScale = Math.max(1, ...exps.flatMap((e) => [Math.abs(e.pnl.YES), Math.abs(e.pnl.NO)]))
  const soon = exps.filter((e) => e.days <= 30)
  const week = busiestWeek(exps)

  // Portfolio scope: always every holding. Table scope: only the filtered rows. Both exclude impossible joint outcomes.
  const portfolio = settlementRange(Object.values(baseHoldings()), rels)
  const issue = portfolio ? null : rangeIssue([...new Set(Object.values(baseHoldings()).filter((h) => h.shares > 0).map((h) => h.eventId))], rels)
  const shownIds = new Set(rows.map((e) => e.event.id))
  const table = settlementRangeFor([...shownIds], rels)
  const worstValue = portfolio ? acct.cash + committed + portfolio.min : null
  // Source relationships between held events, grouped by their note (e.g. one annotation covering several pairs).
  const relGroups = useMemo(() => {
    const groups = new Map<string, { key: string; title: string; cls: RelClass; provenance: (typeof rels)[number]['provenance']; ids: Set<string> }>()
    for (const r of rels) {
      if (!exps.some((e) => e.event.id === r.a) || !exps.some((e) => e.event.id === r.b) || r.cls === 'unknown') continue
      const key = `${r.cls}|${r.provenance}|${r.note ?? `${r.a}-${r.b}`}`
      const g = groups.get(key) ?? { key, title: r.note ?? 'Related events', cls: r.cls, provenance: r.provenance, ids: new Set<string>() }
      g.ids.add(r.a); g.ids.add(r.b); groups.set(key, g)
    }
    return [...groups.values()].map((g) => ({ ...g, events: exps.filter((e) => g.ids.has(e.event.id)) }))
  }, [rels, exps])
  const openEvent = (id: string) => details.open({ kind: 'event', id, scope: 'all' })
  // Explicit hand-off of the holdings behind the rows shown; the Lab confirms the scenario and which of them to add.
  const stressIds = rows.flatMap((e) => e.positions.map((p) => p.id))
  const stressTest = () => nav(handoffPath(stressIds, `Outcome payoffs in Risk (${filter.toLowerCase()})`))
  const na = 'Unavailable'

  return (
    <div className="shell">
      <SectionRail title="Risk" sections={RAIL}>
        <div className="rail-extra"><h6 className="caps" style={{ paddingLeft: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>Limits</h6>
          <ol>
            <li><a href="#conc" onClick={(e) => { e.preventDefault(); setEditLimit(limit) }}><Icon name="shield" />Event ≤ {limit}%<span className="count">edit</span></a></li>
          </ol>
        </div>
      </SectionRail>

      <main>
        <PageHead caption={`${count(acct.openCount, 'position')} across ${count(exps.length, 'event')}`} title="Portfolio risk"
          actions={<><Seg label="Group by" options={['By event', 'By category', 'By platform'] as const} value={groupBy} onChange={setGroupBy} /><Button variant="primary" onClick={stressTest} disabled={stressIds.length === 0} title={`Choose a scenario and which of the ${count(stressIds.length, 'position')} behind the payoff table to add`}><Icon name="flask" size={15} />Stress-test in Lab…</Button></>} />
        <DataIssues denominations={ACCOUNTS.map((a) => a.denomination)} />
        {exps.length === 0 && <Callout icon="info">No open positions in the selected sources, so there is no event exposure to analyse. This is an empty portfolio, not missing data.</Callout>}
        <p className="summary">You have <b>{fmt(committed)}</b> committed across {count(exps.length, 'event')}. {over.length > 0
          ? <><b>{over.length === 1 ? 'One event' : `${count(over.length, 'event')}`}</b> ({over.map((e) => e.event.short).join(', ')}) {over.length === 1 ? 'is' : 'are'} above your <button type="button" className="link" onClick={() => setEditLimit(limit)}>{limit}% limit</button>.</>
          : <>No event is above your <button type="button" className="link" onClick={() => setEditLimit(limit)}>{limit}% limit</button>.</>} If your three most exposed events all settled against you, you’d lose <b className="loss">{sfmt(-top3Loss)}</b> {acct.totalValue > 0 && <> ({pct((top3Loss / acct.totalValue) * 100, 0)} of portfolio value)</>}.{week.n > 1 && <> <b>{fmt(week.cost)}</b> resolves within one week ({fmtDate(week.from)}–{fmtDate(week.to)}).</>}</p>

        <div className="tiles">
          <Tile label="Capital committed" info="Acquisition cost at risk: cost basis of open positions, fees included. Their current value is shown below and moves with market prices." value={fmt(committed)} foot={`Worth ${fmt(acct.positionsValue)} at current prices`} />
          <Tile label="Worst-case settlement P&L" info={HELP.worstCase} value={portfolio ? sfmt(portfolio.min) : na} tone={portfolio ? 'loss' : undefined} foot={worstValue != null ? `${sfmt(worstValue - acct.totalValue)} from today’s value` : issue === 'too-many-events' ? `More than ${MAX_JOINT_EVENTS} events to check every combination` : issue === 'no-feasible-outcome' ? 'Recorded relationships leave no possible outcome' : 'Not available for this portfolio'} />
          <Tile label="Largest single event" info="Capital committed to one event (the same outcome across platforms counts once) ÷ total committed." value={top ? pct(shareOf(top.cost)) : 'None'} tone={top && shareOf(top.cost) > limit ? 'warn' : undefined} foot={top ? `${top.event.short}, ${shareOf(top.cost) > limit ? `above your ${limit}% limit` : `within your ${limit}% limit`}` : 'No open positions'} />
          <Tile label="Top-3 concentration" info="Share of committed capital in your three largest events." value={pct(shareOf(top3), 0)} foot={`${fmt(top3)} of capital committed`} />
          <Tile label="Resolving within 30 days" info="Capital committed to events that resolve within 30 days." value={fmt(soon.reduce((a, e) => a + e.cost, 0))} foot={soon.length ? `${count(soon.length, 'event')}, first on ${fmtDate([...soon].sort((a, b) => a.days - b.days)[0].resolves)}` : 'None'} />
        </div>

        <div className="grid g-21 anchor" id="exposure">
          <Card id="conc">
            <CardHeader title={`${groupBy.replace('By ', '').replace(/^./, (c) => c.toUpperCase())} concentration`} sub="Capital committed" info={HELP.concentration}
              right={<Legend items={[{ label: 'Within limit', color: 'var(--color-data-1)' }, { label: `Over ${groupLimit}%`, color: 'var(--color-warn-fg)' }]} />} />
            <div className="card-b">
              {groups.map((g) => {
                const s = shareOf(g.cost)
                const go = () => groupBy === 'By event' ? openEvent(g.key)
                  : details.open({ kind: 'group', title: g.name, sub: `${fmt(g.cost)} committed, ${s.toFixed(1)}% of the total`, ids: g.ids })
                return (
                  <button type="button" key={g.key} className="conc conc-btn hoverable" aria-label={`${g.name}: ${s.toFixed(1)}% of committed capital, view details`} onClick={go}>
                    <span className="nm">{g.platforms.map((p) => <PlatformBadge key={p} p={p} />)}<span>{g.name}</span></span>
                    <div className="cbar"><i className={cx(s > groupLimit && 'over')} style={{ width: `${(s / scale) * 100}%` }} />{groupLimit < scale && <span className="lim" style={{ left: `${(groupLimit / scale) * 100}%` }} />}</div>
                    <span className="r">{fmt(g.cost)}</span><span className="r t3">{s.toFixed(1)}%</span>
                  </button>
                )
              })}
              {groupBy === 'By event' && <div style={{ marginTop: 'var(--space-3)' }}><Button size="sm" variant="ghost" onClick={() => setEditLimit(limit)}>Edit {limit}% limit</Button></div>}
            </div>
          </Card>
          <Card id="ladder">
            <CardHeader title="Downside ladder" info={HELP.downsideLadder} />
            <div className="card-b">
              <div ref={ladderRef}><svg viewBox={`0 0 ${LW} 220`} width="100%" style={{ overflow: 'visible' }} className="chart" role="group" aria-label={`Downside ladder: largest event ${sfmt(-(byLoss[0]?.maxLoss ?? 0))}, top three ${sfmt(-top3Loss)}, all events ${sfmt(-(ladder.at(-1) ?? 0))}`} onPointerLeave={() => setHotStep(null)}>
                <g className="axis">{ladderTicks.map((t) => <g key={t}><line className="grid-l" x1={48} x2={LW - 10} y1={10 + (t / ladderMax) * 182} y2={10 + (t / ladderMax) * 182} strokeDasharray="2 4" /><text x={40} y={14 + (t / ladderMax) * 182} textAnchor="end">{t ? `−${kfmt(t)}` : '$0'}</text></g>)}
                  {byLoss.map((_, i) => <text key={i} x={48 + (i + 0.5) * ((LW - 58) / byLoss.length)} y={212} textAnchor="middle">{i + 1}</text>)}</g>
                {byLoss.map((e, i) => {
                  const bw = (LW - 58) / byLoss.length, x0 = 48 + i * bw, y = (v: number) => 10 + (v / ladderMax) * 182, prev = i ? ladder[i - 1] : 0
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
                  <div><div className="l">Largest event</div><div className="v loss">{sfmt(-(byLoss[0]?.maxLoss ?? 0))}</div></div>
                  <div><div className="l">Top 3 events</div><div className="v loss">{sfmt(-top3Loss)}</div></div>
                  <div><div className="l">All events</div><div className="v loss">{sfmt(-(ladder.at(-1) ?? 0))}</div></div>
                </> : <>
                  <div style={{ gridColumn: 'span 2' }}><div className="l">If your top {hotStep + 1} event{hotStep ? 's' : ''} go against you</div><div className="v loss">{sfmt(-ladder[hotStep])}</div></div>
                  <div><div className="l">Adds</div><button type="button" className="link v t2" style={{ fontSize: 'var(--font-size-sm)', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => openEvent(byLoss[hotStep].event.id)}>{byLoss[hotStep].event.name}</button></div>
                </>}
              </div>
            </div>
          </Card>
        </div>

        <Card id="payoffs" flush>
          <CardHeader pad title="Outcome payoffs" info={HELP.payoffs} right={<Tabs label="Filter events" options={['All events', 'Next 30 days', 'Above limit'] as const} value={filter} onChange={setFilter} />} />
          <div className="po-row h"><span>Event and side</span><span>Resolves</span><span>Better outcome</span><span>Worse outcome</span><span className="r">Share</span></div>
          {rows.length === 0 && <div className="empty"><p>No events match “{filter}”. This filter only changes the table: the portfolio’s worst feasible outcome is still <b className="loss">{portfolio ? sfmt(portfolio.min) : na}</b>.</p><button type="button" className="link" onClick={() => setFilter('All events')}>Show all events</button></div>}
          {rows.map((e) => {
            const rel = relationOf(e.event.id)
            const chip = rel === 'equivalent' ? { tone: 'accent' as const, text: `${e.positions.length} equivalent contracts` } : rel ? { tone: REL_TEXT[rel].tone, text: REL_TEXT[rel].short } : null
            return (
              <button type="button" key={e.event.id} className={cx('po-row', 'po-btn', 'hoverable', focus === e.event.id && 'sel')} style={focus === e.event.id ? { background: 'var(--color-accent-bg)' } : undefined}
                onClick={() => openEvent(e.event.id)} aria-label={`${e.event.name}, ${e.positions.length} contract${e.positions.length > 1 ? 's' : ''}: view event exposure`}>
                <div className="mk">{e.platforms.map((p) => <PlatformBadge key={p} p={p} />)}<div><b>{e.event.name}</b><span className="row" style={{ marginTop: 'var(--space-1)', gap: 'var(--space-1)' }}><Chip tone={e.side === 'YES' ? 'yes' : e.side === 'NO' ? 'no' : 'warn'}>{e.side === 'Mixed' ? 'YES + NO' : e.side}</Chip>{chip && <Chip tone={chip.tone}>{chip.text}</Chip>}</span></div></div>
                <span>{fmtDate(e.resolves)}<br /><small className="t3">in {count(e.days, 'day')}</small></span>
                {[e.best, e.worst].map((x) => (
                  <div className="po" key={x.outcome} title={outcomeLabel(e, x.outcome)}><div className="bar"><i style={{ width: `${(Math.abs(x.pnl) / poScale) * 100}%`, background: x.pnl >= 0 ? 'var(--color-gain-fg)' : 'var(--color-loss-fg)' }} /></div>
                    <span className={x.pnl > 0 ? 'gain' : x.pnl < 0 ? 'loss' : 't2'}>{sfmt(x.pnl)}<small className="t3 po-o">{x.outcome}</small></span></div>
                ))}
                <span className="r" style={shareOf(e.cost) > limit ? { color: 'var(--color-warn-fg)' } : undefined}>{shareOf(e.cost).toFixed(1)}%</span>
              </button>
            )
          })}
          {table && <div className="po-row t"><span>{filter === 'All events' ? 'Whole portfolio' : `Subtotal for ${count(rows.length, 'event')}`}</span><span /><span className="gain r">{sfmt(table.max)} <small className="t3">best case</small></span><span className="loss r">{sfmt(table.min)} <small className="t3">worst case</small></span><span className="r">{pct(rows.reduce((a, e) => a + shareOf(e.cost), 0), 0)}</span></div>}
          {(!!table?.excluded || filter !== 'All events') && <div className="foot"><span>{sentences(
            table?.excluded ? `${count(table.excluded, 'combination')} excluded by verified constraints` : null,
            filter !== 'All events' && `Portfolio-wide: ${portfolio ? `${sfmt(portfolio.min)} to ${sfmt(portfolio.max)}` : na}`)}</span></div>}
        </Card>

        <div className="grid g-12 anchor" id="context">
          <Card id="rel">
            <CardHeader title="Event relationships" info={HELP.relationships} />
            <div className="card-b">
              {exps.filter((e) => e.positions.length > 1).map((e) => (
                <div className="rel" key={e.event.id}><div className="h"><button type="button" className="link" onClick={() => openEvent(e.event.id)}><b>{e.event.name}</b></button><Chip tone="yes">Confirmed equivalent</Chip></div>
                  {e.positions.map((p) => <div className="leg" key={p.id}><PlatformBadge p={p.platform} />{p.market} {p.side}</div>)}
                  <p>Same source and date, combined as one event. If it resolves {e.worst.outcome}: <span className={e.worst.pnl < 0 ? 'loss' : 'gain'}>{sfmt(e.worst.pnl)}</span>.</p></div>
              ))}
              {relGroups.map((g) => (
                <div className="rel" key={g.key}><div className="h"><b>{g.title}</b><Chip tone={REL_TEXT[g.cls].tone}>{REL_TEXT[g.cls].label}</Chip><small className="t3">{PROVENANCE_TEXT[g.provenance]}</small></div>
                  <p>{g.events.map((e) => `${e.event.short} (${e.side === 'Mixed' ? 'YES and NO' : e.side})`).join(', ')}. {g.cls === 'related' ? 'They may share drivers, but every combination of outcomes stays possible and nothing is netted.' : g.cls === 'mutex' ? 'Verified: they can’t both resolve YES, so that combination is excluded.' : g.cls === 'equivalent' ? 'Verified: they settle the same way.' : 'No constraint.'}{' '}
                    <button type="button" className="link" onClick={() => nav(handoffPath(g.events.flatMap((e) => e.positions.map((p) => p.id)), `${g.title} in Risk`))} title="Choose a scenario and which of these holdings to add">Model them together in Scenario Lab…</button></p></div>
              ))}
            </div>
          </Card>
          <Card id="calendar">
            <CardHeader title="Resolution calendar" sub="Capital committed by scheduled resolution date" info={HELP.calendar} right={<Seg label="Range" options={['90 days', '12 months'] as const} value={range} onChange={setRange} />} />
            <div className="card-b">
              <Calendar exps={exps} range={range} hot={hotCal} setHot={setHotCal} onPick={openEvent} />
              <div className="tl-list cal-list" role="list" aria-label="Next resolutions">
                {[...exps].sort((a, b) => a.days - b.days).slice(0, 5).map((e) => (
                  <button type="button" role="listitem" key={e.event.id} className="tl-li cal-li" onClick={() => openEvent(e.event.id)}>
                    <span className="t3 tnum">{fmtDate(e.resolves)}</span><span className="tl-t">{e.event.name}</span>
                    <span className="r tnum">{fmt(e.cost)}<small className="t3"> at stake</small></span><small className="t3 r">{e.days}d</small>
                  </button>
                ))}
              </div>
              {week.n > 1 && <div style={{ marginTop: 'var(--space-3)' }}><Callout tone="warn"><b>{fmt(week.cost)}</b> resolves between {fmtDate(week.from)} and {fmtDate(week.to)}. If those {count(week.n, 'event')} all settled against you, you’d lose {fmt(week.loss)} ({pct((week.loss / acct.totalValue) * 100, 0)} of portfolio value).</Callout></div>}
            </div>
          </Card>
        </div>
      </main>

      {editLimit != null && (
        <Modal title="Concentration limit" sub="Flag any event holding more than this share of capital committed" onClose={() => setEditLimit(null)}
          footer={<><Button variant="ghost" onClick={() => setEditLimit(null)}>Cancel</Button><Button variant="primary" onClick={() => { setLimit(editLimit); setEditLimit(null); toast(`Limit set to ${editLimit}%`) }}>Save limit</Button></>}>
          <div className="row"><span className="hero-fig" style={{ fontSize: 'var(--font-size-display)' }} aria-live="polite">{editLimit}%</span></div>
          <input data-autofocus className="slider" type="range" min={5} max={40} step={1} value={editLimit} onChange={(e) => setEditLimit(Number(e.target.value))} aria-label="Limit percent" />
          <Callout>{sentences(`${count(exps.filter((e) => shareOf(e.cost) > editLimit).length, 'event')} would be above this limit`, 'The limit only flags events. Scevia never trades')}</Callout>
        </Modal>
      )}
    </div>
  )
}

function Calendar({ exps, range, hot, setHot, onPick }: { exps: EventExposure[]; range: '90 days' | '12 months'; hot: string | null; setHot: (k: string | null) => void; onPick: (id: string) => void }) {
  const { TODAY } = useFinance()
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
      {h && <div className="tip" style={{ left: `${(x(h.days) / W) * 100}%`, top: 0, transform: 'translateX(-50%)' }}><div className="t3">{fmtDate(h.resolves)}, in {count(h.days, 'day')}</div><b>{h.event.name}</b><div>{kfmt(h.cost)} at stake</div></div>}
    </div>
  )
}

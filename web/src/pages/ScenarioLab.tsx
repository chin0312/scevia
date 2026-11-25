import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Menu, Modal, useToast } from '../components/overlays'
import { useWidth } from '../components/charts'
import { RelationshipModal } from '../components/relationships'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, PlatformBadge, SideChip, Tabs, cx } from '../components/ui'
import { EVENTS, FEE_RATE } from '../data/portfolio'
import type { RiskEvent } from '../data/types'
import { REL_TEXT, useRelations } from '../data/relations'
import {
  MAX_PRICE, MIN_PRICE, POSITIONS, POS_BY_ID, exposures, fmtDate, groupPnl, isFeasible, pairRelation, scenarioMetrics, simulate, validatePrice,
  type Adjustment, type Outcome, type ScenarioMetrics, type Simulation,
} from '../lib/finance'
import { fmt, int, kfmt, sfmt } from '../lib/format'
import * as SC from '../lib/scenarios'
import { useSessionState } from '../lib/useSessionState'
import type { Scenario } from '../lib/scenarios'


const RAIL: RailSection[] = [
  { id: 'workspace', label: 'Adjust & impact', icon: 'sliders', children: [{ id: 'adjust', label: 'Adjustments' }, { id: 'ba', label: 'Before / after' }, { id: 'matrix', label: 'Outcome matrix' }] },
  { id: 'payoff', label: 'Payoff by event', icon: 'bars' },
  { id: 'cmp', label: 'Compare scenarios', icon: 'table' },
  { id: 'assume', label: 'Assumptions', icon: 'info' },
]
const COLORS = ['var(--color-accent-solid)', 'var(--color-data-1)', 'var(--color-data-3)', 'var(--color-data-4)', 'var(--color-data-5)', 'var(--color-data-6)']
const TEMPLATE: Record<string, Adjustment[]> = {
  draft: [{ id: 'btc', to: 4000, price: 0.29 }, { id: 'fedk', to: 6200, price: 0.65 }, { id: 'chf', to: 0, price: 0.12 }],
  sports: [{ id: 'cel', to: 0, price: 0.26 }, { id: 'chf', to: 0, price: 0.12 }],
  shut: [{ id: 'shut', to: 3500, price: 0.47 }],
}
const INITIAL: Scenario[] = [
  { key: 'draft', name: 'Trim crypto, add to Fed', adjs: TEMPLATE.draft, saved: null, savedAt: null, color: COLORS[0] },
  { key: 'sports', name: 'Exit sports longshots', adjs: TEMPLATE.sports, saved: { name: 'Exit sports longshots', adjs: TEMPLATE.sports }, savedAt: '2026-11-21', color: COLORS[1] },
  { key: 'shut', name: 'Hedge the shutdown', adjs: TEMPLATE.shut, saved: { name: 'Hedge the shutdown', adjs: TEMPLATE.shut }, savedAt: '2026-11-18', color: COLORS[2] },
]
const NO_ADJ: Adjustment[] = []
const maxFor = (sh: number) => Math.max(1000, Math.ceil((sh * 1.5) / 1000) * 1000)


type Row = { label: string; key: keyof ScenarioMetrics; tone: 'up' | 'down' | 'neutral'; info: string }
const ROWS: Row[] = [
  { label: 'Cash', key: 'cash', tone: 'neutral', info: 'Buying spends cash; selling returns it. A transfer, not a gain. Negative means the scenario needs more cash than you hold.' },
  { label: 'Positions at mark', key: 'positionsValue', tone: 'neutral', info: 'Shares × mark (the last traded price).' },
  { label: 'Value at mark', key: 'totalValue', tone: 'up', info: 'Cash + positions at mark. A trade at your assumed fill price changes this only by the gap between that price and the mark, plus fees.' },
  { label: 'Capital committed', key: 'committed', tone: 'neutral', info: 'Cost basis of open positions after the scenario.' },
  { label: 'Locked-in from sales', key: 'realized', tone: 'up', info: 'Realized P&L of hypothetical sales after their fees. Purchases never create realized P&L.' },
  { label: 'Est. fees on these trades', key: 'fees', tone: 'down', info: 'Estimated at each platform’s fee rate when “Trading fees” is on. Fees already paid on existing positions aren’t included.' },
  { label: 'Value if worst feasible outcome', key: 'worstValue', tone: 'up', info: 'Cash + $1 per winning share in the worst joint outcome that’s possible given confirmed relationships. Any extra funding the scenario needs is subtracted (cash can be negative).' },
  { label: 'Value if best feasible outcome', key: 'bestValue', tone: 'up', info: 'Cash + $1 per winning share in the best possible joint outcome, net of any extra funding needed.' },
  { label: 'Largest single-event loss', key: 'largestEventLoss', tone: 'down', info: 'Biggest cost basis riding on one event (what you’d lose if it went against you).' },
]

export default function ScenarioLab() {
  useHashScroll()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { crypto, rels } = useRelations()
  const [scenarios, setScenarios] = useSessionState<Scenario[]>('scevia-scenarios-v3', INITIAL)
  const [activeKey, setActiveKey] = useSessionState<string>('scevia-active-v3', 'draft')
  const [includeFees, setIncludeFees] = useSessionState('scevia-fees', true)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [view, setView] = useState<'Portfolio impact' | 'Position impact'>('Portfolio impact')
  const [mxA, setMxA] = useState('fed')
  const [mxB, setMxB] = useState('btc')

  const isBase = activeKey === 'base'
  const active = scenarios.find((s) => s.key === activeKey)
  const adjs = active?.adjs ?? NO_ADJ

  // ?add=<positionIds> / ?addEvent=<eventIds> from other modules: ask before changing anything.
  // The request is read once (ref guards StrictMode) and removed from the URL, so reloads and Back never re-add.
  const [pending, setPending] = useState<string[] | null>(null)
  const [editRel, setEditRel] = useState(false)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    const add = params.get('add'), addEvent = params.get('addEvent')
    if (!add && !addEvent) return
    const sig = params.toString()
    if (handled.current === sig) return
    handled.current = sig
    setParams({}, { replace: true })
    const evIds = (addEvent ?? '').split(',').filter(Boolean)
    const ids = [...new Set([...(add ?? '').split(',').filter((id) => POS_BY_ID[id]), ...POSITIONS.filter((p) => evIds.includes(p.eventId)).map((p) => p.id)])]
    if (!ids.length) { toast('Those holdings aren’t in your portfolio', 'info'); return }
    setPending(ids)
  }, [params, setParams, toast])
  const confirmAdd = (target: string, ids: string[]) => {
    const adds = ids.map((id) => ({ id, to: POS_BY_ID[id].shares, price: POS_BY_ID[id].mark }))
    let key = target, name = scenarios.find((x) => x.key === target)?.name ?? 'New scenario'
    if (target === 'new') {
      key = `s${Date.now()}`; name = 'New scenario'
      setScenarios((ss) => [...ss, SC.addPositions(SC.create(key, COLORS[ss.length % COLORS.length]), adds).scenario])
    } else {
      setScenarios((ss) => ss.map((x) => (x.key === target ? SC.addPositions(x, adds).scenario : x)))
    }
    setActiveKey(key); setPending(null)
    const ev = POS_BY_ID[ids[0]].eventId
    if (ev !== mxA) setMxB(ev)
    toast(`Added ${ids.length > 1 ? `${ids.length} positions` : `“${POS_BY_ID[ids[0]].market}”`} to “${name}” at current size and mark: no change until you edit ${ids.length > 1 ? 'them' : 'it'}`, 'info')
    window.setTimeout(() => document.getElementById('adjust')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const update = (fn: (a: Adjustment[]) => Adjustment[]) => {
    if (!active) return
    setScenarios((ss) => ss.map((s) => (s.key === active.key ? { ...s, adjs: fn(s.adjs) } : s)))
  }
  const sims = useMemo(() => Object.fromEntries(scenarios.map((s) => [s.key, simulate(s.adjs, { includeFees })])) as Record<string, Simulation>, [scenarios, includeFees])
  const base = useMemo(() => simulate([], { includeFees }), [includeFees])
  const S = isBase ? base : sims[activeKey] ?? base
  const B = useMemo(() => scenarioMetrics(base, rels), [base, rels])
  const A = useMemo(() => scenarioMetrics(S, rels), [S, rels])
  const metricsOf = (key: string) => (key === activeKey ? A : scenarioMetrics(sims[key], rels))
  const errors = S.errors
  const errorCount = Object.keys(errors).length

  const heldEvents = exposures('all').map((e) => e.event)
  const evA = EVENTS.find((e) => e.id === mxA)!, evB = EVENTS.find((e) => e.id === mxB)!
  const rel = pairRelation(mxA, mxB, rels)
  const sideOf = (e: RiskEvent) => POSITIONS.find((p) => p.eventId === e.id)?.side ?? 'YES'
  const cells = (['YES', 'NO'] as Outcome[]).flatMap((oa) => (['YES', 'NO'] as Outcome[]).map((ob) => {
    const o = { [mxA]: oa, [mxB]: ob }
    return { oa, ob, before: groupPnl(base, [mxA, mxB], o), after: groupPnl(S, [mxA, mxB], o), impossible: !isFeasible(o, rels) }
  }))
  const feasible = cells.filter((c) => !c.impossible)
  const best = [...feasible].sort((x, y) => (y.after - y.before) - (x.after - x.before))[0]
  const worst = [...feasible].sort((x, y) => (x.after - x.before) - (y.after - y.before))[0]
  const touched = EVENTS.filter((e) => adjs.some((a) => POS_BY_ID[a.id]?.eventId === e.id))

  const save = () => {
    if (!active || errorCount) return
    setScenarios((ss) => ss.map((s) => (s.key === active.key ? SC.save(s, 'this session') : s)))
    toast(`Saved “${active.name}”`)
  }
  const nextColor = () => COLORS[scenarios.length % COLORS.length]
  const duplicate = () => {
    if (!active) return
    const key = `s${Date.now()}`
    setScenarios((ss) => [...ss, SC.duplicate(active, key, nextColor())])
    setActiveKey(key); toast('Scenario duplicated (not saved yet)')
  }
  const create = () => {
    const key = `s${Date.now()}`
    setScenarios((ss) => [...ss, SC.create(key, nextColor())])
    setActiveKey(key); setRenaming(true)
  }
  const revert = () => {
    if (!active) return
    setScenarios((ss) => ss.map((s) => (s.key === active.key ? SC.revert(s, TEMPLATE[s.key]) : s)))
    toast(active.saved ? 'Reverted to the saved version' : 'Reset to the starting adjustments', 'info')
  }
  const remove = () => {
    if (!active) return
    setScenarios((ss) => ss.filter((s) => s.key !== active.key)); setActiveKey('base'); setConfirmDelete(false)
    toast(`Deleted “${active.name}”`, 'info')
  }

  const change = (r: Row, a: number, b: number) => {
    const d = a - b
    if (Math.abs(d) < 0.5) return <span className="delta flat">—</span>
    const good = r.tone === 'neutral' ? null : r.tone === 'up' ? d > 0 : d < 0
    return <span className={cx('delta', good == null ? 'flat' : good ? 'good' : 'bad')}>{sfmt(d)}</span>
  }
  const value = (r: Row, m: ScenarioMetrics) => (r.key === 'largestEventLoss' ? sfmt(-m.largestEventLoss) : r.key === 'realized' || r.key === 'fees' ? (Math.abs(m[r.key] as number) < 0.005 ? '$0' : r.key === 'fees' ? fmt(m.fees, 2) : sfmt(m.realized, 2)) : fmt(m[r.key] as number))

  return (
    <div className="shell">
      <SectionRail sections={RAIL}>
        <div className="rail-keep">
          <h6 className="caps" style={{ paddingLeft: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>Scenarios</h6>
          <div className="scn" role="listbox" aria-label="Scenarios">
            <a href="#adjust" role="option" aria-selected={isBase} className={cx(isBase && 'on')} onClick={(e) => { e.preventDefault(); setActiveKey('base'); setRenaming(false) }}><i style={{ background: 'var(--color-text-tertiary)' }} />Current portfolio<small>base</small></a>
            {scenarios.map((s) => (
              <a key={s.key} href="#adjust" role="option" aria-selected={activeKey === s.key} className={cx(activeKey === s.key && 'on')} onClick={(e) => { e.preventDefault(); setActiveKey(s.key); setRenaming(false) }}>
                <i style={{ background: s.color }} />{s.name}<small>{SC.status(s) === 'saved' ? (s.savedAt === 'this session' ? 'saved' : `saved ${fmtDate(s.savedAt!)}`) : SC.status(s) === 'new' ? 'not saved' : 'edited'}</small>
              </a>
            ))}
            <a href="#adjust" className="t3" onClick={(e) => { e.preventDefault(); create() }}>+ New scenario</a>
          </div>
        </div>
      </SectionRail>

      <main>
        <section className="page-head anchor" id="summary">
          <div>
            <div className="caps"><span className="accent">Scenario Lab</span> · {isBase ? 'Your current portfolio, unchanged' : active ? SC.statusLabel(active) : ''}</div>
            {isBase ? <h1>Current portfolio</h1> : renaming
              ? <input className="inline-edit" aria-label="Scenario name" autoFocus defaultValue={active?.name} onBlur={(e) => { const v = e.target.value; setScenarios((ss) => ss.map((s) => (s.key === activeKey ? SC.rename(s, v) : s))); setRenaming(false) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false) }} />
              : <h1>{active?.name}<button type="button" className="edit-btn" aria-label="Rename scenario" onClick={() => setRenaming(true)}><Icon name="edit" size={16} /></button></h1>}
          </div>
          <div className="actions">
            {!isBase && <Button variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>Delete</Button>}
            <Button variant="ghost" icon="reset" onClick={revert} disabled={isBase || !active || !SC.canRevert(active, TEMPLATE[active.key])}>{active?.saved ? 'Revert' : 'Reset'}</Button>
            <Button icon="copy" onClick={duplicate} disabled={isBase}>Duplicate</Button>
            <Button variant="primary" icon="save" onClick={save} disabled={isBase || !active || !SC.isDirty(active) || errorCount > 0} title={errorCount ? 'Fix the highlighted inputs first' : undefined}>{!isBase && active && !SC.isDirty(active) ? 'Saved' : 'Save scenario'}</Button>
          </div>
        </section>
        <Callout icon="shield"><b>Hypothetical only.</b> No orders are placed. Prices are what <i>you</i> assume you could trade at, not guaranteed fills. Outcomes are shown without probabilities.</Callout>
        {errorCount > 0 && <Callout tone="warn"><b>{errorCount} adjustment{errorCount > 1 ? 's have' : ' has'} invalid input</b> and {errorCount > 1 ? 'are' : 'is'} left out of the results below. Fix the highlighted fields to include {errorCount > 1 ? 'them' : 'it'}.</Callout>}
        {A.shortfall > 0 && <Callout tone="warn" icon="alert"><b>Needs {fmt(A.shortfall, 2)} more cash than you hold</b> ({(['pm', 'ks'] as const).filter((p) => S.shortfall[p] > 0).map((p) => `${p === 'pm' ? 'Polymarket' : 'Kalshi'} ${fmt(S.shortfall[p], 2)}`).join(', ')}). Results show the purchases as if funded; the extra funding is subtracted from cash, so values stay comparable. With current balances this allocation isn’t reachable without a deposit or selling something else.</Callout>}

        <div className="lab anchor" id="workspace">
          <Card id="adjust">
            <CardHeader pad title="Adjustments" sub={isBase ? 'Pick or create a scenario to adjust positions' : 'Set a target size and the price you assume you’d trade at'}
              right={!isBase && (
                <Menu label="Add a position" width={360} trigger={(t) => <button type="button" className="btn btn-sm" {...t}><Icon name="plus" size={15} />Add position</button>}>
                  {(close) => (<>
                    <div className="menu-h">Add an open position</div>
                    {POSITIONS.filter((p) => !adjs.some((a) => a.id === p.id)).map((p) => (
                      <button type="button" role="menuitem" key={p.id} className="menu-i" onClick={() => { update((a) => [...a, { id: p.id, to: p.shares, price: p.mark }]); close() }}>
                        <PlatformBadge p={p.platform} /><span style={{ flex: 1 }}>{p.market}</span><SideChip side={p.side} />
                      </button>
                    ))}
                    {POSITIONS.every((p) => adjs.some((a) => a.id === p.id)) && <div className="menu-h">Every position is already in this scenario.</div>}
                  </>)}
                </Menu>
              )} />
            {adjs.length === 0 && (
              <div className="empty" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                <p>{isBase ? 'This is your portfolio as it is today.' : 'No adjustments yet. Add a position to start.'}</p>
                {isBase && scenarios[0] && <Button size="sm" onClick={() => setActiveKey(scenarios[0].key)}>Open “{scenarios[0].name}”</Button>}
              </div>
            )}
            {adjs.map((a, k) => <AdjustmentRow key={`${activeKey}:${a.id}`} a={a} error={errors[a.id]} shortfall={S.shortfall[POS_BY_ID[a.id]?.platform ?? 'pm']} includeFees={includeFees}
              onChange={(next) => update((list) => list.map((x, i) => (i === k ? next : x)))} onRemove={() => update((list) => list.filter((_, i) => i !== k))} />)}
            <div className="sumbar">
              <div><div className="l">Net cash change</div><div className={cx('v', A.cash - B.cash >= 0 ? 'gain' : 'loss')}>{sfmt(A.cash - B.cash, 2)}</div></div>
              <div><div className="l">Cash after trades · Poly / Kalshi</div><div className="v" style={{ fontSize: 'var(--font-size-md)' }}><span className={cx(S.cash.pm < 0 && 'loss')}>{fmt(S.cash.pm)}</span> / <span className={cx(S.cash.ks < 0 && 'loss')}>{fmt(S.cash.ks)}</span></div></div>
            </div>
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
            <Card id="ba" flush>
              <CardHeader pad title="Before / after" sub={`Whole portfolio · fees ${includeFees ? 'estimated' : 'excluded'} · worst/best respect event relationships`}
                right={<Tabs label="Impact view" options={['Portfolio impact', 'Position impact'] as const} value={view} onChange={setView} />} />
              {view === 'Portfolio impact' ? (<>
                <div className="ba-row h"><span>Metric</span><span>Current</span><span>Scenario</span><span>Change</span></div>
                {ROWS.map((r) => (
                  <div className="ba-row" key={r.key} title={r.info}><span>{r.label}</span><span className="t3">{value(r, B)}</span><span className="after">{value(r, A)}</span><span>{change(r, r.key === 'largestEventLoss' ? -A.largestEventLoss : (A[r.key] as number), r.key === 'largestEventLoss' ? -B.largestEventLoss : (B[r.key] as number))}</span></div>
                ))}
                <div className="foot"><span>Buying moves cash into contracts: at today’s marks it can only cost the gap to the mark and fees. What changes is the range you could end with at settlement.{A.excluded ? ` ${A.excluded} impossible joint outcomes excluded.` : ''}</span></div>
              </>) : (<>
                <div className="ba-row h"><span>Position</span><span>Shares</span><span>If for / against</span><span>Change if against</span></div>
                {adjs.length === 0 && <div className="empty"><p>No positions changed.</p></div>}
                {adjs.map((a) => {
                  const h = S.holdings[a.id], p = POS_BY_ID[a.id]
                  if (!h || !p) return null
                  const forV = groupPnlFor(S, a.id, p.side), againstV = groupPnlFor(S, a.id, p.side === 'YES' ? 'NO' : 'YES')
                  return <div className="ba-row" key={a.id}><span>{p.market}</span><span><span className="t3">{int(p.shares)} → </span>{int(h.shares)}</span>
                    <span><span className="gain">{sfmt(forV)}</span> / <span className="loss">{sfmt(againstV)}</span></span>
                    <span>{change(ROWS[2], againstV, p.ifLose)}</span></div>
                })}
              </>)}
            </Card>

            <Card id="matrix">
              <CardHeader title="Outcome matrix" sub="P&L of two events’ positions in each joint outcome, including this scenario’s trades" />
              <div className="card-b">
                <div className="row" style={{ marginBottom: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <select className="select" value={mxA} onChange={(e) => setMxA(e.target.value)} aria-label="First event">{heldEvents.filter((e) => e.id !== mxB).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                  <span className="t3">×</span>
                  <select className="select" value={mxB} onChange={(e) => setMxB(e.target.value)} aria-label="Second event">{heldEvents.filter((e) => e.id !== mxA).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                  <span className="spacer" />
                  {rel ? <Chip tone={REL_TEXT[rel].tone}>{REL_TEXT[rel].label}</Chip> : <Chip tone="warn">? Unclassified</Chip>}
                  {[mxA, mxB].sort().join() === 'btc,eth' && <button type="button" className="link" onClick={() => setEditRel(true)}>Change</button>}
                </div>
                <p className="t3" style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--space-3)' }}>{
                  rel === 'mutex' ? 'Both can’t resolve YES, so that combination is excluded.'
                    : rel === 'related' ? 'They share drivers but settle on different rules: all four combinations are possible and nothing is netted.'
                      : rel === 'unknown' ? 'Marked unknown: all four combinations are shown as possible (unmodeled dependency).'
                        : 'Nobody has classified this pair: all four combinations are shown as possible (unmodeled dependency).'}</p>
                <div className="matrix">
                  <div />
                  {(['YES', 'NO'] as Outcome[]).map((ob) => <div className="mh" key={ob}><span><b>{evB.short}</b> resolves {ob}<br /><small>{ob === sideOf(evB) ? 'for you' : 'against you'}</small></span></div>)}
                  {(['YES', 'NO'] as Outcome[]).map((oa) => (
                    <MatrixRow key={oa} label={<><b>{evA.short}</b> resolves {oa}<br /><small>{oa === sideOf(evA) ? 'for you' : 'against you'}</small></>} cells={cells.filter((c) => c.oa === oa)} />
                  ))}
                </div>
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <Callout icon="spark">{!best || (Math.abs(best.after - best.before) < 1 && Math.abs(worst.after - worst.before) < 1)
                    ? <>This scenario doesn’t change these two events. Pick events you adjusted, or add a position.</>
                    : <>Biggest improvement: <b>{evA.short} {best.oa}, {evB.short} {best.ob}</b> <b className={best.after - best.before >= 0 ? 'gain' : 'loss'}>{sfmt(best.after - best.before)}</b>. Biggest deterioration: <b>{evA.short} {worst.oa}, {evB.short} {worst.ob}</b> <b className={worst.after - worst.before < 0 ? 'loss' : 'gain'}>{sfmt(worst.after - worst.before)}</b>, ending at <b className={worst.after < 0 ? 'loss' : 'gain'}>{sfmt(worst.after)}</b>.</>}</Callout>
                </div>
              </div>
            </Card>
          </div>
        </div>

        <Card id="payoff">
          <CardHeader title="Payoff by event" sub="P&L if each adjusted event resolves for or against you · ○ current → ● scenario" />
          <div className="card-b"><div style={{ maxWidth: 860 }}>{touched.length ? <Dumbbell events={touched} base={base} S={S} /> : <div className="empty"><p>Adjust a position to see payoffs move.</p></div>}</div></div>
        </Card>

        <Card id="cmp" flush>
          <CardHeader pad title="Compare scenarios" sub="Calculated live for every scenario · the line under each value is the change vs. your current portfolio · click a column to open it" />
          <div className="dt-wrap">
            <table className="dt cmp-table">
              <thead><tr>
                <th scope="col" className="sticky">Metric</th>
                <th scope="col" className="r">Current portfolio<small>base</small></th>
                {scenarios.map((s) => (
                  <th scope="col" key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>
                    <button type="button" className="col-btn" aria-pressed={s.key === activeKey} onClick={() => { setActiveKey(s.key); setRenaming(false); document.getElementById('summary')?.scrollIntoView({ behavior: 'smooth' }) }}>
                      <i style={{ background: s.color }} />{s.name}
                    </button>
                    <small>{s.adjs.length} change{s.adjs.length === 1 ? '' : 's'} · {SC.statusLabel(s).toLowerCase()}{Object.keys(sims[s.key].errors).length ? ' · invalid input' : ''}{sims[s.key].shortfall.pm + sims[s.key].shortfall.ks > 0 ? ` · needs ${fmt(sims[s.key].shortfall.pm + sims[s.key].shortfall.ks)} more cash` : ''}</small>
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.key}>
                    <th scope="row" className="sticky" style={{ fontWeight: 'var(--font-weight-regular)' }}>{r.label}</th>
                    <td className="r t2">{value(r, B)}</td>
                    {scenarios.map((s) => {
                      const m = metricsOf(s.key)
                      const a = r.key === 'largestEventLoss' ? -m.largestEventLoss : (m[r.key] as number), b = r.key === 'largestEventLoss' ? -B.largestEventLoss : (B[r.key] as number)
                      const d = a - b, good = r.tone === 'neutral' ? null : r.tone === 'up' ? d > 0 : d < 0
                      return (
                        <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>
                          <span style={s.key === activeKey ? { fontWeight: 'var(--font-weight-semibold)' } : undefined}>{value(r, m)}</span>
                          <small className={cx(Math.abs(d) < 0.5 || good == null ? 't3' : good ? 'gain' : 'loss')}>{Math.abs(d) < 0.5 ? 'no change' : sfmt(d)}</small>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="foot"><span>All scenarios use the current assumptions: fees {includeFees ? 'estimated' : 'excluded'}, BTC × ETH {REL_TEXT[crypto].short.toLowerCase()}. Green = better for you, red = worse, grey = a transfer (e.g. cash into contracts).</span><span>{scenarios.length} scenarios</span></div>
        </Card>

        <section className="card assume anchor" id="assume" aria-label="Assumptions">
          <div><div className="l">Fill prices</div><div className="v">Your assumed prices ({MIN_PRICE.toFixed(2)}–{MAX_PRICE.toFixed(2)})</div></div>
          <div><div className="l">Trading fees</div><div className="v">
            <button type="button" role="switch" aria-checked={includeFees} aria-label="Include estimated fees" className={cx('switch', includeFees && 'on')} onClick={() => setIncludeFees((x) => !x)}><span /></button>
            {includeFees ? `Estimated: Kalshi ${(FEE_RATE.ks * 100).toFixed(1)}% · Polymarket ${(FEE_RATE.pm * 100).toFixed(0)}% of notional` : 'Excluded'}</div></div>
          <div><div className="l">Slippage / depth</div><div className="v">Not modeled</div></div>
          <div><div className="l">Event relationships</div><div className="v">BTC × ETH: {REL_TEXT[crypto].short} · macro: related <button type="button" className="link" onClick={() => setEditRel(true)} title="Shared with Risk">Change</button></div></div>
        </section>

        <div className="footer-note"><span>Scenario results show what happens under the outcomes and prices you choose. They aren’t forecasts or recommendations.</span><span>Sample portfolio · fictional data</span></div>
      </main>

      {editRel && <RelationshipModal current={crypto} onClose={() => setEditRel(false)} />}
      {pending && <AddToScenarioModal ids={pending} scenarios={scenarios} defaultTarget={!isBase && active ? active.key : scenarios[0]?.key ?? 'new'} onCancel={() => setPending(null)} onConfirm={confirmAdd} />}
      {confirmDelete && active && (
        <Modal title={`Delete “${active.name}”?`} sub="This can’t be undone" onClose={() => setConfirmDelete(false)}
          footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="primary" onClick={remove}>Delete scenario</Button></>}>
          <p className="t2">This removes the scenario and its {active.adjs.length} adjustment{active.adjs.length === 1 ? '' : 's'}. Your current portfolio isn’t affected.</p>
        </Modal>
      )}
    </div>
  )
}

/** P&L of one position's event for an outcome, including the scenario's own trades on that position. */
function groupPnlFor(S: Simulation, id: string, o: Outcome) {
  const h = S.holdings[id]
  return (h.shares > 0 ? (h.side === o ? h.shares : 0) - h.cost : 0) + (S.realizedBy[id] ?? 0) - (id in S.realizedBy ? 0 : S.feesBy[id] ?? 0)
}

function AdjustmentRow({ a, error, shortfall, includeFees, onChange, onRemove }: { a: Adjustment; error?: string; shortfall: number; includeFees: boolean; onChange: (a: Adjustment) => void; onRemove: () => void }) {
  const p = POS_BY_ID[a.id]
  const valid = !validatePrice(a.price)
  const [priceText, setPriceText] = useState(valid ? a.price.toFixed(2) : '')
  const [priceErr, setPriceErr] = useState<string | null>(null)
  useEffect(() => { if (!validatePrice(a.price)) { setPriceText(a.price.toFixed(2)); setPriceErr(null) } }, [a.price])
  if (!p) return null
  const d = a.to - p.shares, max = maxFor(p.shares)
  const act = d < 0 ? (a.to === 0 ? ['Exit', 'exit'] : [`Sell ${int(-d)}`, 'sell']) : d > 0 ? [`Buy ${int(d)}`, 'buy'] : ['No change', 'none']
  const setTo = (v: number) => onChange({ ...a, to: Math.max(0, Math.min(max, Math.round(v / 100) * 100)) })
  const notional = valid ? Math.abs(d) * a.price : 0, fee = includeFees ? notional * FEE_RATE[p.platform] : 0
  const commitPrice = (txt: string) => {
    const t = txt.replace('$', '').trim()
    if (t === '' || /^0?\.?0?$/.test(t)) { setPriceErr(null); return } // still typing ("", "0", "0.", ".0")
    const v = Number(t), err = validatePrice(v)
    setPriceErr(err)
    // Invalid prices are passed on too, so the scenario knows: the adjustment is excluded and Save is blocked.
    onChange({ ...a, price: err ? (Number.isFinite(v) ? v : -1) : Math.round(v * 100) / 100 })
  }
  const msg = priceErr ?? error
  return (
    <div className={cx('adj', msg && 'has-error')}>
      <div className="adj-h"><PlatformBadge p={p.platform} /><div><b>{p.market}</b><small><SideChip side={p.side} /> avg {p.avg.toFixed(2)} · mark {p.mark.toFixed(2)} · {fmtDate(p.resolves)}</small></div>
        <button type="button" className="x icon-btn" aria-label={`Remove ${p.market} from scenario`} onClick={onRemove}><Icon name="x" size={14} /></button></div>
      <div className="qty"><span className={cx('act', act[1])}>{act[0]}</span><span>{d !== 0 && <span className="from">{int(p.shares)}</span>}<span className="to">{int(a.to)}</span> <span className="t3">shares</span></span></div>
      <input className="slider" type="range" min={0} max={max} step={100} value={a.to} aria-label={`Target shares of ${p.market}`} aria-valuetext={`${int(a.to)} shares`} onChange={(e) => setTo(Number(e.target.value))} />
      <div className="scale"><button type="button" className="link" onClick={() => setTo(0)}>Exit (0)</button><button type="button" className="link" onClick={() => setTo(p.shares)}>current {int(p.shares)}</button><span>{int(max)}</span></div>
      <div className="f2">
        <div className="field"><label htmlFor={`sh-${a.id}`}>Target shares</label>
          <input id={`sh-${a.id}`} inputMode="numeric" value={a.to} onChange={(e) => { const v = Number(e.target.value.replace(/[^0-9]/g, '')); if (Number.isFinite(v)) onChange({ ...a, to: Math.min(max, v) }) }} /></div>
        <div className="field" style={priceErr ? { borderColor: 'var(--color-loss-fg)' } : undefined}><label htmlFor={`px-${a.id}`}>Assumed fill price ($)</label>
          <input id={`px-${a.id}`} inputMode="decimal" value={priceText} aria-invalid={!!priceErr} aria-describedby={msg ? `err-${a.id}` : undefined}
            onChange={(e) => { setPriceText(e.target.value); commitPrice(e.target.value) }} onBlur={(e) => { const t = e.target.value.replace('$', '').trim(); const err = t === '' ? 'Enter a price' : validatePrice(Number(t)); setPriceErr(err); if (err) onChange({ ...a, price: -1 }); else setPriceText(a.price.toFixed(2)) }} /></div>
      </div>
      <div className="t3" style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-2)' }}>
        {!valid ? 'Waiting for a valid price' : d === 0 ? 'No trade' : d > 0 ? `Spends ${fmt(notional + fee, 2)}${fee ? ` incl. ${fmt(fee, 2)} est. fee` : ''} · worth ${fmt(Math.abs(d) * p.mark, 2)} at the mark · pays ${fmt(Math.abs(d), 0)} if it resolves for you` : `Returns ${fmt(notional - fee, 2)}${fee ? ` after ${fmt(fee, 2)} est. fee` : ''} · realizes ${sfmt(-d * (a.price - p.avg) - fee, 2)} vs. average cost`}
      </div>
      {msg && <div id={`err-${a.id}`} role="alert" className="loss" style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-1)' }}>{msg}. Left out of the results until fixed.</div>}
      {!msg && d > 0 && shortfall > 0 && <div role="status" className="stale" style={{ marginTop: 'var(--space-1)' }}>{p.platform === 'pm' ? 'Polymarket' : 'Kalshi'} purchases in this scenario exceed available cash; included as if funded.</div>}
    </div>
  )
}

function MatrixRow({ label, cells }: { label: React.ReactNode; cells: { before: number; after: number; impossible: boolean }[] }) {
  return (<>
    <div className="mh row"><span>{label}</span></div>
    {cells.map((v, i) => v.impossible ? (
      <div key={i} className="cell impossible"><div className="caps">Not possible</div><div className="was">Mutually exclusive: both can’t resolve YES</div></div>
    ) : (
      <div key={i} className={cx('cell', v.after >= 0 ? 'pos' : 'neg')}>
        {Math.abs(v.after - v.before) < 0.5 ? <span className="delta flat">—</span> : <span className={cx('delta', v.after > v.before ? 'good' : 'bad')}>{sfmt(v.after - v.before)}</span>}
        <div className="caps">Scenario</div><div className={cx('v', v.after >= 0 ? 'gain' : 'loss')}>{sfmt(v.after)}</div><div className="was">was {sfmt(v.before)}</div></div>
    ))}
  </>)
}

function Dumbbell({ events, base, S }: { events: RiskEvent[]; base: Simulation; S: Simulation }) {
  const sideOf = (e: RiskEvent) => POSITIONS.find((p) => p.eventId === e.id)?.side ?? 'YES'
  const val = (sim: Simulation, e: RiskEvent, forYou: boolean) => { const s = sideOf(e); return groupPnl(sim, [e.id], { [e.id]: forYou ? s : s === 'YES' ? 'NO' : 'YES' }) }
  const vals = events.flatMap((e) => [true, false].flatMap((w) => [val(base, e, w), val(S, e, w)]))
  const lim = Math.ceil(Math.max(3000, ...vals.map(Math.abs)) / 1000) * 1000
  const [wrap, W] = useWidth<HTMLDivElement>(600)
  // Narrow: event names sit above their rows instead of in a left column.
  const compact = W < 480, left = compact ? 84 : 220, top = compact ? 24 : 0
  const rowH = 76 + top, H = events.length * rowH + 30, X = (v: number) => left + ((v + lim) / (2 * lim)) * (W - left - 20)
  const maxName = compact ? Math.floor(W / 8) : 26
  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ overflow: 'visible' }} role="img" aria-label={events.map((e) => `${e.short}: if for you ${sfmt(val(base, e, true))} → ${sfmt(val(S, e, true))}; if against ${sfmt(val(base, e, false))} → ${sfmt(val(S, e, false))}`).join('. ')}>
        <g className="axis">{[-lim, -lim / 2, 0, lim / 2, lim].map((t) => <g key={t}><line className={t ? 'grid-l' : 'zero'} x1={X(t)} x2={X(t)} y1={4} y2={H - 26} strokeDasharray={t ? '2 4' : undefined} /><text x={X(t)} y={H - 8} textAnchor="middle">{t ? `${t > 0 ? '+' : ''}${kfmt(t)}` : '$0'}</text></g>)}</g>
        {events.map((e, i) => {
          const y0 = 20 + i * rowH + top
          return (
            <g key={e.id}>
              <text className="name" x={0} y={compact ? y0 - 14 : y0 + 18}>{e.name.length > maxName ? `${e.name.slice(0, maxName - 1)}…` : e.name}</text>
              {([[true, 'if for you', y0], [false, 'if against', y0 + 28]] as const).map(([w, lab, yy]) => {
                const b = val(base, e, w), a = val(S, e, w)
                return (
                  <g key={lab}>
                    <text className="ax" x={X(-lim) - 14} y={yy + 4} textAnchor="end">{lab}</text>
                    <line x1={X(b)} x2={X(a)} y1={yy} y2={yy} style={{ stroke: 'var(--color-accent-solid)' }} strokeWidth={3} opacity={0.55} />
                    <circle cx={X(b)} cy={yy} r={5} style={{ fill: 'var(--color-bg-surface)', stroke: 'var(--color-text-secondary)' }} strokeWidth={1.6} />
                    <circle cx={X(a)} cy={yy} r={6} style={{ fill: 'var(--color-accent-fg)' }} />
                    {(() => { const r = Math.max(X(a), X(b)) + 11, flip = r > W - 56; return <text className="lbl" x={flip ? Math.min(X(a), X(b)) - 11 : r} textAnchor={flip ? 'end' : 'start'} y={yy + 4} style={{ fill: a >= 0 ? 'var(--color-gain-fg)' : 'var(--color-loss-fg)' }}>{sfmt(a)}</text> })()}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** Confirms an incoming “add to scenario” request: which scenario, and which holdings. Nothing changes until Add. */
function AddToScenarioModal({ ids, scenarios, defaultTarget, onCancel, onConfirm }: {
  ids: string[]; scenarios: Scenario[]; defaultTarget: string; onCancel: () => void; onConfirm: (target: string, ids: string[]) => void
}) {
  const [target, setTarget] = useState(defaultTarget)
  const [picked, setPicked] = useState<string[]>(ids)
  const present = new Set(scenarios.find((x) => x.key === target)?.adjs.map((a) => a.id) ?? [])
  const addable = picked.filter((id) => !present.has(id))
  return (
    <Modal title="Add to a scenario" sub="Positions start at their current size and mark, so the scenario doesn’t change until you edit them" onClose={onCancel}
      footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={addable.length === 0} onClick={() => onConfirm(target, addable)}>{addable.length ? `Add ${addable.length} position${addable.length > 1 ? 's' : ''}` : 'Nothing to add'}</Button></>}>
      <label className="add-field"><span className="l">Scenario</span>
        <select data-autofocus className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target scenario">
          {scenarios.map((x) => <option key={x.key} value={x.key}>{x.name} · {x.adjs.length} change{x.adjs.length === 1 ? '' : 's'}</option>)}
          <option value="new">New scenario</option>
        </select>
      </label>
      <fieldset className="add-list"><legend className="l">Holdings</legend>
        {ids.map((id) => {
          const p = POS_BY_ID[id], already = present.has(id)
          return (
            <label key={id} className={cx('choice', picked.includes(id) && !already && 'on')} style={already ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}>
              <input type="checkbox" disabled={already} checked={already || picked.includes(id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, id] : x.filter((y) => y !== id)))} />
              <span><span className="row" style={{ gap: 'var(--space-2)' }}><PlatformBadge p={p.platform} />{p.market}<SideChip side={p.side} /></span>
                <small>{already ? 'Already in this scenario: left as it is' : `${int(p.shares)} shares at ${p.mark.toFixed(2)}`}</small></span>
            </label>
          )
        })}
      </fieldset>
    </Modal>
  )
}

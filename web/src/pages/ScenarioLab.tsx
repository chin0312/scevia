/* Scenario Lab: construct and compare hypothetical prediction-market portfolios.
   Workflow (not a wizard): choose a scenario → set it up (starting portfolio, added capital, assumptions) → build its
   portfolio (held positions, searched markets, pasted links) → review impact and settlement → compare scenarios.
   Everything is hypothetical: actual holdings, cash and history are never changed. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Menu, Modal, useToast } from '../components/overlays'
import { RelationshipModal } from '../components/relationships'
import { SectionRail, scrollToSection, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, PlatformBadge, Seg, SideChip, cx } from '../components/ui'
import { FEE_RATE, TODAY } from '../data/portfolio'
import { PLATFORM_NAME } from '../data/labels'
import { REL_TEXT, useRelations } from '../data/relations'
import type { Platform, RelClass } from '../data/types'
import { MAX_FUNDING, MAX_JOINT_EVENTS, POSITIONS, POS_BY_ID, account, fmtDate, instrumentOfPosition, validFunding, type Adjustment, type Baseline } from '../lib/finance'
import { fmt, int, sfmt } from '../lib/format'
import { claimHandoff, readHandoff } from '../lib/handoff'
import * as SC from '../lib/scenarios'
import { readStored } from '../lib/storage'
import { useSessionState, useStorageHealthy } from '../lib/useSessionState'
import type { Scenario } from '../lib/scenarios'
import { AddPositionModal } from './lab/AddPosition'
import { PositionRow } from './lab/Builder'
import { AllocationImpact, Dumbbell, OutcomeMatrix } from './lab/Impact'
import { COLORS, EXAMPLES, ROWS, diff, evaluate, evaluateActual, eventsHeld, rowValue, type Evaluation, type Row } from './lab/model'

const RAIL: RailSection[] = [
  { id: 'setup', label: 'Setup & assumptions', icon: 'sliders' },
  { id: 'builder', label: 'Portfolio', icon: 'layers' },
  { id: 'impact', label: 'Impact', icon: 'compare', children: [{ id: 'ba', label: 'Before / after' }, { id: 'alloc', label: 'Allocation' }] },
  { id: 'settlement', label: 'Settlement', icon: 'grid', children: [{ id: 'matrix', label: 'Outcome matrix' }, { id: 'payoff', label: 'Payoff by event' }] },
  { id: 'cmp', label: 'Compare', icon: 'table' },
]
const KEY = 'scevia-scenarios-v4', LEGACY_KEY = 'scevia-scenarios-v3'
const known = (id: string) => !!POS_BY_ID[id]
const NO_ADJ: Adjustment[] = []

export default function ScenarioLab() {
  useHashScroll()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { crypto: sharedCrypto } = useRelations()
  // A new workspace is empty. Scenarios saved in an earlier format are migrated, never discarded.
  const [legacy] = useState(() => readStored<Scenario[] | null>(LEGACY_KEY, null, (raw) => SC.sanitize(raw, known)?.scenarios ?? null))
  const [scenarios, setScenarios] = useSessionState<Scenario[]>(KEY, legacy ?? [], (raw) => {
    const r = SC.sanitize(raw, known)
    return r ? r.scenarios.map((x, i) => ({ ...x, color: x.color || COLORS[i % COLORS.length] })) : null
  })
  const [storedActive, setActiveKey] = useSessionState<string>('scevia-active-v4', 'base', (v) => (typeof v === 'string' ? v : null))
  const activeKey = storedActive === 'base' || scenarios.some((x) => x.key === storedActive) ? storedActive : 'base'
  const storageOk = useStorageHealthy()
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editShared, setEditShared] = useState(false)
  const [adding, setAdding] = useState(false)

  const isBase = activeKey === 'base'
  const active = scenarios.find((s) => s.key === activeKey)
  const adjs = active?.adjs ?? NO_ADJ

  // Every scenario is evaluated once per change of scenarios or the shared relationship (memoized for the comparison).
  const actual = useMemo(() => evaluateActual(sharedCrypto), [sharedCrypto])
  const evals = useMemo(() => Object.fromEntries(scenarios.map((s) => [s.key, evaluate(s, sharedCrypto)])) as Record<string, Evaluation>, [scenarios, sharedCrypto])
  const E = isBase || !active ? actual : evals[active.key]
  const { start, sim: S, A, B } = E
  const errors = S.errors, errorCount = Object.keys(errors).length
  const fundingErr = active && (['pm', 'ks'] as Platform[]).some((p) => active.funding[p] != null && !validFunding(active.funding[p]))

  const update = (fn: (s: Scenario) => Scenario) => { if (active) setScenarios((ss) => ss.map((s) => (s.key === active.key ? fn(s) : s))) }
  const setAdjs = (fn: (a: Adjustment[]) => Adjustment[]) => update((s) => ({ ...s, adjs: fn(s.adjs) }))
  const nextKey = () => `s${Date.now().toString(36)}`
  const nextColor = () => COLORS[scenarios.length % COLORS.length]

  // Hand-offs from other modules (lib/handoff.ts): confirm first; each request id is processed once.
  const [pending, setPending] = useState<{ ids: string[]; from: string | null } | null>(null)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    const h = readHandoff(params)
    if (!h) return
    const sig = h.req ?? params.toString()
    if (handled.current === sig) return
    handled.current = sig
    setParams({}, { replace: true })
    if (!claimHandoff(h.req)) return
    const ids = [...new Set([...h.ids.filter((id) => POS_BY_ID[id]), ...POSITIONS.filter((p) => h.events.includes(p.eventId)).map((p) => p.id)])]
    if (!ids.length) { toast('Those holdings aren’t in your portfolio', 'info'); return }
    setPending({ ids, from: h.from ?? (h.events.length ? 'Event link · all platforms' : null) })
  }, [params, setParams, toast])
  const confirmAdd = (target: string, ids: string[]) => {
    const adds = ids.map((id) => ({ id, to: POS_BY_ID[id].shares, price: POS_BY_ID[id].mark, instrument: instrumentOfPosition(POS_BY_ID[id]) }))
    let key = target, name = scenarios.find((x) => x.key === target)?.name ?? 'New scenario'
    if (target === 'new') {
      key = nextKey(); name = 'New scenario'
      setScenarios((ss) => [...ss, SC.addPositions(SC.create(key, COLORS[ss.length % COLORS.length], name), adds).scenario])
    } else setScenarios((ss) => ss.map((x) => (x.key === target ? SC.addPositions(x, adds).scenario : x)))
    setActiveKey(key); setPending(null)
    toast(`Added ${ids.length > 1 ? `${ids.length} positions` : `“${POS_BY_ID[ids[0]].market}”`} to “${name}” at current size and mark: no change until you edit ${ids.length > 1 ? 'them' : 'it'}`, 'info')
    window.setTimeout(() => scrollToSection('builder'), 50)
  }

  const create = (baseline: Baseline) => {
    const key = nextKey()
    setScenarios((ss) => [...ss, SC.create(key, nextColor(), baseline === 'scratch' ? 'From scratch' : 'Untitled scenario', baseline)])
    setActiveKey(key); setRenaming(true)
  }
  const startExample = (i: number) => {
    const key = nextKey(), ex = EXAMPLES[i]
    setScenarios((ss) => [...ss, SC.fromExample(key, nextColor(), { name: ex.name, adjs: ex.adjs(), baseline: 'portfolio' })])
    setActiveKey(key); toast(`Started from the example “${ex.name}” (not saved yet)`, 'info')
  }
  const save = () => { if (!active || errorCount || fundingErr) return; update((s) => SC.save(s, 'this session')); toast(`Saved “${active.name}”`) }
  const duplicate = () => { if (!active) return; const key = nextKey(); setScenarios((ss) => [...ss, SC.duplicate(active, key, nextColor())]); setActiveKey(key); toast('Scenario duplicated (not saved yet)') }
  const revert = () => { if (!active) return; update(SC.revert); toast(active.saved ? 'Reverted to the saved version' : 'Reset to where this scenario started', 'info') }
  const remove = () => { if (!active) return; setScenarios((ss) => ss.filter((s) => s.key !== active.key)); setActiveKey('base'); setConfirmDelete(false); toast(`Deleted “${active.name}”`, 'info') }

  const newMenu = (
    <Menu label="New scenario" width={300} trigger={(t) => <button type="button" className="btn btn-sm" {...t}><Icon name="plus" size={15} />New scenario</button>}>
      {(close) => (<>
        <div className="menu-h">Start from</div>
        <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); create('portfolio') }}><Icon name="layers" />Current portfolio<small className="t3" style={{ marginLeft: 'auto' }}>no changes</small></button>
        <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); create('scratch') }}><Icon name="plus" />Empty portfolio<small className="t3" style={{ marginLeft: 'auto' }}>from scratch</small></button>
        <div className="menu-h">Examples</div>
        {EXAMPLES.map((ex, i) => <button type="button" role="menuitem" key={ex.name} className="menu-i" onClick={() => { close(); startExample(i) }}><Icon name="flask" />{ex.name}</button>)}
      </>)}
    </Menu>
  )

  const touchedEvents = useMemo(() => [...new Set(adjs.map((a) => S.holdings[a.id]?.eventId).filter((x): x is string => !!x))], [adjs, S])

  return (
    <div className="shell">
      <SectionRail sections={RAIL}>
        <div className="rail-keep">
          <h6 className="caps" style={{ paddingLeft: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>Scenarios</h6>
          <div className="scn" role="listbox" aria-label="Scenarios">
            <a href="#setup" role="option" aria-selected={isBase} className={cx(isBase && 'on')} onClick={(e) => { e.preventDefault(); setActiveKey('base'); setRenaming(false) }}><i style={{ background: 'var(--color-text-tertiary)' }} />Current portfolio<small>actual</small></a>
            {scenarios.map((s) => (
              <a key={s.key} href="#setup" role="option" aria-selected={activeKey === s.key} className={cx(activeKey === s.key && 'on')} onClick={(e) => { e.preventDefault(); setActiveKey(s.key); setRenaming(false) }}>
                <i style={{ background: s.color }} /><span className="scn-n">{s.name}</span><small>{SC.status(s) === 'saved' ? (s.savedAt === 'this session' ? 'saved' : `saved ${fmtDate(s.savedAt!)}`) : SC.status(s) === 'new' ? 'not saved' : 'edited'}</small>
              </a>
            ))}
            <a href="#setup" className="t3" onClick={(e) => { e.preventDefault(); create('portfolio') }}>+ New scenario</a>
          </div>
        </div>
      </SectionRail>

      <main className="lab-main">
        <section className="page-head anchor" id="summary">
          <div style={{ minWidth: 0 }}>
            <div className="caps"><span className="accent">Scenario Lab</span> · {isBase ? 'Your actual portfolio, unchanged' : active ? `${SC.statusLabel(active)} · ${active.baseline === 'scratch' ? 'starts from an empty portfolio' : 'starts from your current portfolio'}` : ''}</div>
            {isBase ? <h1>Current portfolio</h1> : renaming
              ? <input className="inline-edit" aria-label="Scenario name" autoFocus defaultValue={active?.name} onBlur={(e) => { const v = e.target.value; update((s) => SC.rename(s, v)); setRenaming(false) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false) }} />
              : <h1 className="scn-title">{active?.name}<button type="button" className="edit-btn" aria-label="Rename scenario" onClick={() => setRenaming(true)}><Icon name="edit" size={16} /></button></h1>}
          </div>
          <div className="actions">
            {newMenu}
            {!isBase && <Button variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>Delete</Button>}
            {!isBase && <Button variant="ghost" icon="reset" onClick={revert} disabled={!active || !SC.canRevert(active)}>{active?.saved ? 'Revert' : 'Reset'}</Button>}
            {!isBase && <Button icon="copy" onClick={duplicate}>Duplicate</Button>}
            {!isBase && <Button variant="primary" icon="save" onClick={save} disabled={!active || !SC.isDirty(active) || errorCount > 0 || !!fundingErr} title={errorCount || fundingErr ? 'Fix the highlighted inputs first' : undefined}>{active && !SC.isDirty(active) ? 'Saved' : 'Save scenario'}</Button>}
          </div>
        </section>
        <Callout icon="shield"><b>Hypothetical only.</b> No orders are placed and your actual holdings don’t change. Prices are what <i>you</i> assume you could trade at, not quotes. Outcomes are shown without probabilities.</Callout>
        {!storageOk && <Callout tone="warn" icon="alert">This browser isn’t letting Scevia keep data in this tab, so scenarios will be lost when you reload or leave the page.</Callout>}

        {/* 1 · Setup and assumptions: before any results */}
        <Card id="setup">
          <CardHeader title="Setup & assumptions" sub={isBase ? 'Your actual portfolio is the reference point. Create a scenario to explore changes.' : 'What this scenario starts from and assumes. Results below update as you change these.'} />
          <div className="card-b setup">
            {isBase || !active ? (
              <div className="setup-empty">
                <p className="t2">Scenarios are hypothetical portfolios. Start from what you hold now, or from an empty portfolio with capital you choose. Nothing is pre-filled.</p>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <Button variant="primary" icon="layers" onClick={() => create('portfolio')}>Start from current portfolio</Button>
                  <Button icon="plus" onClick={() => create('scratch')}>Start from scratch</Button>
                </div>
                <Facts />
              </div>
            ) : <Setup s={active} E={E} sharedCrypto={sharedCrypto} onChange={(patch) => update((s) => SC.configure(s, patch))} onEditShared={() => setEditShared(true)} />}
          </div>
        </Card>

        {/* 2 · Portfolio construction */}
        <Card id="builder" flush>
          <CardHeader pad title="Portfolio" sub={isBase ? 'Your current holdings. Create a scenario to change them or add markets.' : `${adjs.length} position${adjs.length === 1 ? '' : 's'} in this scenario · target shares at the price you assume you’d trade at`}
            right={!isBase && active && <Button size="sm" icon="plus" onClick={() => setAdding(true)}>Add position…</Button>} />
          {isBase ? <HoldingsList /> : <>
            <div role="table" aria-label="Scenario positions" className="builder">
              {adjs.length > 0 && <div className="brow brow-h" role="row"><span role="columnheader">Position</span><span role="columnheader" className="r">Current</span><span role="columnheader">Target shares</span><span role="columnheader">Trade</span><span role="columnheader">Assumed price</span><span role="columnheader" className="r">Notional</span><span role="columnheader" className="r">Est. fee</span><span role="columnheader"><span className="sr-only">Remove</span></span></div>}
              {adjs.map((a, k) => <PositionRow key={`${activeKey}:${a.id}`} a={a} start={start.holdings[a.id]} after={S.holdings[a.id]} error={errors[a.id]} includeFees={E.includeFees}
                shortfall={S.shortfall[S.holdings[a.id]?.platform ?? a.instrument?.provider ?? 'pm']}
                onChange={(next) => setAdjs((list) => list.map((x, i) => (i === k ? next : x)))} onRemove={() => setAdjs((list) => list.filter((_, i) => i !== k))} />)}
            </div>
            {adjs.length === 0 && <div className="empty" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
              <p>{active?.baseline === 'scratch' ? 'An empty portfolio. Add markets to build one.' : 'No changes yet: this scenario equals your current portfolio.'}</p>
              <Button size="sm" icon="plus" onClick={() => setAdding(true)}>Add position…</Button></div>}
            <div className="sumbar sumbar-3">
              <div><div className="l">Net cash from trades</div><div className={cx('v', A.cash - B.cash >= 0 ? 'gain' : 'loss')}>{sfmt(A.cash - B.cash, 2)}</div></div>
              <div><div className="l">Cash after trades · Polymarket / Kalshi</div><div className="v" style={{ fontSize: 'var(--font-size-md)' }}><span className={cx(S.cash.pm < 0 && 'loss')}>{fmt(S.cash.pm)}</span> / <span className={cx(S.cash.ks < 0 && 'loss')}>{fmt(S.cash.ks)}</span></div></div>
              <div><div className="l">Funding needed</div><div className={cx('v', A.shortfall > 0 && 'stale')} style={{ fontSize: 'var(--font-size-md)' }}>{A.shortfall > 0 ? (['pm', 'ks'] as Platform[]).filter((p) => S.shortfall[p] > 0).map((p) => `${PLATFORM_NAME[p]} ${fmt(S.shortfall[p], 2)}`).join(' · ') : 'None'}</div></div>
            </div>
          </>}
        </Card>
        {errorCount > 0 && <Callout tone="warn"><b>{errorCount} position{errorCount > 1 ? 's are' : ' is'} incomplete or invalid</b> and left out of the results below. Fix the highlighted fields to include {errorCount > 1 ? 'them' : 'it'}.</Callout>}
        {A.shortfall > 0 && <Callout tone="warn" icon="alert"><b>Needs {fmt(A.shortfall, 2)} more cash than this scenario has</b> on {(['pm', 'ks'] as Platform[]).filter((p) => S.shortfall[p] > 0).map((p) => PLATFORM_NAME[p]).join(' and ')}. Results show the purchases as if funded (cash goes negative), so values stay comparable. Cash isn’t moved between platforms; add capital in Setup to fund it explicitly.</Callout>}

        {/* 3 · Impact */}
        <div className="grid g-lab anchor" id="impact">
          <Card id="ba" flush>
            <CardHeader pad title="Before / after" sub={isBase ? 'Your actual portfolio' : `Starting point → scenario · fees ${E.includeFees ? 'estimated' : 'excluded'} · BTC × ETH ${REL_TEXT[E.crypto].short.toLowerCase()}`} />
            <div className="ba-row h"><span>Metric</span><span>Start</span><span>Scenario</span><span>Change</span></div>
            {E.funding > 0 && <div className="ba-row"><span title="Added in Setup. Contributed capital: part of the starting point, never counted as gain.">Added capital</span><span className="t3">{fmt(E.funding)}</span><span className="after">{fmt(E.funding)}</span><span><span className="delta flat">—</span></span></div>}
            {ROWS.map((r) => {
              const b = rowValue(r, B, start), a = rowValue(r, A, S)
              return <div className="ba-row" key={r.key} title={r.info}><span>{r.label}</span><span className="t3">{show(r, b)}</span><span className="after">{show(r, a)}</span><span>{change(r, a, b)}</span></div>
            })}
            <div className="foot"><span>Buying moves cash into contracts: at reference prices it costs only the gap to the mark and fees. What changes is the range you could end with at settlement.{A.excluded ? ` ${A.excluded} impossible joint outcomes excluded.` : ''}{A.worstValue == null ? ` Best/worst values are unavailable above ${MAX_JOINT_EVENTS} events (exact enumeration only).` : ''}</span></div>
          </Card>
          <Card id="alloc">
            <CardHeader title="Allocation impact" sub="How the portfolio’s market value is spread, before and after" />
            <div className="card-b"><AllocationImpact start={start} after={S} /></div>
          </Card>
        </div>

        {/* 4 · Settlement */}
        <div className="grid g-lab anchor" id="settlement">
          <Card id="matrix">
            <CardHeader title="Outcome matrix" sub="P&L of two events’ positions in each joint outcome, including this scenario’s trades" />
            <div className="card-b"><OutcomeMatrix key={activeKey} start={start} after={S} rels={E.rels} onRelations={() => scrollToSection('setup')} /></div>
          </Card>
          <Card id="payoff">
            <CardHeader title="Payoff by event" sub="Settlement P&L for each event this scenario changes · ○ start → ● scenario" />
            <div className="card-b"><Dumbbell eventIds={touchedEvents} start={start} after={S} /></div>
          </Card>
        </div>

        {/* 5 · Compare */}
        <Compare scenarios={scenarios} evals={evals} actual={actual} activeKey={activeKey} sharedCrypto={sharedCrypto} onOpen={(k) => { setActiveKey(k); setRenaming(false); scrollToSection('setup') }} />

        <div className="footer-note"><span>Scenario results show what happens under the outcomes and prices you choose. They aren’t forecasts or recommendations.</span><span>Sample portfolio · sample market data</span></div>
      </main>

      {editShared && <RelationshipModal current={sharedCrypto} onClose={() => setEditShared(false)} />}
      {adding && active && <AddPositionModal baseline={active.baseline} present={new Set(adjs.map((a) => a.id))} onClose={() => setAdding(false)}
        onAdd={(a) => { setAdjs((list) => (list.some((x) => x.id === a.id) ? list : [...list, a])); toast(a.to == null ? 'Added. Enter a target quantity and price to include it.' : 'Added at its current size: no change until you edit it.', 'info') }} />}
      {pending && <AddToScenarioModal ids={pending.ids} from={pending.from} scenarios={scenarios.filter((s) => s.baseline === 'portfolio')} defaultTarget={!isBase && active?.baseline === 'portfolio' ? active.key : scenarios.find((s) => s.baseline === 'portfolio')?.key ?? 'new'} onCancel={() => setPending(null)} onConfirm={confirmAdd} />}
      {confirmDelete && active && (
        <Modal title={`Delete “${active.name}”?`} sub="This can’t be undone" onClose={() => setConfirmDelete(false)}
          footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="primary" onClick={remove}>Delete scenario</Button></>}>
          <p className="t2">This removes the scenario and its {active.adjs.length} position{active.adjs.length === 1 ? '' : 's'}. Your actual portfolio isn’t affected.</p>
        </Modal>
      )}
    </div>
  )
}

function show(r: Row, v: number | null) {
  if (v == null) return 'Unavailable'
  if (r.key === 'events') return String(v)
  if (r.key === 'largestEventLoss') return sfmt(v)
  if (r.key === 'realized' || r.key === 'fees') return Math.abs(v) < 0.005 ? '$0' : r.key === 'fees' ? fmt(v, 2) : sfmt(v, 2)
  return fmt(v)
}
function change(r: Row, a: number | null, b: number | null) {
  const d = diff(a, b)
  if (d == null) return <span className="delta flat" title="Unavailable">n/a</span>
  if (Math.abs(d) < 0.5) return <span className="delta flat">—</span>
  const good = r.tone === 'neutral' ? null : r.tone === 'up' ? d > 0 : d < 0
  return <span className={cx('delta', good == null ? 'flat' : good ? 'good' : 'bad')}>{r.key === 'events' ? `${d > 0 ? '+' : '−'}${Math.abs(d)}` : sfmt(d)}</span>
}

/** Facts from sources (not editable in a scenario) and fixed methodology. */
function Facts({ baseline = 'portfolio' as Baseline }) {
  const pm = account('pm'), ks = account('ks')
  return (
    <div className="facts">
      <div><h5 className="caps">From your sources</h5>
        {baseline === 'portfolio'
          ? <p className="t2">{POSITIONS.length} holdings · cash Polymarket {fmt(pm.cash)} · Kalshi {fmt(ks.cash)} · marks as of {fmtDate(TODAY)} <span className="t3">(sample portfolio)</span></p>
          : <p className="t2">Not used: this scenario starts empty, with no holdings, cash or history from your accounts.</p>}</div>
      <div><h5 className="caps">Methodology</h5>
        <p className="t2">Contracts settle at $1 or $0. Your assumed price applies to the whole quantity; slippage and order-book depth aren’t modelled. Cash stays on its platform. Fee estimate: Kalshi {(FEE_RATE.ks * 100).toFixed(1)}% · Polymarket {(FEE_RATE.pm * 100).toFixed(0)}% of notional (sample rates).</p></div>
    </div>
  )
}

function Setup({ s, E, sharedCrypto, onChange, onEditShared }: { s: Scenario; E: Evaluation; sharedCrypto: RelClass; onChange: (p: Partial<Pick<Scenario, 'baseline' | 'funding' | 'assumptions'>>) => void; onEditShared: () => void }) {
  const heldRows = s.adjs.filter((a) => !a.instrument).length
  const relValue = s.assumptions.crypto ?? 'inherit'
  return (<>
    <div className="setup-grid">
      <fieldset className="setup-f"><legend className="l">Starting portfolio</legend>
        <Seg label="Starting portfolio" options={['Current portfolio', 'Empty portfolio'] as const} value={s.baseline === 'scratch' ? 'Empty portfolio' : 'Current portfolio'} onChange={(v) => onChange({ baseline: v === 'Empty portfolio' ? 'scratch' : 'portfolio' })} />
        <small className="t3">{s.baseline === 'scratch' ? 'No holdings, cash or history. Positions are bought from zero.' : 'Your holdings and cash, unchanged until you add positions.'}{heldRows > 0 && s.baseline === 'scratch' ? ` ${heldRows} older position${heldRows > 1 ? 's' : ''} can’t be used from scratch.` : ''}</small>
      </fieldset>
      <fieldset className="setup-f"><legend className="l">Added capital <span className="t3">(optional, not profit)</span></legend>
        <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {(['pm', 'ks'] as Platform[]).map((p) => <FundingInput key={p} p={p} value={s.funding[p]} onChange={(v) => onChange({ funding: { ...s.funding, [p]: v } })} />)}
        </div>
        <small className="t3">Contributed capital per platform. It raises cash and the starting value; it’s never counted as a gain.{E.funding > 0 ? ` Total added: ${fmt(E.funding)}.` : ''}</small>
      </fieldset>
      <fieldset className="setup-f"><legend className="l">Trading fees</legend>
        <Seg label="Trading fees" options={['Estimated', 'Excluded'] as const} value={s.assumptions.includeFees === false ? 'Excluded' : 'Estimated'} onChange={(v) => onChange({ assumptions: { ...s.assumptions, includeFees: v === 'Excluded' ? false : undefined } })} />
        <small className="t3">Applies to this scenario’s hypothetical trades only.</small>
      </fieldset>
      <fieldset className="setup-f"><legend className="l">BTC × ETH relationship</legend>
        <select className="select" aria-label="BTC × ETH relationship for this scenario" value={relValue} onChange={(e) => onChange({ assumptions: { ...s.assumptions, crypto: e.target.value === 'inherit' ? undefined : (e.target.value as RelClass) } })}>
          <option value="inherit">Shared: {REL_TEXT[sharedCrypto].label}</option>
          {(['related', 'mutex', 'unknown'] as RelClass[]).map((c) => <option key={c} value={c}>This scenario only: {REL_TEXT[c].label}</option>)}
        </select>
        <small className="t3">{s.assumptions.crypto ? <>Overrides the shared setting for this scenario only; Risk and other scenarios keep {REL_TEXT[sharedCrypto].label.toLowerCase()}. <button type="button" className="link" onClick={() => onChange({ assumptions: { ...s.assumptions, crypto: undefined } })}>Use shared</button></> : <>Shared with Risk and every scenario that doesn’t override it. <button type="button" className="link" onClick={onEditShared}>Edit shared…</button></>}</small>
      </fieldset>
    </div>
    <Facts baseline={s.baseline} />
  </>)
}

function FundingInput({ p, value, onChange }: { p: Platform; value?: number; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(value == null ? '' : String(value))
  useEffect(() => { setText(value == null ? '' : String(value)) }, [value])
  const invalid = value != null && !validFunding(value)
  return (
    <label className={cx('fund', invalid && 'has-error')}><PlatformBadge p={p} size={18} />
      <span className="sr-only">Added capital on {PLATFORM_NAME[p]}</span>
      <input className="num-input" inputMode="decimal" placeholder={`${PLATFORM_NAME[p]} $`} aria-label={`Added capital on ${PLATFORM_NAME[p]}`} aria-invalid={invalid} value={text}
        onChange={(e) => { const t = e.target.value; setText(t); const c = t.replace(/[$,\s]/g, ''); onChange(c === '' ? undefined : /^\d+(\.\d+)?$/.test(c) ? Number(c) : NaN) }} />
      {invalid && <span role="alert" className="loss" style={{ fontSize: 'var(--font-size-xs)' }}>0–{fmt(MAX_FUNDING)}</span>}
    </label>
  )
}

function HoldingsList() {
  return (
    <div role="table" aria-label="Current holdings" className="builder">
      {POSITIONS.map((p) => (
        <div className="brow brow-ro" role="row" key={p.id}>
          <div className="brow-i" role="cell"><PlatformBadge p={p.platform} /><span className="brow-t"><b>{p.market}</b><small className="t3"><SideChip side={p.side} />mark {p.mark.toFixed(2)} · resolves {fmtDate(p.resolves)}</small></span></div>
          <div className="brow-n r" role="cell"><span className="brow-l">Shares</span>{int(p.shares)}</div>
          <div className="brow-n r" role="cell"><span className="brow-l">Value</span>{fmt(p.value)}</div>
        </div>
      ))}
    </div>
  )
}

/** Side-by-side comparison. Each scenario's change is measured from its own starting point (baseline + added capital),
 *  so scenarios with different starts can be compared on what their positions did, not on how much capital they had. */
function Compare({ scenarios, evals, actual, activeKey, sharedCrypto, onOpen }: { scenarios: Scenario[]; evals: Record<string, Evaluation>; actual: Evaluation; activeKey: string; sharedCrypto: RelClass; onOpen: (k: string) => void }) {
  const differs = scenarios.length > 1 && new Set(scenarios.map((s) => JSON.stringify([s.baseline, evals[s.key].funding, evals[s.key].includeFees, evals[s.key].crypto]))).size > 1
  return (
    <Card id="cmp" flush>
      <CardHeader pad title="Compare scenarios" sub="Each value with its change from that scenario’s own starting point · select a column to open it" />
      {scenarios.length === 0 ? <div className="empty"><p>No scenarios yet. Create one to compare it with your current portfolio.</p></div> : (<>
        {differs && <div className="cmp-note"><Callout icon="info">These scenarios start from different portfolios, capital or assumptions. Compare each one’s <b>change from its start</b>; a larger absolute value can simply mean more starting capital.</Callout></div>}
        <div className="dt-wrap">
          <table className="dt cmp-table">
            <thead><tr>
              <th scope="col" className="sticky">Metric</th>
              <th scope="col" className="r">Current portfolio<small>actual</small></th>
              {scenarios.map((s) => (
                <th scope="col" key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>
                  <button type="button" className="col-btn" aria-pressed={s.key === activeKey} onClick={() => onOpen(s.key)}><i style={{ background: s.color }} />{s.name}</button>
                  <small>{s.adjs.length} position{s.adjs.length === 1 ? '' : 's'} · {SC.statusLabel(s).toLowerCase()}{Object.keys(evals[s.key].sim.errors).length ? ' · incomplete' : ''}{evals[s.key].A.shortfall > 0 ? ` · needs ${fmt(evals[s.key].A.shortfall)} more cash` : ''}</small>
                </th>
              ))}
            </tr></thead>
            <tbody>
              <tr className="cmp-setup"><th scope="row" className="sticky">Starts from</th><td className="r t2">—</td>{scenarios.map((s) => <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>{s.baseline === 'scratch' ? 'Empty portfolio' : 'Current portfolio'}</td>)}</tr>
              <tr className="cmp-setup"><th scope="row" className="sticky">Added capital</th><td className="r t2">—</td>{scenarios.map((s) => <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>{evals[s.key].funding ? fmt(evals[s.key].funding) : 'None'}</td>)}</tr>
              <tr className="cmp-setup"><th scope="row" className="sticky">Fees · BTC × ETH</th><td className="r t2">— · {REL_TEXT[sharedCrypto].short}</td>{scenarios.map((s) => <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>{evals[s.key].includeFees ? 'Estimated' : 'Excluded'} · {REL_TEXT[evals[s.key].crypto].short}{s.assumptions.crypto ? '*' : ''}</td>)}</tr>
              {ROWS.map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="sticky" style={{ fontWeight: 'var(--font-weight-regular)' }}>{r.label}</th>
                  <td className="r t2">{show(r, rowValue(r, actual.A, actual.sim))}</td>
                  {scenarios.map((s) => {
                    const e = evals[s.key], a = rowValue(r, e.A, e.sim), b = rowValue(r, e.B, e.start), d = diff(a, b)
                    const good = d == null || r.tone === 'neutral' ? null : r.tone === 'up' ? d > 0 : d < 0
                    return (
                      <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>
                        <span style={s.key === activeKey ? { fontWeight: 'var(--font-weight-semibold)' } : undefined}>{show(r, a)}</span>
                        <small className={cx(d == null || Math.abs(d) < 0.5 || good == null ? 't3' : good ? 'gain' : 'loss')}>{d == null ? 'change unavailable' : Math.abs(d) < 0.5 ? 'no change' : `${r.key === 'events' ? `${d > 0 ? '+' : '−'}${Math.abs(d)}` : sfmt(d)} vs. start`}</small>
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr><th scope="row" className="sticky" style={{ fontWeight: 'var(--font-weight-regular)' }}>Events held</th><td className="r t2">{eventsHeld(actual.sim)}</td>{scenarios.map((s) => <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>{eventsHeld(evals[s.key].sim)}</td>)}</tr>
            </tbody>
          </table>
        </div>
        <div className="foot"><span>Changes exclude added capital: each scenario is measured against its own start. * = relationship overridden for that scenario only. Green = better for you, red = worse, grey = a transfer (e.g. cash into contracts).</span><span>{scenarios.length} scenario{scenarios.length === 1 ? '' : 's'}</span></div>
      </>)}
    </Card>
  )
}

/** Confirms an incoming “add to scenario” request: which scenario, and which holdings. Nothing changes until Add. */
function AddToScenarioModal({ ids, from, scenarios, defaultTarget, onCancel, onConfirm }: {
  ids: string[]; from: string | null; scenarios: Scenario[]; defaultTarget: string; onCancel: () => void; onConfirm: (target: string, ids: string[]) => void
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
          {scenarios.map((x) => <option key={x.key} value={x.key}>{x.name} · {x.adjs.length} position{x.adjs.length === 1 ? '' : 's'}</option>)}
          <option value="new">New scenario (current portfolio)</option>
        </select>
      </label>
      {from && <p className="t2" style={{ fontSize: 'var(--font-size-sm)' }}><span className="t3">From </span>{from}</p>}
      <fieldset className="add-list"><legend className="l">Holdings · {[...new Set(ids.map((id) => PLATFORM_NAME[POS_BY_ID[id].platform]))].join(' + ')}</legend>
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


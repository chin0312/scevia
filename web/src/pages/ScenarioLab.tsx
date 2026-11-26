/* Scenario Lab: construct, analyze and compare hypothetical prediction-market portfolios.
   Entry: pick a starting path (modify current portfolio / build from scratch), resume a scenario, or open an example.
   Active scenario: Build (setup + positions + live summary) → Analyze (charts + exact tables) → Compare (picked
   scenarios). The three views share one scenario state, so moving between them never loses work.
   Everything is hypothetical: actual holdings, cash and history are never changed. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Menu, Modal, useToast } from '../components/overlays'
import { SectionRail, scrollToSection, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, PlatformBadge, SideChip, Tabs, cx } from '../components/ui'
import { PLATFORM_NAME } from '../data/labels'
import type { Platform, PortfolioData } from '../data/types'
import { useActiveWorkspace } from '../lib/workspaceContext'
import { FinanceProvider, emptyPortfolio } from '../lib/financeContext'
import { LAB_ACTIVE_KEY, LAB_SCENARIOS_KEY, baselineDiff, freezeBaseline, mergeByKey } from './lab/baseline'
import { createFinance, fmtDate, instrumentKey, validFunding, type Adjustment, type Baseline, type Finance } from '../lib/finance'
import { validFeePct } from '../lib/fees'
import { fmt, int } from '../lib/format'
import { claimHandoff, readHandoff } from '../lib/handoff'
import * as SC from '../lib/scenarios'
import { readStored, removeStored, scopedKey, writeStored } from '../lib/storage'
import { useSettings } from '../lib/settings'
import { useSessionState, useStorageHealthy } from '../lib/useSessionState'
import type { Scenario } from '../lib/scenarios'
import { AddPositionModal } from './lab/AddPosition'
import { AnalyzeView } from './lab/Analyze'
import { BuildSummary, PositionsCard } from './lab/Builder'
import { CompareView } from './lab/Compare'
import { LabHome } from './lab/Home'
import { AssumptionsBar, AssumptionsDrawer, StartSetup } from './lab/Setup'
import { COLORS, EXAMPLES, describe, evaluate, evaluateActual, type Evaluation, type SizeMode } from './lab/model'
import { PriceCheckModal } from './lab/PriceCheck'
import { useFinance, useFinanceCtx } from '../lib/financeContext'
import { WorkspaceLabel } from '../components/Workspace'

type View = 'Build' | 'Analyze' | 'Compare'
const VIEWS = ['Build', 'Analyze', 'Compare'] as const
const RAILS: Record<View | 'home', RailSection[]> = {
  home: [{ id: 'summary', label: 'Start', icon: 'flask' }, { id: 'saved', label: 'Your scenarios', icon: 'layers' }],
  Build: [{ id: 'setup', label: 'Setup', icon: 'sliders' }, { id: 'positions', label: 'Positions', icon: 'list' }, { id: 'build-summary', label: 'Cash & value', icon: 'db' }],
  Analyze: [
    { id: 'a-summary', label: 'Summary', icon: 'spark' },
    { id: 'a-value', label: 'Value & range', icon: 'bars', children: [{ id: 'a-bridge', label: 'Value bridge' }, { id: 'a-range', label: 'Settlement range' }] },
    { id: 'a-alloc', label: 'Allocation', icon: 'pie' },
    { id: 'a-events', label: 'Exposure & timing', icon: 'target', children: [{ id: 'a-exposure', label: 'Event exposure' }, { id: 'a-timeline', label: 'Resolution timeline' }] },
    { id: 'a-settle', label: 'Outcomes', icon: 'grid', children: [{ id: 'matrix', label: 'Outcome matrix' }, { id: 'payoff', label: 'Payoff by event' }] },
    { id: 'a-positions', label: 'Positions in detail', icon: 'table' },
  ],
  Compare: [{ id: 'c-pick', label: 'Scenarios', icon: 'layers' }, { id: 'c-charts', label: 'Charts', icon: 'compare' }, { id: 'c-table', label: 'Detailed table', icon: 'table' }],
}
const LEGACY_KEYS = ['scevia-scenarios-v4', 'scevia-scenarios-v3']
const NO_ADJ: Adjustment[] = []
const knownIn = (id: string, frozen: PortfolioData | null) => !!frozen?.openPositions.some((p) => p.id === id)

export default function ScenarioLab() {
  const { F, workspaceId: wsId, hasPortfolio } = useFinanceCtx()
  const wsName = useActiveWorkspace().snapshot.summary.name
  const { TODAY, POSITIONS, POS_BY_ID, instrumentOfPosition } = F
  useHashScroll()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  // The Scenario Lab collection is the user's, not a tracked portfolio's. Scenarios kept per portfolio by earlier
  // versions are merged in once (by key, never duplicated) and their old keys removed. Current-portfolio scenarios
  // from then are frozen at this portfolio's state as they're migrated, and say so.
  const sanitizeAll = (raw: unknown) => { const r = SC.sanitize(raw, knownIn); return r ? r.scenarios.map((x, i) => ({ ...x, color: x.color || COLORS[i % COLORS.length] })) : null }
  const [initial] = useState<Scenario[]>(() => {
    let all = readStored<Scenario[]>(LAB_SCENARIOS_KEY, [], sanitizeAll)
    for (const base of LEGACY_KEYS) {
      const k = scopedKey(base, wsId)
      const legacy = readStored<Scenario[] | null>(k, null, (raw) => SC.sanitize(raw, (id) => !!POS_BY_ID[id])?.scenarios ?? null)
      if (!legacy) continue
      const migrated = legacy.map((x) => (x.baseline === 'portfolio' && !x.frozen ? { ...x, frozen: hasPortfolio ? freezeBaseline(F) : null, source: { workspaceId: wsId, name: wsName }, baseAsOf: x.baseAsOf ?? TODAY } : x))
      all = mergeByKey(all, migrated)
      if (writeStored(LAB_SCENARIOS_KEY, all)) removeStored(k)
    }
    return all
  })
  const [scenarios, setScenarios] = useSessionState<Scenario[]>(LAB_SCENARIOS_KEY, initial, sanitizeAll)
  const [initialActive] = useState(() => readStored<string | null>(LAB_ACTIVE_KEY, null, (v) => (typeof v === 'string' ? v : null)) ?? readStored<string>(scopedKey('scevia-active-v4', wsId), 'base', (v) => (typeof v === 'string' ? v : null)))
  const [storedActive, setActiveKey] = useSessionState<string>(LAB_ACTIVE_KEY, initialActive, (v) => (typeof v === 'string' ? v : null))
  const [view, setView] = useSessionState<View>('scevia-lab-view', 'Build', (v) => (VIEWS.includes(v as View) ? (v as View) : null))
  const { settings } = useSettings()
  // A view preference: opens as set in Settings › Scenario Lab; each target keeps the unit it was typed in.
  const [mode, setMode] = useState<SizeMode>(settings.labSize)
  const activeKey = storedActive === 'base' || scenarios.some((x) => x.key === storedActive) ? storedActive : 'base'
  const storageOk = useStorageHealthy()
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [switchTo, setSwitchTo] = useState<Baseline | null>(null)
  const [adding, setAdding] = useState(false)
  const [assumptions, setAssumptions] = useState(false)
  const [priceCheck, setPriceCheck] = useState(false)
  const [undo, setUndo] = useState<{ label: string; prev: Adjustment[]; key: string } | null>(null)

  const isHome = activeKey === 'base'
  const active = scenarios.find((s) => s.key === activeKey)
  const adjs = active?.adjs ?? NO_ADJ

  // Each scenario is evaluated against its own starting point: the frozen snapshot of the portfolio it came from, or
  // an empty portfolio from scratch. Never the latest workspace, so refreshes, other portfolios and preferences can't
  // change its results. Evaluations are cached per scenario object (lab/model.ts).
  const financeOf = useMemo(() => {
    const byData = new WeakMap<PortfolioData, Finance>(), empty = new Map<string, Finance>()
    return (s: Scenario): Finance => {
      if (s.baseline === 'portfolio' && s.frozen) { let f = byData.get(s.frozen); if (!f) { f = createFinance(s.frozen); byData.set(s.frozen, f) } return f }
      const d = s.baseAsOf ?? TODAY
      let f = empty.get(d); if (!f) { f = createFinance(emptyPortfolio(d)); empty.set(d, f) } return f
    }
  }, [TODAY])
  const actual = useMemo(() => evaluateActual(F), [F])
  const evals = useMemo(() => Object.fromEntries(scenarios.map((s) => [s.key, evaluate(s, financeOf(s))])) as Record<string, Evaluation>, [scenarios, financeOf])
  const SF = active ? financeOf(active) : F
  const fromHere = !!active?.source && active.source.workspaceId === wsId && hasPortfolio
  const diff = useMemo(() => (active?.baseline === 'portfolio' && active.frozen && fromHere ? baselineDiff(SF, F) : null), [active, fromHere, SF, F])
  const [rebasing, setRebasing] = useState(false)
  const frozenFor = (): Pick<Scenario, 'frozen' | 'source' | 'baseAsOf'> => ({ frozen: freezeBaseline(F), source: { workspaceId: wsId, name: wsName }, baseAsOf: TODAY })
  const E = active ? evals[active.key] : actual
  const errorCount = Object.keys(E.sim.errors).length
  const fundingErr = active && (['pm', 'ks'] as Platform[]).some((p) => active.funding[p] != null && !validFunding(active.funding[p]))
  const feeErr = active?.assumptions.fees?.mode === 'custom' && !validFeePct(active.assumptions.fees.pct)
  const blocked = errorCount > 0 || !!fundingErr || feeErr

  const update = (fn: (s: Scenario) => Scenario) => { if (active) setScenarios((ss) => ss.map((s) => (s.key === active.key ? fn(s) : s))) }
  const setAdjs = (fn: (a: Adjustment[]) => Adjustment[]) => update((s) => ({ ...s, adjs: fn(s.adjs) }))
  const nextKey = () => `s${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 2).toString(36)}`
  const nextColor = () => COLORS[scenarios.length % COLORS.length]
  const open = (k: string, v: View = 'Build') => { setActiveKey(k); setRenaming(false); setView(v); setUndo(null); window.scrollTo(0, 0) }

  // Opening a scenario from search (?open=key) only selects it; nothing else changes.
  useEffect(() => {
    const k = params.get('open')
    if (!k) return
    if (scenarios.some((x) => x.key === k)) { setActiveKey(k); setView('Build') }
    const next = new URLSearchParams(params); next.delete('open'); setParams(next, { replace: true })
  }, [params]) // eslint-disable-line react-hooks/exhaustive-deps
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
  /** The destination's starting portfolio decides how incoming holdings start: at their current size (no trade) in a
   *  current-portfolio scenario; from zero with no quantity in an empty-portfolio scenario, unless the user chose to
   *  copy their quantities as purchases. */
  const confirmAdd = (target: string, ids: string[], copyQty: boolean) => {
    const dest = target === 'new' ? 'portfolio' : scenarios.find((x) => x.key === target)?.baseline ?? 'portfolio'
    const targetS = scenarios.find((x) => x.key === target)
    const adds = ids.map((id) => {
      const p = POS_BY_ID[id], keep = dest === 'portfolio' || copyQty, inst = instrumentOfPosition(p)
      // A holding that isn't in the target's frozen starting portfolio is added as a new purchase of that instrument.
      if (targetS && targetS.baseline === 'portfolio' && !financeOf(targetS).POS_BY_ID[id]) return { id: instrumentKey(inst), to: null, price: null, instrument: inst }
      return { id, to: keep ? p.shares : null, price: keep ? p.mark : null, instrument: inst }
    })
    let key = target, name = scenarios.find((x) => x.key === target)?.name ?? 'New scenario'
    if (target === 'new') {
      key = nextKey(); name = 'New scenario'
      setScenarios((ss) => [...ss, SC.addPositions({ ...SC.create(key, COLORS[ss.length % COLORS.length], name, 'portfolio', TODAY), ...frozenFor() }, adds).scenario])
    } else setScenarios((ss) => ss.map((x) => (x.key === target ? SC.addPositions(x, adds).scenario : x)))
    open(key); setPending(null)
    const what = ids.length > 1 ? `${ids.length} positions` : `“${POS_BY_ID[ids[0]].market}”`
    toast(dest === 'portfolio' ? `Added ${what} to “${name}” at current size and mark: no change until you edit ${ids.length > 1 ? 'them' : 'it'}`
      : copyQty ? `Added ${what} to “${name}” as purchases of your current quantities, from an empty portfolio`
        : `Added ${what} to “${name}” from zero: enter quantities and prices to include ${ids.length > 1 ? 'them' : 'it'}`, 'info')
    window.setTimeout(() => scrollToSection('positions'), 50)
  }
  /** Switching the starting portfolio changes what target quantities mean, so ask only when rows would change meaning. */
  const requestBaseline = (next: Baseline) => {
    if (!active || next === active.baseline) return
    // Starting from a current portfolio needs one; without it the choice isn't offered (and is refused here too).
    if (next === 'portfolio' && !hasPortfolio) return
    const held = active.adjs.filter((a) => SF.POSITIONS.some((p) => p.id === a.id) || POSITIONS.some((p) => p.id === a.id))
    if (held.length === 0) update((s) => ({ ...SC.configure(s, { baseline: next }), ...(next === 'portfolio' ? frozenFor() : { frozen: null, source: null, baseAsOf: s.baseAsOf ?? TODAY }) }))
    else setSwitchTo(next)
  }
  const applyBaseline = (next: Baseline, keep: boolean) => {
    if (next === 'portfolio' && !hasPortfolio) { setSwitchTo(null); return }
    update((s) => ({ ...SC.configure(s, { baseline: next }), ...(next === 'portfolio' ? frozenFor() : { frozen: null, source: null, baseAsOf: s.baseAsOf ?? TODAY }), adjs: keep ? s.adjs : s.adjs.map((a) => {
      const p = POS_BY_ID[a.id] ?? SF.POS_BY_ID[a.id]
      if (!p) return a
      return next === 'scratch' ? { ...a, to: null, size: undefined } : { ...a, to: p.shares, size: undefined, price: a.price ?? p.mark }
    }) }))
    setSwitchTo(null)
  }

  const create = (baseline: Baseline, funding: Partial<Record<Platform, number>> = {}) => {
    if (baseline === 'portfolio' && !hasPortfolio) return
    const key = nextKey()
    const s0 = SC.create(key, nextColor(), baseline === 'scratch' ? 'From scratch' : 'Untitled scenario', baseline, TODAY, funding, settings.newFees === 'excluded' ? { fees: { mode: 'excluded' } } : {})
    setScenarios((ss) => [...ss, baseline === 'portfolio' ? { ...s0, ...frozenFor() } : s0])
    open(key); setRenaming(true)
    if (baseline === 'scratch') window.setTimeout(() => setAdding(true), 0)
  }
  const startExample = (i: number) => {
    const key = nextKey(), ex = EXAMPLES[i]
    if (!hasPortfolio || !ex.adjs(F)) return
    setScenarios((ss) => [...ss, { ...SC.fromExample(key, nextColor(), { name: ex.name, adjs: ex.adjs(F) ?? [], baseline: 'portfolio' }), ...frozenFor() }])
    open(key); toast(`Started from the example “${ex.name}” (not saved yet)`, 'info')
  }
  const save = () => { if (!active || blocked) return; update((s) => SC.save(s, 'this session')); toast(`Saved “${active.name}”`) }
  const duplicate = () => { if (!active) return; const key = nextKey(); setScenarios((ss) => [...ss, { ...SC.duplicate(active, key, nextColor()), baseAsOf: active.baseAsOf ?? null, frozen: active.frozen ?? null, source: active.source ?? null }]); open(key, view); toast('Scenario duplicated (not saved yet)') }
  const revert = () => { if (!active) return; update(SC.revert); setUndo(null); toast(active.saved ? 'Reverted to the saved version' : 'Reset to where this scenario started', 'info') }
  const remove = () => { if (!active) return; setScenarios((ss) => ss.filter((s) => s.key !== active.key)); setActiveKey('base'); setConfirmDelete(false); toast(`Deleted “${active.name}”`, 'info') }
  /** From an analysis back to the row that causes it. */
  const editRow = (id: string) => {
    setView('Build')
    window.setTimeout(() => { const el = document.getElementById(`row-${id}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.querySelector<HTMLInputElement>('input.num-input')?.focus({ preventScroll: true }); el.classList.add('section-flash'); window.setTimeout(() => el.classList.remove('section-flash'), 1400) } }, 60)
  }

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
  /** Explicit rebase: replace the frozen starting portfolio with the latest one (or copy into a new scenario). */
  const rebase = (copy: boolean) => {
    if (!active || !fromHere) return
    if (copy) { const key = nextKey(); setScenarios((ss) => [...ss, { ...SC.duplicate(active, key, nextColor()), name: `${active.name} (latest)`.slice(0, 80), ...frozenFor() }]); open(key); toast('New scenario from the latest portfolio (not saved yet)') }
    else { update((s) => ({ ...s, ...frozenFor() })); toast('Rebased onto the latest portfolio. Save to keep it.', 'info') }
    setRebasing(false)
  }

  return (
    <div className="shell">
      <SectionRail key={isHome ? 'home' : view} sections={RAILS[isHome ? 'home' : view]}>
        <div className="rail-keep">
          <h6 className="caps" style={{ paddingLeft: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>Scenarios</h6>
          <div className="scn" role="listbox" aria-label="Scenarios">
            <a href="#summary" role="option" aria-selected={isHome} className={cx(isHome && 'on')} onClick={(e) => { e.preventDefault(); setActiveKey('base'); setRenaming(false); window.scrollTo(0, 0) }}><i style={{ background: 'var(--color-text-tertiary)' }} />All scenarios<small>start</small></a>
            {scenarios.map((s) => (
              <a key={s.key} href="#setup" role="option" aria-selected={activeKey === s.key} className={cx(activeKey === s.key && 'on')} onClick={(e) => { e.preventDefault(); open(s.key, view) }}>
                <i style={{ background: s.color }} /><span className="scn-n">{s.name}</span><small>{SC.status(s) === 'saved' ? (s.savedAt === 'this session' ? 'saved' : `saved ${fmtDate(s.savedAt!)}`) : SC.status(s) === 'new' ? 'not saved' : 'edited'}</small>
              </a>
            ))}
          </div>
        </div>
      </SectionRail>

      <FinanceProvider finance={SF} data={active ? active.frozen ?? null : hasPortfolio ? F.PORTFOLIO : null} workspaceId={wsId} revision={null}>
      <main className="lab-main">
        {!storageOk && <Callout tone="warn" icon="alert">This browser isn’t letting Scevia keep data in this tab, so scenarios will be lost when you reload or leave the page.</Callout>}
        {isHome || !active ? (
          <LabHome hasPortfolio={hasPortfolio} scenarios={scenarios} evals={evals} onCurrent={() => create('portfolio')} onScratch={(f) => create('scratch', f)} onOpen={(k) => open(k)} onExample={startExample} />
        ) : (<>
          <section className="page-head anchor lab-head" id="summary">
            <div style={{ minWidth: 0 }}>
              <div className="caps"><span className="accent">Scenario Lab</span> · {SC.statusLabel(active)} · hypothetical, nothing is traded</div>
              {renaming
                ? <input className="inline-edit" aria-label="Scenario name" autoFocus defaultValue={active.name} onBlur={(e) => { const v = e.target.value; update((s) => SC.rename(s, v)); setRenaming(false) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false) }} />
                : <h1 className="scn-title">{active.name}<button type="button" className="edit-btn" aria-label="Rename scenario" onClick={() => setRenaming(true)}><Icon name="edit" size={16} /></button></h1>}
            </div>
            <div className="actions">
              {newMenu}
              <Button variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>Delete</Button>
              <Button variant="ghost" icon="reset" onClick={revert} disabled={!SC.canRevert(active)}>{active.saved ? 'Revert' : 'Reset'}</Button>
              <Button icon="copy" onClick={duplicate}>Duplicate</Button>
              <Button variant="primary" icon="save" onClick={save} disabled={!SC.isDirty(active) || blocked} title={blocked ? 'Fix the highlighted inputs first' : undefined}>{!SC.isDirty(active) ? 'Saved' : 'Save scenario'}</Button>
            </div>
          </section>
          <div className="lab-nav">
            <Tabs label="Scenario views" options={VIEWS} value={view} onChange={(v) => { setView(v); window.scrollTo(0, 0) }}
              render={(o) => <span className="row" style={{ gap: 'var(--space-2)' }}>{o}{o === 'Build' && errorCount > 0 && <span className="tab-flag" aria-label={`${errorCount} incomplete`}>{errorCount}</span>}{o === 'Compare' && <small className="t3">{scenarios.length}</small>}</span>} />
            <AssumptionsBar s={active} E={E} onEdit={() => setAssumptions(true)} onCheckPrices={() => setPriceCheck(true)} />
          </div>
          {active.baseline === 'portfolio' && (!active.frozen
            ? <Callout tone="warn" icon="alert">This scenario’s starting portfolio wasn’t recorded, so it starts empty. {fromHere ? <button type="button" className="link" onClick={() => rebase(false)}>Start from {wsName} now</button> : `Select ${active.source?.name ?? 'its portfolio'} to rebase it.`}</Callout>
            : !fromHere ? <Callout icon="info">Starts from {active.source?.name ?? 'a portfolio'} as of {fmtDate(active.frozen.asOf)}, frozen. That portfolio isn’t the one selected now (or has no data), so its latest state isn’t compared; the saved starting point and results are kept.</Callout>
            : diff && !diff.same ? <Callout icon="info">{wsName} has changed since this scenario’s starting point ({fmtDate(diff.asOf.frozen)}). The scenario keeps its frozen start until you rebase. <button type="button" className="link" onClick={() => setRebasing(true)}>Review rebase…</button></Callout>
            : null)}

          {view === 'Build' && (
            <div className="build-grid">
              <div className="build-main">
                <StartSetup s={active} E={E} canPortfolio={hasPortfolio} onChange={(patch) => update((s) => SC.configure(s, patch))} onBaseline={requestBaseline} />
                <PositionsCard E={E} adjs={adjs} baseline={active.baseline} mode={mode} onMode={setMode} onAdjs={(fn) => { setUndo(null); setAdjs(fn) }} onAdd={() => setAdding(true)}
                  onBulk={(label, prev) => { setUndo({ label, prev, key: active.key }); toast(label, 'info') }} />
                {undo && undo.key === active.key && <div className="undo-line" role="status"><span>{undo.label}.</span><button type="button" className="link" onClick={() => { setAdjs(() => undo.prev); setUndo(null) }}>Undo</button></div>}
              </div>
              <BuildSummary E={E} onAnalyze={() => { setView('Analyze'); window.scrollTo(0, 0) }} onCover={(p, amount) => { update((s) => SC.configure(s, { funding: { ...s.funding, [p]: (s.funding[p] ?? 0) + amount } })); toast('Virtual capital added. No real funds are involved.') }} />
            </div>
          )}
          {view === 'Analyze' && <AnalyzeView E={E} onEdit={editRow} />}
          {view === 'Compare' && <CompareView key={activeKey} scenarios={scenarios} evals={evals} actual={actual} activeKey={activeKey} onOpen={(k) => open(k, 'Compare')} />}
          <div className="footer-note"><span>Scenario results show what happens under the outcomes and prices you choose. They aren’t forecasts or recommendations.</span><span><WorkspaceLabel suffix="sample market data" /></span></div>
        </>)}
      </main>

      {switchTo && active && (
        <Modal title={switchTo === 'scratch' ? 'Start from an empty portfolio?' : 'Start from your current portfolio?'} sub="This changes what the target quantities of held positions mean" onClose={() => setSwitchTo(null)}
          footer={<><Button variant="ghost" onClick={() => setSwitchTo(null)}>Cancel</Button>
            <Button onClick={() => applyBaseline(switchTo, true)}>Keep target quantities</Button>
            <Button variant="primary" onClick={() => applyBaseline(switchTo, false)}>{switchTo === 'scratch' ? 'Clear quantities of held positions' : 'Start held positions unchanged'}</Button></>}>
          <p className="t2">{switchTo === 'scratch'
            ? 'From an empty portfolio, every target quantity is a purchase from zero. Keeping them turns positions you hold into full-size purchases; clearing them lets you enter new quantities.'
            : 'From your current portfolio, a target quantity is compared with what you hold: the difference becomes a buy or sell. Starting held positions unchanged sets them to your current quantity (no trade).'}</p>
        </Modal>
      )}
      {adding && active && <AddPositionModal baseline={active.baseline} present={new Set(adjs.map((a) => a.id))} onClose={() => setAdding(false)}
        onAdd={(list) => {
          if (!list.length) return
          setUndo(null)
          setAdjs((cur) => [...cur, ...list.filter((a) => !cur.some((x) => x.id === a.id))])
          const blank = list.filter((a) => a.to == null).length
          toast(`Added ${list.length} position${list.length > 1 ? 's' : ''}.${blank ? ` ${blank === list.length ? (blank > 1 ? 'Enter their targets and prices' : 'Enter a target and price') : `${blank} need${blank > 1 ? '' : 's'} a target and price`} to be included.` : ' Held positions start at their current size.'}`, 'info')
          setView('Build')
        }} />}
      {priceCheck && active && <PriceCheckModal adjs={adjs} baseAsOf={active.baseAsOf ?? null} latest={active.baseline === 'portfolio' ? (fromHere ? F : null) : F} titleOf={(a) => `${describe(a, SF).title} · ${describe(a, SF).side}`} onClose={() => setPriceCheck(false)}
        onApply={(checks) => { setAdjs((as) => SC.applyLatestRefs(as, checks)); setPriceCheck(false); toast('Reference prices updated. Save to keep them; assumed prices and targets are unchanged.') }} />}
      {assumptions && active && <AssumptionsDrawer s={active} E={E} onChange={(patch) => update((s) => SC.configure(s, patch))} onClose={() => setAssumptions(false)} />}
      {rebasing && active && diff && (
        <Modal title="Rebase onto the latest portfolio?" sub={`${active.name} · frozen ${fmtDate(diff.asOf.frozen)} → latest ${fmtDate(diff.asOf.latest)}`} onClose={() => setRebasing(false)} width={600}
          footer={<><Button variant="ghost" onClick={() => setRebasing(false)}>Keep existing baseline</Button><Button onClick={() => rebase(true)}>Duplicate with latest</Button><Button variant="primary" onClick={() => rebase(false)}>Rebase this scenario</Button></>}>
          <p className="t2">Rebasing replaces the starting holdings, cash and marks with the latest portfolio. Your hypothetical positions, assumed prices and assumptions stay; held-position targets are then compared with the latest holdings.</p>
          <ul className="rebase-list">
            {diff.cash.map((c) => <li key={c.venue}>Cash on {c.venue === 'pm' ? 'Polymarket' : 'Kalshi'}: {fmt(c.frozen, 2)} → {fmt(c.latest, 2)}</li>)}
            {diff.added.map((x) => <li key={`a${x.id}`}>New holding: {x.market}</li>)}
            {diff.removed.map((x) => <li key={`r${x.id}`}>No longer held: {x.market}</li>)}
            {diff.resized.map((x) => <li key={`s${x.id}`}>{x.market}: {x.frozen} → {x.latest} shares</li>)}
            {diff.marksMoved > 0 && <li>{diff.marksMoved} mark{diff.marksMoved === 1 ? '' : 's'} moved</li>}
            {diff.asOf.frozen !== diff.asOf.latest && <li>Valuation date {fmtDate(diff.asOf.frozen)} → {fmtDate(diff.asOf.latest)}</li>}
          </ul>
          <small className="t3">Checking latest prices only updates reference prices; rebasing changes the whole starting portfolio. Nothing is saved until you save.</small>
        </Modal>
      )}
      </FinanceProvider>
      {pending && <AddToScenarioModal ids={pending.ids} from={pending.from} scenarios={scenarios} defaultTarget={active ? active.key : scenarios[0]?.key ?? 'new'} onCancel={() => setPending(null)} onConfirm={confirmAdd} />}
      {confirmDelete && active && (
        <Modal title={`Delete “${active.name}”?`} sub="This can’t be undone" onClose={() => setConfirmDelete(false)}
          footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="primary" onClick={remove}>Delete scenario</Button></>}>
          <p className="t2">This removes the scenario and its {active.adjs.length} position{active.adjs.length === 1 ? '' : 's'}. Your actual portfolio isn’t affected.</p>
        </Modal>
      )}
    </div>
  )
}

/** Confirms an incoming “add to scenario” request: which scenario, and which holdings. Nothing changes until Add. */
function AddToScenarioModal({ ids, from, scenarios, defaultTarget, onCancel, onConfirm }: {
  ids: string[]; from: string | null; scenarios: Scenario[]; defaultTarget: string; onCancel: () => void; onConfirm: (target: string, ids: string[], copyQty: boolean) => void
}) {
  const { POS_BY_ID } = useFinance()
  const [target, setTarget] = useState(defaultTarget)
  const [copyQty, setCopyQty] = useState(false)
  const scratch = scenarios.find((x) => x.key === target)?.baseline === 'scratch'
  const [picked, setPicked] = useState<string[]>(ids)
  const present = new Set(scenarios.find((x) => x.key === target)?.adjs.map((a) => a.id) ?? [])
  const addable = picked.filter((id) => !present.has(id))
  return (
    <Modal title="Add to a scenario" sub={scratch ? 'This scenario starts from an empty portfolio: positions are added from zero' : 'Positions start at their current size and mark, so the scenario doesn’t change until you edit them'} onClose={onCancel}
      footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={addable.length === 0} onClick={() => onConfirm(target, addable, scratch && copyQty)}>{addable.length ? `Add ${addable.length} position${addable.length > 1 ? 's' : ''}` : 'Nothing to add'}</Button></>}>
      <label className="add-field"><span className="l">Scenario</span>
        <select data-autofocus className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target scenario">
          {scenarios.map((x) => <option key={x.key} value={x.key}>{x.name} · {x.adjs.length} position{x.adjs.length === 1 ? '' : 's'}{x.baseline === 'scratch' ? ' · empty portfolio' : ''}</option>)}
          <option value="new">New scenario (current portfolio)</option>
        </select>
      </label>
      {from && <p className="t2" style={{ fontSize: 'var(--font-size-sm)' }}><span className="t3">From </span>{from}</p>}
      {scratch && <label className="choice"><input type="checkbox" checked={copyQty} onChange={(e) => setCopyQty(e.target.checked)} /><span>Copy my current quantities as purchases<small>Otherwise they’re added with no quantity, and nothing changes until you enter one.</small></span></label>}
      <fieldset className="add-list"><legend className="l">Holdings · {[...new Set(ids.map((id) => PLATFORM_NAME[POS_BY_ID[id].platform]))].join(' + ')}</legend>
        {ids.map((id) => {
          const p = POS_BY_ID[id], already = present.has(id)
          return (
            <label key={id} className={cx('choice', picked.includes(id) && !already && 'on')} style={already ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}>
              <input type="checkbox" disabled={already} checked={already || picked.includes(id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, id] : x.filter((y) => y !== id)))} />
              <span><span className="row" style={{ gap: 'var(--space-2)' }}><PlatformBadge p={p.platform} />{p.market}<SideChip side={p.side} /></span>
                <small>{already ? 'Already in this scenario: left as it is' : scratch ? (copyQty ? `Buys ${int(p.shares)} shares at ${p.mark.toFixed(2)}` : 'Added from zero; you enter the quantity') : `${int(p.shares)} shares at ${p.mark.toFixed(2)} (no change)`}</small></span>
            </label>
          )
        })}
      </fieldset>
    </Modal>
  )
}


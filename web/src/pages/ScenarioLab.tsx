import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Menu, useToast } from '../components/overlays'
import { SectionRail, useHashScroll, type RailSection } from '../components/shell'
import { Button, Callout, Card, CardHeader, Chip, PlatformBadge, SideChip, Tabs, cx } from '../components/ui'
import { ACCOUNT, EVENTS, POSITIONS, POS_BY_ID, type RiskEvent } from '../data/portfolio'
import { fmt, int, kfmt, sfmt } from '../lib/format'
import { REL_TEXT, pairRelation, useCryptoRelation } from '../data/relations'

interface Adj { id: string; to: number; px: number }
interface Scenario { key: string; name: string; adjs: Adj[]; saved: string | null; color: string }
type State = Record<string, { sh: number; cost: number; realized: number }>

const RAIL: RailSection[] = [
  { id: 'adjust', label: 'Adjustments', icon: 'sliders' },
  { id: 'ba', label: 'Before / after', icon: 'compare' },
  { id: 'matrix', label: 'Outcome matrix', icon: 'grid' },
  { id: 'payoff', label: 'Payoff by event', icon: 'bars' },
  { id: 'cmp', label: 'Compare scenarios', icon: 'table' },
  { id: 'assume', label: 'Assumptions', icon: 'info' },
]
const INITIAL: Scenario[] = [
  { key: 'draft', name: 'Trim crypto, add to Fed', saved: null, color: 'var(--color-accent-solid)', adjs: [{ id: 'btc', to: 4000, px: 0.29 }, { id: 'fedk', to: 6200, px: 0.65 }, { id: 'chf', to: 0, px: 0.12 }] },
  { key: 'sports', name: 'Exit sports longshots', saved: 'Nov 21', color: 'var(--color-data-1)', adjs: [{ id: 'cel', to: 0, px: 0.26 }, { id: 'chf', to: 0, px: 0.12 }] },
  { key: 'shut', name: 'Hedge the shutdown', saved: 'Nov 18', color: 'var(--color-data-3)', adjs: [{ id: 'shut', to: 3500, px: 0.47 }] },
]
const NO_ADJ: Adj[] = []
const maxFor = (sh: number) => Math.max(1000, Math.ceil((sh * 1.5) / 1000) * 1000)

function simulate(adjs: Adj[], feeRate: number) {
  const st: State = Object.fromEntries(POSITIONS.map((p) => [p.id, { sh: p.shares, cost: p.cost, realized: 0 }]))
  let cash = 0
  adjs.forEach((a) => {
    const p = POS_BY_ID[a.id], s = st[a.id], d = a.to - p.shares, fee = Math.abs(d) * a.px * feeRate
    if (d < 0) { s.realized = -d * (a.px - p.avg) - fee; s.sh = a.to; s.cost = a.to * p.avg; cash += -d * a.px - fee }
    else if (d > 0) { s.sh = a.to; s.cost = p.cost + d * a.px; cash -= d * a.px + fee; s.realized = -fee }
  })
  return { st, cash }
}
type Sim = ReturnType<typeof simulate>
const evP = (S: Sim, ids: string[], win: boolean) => ids.reduce((t, i) => { const s = S.st[i]; return t + s.realized + (win ? s.sh - s.cost : -s.cost) }, 0)
function metrics(S: Sim) {
  const v = Object.values(S.st), committed = v.reduce((a, s) => a + s.cost, 0), real = v.reduce((a, s) => a + s.realized, 0), sh = v.reduce((a, s) => a + s.sh, 0)
  const largest = Math.max(...EVENTS.map((e) => e.ids.reduce((a, i) => a + S.st[i].cost, 0)))
  return { committed, cash: ACCOUNT.cash + S.cash, worst: -committed + real, best: sh - committed + real, fedNo: evP(S, ['fedk', 'fedp'], false), largest: -largest, real }
}
const BASE = simulate([], 0)

/* Session persistence: scenarios survive navigation within the prototype (no backend). */
function useSessionState<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => { const raw = sessionStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial })
  useEffect(() => { sessionStorage.setItem(key, JSON.stringify(v)) }, [key, v])
  return [v, setV] as const
}

export default function ScenarioLab() {
  useHashScroll()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [scenarios, setScenarios] = useSessionState<Scenario[]>('scevia-scenarios', INITIAL)
  const [activeKey, setActiveKey] = useSessionState<string>('scevia-active', 'draft')
  const [dirty, setDirty] = useSessionState<Record<string, boolean>>('scevia-dirty', { draft: true })
  const [renaming, setRenaming] = useState(false)
  const [fees, setFees] = useState(false)
  const [view, setView] = useState<'Portfolio impact' | 'Position impact'>('Portfolio impact')
  const [mxA, setMxA] = useState('fed')
  const [mxB, setMxB] = useState('btc')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [cryptoRel] = useCryptoRelation()

  const isBase = activeKey === 'base'
  const active = scenarios.find((s) => s.key === activeKey)
  const adjs = active?.adjs ?? NO_ADJ
  const feeRate = fees ? 0.02 : 0

  // ?add=<positionId> from Overview / Risk / ⌘K → add to the draft (ref guards StrictMode double-run)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    const id = params.get('add')
    if (!id || !POS_BY_ID[id] || handled.current === id) return
    handled.current = id
    const p = POS_BY_ID[id]
    setScenarios((ss) => ss.map((s) => (s.key === 'draft' && !s.adjs.some((a) => a.id === id) ? { ...s, adjs: [{ id, to: Math.round(p.shares / 2 / 100) * 100, px: p.mark }, ...s.adjs] } : s)))
    setActiveKey('draft'); setDirty((d) => ({ ...d, draft: true }))
    const ev = EVENTS.find((e) => e.ids.includes(id))
    if (ev && ev.id !== 'fed') setMxB(ev.id)
    toast(`Added “${p.market}” to the draft`, 'info')
    setParams({}, { replace: true })
  }, [params, setParams, toast, setScenarios, setActiveKey, setDirty])

  const update = (fn: (a: Adj[]) => Adj[]) => {
    if (!active) return
    setScenarios((ss) => ss.map((s) => (s.key === active.key ? { ...s, adjs: fn(s.adjs) } : s)))
    setDirty((d) => ({ ...d, [active.key]: true }))
  }
  const S = useMemo(() => simulate(adjs, feeRate), [adjs, feeRate])
  const B = useMemo(() => metrics(BASE), [])
  const A = useMemo(() => metrics(S), [S])
  const allMetrics = useMemo(() => Object.fromEntries(scenarios.map((s) => [s.key, s.key === activeKey ? A : metrics(simulate(s.adjs, feeRate))])), [scenarios, activeKey, A, feeRate])

  const evA = EVENTS.find((e) => e.id === mxA)!, evB = EVENTS.find((e) => e.id === mxB)!
  const rel = pairRelation(mxA, mxB, cryptoRel)
  // "for you" means the event resolves on your side; an event resolves YES when (for you && side YES) || (against && side NO).
  const resolvesYes = (e: RiskEvent, forYou: boolean) => forYou === (POS_BY_ID[e.ids[0]].side === 'YES')
  const cells = ([[true, true], [true, false], [false, true], [false, false]] as const).map(([a, b]) => ({
    a, b, before: evP(BASE, evA.ids, a) + evP(BASE, evB.ids, b), after: evP(S, evA.ids, a) + evP(S, evB.ids, b),
    impossible: rel === 'mutex' && resolvesYes(evA, a) && resolvesYes(evB, b),
  }))
  const feasible = cells.filter((c) => !c.impossible)
  const best = [...feasible].sort((x, y) => (y.after - y.before) - (x.after - x.before))[0]
  const worst = [...feasible].sort((x, y) => (x.after - x.before) - (y.after - y.before))[0]
  const touched = EVENTS.filter((e) => e.ids.some((i) => adjs.some((a) => a.id === i)))
  const sideOf = (e: RiskEvent) => POS_BY_ID[e.ids[0]].side

  const save = () => {
    if (!active) return
    setScenarios((ss) => ss.map((s) => (s.key === active.key ? { ...s, saved: 'just now' } : s)))
    setDirty((d) => ({ ...d, [active.key]: false }))
    toast(`Saved “${active.name}”`)
  }
  const duplicate = () => {
    if (!active) return
    const key = `s${Date.now()}`
    setScenarios((ss) => [...ss, { ...active, key, name: `${active.name} (copy)`, saved: null, color: 'var(--color-data-4)', adjs: active.adjs.map((a) => ({ ...a })) }])
    setActiveKey(key); setDirty((d) => ({ ...d, [key]: true })); toast('Scenario duplicated')
  }
  const create = () => {
    const key = `s${Date.now()}`
    setScenarios((ss) => [...ss, { key, name: 'Untitled scenario', saved: null, color: 'var(--color-data-5)', adjs: [] }])
    setActiveKey(key); setDirty((d) => ({ ...d, [key]: true })); setRenaming(true)
  }
  const reset = () => {
    const init = INITIAL.find((s) => s.key === activeKey)
    update(() => (init ? init.adjs.map((a) => ({ ...a })) : []))
    setErrors({}); toast('Adjustments reset', 'info')
  }

  const rows: [string, keyof ReturnType<typeof metrics>, boolean][] = [
    ['Capital committed', 'committed', false], ['Cash available', 'cash', true], ['Worst case · everything against you*', 'worst', true],
    ['Best case · everything for you', 'best', true], ['If the Fed does not cut', 'fedNo', true], ['Largest single-event loss', 'largest', true],
  ]
  const dchip = (d: number, up: boolean) => (Math.abs(d) < 0.5 ? <span className="delta flat">—</span> : <span className={cx('delta', (up ? d > 0 : d < 0) ? 'good' : 'bad')}>{sfmt(d)}</span>)

  return (
    <div className="shell">
      <SectionRail sections={RAIL}>
        <div>
          <h6 className="caps" style={{ paddingLeft: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>Scenarios</h6>
          <div className="scn">
            <a href="#adjust" className={cx(isBase && 'on')} onClick={(e) => { e.preventDefault(); setActiveKey('base') }}><i style={{ background: 'var(--color-text-tertiary)' }} />Current portfolio<small>base</small></a>
            {scenarios.map((s) => (
              <a key={s.key} href="#adjust" className={cx(activeKey === s.key && 'on')} onClick={(e) => { e.preventDefault(); setActiveKey(s.key); setRenaming(false) }}>
                <i style={{ background: s.color }} />{s.name}<small>{dirty[s.key] ? 'unsaved' : s.saved}</small>
              </a>
            ))}
            <a href="#adjust" className="t3" onClick={(e) => { e.preventDefault(); create() }}>+ New scenario</a>
          </div>
        </div>
      </SectionRail>

      <main>
        <section className="page-head anchor" id="summary">
          <div>
            <div className="caps"><span className="accent">Scenario Lab</span> · {isBase ? 'Your current portfolio, unchanged' : dirty[activeKey] ? 'Unsaved changes' : `Saved ${active?.saved}`}</div>
            {isBase ? <h1>Current portfolio</h1> : renaming
              ? <input className="inline-edit" autoFocus defaultValue={active?.name} onBlur={(e) => { const v = e.target.value.trim() || 'Untitled scenario'; setScenarios((ss) => ss.map((s) => (s.key === activeKey ? { ...s, name: v } : s))); setRenaming(false); setDirty((d) => ({ ...d, [activeKey]: true })) }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
              : <h1>{active?.name}<button type="button" className="edit-btn" aria-label="Rename" onClick={() => setRenaming(true)}><Icon name="edit" size={16} /></button></h1>}
          </div>
          <div className="actions">
            <Button variant="ghost" icon="reset" onClick={reset} disabled={isBase}>Reset</Button>
            <Button icon="copy" onClick={duplicate} disabled={isBase}>Duplicate</Button>
            <Button variant="primary" icon="save" onClick={save} disabled={isBase || !dirty[activeKey]}>{!isBase && !dirty[activeKey] ? 'Saved' : 'Save scenario'}</Button>
          </div>
        </section>
        <Callout icon="shield"><b>Hypothetical only.</b> No orders are placed. Prices are what <i>you</i> assume you could trade at, not guaranteed fills. Outcomes are shown without probabilities.</Callout>

        <div className="lab">
          <Card id="adjust">
            <CardHeader pad title="Adjustments" sub={isBase ? 'Pick or create a scenario to adjust positions' : 'Drag to resize · type a hypothetical price'}
              right={!isBase && (
                <Menu width={340} trigger={({ toggle }) => <Button size="sm" icon="plus" onClick={toggle}>Add position</Button>}>
                  {(close) => (<>
                    <div className="menu-h">Add an open position</div>
                    {POSITIONS.filter((p) => !adjs.some((a) => a.id === p.id)).map((p) => (
                      <button type="button" key={p.id} className="menu-i" onClick={() => { update((a) => [...a, { id: p.id, to: p.shares, px: p.mark }]); close() }}>
                        <PlatformBadge p={p.platform} /><span style={{ flex: 1 }}>{p.market}</span><SideChip side={p.side} />
                      </button>
                    ))}
                  </>)}
                </Menu>
              )} />
            {adjs.length === 0 && (
              <div className="empty" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                <p>{isBase ? 'This is your portfolio as it is today.' : 'No adjustments yet. Add a position to start.'}</p>
                {isBase && <Button size="sm" onClick={() => setActiveKey('draft')}>Open the draft scenario</Button>}
              </div>
            )}
            {adjs.map((a, k) => {
              const p = POS_BY_ID[a.id], d = a.to - p.shares, max = maxFor(p.shares)
              const act = d < 0 ? (a.to === 0 ? ['Exit', 'exit'] : [`Sell ${int(-d)}`, 'sell']) : d > 0 ? [`Buy ${int(d)}`, 'buy'] : ['No change', 'none']
              const setTo = (v: number) => update((list) => list.map((x, i) => (i === k ? { ...x, to: Math.max(0, Math.min(max, v)) } : x)))
              return (
                <div className="adj" key={a.id}>
                  <div className="adj-h"><PlatformBadge p={p.platform} /><div><b>{p.market}</b><small><SideChip side={p.side} /> avg {p.avg.toFixed(2)} · mark {p.mark.toFixed(2)} · {p.resolves}</small></div>
                    <button type="button" className="x icon-btn" aria-label="Remove adjustment" onClick={() => update((list) => list.filter((_, i) => i !== k))}><Icon name="x" size={14} /></button></div>
                  <div className="qty"><span className={cx('act', act[1])}>{act[0]}</span><span>{d !== 0 && <span className="from">{int(p.shares)}</span>}<span className="to">{int(a.to)}</span> <span className="t3">shares</span></span></div>
                  <input className="slider" type="range" min={0} max={max} step={100} value={a.to} aria-label={`Shares of ${p.market}`} onChange={(e) => setTo(Number(e.target.value))} />
                  <div className="scale"><button type="button" className="link" onClick={() => setTo(0)}>0</button><button type="button" className="link" onClick={() => setTo(p.shares)}>current {int(p.shares)}</button><span>{int(max)}</span></div>
                  <div className="f2">
                    <div className="field" style={errors[a.id] ? { borderColor: 'var(--color-loss-fg)' } : undefined}><label htmlFor={`px-${a.id}`}>Hypothetical price</label>
                      <input id={`px-${a.id}`} defaultValue={`$${a.px.toFixed(2)}`} key={`${activeKey}-${a.id}-${a.px}`}
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value.replace('$', ''))
                          if (!(v > 0 && v < 1)) { setErrors((er) => ({ ...er, [a.id]: 'Enter a price between $0.01 and $0.99' })); return }
                          setErrors((er) => { const n = { ...er }; delete n[a.id]; return n })
                          update((list) => list.map((x, i) => (i === k ? { ...x, px: Math.round(v * 100) / 100 } : x)))
                        }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></div>
                    <div className="field"><label>{d < 0 ? 'Proceeds' : d > 0 ? 'Cost' : 'Cash impact'}</label><div className="v">{d ? `${d < 0 ? '+' : '−'}${fmt(Math.abs(d) * a.px)}` : '$0'}</div></div>
                  </div>
                  {errors[a.id] && <div className="loss" style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-1)' }}>{errors[a.id]}</div>}
                </div>
              )
            })}
            <div className="sumbar">
              <div><div className="l">Net cash impact</div><div className={cx('v', S.cash >= 0 ? 'gain' : 'loss')}>{sfmt(S.cash, 2)}</div></div>
              <div><div className="l">Locked-in realized P&amp;L{fees && ' (incl. fees)'}</div><div className={cx('v', A.real >= 0 ? 'gain' : 'loss')}>{sfmt(A.real, 2)}</div></div>
            </div>
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
            <Card id="ba" flush>
              <CardHeader pad title="Before / after" sub={`Whole portfolio at resolution · fees ${fees ? 'estimated at 2%' : 'excluded'}`}
                right={<Tabs options={['Portfolio impact', 'Position impact'] as const} value={view} onChange={setView} />} />
              {view === 'Portfolio impact' ? (<>
                <div className="ba-row h"><span>Metric</span><span>Current</span><span>Scenario</span><span>Change</span></div>
                {rows.map(([l, k, up]) => (
                  <div className="ba-row" key={k}><span>{l}</span><span className="t3">{fmt(B[k])}</span><span className="after">{fmt(A[k])}</span><span>{dchip(A[k] - B[k], up)}</span></div>
                ))}
              </>) : (<>
                <div className="ba-row h"><span>Position</span><span>Shares</span><span>If for / against</span><span>Change if against</span></div>
                {adjs.length === 0 && <div className="empty"><p>No positions changed.</p></div>}
                {adjs.map((a) => {
                  const s = S.st[a.id], p = POS_BY_ID[a.id]
                  return <div className="ba-row" key={a.id}><span>{p.market}</span><span><span className="t3">{int(p.shares)} → </span>{int(s.sh)}</span>
                    <span><span className="gain">{skfmtPos(s.realized + s.sh - s.cost)}</span> / <span className="loss">{kfmt(s.realized - s.cost)}</span></span>
                    <span>{dchip(s.realized - s.cost - p.ifLose, true)}</span></div>
                })}
              </>)}
            </Card>

            <Card id="matrix">
              <CardHeader title="Outcome matrix" sub="P&L of the two chosen events in each combination of outcomes" />
              <div className="card-b">
                <div className="row" style={{ marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
                  <select className="select" value={mxA} onChange={(e) => setMxA(e.target.value)} aria-label="First event">{EVENTS.filter((e) => e.id !== mxB).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                  <span className="t3">×</span>
                  <select className="select" value={mxB} onChange={(e) => setMxB(e.target.value)} aria-label="Second event">{EVENTS.filter((e) => e.id !== mxA).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                  <span className="spacer" />
                  {rel ? <Chip tone={REL_TEXT[rel].tone}>{REL_TEXT[rel].label}</Chip> : <Chip tone="warn">? Unmodeled dependency</Chip>}
                </div>
                <p className="t3" style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--space-3)' }}>{
                  rel === 'mutex' ? 'Both can’t resolve YES, so that combination is excluded.'
                  : rel === 'related' ? 'These share drivers but settle on different rules. All four combinations are possible; none are netted.'
                  : rel === 'unknown' ? 'You marked this relationship as unknown in Risk. All four combinations are shown as possible.'
                  : 'Nobody has classified this pair. All four combinations are shown as possible; treat the result as an unmodeled dependency.'}</p>
                <div className="matrix">
                  <div />
                  <div className="mh"><span><b>{evB.name}</b> · for you ({sideOf(evB)})</span></div>
                  <div className="mh"><span><b>{evB.name}</b> · against you</span></div>
                  {[true, false].map((a) => (
                    <FragmentRow key={String(a)} label={<><b>{evA.name}</b><br />{a ? `for you (${sideOf(evA)})` : 'against you'}</>}
                      cells={cells.filter((c) => c.a === a)} dchip={dchip} />
                  ))}
                </div>
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <Callout icon="spark">{Math.abs(best.after - best.before) < 1 && Math.abs(worst.after - worst.before) < 1
                    ? <>This scenario doesn’t change these two events. Pick events you adjusted, or add a position.</>
                    : <>Biggest improvement: <b>{cellName(evA, evB, best)}</b> <b className="gain">{sfmt(best.after - best.before)}</b>. Biggest deterioration: <b>{cellName(evA, evB, worst)}</b> <b className={worst.after - worst.before < 0 ? 'loss' : 'gain'}>{sfmt(worst.after - worst.before)}</b>, ending at <b className={worst.after < 0 ? 'loss' : 'gain'}>{sfmt(worst.after)}</b>.</>}</Callout>
                </div>
              </div>
            </Card>
          </div>
        </div>

        <Card id="payoff">
          <CardHeader title="Payoff by event" sub="How each outcome moves · ○ current → ● scenario" />
          <div className="card-b"><div style={{ maxWidth: 860 }}>{touched.length ? <Dumbbell events={touched} S={S} /> : <div className="empty"><p>Adjust a position to see payoffs move.</p></div>}</div></div>
        </Card>

        <Card id="cmp" flush>
          <CardHeader pad title="Compare scenarios" sub="Calculated live for every scenario · the line under each value is the change vs. your current portfolio · click a column to open it" />
          <div className="dt-wrap">
            <table className="dt cmp-table">
              <thead><tr>
                <th className="sticky">Metric</th>
                <th className="r">Current portfolio<small>base</small></th>
                {scenarios.map((s) => (
                  <th key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>
                    <button type="button" className="col-btn" aria-pressed={s.key === activeKey} onClick={() => { setActiveKey(s.key); setRenaming(false); document.getElementById('summary')?.scrollIntoView({ behavior: 'smooth' }) }}>
                      <i style={{ background: s.color }} />{s.name}
                    </button>
                    <small>{s.adjs.length} change{s.adjs.length === 1 ? '' : 's'} · {dirty[s.key] ? 'unsaved' : `saved ${s.saved}`}</small>
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {rows.map(([l, k, up]) => (
                  <tr key={k}>
                    <td className="sticky">{l.replace(' · everything against you*', '*').replace(' · everything for you', '')}</td>
                    <td className="r t2">{fmt(B[k])}</td>
                    {scenarios.map((s) => {
                      const v = allMetrics[s.key][k], d = v - B[k], better = up ? d > 0 : d < 0
                      return (
                        <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>
                          <span style={s.key === activeKey ? { fontWeight: 'var(--font-weight-semibold)' } : undefined}>{fmt(v)}</span>
                          <small className={cx(Math.abs(d) < 0.5 ? 't3' : better ? 'gain' : 'loss')}>{Math.abs(d) < 0.5 ? 'no change' : sfmt(d)}</small>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="foot"><span>* Worst case assumes every event can go against you at once; dependencies are not modeled. Green = better for you, red = worse.</span><span>{scenarios.length} scenarios</span></div>
        </Card>

        <section className="card assume anchor" id="assume">
          <div><div className="l">Fill prices</div><div className="v">Your hypothetical prices</div></div>
          <div><div className="l">Trading fees</div><div className="v">
            <button type="button" role="switch" aria-checked={fees} className={cx('switch', fees && 'on')} onClick={() => setFees((f) => !f)}><span /></button>{fees ? 'Estimated 2% of notional' : 'Excluded'}</div></div>
          <div><div className="l">Slippage / depth</div><div className="v">Not modeled</div></div>
          <div><div className="l">Event relationships</div><div className="v">Treated as independent <Chip tone="warn">see Risk</Chip></div></div>
        </section>

        <div className="footer-note"><span>Scenario results show what happens under the outcomes and prices you choose. They aren’t forecasts or recommendations.</span><span>Sample portfolio · fictional data</span></div>
      </main>
    </div>
  )
}

const skfmtPos = (v: number) => `${v >= 0 ? '+' : ''}${kfmt(v)}`
const cellName = (a: RiskEvent, b: RiskEvent, c: { a: boolean; b: boolean }) => `${short(a)} ${c.a ? 'for' : 'against'} you, ${short(b)} ${c.b ? 'for' : 'against'} you`
const short = (e: RiskEvent) => e.name.split(/[,(]/)[0].replace(/^(Dec 2026|Nov|US|2026) /, '').trim()

function FragmentRow({ label, cells, dchip }: { label: React.ReactNode; cells: { before: number; after: number; impossible: boolean }[]; dchip: (d: number, up: boolean) => React.ReactNode }) {
  return (<>
    <div className="mh row"><span>{label}</span></div>
    {cells.map((v, i) => v.impossible ? (
      <div key={i} className="cell impossible"><div className="caps">Not possible</div><div className="was">Mutually exclusive: both can’t resolve YES</div></div>
    ) : (
      <div key={i} className={cx('cell', v.after >= 0 ? 'pos' : 'neg')}>{dchip(v.after - v.before, true)}
        <div className="caps">Scenario</div><div className={cx('v', v.after >= 0 ? 'gain' : 'loss')}>{sfmt(v.after)}</div><div className="was">was {sfmt(v.before)}</div></div>
    ))}
  </>)
}

function Dumbbell({ events, S }: { events: RiskEvent[]; S: Sim }) {
  const vals = events.flatMap((e) => [true, false].flatMap((w) => [evP(BASE, e.ids, w), evP(S, e.ids, w)]))
  const lim = Math.ceil(Math.max(3000, ...vals.map(Math.abs)) / 1000) * 1000
  const W = 600, rowH = 76, H = events.length * rowH + 30, X = (v: number) => 220 + ((v + lim) / (2 * lim)) * (W - 240)
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim]
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ overflow: 'visible' }}>
        <g className="axis">{ticks.map((t) => <g key={t}><line className={t ? 'grid-l' : 'zero'} x1={X(t)} x2={X(t)} y1={4} y2={H - 26} strokeDasharray={t ? '2 4' : undefined} /><text x={X(t)} y={H - 8} textAnchor="middle">{t ? `${t > 0 ? '+' : ''}${kfmt(t)}` : '$0'}</text></g>)}</g>
        {events.map((e, i) => {
          const y0 = 20 + i * rowH
          return (
            <g key={e.id}>
              <text className="name" x={0} y={y0 + 18}>{e.name.length > 26 ? `${e.name.slice(0, 25)}…` : e.name}</text>
              {([[true, 'if for you', y0], [false, 'if against', y0 + 28]] as const).map(([w, lab, yy]) => {
                const b = evP(BASE, e.ids, w), a = evP(S, e.ids, w)
                return (
                  <g key={lab}>
                    <text className="ax" x={X(-lim) - 14} y={yy + 4} textAnchor="end">{lab}</text>
                    <line x1={X(b)} x2={X(a)} y1={yy} y2={yy} style={{ stroke: 'var(--color-accent-solid)' }} strokeWidth={3} opacity={0.55} />
                    <circle cx={X(b)} cy={yy} r={5} style={{ fill: 'var(--color-bg-surface)', stroke: 'var(--color-text-secondary)' }} strokeWidth={1.6} />
                    <circle cx={X(a)} cy={yy} r={6} style={{ fill: 'var(--color-accent-fg)', transition: 'cx var(--motion-duration-base) var(--motion-easing-out)' }} />
                    <text className="lbl" x={Math.max(X(a), X(b)) + 11} y={yy + 4} style={{ fill: a >= 0 ? 'var(--color-gain-fg)' : 'var(--color-loss-fg)' }}>{sfmt(a)}</text>
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

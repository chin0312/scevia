/* Scenario settlement views: outcome matrix and payoff by event.
   All of them read the two simulations (start, after) and never fill unavailable values with zero. */
import { useMemo, useState } from 'react'
import { useWidth } from '../../components/charts'
import { Callout, Chip, cx } from '../../components/ui'
import { PROVENANCE_TEXT, REL_TEXT } from '../../data/relations'
import type { Relation } from '../../data/types'
import { constrains, constraintComponent, findRelation, groupPnl, partialFeasible, type Outcome, type Simulation } from '../../lib/finance'
import { kfmt, sfmt } from '../../lib/format'
import { eventsIn } from './model'

export function OutcomeMatrix({ start, after, rels, onRelations }: { start: Simulation; after: Simulation; rels: Relation[]; onRelations?: () => void }) {
  const events = useMemo(() => eventsIn(start, after), [start, after])
  const touched = events.filter((e) => Object.keys(after.feesBy).concat(Object.keys(after.realizedBy)).some((id) => after.holdings[id]?.eventId === e.id) || Object.values(after.holdings).some((h) => h.isNew && h.eventId === e.id))
  const pick = [...touched, ...events.filter((e) => !touched.includes(e))]
  const [sel, setSel] = useState<[string | null, string | null]>([null, null])
  const aId = sel[0] && events.some((e) => e.id === sel[0]) ? sel[0] : pick[0]?.id ?? null
  const bId = sel[1] && events.some((e) => e.id === sel[1]) && sel[1] !== aId ? sel[1] : pick.find((e) => e.id !== aId)?.id ?? null
  if (!aId || !bId) return <div className="empty"><p>The outcome matrix needs two events. {events.length === 1 ? 'This portfolio holds one event. Its payoffs are shown below.' : 'Add positions to see joint outcomes.'}</p></div>
  const evA = events.find((e) => e.id === aId)!, evB = events.find((e) => e.id === bId)!
  const relation = findRelation(aId, bId, rels)
  const rel = relation?.cls ?? null, binds = !!relation && constrains(relation)
  const label = (e: typeof evA, o: Outcome) => (e.sides.size === 1 ? (e.sides.has(o) ? 'for you' : 'against you') : 'both sides held')
  // Feasibility uses every constraint among the scenario's events, including implications through other events
  // (A ≡ B and B × C exclusive ⇒ A and C can't both be YES), so a pair never looks possible when the portfolio isn't.
  const all = events.map((e) => e.id)
  const chain = constraintComponent([aId, bId], all, rels).relations
  const titleOf = (id: string) => events.find((e) => e.id === id)?.title ?? id
  const why = chain.map((r) => `${titleOf(r.a)} ${r.cls === 'mutex' ? '× (not both YES)' : '≡ (same result)'} ${titleOf(r.b)}, ${PROVENANCE_TEXT[r.provenance]}`)
  const cells = (['YES', 'NO'] as Outcome[]).flatMap((oa) => (['YES', 'NO'] as Outcome[]).map((ob) => {
    const o = { [aId]: oa, [bId]: ob }
    return { oa, ob, before: groupPnl(start, [aId, bId], o), after: groupPnl(after, [aId, bId], o), impossible: partialFeasible(o, all, rels) === false }
  }))
  const feasible = cells.filter((c) => !c.impossible)
  const best = [...feasible].sort((x, y) => (y.after - y.before) - (x.after - x.before))[0]
  const worst = [...feasible].sort((x, y) => (x.after - x.before) - (y.after - y.before))[0]
  return (<>
    <div className="row" style={{ marginBottom: 'var(--space-2)', flexWrap: 'wrap' }}>
      <select className="select" value={aId} onChange={(e) => setSel([e.target.value, bId])} aria-label="First event">{events.filter((e) => e.id !== bId).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select>
      <span className="t3">×</span>
      <select className="select" value={bId} onChange={(e) => setSel([aId, e.target.value])} aria-label="Second event">{events.filter((e) => e.id !== aId).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select>
      <span className="spacer" />
      {rel ? <><Chip tone={REL_TEXT[rel].tone}>{REL_TEXT[rel].label}</Chip><small className="t3">{PROVENANCE_TEXT[relation!.provenance]}</small></> : <Chip tone="warn">Unclassified</Chip>}
      {onRelations && <button type="button" className="link" onClick={onRelations}>Constraints…</button>}
    </div>
    <p className="t3" style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--space-3)' }}>{
      rel === 'mutex' && binds ? `Both can’t resolve YES (${relation!.provenance === 'hypothetical' ? 'a hypothetical constraint in this scenario' : 'verified'}), so that combination is excluded. That changes the settlement range, not any probability.`
        : rel === 'equivalent' && binds ? 'They settle the same way, so mixed combinations are excluded.'
        : cells.some((c) => c.impossible) ? 'No direct constraint, but constraints through other events in this portfolio exclude some combinations (see below).'
        : rel === 'related' ? 'They share drivers but settle on different rules: all four combinations are possible and nothing is netted.'
          : 'No constraint applies: all four combinations are possible. That isn’t an assumption that they’re independent.'}</p>
    <div className="matrix">
      <div />
      {(['YES', 'NO'] as Outcome[]).map((ob) => <div className="mh" key={ob}><span><b>{evB.title}</b> resolves {ob}<br /><small>{label(evB, ob)}</small></span></div>)}
      {(['YES', 'NO'] as Outcome[]).map((oa) => (
        <MatrixRow key={oa} label={<><b>{evA.title}</b> resolves {oa}<br /><small>{label(evA, oa)}</small></>} cells={cells.filter((c) => c.oa === oa)} why={why} />
      ))}
    </div>
    <div style={{ marginTop: 'var(--space-4)' }}>
      <Callout icon="spark">{!best || (Math.abs(best.after - best.before) < 1 && Math.abs(worst.after - worst.before) < 1)
        ? <>This scenario doesn’t change these two events. Pick events you adjusted.</>
        : <>Biggest improvement: <b>{evA.title} {best.oa}, {evB.title} {best.ob}</b> <b className={best.after - best.before >= 0 ? 'gain' : 'loss'}>{sfmt(best.after - best.before)}</b>. Biggest deterioration: <b>{evA.title} {worst.oa}, {evB.title} {worst.ob}</b> <b className={worst.after - worst.before < 0 ? 'loss' : 'gain'}>{sfmt(worst.after - worst.before)}</b>, ending at <b className={worst.after < 0 ? 'loss' : 'gain'}>{sfmt(worst.after)}</b>.</>}</Callout>
    </div>
  </>)
}

function MatrixRow({ label, cells, why }: { label: React.ReactNode; cells: { before: number; after: number; impossible: boolean }[]; why: string[] }) {
  return (<>
    <div className="mh row"><span>{label}</span></div>
    {cells.map((v, i) => v.impossible ? (
      <div key={i} className="cell impossible" title={why.join('\n')}><div className="caps">Not possible</div><div className="was">Excluded by {why.length === 1 ? 'a settlement constraint' : `${why.length} linked constraints`}: {why.join('; ')}</div></div>
    ) : (
      <div key={i} className={cx('cell', v.after >= 0 ? 'pos' : 'neg')}>
        {Math.abs(v.after - v.before) < 0.5 ? <span className="delta flat">—</span> : <span className={cx('delta', v.after > v.before ? 'good' : 'bad')}>{sfmt(v.after - v.before)}</span>}
        <div className="caps">Scenario</div><div className={cx('v', v.after >= 0 ? 'gain' : 'loss')}>{sfmt(v.after)}</div><div className="was">was {sfmt(v.before)}</div></div>
    ))}
  </>)
}

/** Settlement P&L per outcome for each event the scenario touches: ○ start → ● scenario. */
export function Dumbbell({ eventIds, start, after }: { eventIds: string[]; start: Simulation; after: Simulation }) {
  const all = eventsIn(start, after)
  const events = eventIds.map((id) => all.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e)
  const rowsOf = (e: (typeof events)[number]): [Outcome, string][] => {
    const s = e.sides.size === 1 ? [...e.sides][0] : null
    return s ? [[s, 'if for you'], [s === 'YES' ? 'NO' : 'YES', 'if against']] : [['YES', 'if YES'], ['NO', 'if NO']]
  }
  const val = (sim: Simulation, id: string, o: Outcome) => groupPnl(sim, [id], { [id]: o })
  const vals = events.flatMap((e) => (['YES', 'NO'] as Outcome[]).flatMap((o) => [val(start, e.id, o), val(after, e.id, o)]))
  const lim = Math.ceil(Math.max(3000, ...vals.map(Math.abs)) / 1000) * 1000
  const [wrap, W] = useWidth<HTMLDivElement>(600)
  const compact = W < 480, left = compact ? 84 : 240, top = compact ? 24 : 0
  const rowH = 76 + top, H = events.length * rowH + 30, X = (v: number) => left + ((v + lim) / (2 * lim)) * (W - left - 20)
  const maxName = compact ? Math.floor(W / 8) : 30
  if (!events.length) return <div className="empty"><p>Add or change a position to see its settlement payoffs.</p></div>
  return (
    <div className="chart" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ overflow: 'visible' }} role="img" aria-label={events.map((e) => `${e.title}: ${rowsOf(e).map(([o, lab]) => `${lab} ${sfmt(val(start, e.id, o))} → ${sfmt(val(after, e.id, o))}`).join('; ')}`).join('. ')}>
        <g className="axis">{[-lim, -lim / 2, 0, lim / 2, lim].map((t) => <g key={t}><line className={t ? 'grid-l' : 'zero'} x1={X(t)} x2={X(t)} y1={4} y2={H - 26} strokeDasharray={t ? '2 4' : undefined} /><text x={X(t)} y={H - 8} textAnchor="middle">{t ? `${t > 0 ? '+' : ''}${kfmt(t)}` : '$0'}</text></g>)}</g>
        {events.map((e, i) => {
          const y0 = 20 + i * rowH + top
          return (
            <g key={e.id}>
              <text className="name" x={0} y={compact ? y0 - 14 : y0 + 18}>{e.title.length > maxName ? `${e.title.slice(0, maxName - 1)}…` : e.title}</text>
              {rowsOf(e).map(([o, lab], k) => {
                const yy = y0 + k * 28, b = val(start, e.id, o), a = val(after, e.id, o)
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

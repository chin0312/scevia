/* Scenario impact views: allocation before/after, outcome matrix and payoff by event.
   All of them read the two simulations (start, after) and never fill unavailable values with zero. */
import { useMemo, useState } from 'react'
import { useWidth } from '../../components/charts'
import { Callout, Chip, Seg, cx } from '../../components/ui'
import { PROVENANCE_TEXT, REL_TEXT } from '../../data/relations'
import type { Relation } from '../../data/types'
import { constrains, findRelation, groupPnl, holdingsAllocation, isFeasible, type AllocationBy, type Outcome, type Simulation } from '../../lib/finance'
import { fmt, kfmt, pct, sfmt } from '../../lib/format'
import { diff, eventsIn } from './model'

const BY: Record<'Category' | 'Platform' | 'Event', AllocationBy> = { Category: 'category', Platform: 'platform', Event: 'event' }

export function AllocationImpact({ start, after }: { start: Simulation; after: Simulation }) {
  const [by, setBy] = useState<'Category' | 'Platform' | 'Event'>('Category')
  const b = holdingsAllocation(Object.values(start.holdings), BY[by]), a = holdingsAllocation(Object.values(after.holdings), BY[by])
  const keys = [...new Set([...b.segments.map((s) => s.key), ...a.segments.map((s) => s.key)])]
  const rows = keys.map((k) => {
    const x = b.segments.find((s) => s.key === k), y = a.segments.find((s) => s.key === k)
    return { key: k, label: (y ?? x)!.label, bv: x?.value ?? 0, bs: x ? x.share : b.total ? 0 : null, av: y?.value ?? 0, as: y ? y.share : a.total ? 0 : null, status: !x ? 'new' : !y ? 'exited' : null }
  }).sort((p, q) => q.av - p.av || q.bv - p.bv)
  // Cash share is only meaningful when cash is non-negative. A negative balance is a funding requirement and is shown
  // as such (never clamped to 0 and never presented as a negative allocation slice).
  const cashCell = (s: Simulation, total: number | null) => {
    const c = s.cash.pm + s.cash.ks
    if (c < -0.005) return <span className="stale" title="Purchases exceed cash: shown as if funded">needs {fmt(-c)} funding</span>
    if (total == null || c + total <= 0) return '—'
    return pct((c / (c + total)) * 100, 0)
  }
  const unavailable = b.total == null || a.total == null
  return (<>
    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
      <span className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>% = share of open-position market value (cash excluded), before and after</span>
      <Seg label="Allocation by" options={['Category', 'Platform', 'Event'] as const} value={by} onChange={setBy} />
    </div>
    {unavailable ? <Callout tone="warn" icon="alert">Allocation is unavailable: a position has no reference price, so its market value is unknown.</Callout>
      : rows.length === 0 ? <div className="empty"><p>No open positions before or after this scenario.</p></div> : (
      <div className="dt-wrap"><table className="dt alloc-impact">
        <thead><tr><th scope="col">{by}</th><th scope="col" className="r">Before</th><th scope="col" className="r">%</th><th scope="col" className="r">After</th><th scope="col" className="r">%</th><th scope="col" className="r">Change</th><th scope="col" className="bar-col"><span className="sr-only">Share bars</span></th></tr></thead>
        <tbody>{rows.map((r) => {
          const d = diff(r.as, r.bs)
          return (
            <tr key={r.key}>
              <td><span className="row" style={{ gap: 'var(--space-2)' }}>{r.label}{r.status === 'new' && <Chip tone="accent">New</Chip>}{r.status === 'exited' && <Chip>Exited</Chip>}</span></td>
              <td className="r t2">{r.bv ? fmt(r.bv) : '—'}</td><td className="r t3">{r.bs == null ? '—' : pct(r.bs * 100, 0)}</td>
              <td className="r">{r.av ? fmt(r.av) : '—'}</td><td className="r">{r.as == null ? '—' : pct(r.as * 100, 0)}</td>
              <td className={cx('r', d == null || Math.abs(d) < 0.005 ? 't3' : 't2')}>{d == null ? '—' : Math.abs(d) < 0.005 ? '0 pts' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)} pts`}</td>
              <td className="bar-col"><div className="ai-bars" aria-hidden="true"><i className="b" style={{ width: `${(r.bs ?? 0) * 100}%` }} /><i className="a" style={{ width: `${(r.as ?? 0) * 100}%` }} /></div></td>
            </tr>
          )
        })}</tbody>
        <tfoot><tr><th scope="row">Open-position value</th><td className="r t2">{fmt(b.total!)}</td><td /><td className="r">{fmt(a.total!)}</td><td /><td /><td /></tr>
          <tr><th scope="row" title="Cash ÷ (cash + open-position value), when cash isn’t negative">Cash share of value</th><td className="r t2" colSpan={2}>{cashCell(start, b.total)}</td><td className="r" colSpan={2}>{cashCell(after, a.total)}</td><td /><td /></tr></tfoot>
      </table></div>
    )}
    <p className="t3" style={{ fontSize: 'var(--font-size-xs)', marginTop: 'var(--space-2)' }}>Market-value allocation at reference prices. It isn’t capital committed or settlement loss, and a more even allocation isn’t necessarily less risk: see the outcome views below.</p>
  </>)
}

export function OutcomeMatrix({ start, after, rels, onRelations }: { start: Simulation; after: Simulation; rels: Relation[]; onRelations?: () => void }) {
  const events = useMemo(() => eventsIn(start, after), [start, after])
  const touched = events.filter((e) => Object.keys(after.feesBy).concat(Object.keys(after.realizedBy)).some((id) => after.holdings[id]?.eventId === e.id) || Object.values(after.holdings).some((h) => h.isNew && h.eventId === e.id))
  const pick = [...touched, ...events.filter((e) => !touched.includes(e))]
  const [sel, setSel] = useState<[string | null, string | null]>([null, null])
  const aId = sel[0] && events.some((e) => e.id === sel[0]) ? sel[0] : pick[0]?.id ?? null
  const bId = sel[1] && events.some((e) => e.id === sel[1]) && sel[1] !== aId ? sel[1] : pick.find((e) => e.id !== aId)?.id ?? null
  if (!aId || !bId) return <div className="empty"><p>The outcome matrix needs two events. {events.length === 1 ? 'This portfolio holds one event; its payoffs are shown below.' : 'Add positions to see joint outcomes.'}</p></div>
  const evA = events.find((e) => e.id === aId)!, evB = events.find((e) => e.id === bId)!
  const relation = findRelation(aId, bId, rels)
  const rel = relation?.cls ?? null, binds = !!relation && constrains(relation)
  const label = (e: typeof evA, o: Outcome) => (e.sides.size === 1 ? (e.sides.has(o) ? 'for you' : 'against you') : 'both sides held')
  const cells = (['YES', 'NO'] as Outcome[]).flatMap((oa) => (['YES', 'NO'] as Outcome[]).map((ob) => {
    const o = { [aId]: oa, [bId]: ob }
    return { oa, ob, before: groupPnl(start, [aId, bId], o), after: groupPnl(after, [aId, bId], o), impossible: !isFeasible(o, rels) }
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
        : rel === 'related' ? 'They share drivers but settle on different rules: all four combinations are possible and nothing is netted.'
          : 'No constraint applies: all four combinations are possible. That isn’t an assumption that they’re independent.'}</p>
    <div className="matrix">
      <div />
      {(['YES', 'NO'] as Outcome[]).map((ob) => <div className="mh" key={ob}><span><b>{evB.title}</b> resolves {ob}<br /><small>{label(evB, ob)}</small></span></div>)}
      {(['YES', 'NO'] as Outcome[]).map((oa) => (
        <MatrixRow key={oa} label={<><b>{evA.title}</b> resolves {oa}<br /><small>{label(evA, oa)}</small></>} cells={cells.filter((c) => c.oa === oa)} />
      ))}
    </div>
    <div style={{ marginTop: 'var(--space-4)' }}>
      <Callout icon="spark">{!best || (Math.abs(best.after - best.before) < 1 && Math.abs(worst.after - worst.before) < 1)
        ? <>This scenario doesn’t change these two events. Pick events you adjusted.</>
        : <>Biggest improvement: <b>{evA.title} {best.oa}, {evB.title} {best.ob}</b> <b className={best.after - best.before >= 0 ? 'gain' : 'loss'}>{sfmt(best.after - best.before)}</b>. Biggest deterioration: <b>{evA.title} {worst.oa}, {evB.title} {worst.ob}</b> <b className={worst.after - worst.before < 0 ? 'loss' : 'gain'}>{sfmt(worst.after - worst.before)}</b>, ending at <b className={worst.after < 0 ? 'loss' : 'gain'}>{sfmt(worst.after)}</b>.</>}</Callout>
    </div>
  </>)
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

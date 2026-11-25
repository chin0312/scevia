/* Shared, context-preserving detail panels for positions, events, groups of holdings and closed trades.
   Inspecting never navigates or changes scenario state; cross-module actions are explicit buttons.
   Panels stack (event → position) with a Back button and return focus to where the user was. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PLATFORM_NAME } from '../data/labels'
import { PROVENANCE_TEXT, REL_TEXT } from '../data/relations'
import type { ClosedTrade } from '../data/types'
import { POS_BY_ID, coverage, eventRelations, sourceRelations, exposures, fmtDate, outcomeLabel, sourceOf, tradeNet, type EventExposure, type PlatformFilter, type Position } from '../lib/finance'
import { handoffPath } from '../lib/handoff'
import { fmt, int, pct, sfmt } from '../lib/format'
import { Icon } from './Icon'
import { Drawer, focusTopLayer } from './overlays'
import { useConnect } from './ConnectSources'
import { Button, Callout, Chip, PlatformBadge, Seg, SideChip, cx } from './ui'

export type Detail =
  /** `scope` is the platform scope of the view the panel was opened from; figures start in that scope. */
  | { kind: 'position'; id: string; scope?: PlatformFilter }
  | { kind: 'event'; id: string; scope?: PlatformFilter }
  | { kind: 'group'; title: string; sub: string; ids: string[] }
  | { kind: 'trades'; title: string; sub: string; trades: ClosedTrade[] }

const Ctx = createContext<{ open: (d: Detail) => void; close: () => void }>({ open: () => {}, close: () => {} })
export const useDetails = () => useContext(Ctx)

export function DetailProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Detail[]>([])
  const open = useCallback((d: Detail) => setStack((s) => [...s, d]), [])
  const close = useCallback(() => setStack([]), [])
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), [])
  const top = stack[stack.length - 1]
  return (
    <Ctx.Provider value={{ open, close }}>
      {children}
      {top && <DetailDrawer d={top} depth={stack.length} onBack={back} onClose={close} open={open} />}
    </Ctx.Provider>
  )
}

function DetailDrawer({ d, depth, onBack, onClose, open }: { d: Detail; depth: number; onBack: () => void; onClose: () => void; open: (d: Detail) => void }) {
  // The drawer stays mounted while its content changes (nested panel, Back): move focus into the new content
  // so it doesn't fall back to the page behind the overlay.
  const first = useRef(true)
  useEffect(() => { if (first.current) { first.current = false; return } focusTopLayer() }, [d])
  const title = d.kind === 'position' ? POS_BY_ID[d.id]?.market ?? 'Position'
    : d.kind === 'event' ? exposures('all').find((e) => e.event.id === d.id)?.event.name ?? 'Event' : d.title
  const sub = d.kind === 'position' ? positionSub(POS_BY_ID[d.id]) : d.kind === 'event' ? 'Event exposure · settlement outcomes YES / NO' : d.sub
  return (
    <Drawer title={title} sub={sub} onClose={onClose}>
      {depth > 1 && <button type="button" className="link back-link" onClick={onBack}><Icon name="arrowRight" size={12} className="flip" /> Back</button>}
      {d.kind === 'position' && <PositionBody p={POS_BY_ID[d.id]} scope={d.scope ?? 'all'} open={open} close={onClose} />}
      {d.kind === 'event' && <EventBody key={d.id} id={d.id} scope={d.scope ?? 'all'} open={open} close={onClose} />}
      {d.kind === 'group' && <GroupBody ids={d.ids} open={open} />}
      {d.kind === 'trades' && <TradesBody trades={d.trades} />}
    </Drawer>
  )
}

const positionSub = (p?: Position) => (p ? `${PLATFORM_NAME[p.platform]} · ${p.category} · resolves ${fmtDate(p.resolves, { month: 'short', day: 'numeric', year: 'numeric' })} (in ${p.days} days)` : '')

/** Explicit hand-off to Scenario Lab. The Lab asks which scenario to use before changing anything. */
function useSimulate(close: () => void) {
  const nav = useNavigate(), { pathname } = useLocation()
  const onLab = pathname.startsWith('/scenario-lab')
  return {
    label: onLab ? 'Add to a scenario…' : 'Simulate in Scenario Lab',
    /** Deliberate hand-off of exactly these holdings; `from` explains the scope in the Lab's confirmation. */
    go: (ids: string[], from: string) => { close(); nav(handoffPath(ids, from)) },
  }
}

function PositionBody({ p, scope, open, close }: { p?: Position; scope: PlatformFilter; open: (d: Detail) => void; close: () => void }) {
  const sim = useSimulate(close)
  if (!p) return <div className="empty"><p>This position is no longer in the portfolio.</p></div>
  const src = sourceOf(p.platform)
  const sameEvent = exposures('all').find((e) => e.event.id === p.eventId)
  return (<>
    <div className="row"><PlatformBadge p={p.platform} /><SideChip side={p.side} /><Chip>{int(p.shares)} shares</Chip><span className="spacer" />
      <span className={cx('stale', !src.stale && 't3')}>{src.label} · as of {fmtDate(src.asOf)}{src.stale && ' · stale'}</span></div>
    <div className="cov-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <div><span className="t3">Cost basis</span><b>{fmt(p.cost, 2)}</b></div>
      <div><span className="t3">Value at mark {p.mark.toFixed(2)}</span><b>{fmt(p.value, 2)}</b></div>
      <div><span className="t3">Unrealized (after purchase fees)</span><b className={p.upl >= 0 ? 'gain' : 'loss'}>{sfmt(p.upl, 2)}</b></div>
    </div>
    <h5 className="caps">If it resolves</h5>
    <div className="cov-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <div><span className="t3">{p.side} (for you)</span><b className={tone(p.ifWin)}>{sfmt(p.ifWin, 2)}</b><span className="t3">{int(p.shares)} × $1 − cost basis</span></div>
      <div><span className="t3">{p.side === 'YES' ? 'NO' : 'YES'} (against you)</span><b className={tone(p.ifLose)}>{sfmt(p.ifLose, 2)}</b><span className="t3">the cost basis is lost</span></div>
    </div>
    <h5 className="caps">Fills · how the average cost is calculated</h5>
    <table className="dt">
      <thead><tr><th scope="col">Date</th><th scope="col">Action</th><th scope="col" className="r">Shares</th><th scope="col" className="r">Price</th><th scope="col" className="r">Fee</th></tr></thead>
      <tbody>{p.fills.map((f) => (
        <tr key={f.date}><td>{fmtDate(f.date, { month: 'short', day: 'numeric', year: 'numeric' })}</td><td>Buy</td><td className="r">{int(f.shares)}</td><td className="r">{f.price.toFixed(3)}</td><td className="r t3">{f.fee ? fmt(f.fee, 2) : '—'}</td></tr>
      ))}
        <tr><td colSpan={2}><b>Weighted average</b></td><td className="r">{int(p.shares)}</td><td className="r"><b>{p.avg.toFixed(3)}</b></td><td className="r t3">{p.fees ? fmt(p.fees, 2) : '—'}</td></tr>
      </tbody>
    </table>
    <Callout>Average cost = Σ(shares × price) ÷ shares. Fees aren’t in the average cost; {p.fees ? `the ${fmt(p.fees, 2)} paid on these fills is subtracted once in net P&L.` : 'no fees were charged on these fills.'} The mark is the last traded price on {PLATFORM_NAME[p.platform]}.</Callout>
    {sameEvent && sameEvent.positions.length > 1 && <Callout icon="link">This contract is one of {sameEvent.positions.length} positions on <b>{sameEvent.event.name}</b>.</Callout>}
    <div className="drawer-actions">
      <Button icon="shield" onClick={() => open({ kind: 'event', id: p.eventId, scope })}>View event exposure</Button>
      <Button variant="primary" icon="flask" onClick={() => sim.go([p.id], `${p.market} · ${PLATFORM_NAME[p.platform]}`)}>{sim.label}</Button>
    </div>
  </>)
}

const SCOPE_LABEL: Record<PlatformFilter, string> = { all: 'All platforms', pm: 'Polymarket only', ks: 'Kalshi only' }
const tone = (v: number) => (v > 0.005 ? 'gain' : v < -0.005 ? 'loss' : undefined)

function EventBody({ id, scope, open, close }: { id: string; scope: PlatformFilter; open: (d: Detail) => void; close: () => void }) {
  const sim = useSimulate(close)
  const nav = useNavigate(), { pathname } = useLocation()
  const rels = sourceRelations()
  const connect = useConnect()
  const full = exposures('all').find((x) => x.event.id === id)
  // Start in the scope the user came from; the full cross-platform event is one switch away and labelled as such.
  const [view, setView] = useState<PlatformFilter>(scope)
  const scoped = exposures(view)
  const e = scoped.find((x) => x.event.id === id)
  if (!full) return <div className="empty"><p>No open positions on this event.</p></div>
  const outside = full.positions.filter((p) => !e?.positions.includes(p))
  // The scope switch exists whenever the event has holdings outside the origin scope, whichever view is showing.
  const canWiden = scope !== 'all' && full.positions.some((p) => p.platform !== scope)
  const committed = scoped.reduce((a, x) => a + x.cost, 0)
  const related = eventRelations(id, rels)
  return (<>
    <div className="row" style={{ flexWrap: 'wrap' }}><Chip>Resolves {fmtDate(full.resolves, { month: 'short', day: 'numeric', year: 'numeric' })} · in {full.days} days</Chip>
      {full.positions.length > 1 && <Chip tone="accent">{full.positions.length} contracts · treated as one event</Chip>}
      <span className="spacer" />
      {canWiden && <Seg label="Scope" options={[SCOPE_LABEL[scope], SCOPE_LABEL.all]} value={SCOPE_LABEL[view]} onChange={(v) => setView(v === SCOPE_LABEL.all ? 'all' : scope)} />}
    </div>
    {view !== 'all' && outside.length > 0 && (
      <Callout icon="info">Showing your {SCOPE_LABEL[view].replace(' only', '')} holdings, as in the view you came from. You also hold this event on {[...new Set(outside.map((p) => PLATFORM_NAME[p.platform]))].join(' and ')} ({fmt(outside.reduce((a, p) => a + p.cost, 0))} committed); switch to All platforms to include it.</Callout>
    )}
    {!e ? <div className="empty"><p>No {SCOPE_LABEL[view].replace(' only', '')} holdings on this event.</p></div> : <EventFigures e={e} committed={committed} scopeLabel={view === 'all' ? 'all platforms' : SCOPE_LABEL[view].replace(' only', '')} open={open} />}
    <h5 className="caps">Relationships</h5>
    {related.length === 0 && <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>No relationship recorded with other events: every combination with them is treated as possible (that’s not an assumption that they’re independent).</p>}
    {related.map((r) => (
      <div className="list-row" key={r.other.id}><span>{r.other.name}{r.note && <small className="t3"> · {r.note}</small>}</span><span className="r row"><Chip tone={REL_TEXT[r.cls].tone}>{REL_TEXT[r.cls].label}</Chip><small className="t3">{PROVENANCE_TEXT[r.provenance]}</small></span></div>
    ))}
    <h5 className="caps">Data <button type="button" className="link" style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 'var(--space-2)' }} onClick={() => { close(); connect('coverage') }}>Data coverage →</button></h5>
    {(e?.platforms ?? []).map((pl) => { const src = sourceOf(pl), c = coverage(pl); return <div className="cov" key={pl}><PlatformBadge p={pl} /><span>{c.fills} fills · {c.settlements} settlements</span><span className={src.stale ? 'stale' : 't3'}>as of {fmtDate(src.asOf)}{src.stale ? ' · stale' : ''}</span></div> })}
    <div className="drawer-actions">
      {!pathname.startsWith('/risk') && <Button icon="shield" onClick={() => { close(); nav(`/risk?event=${id}#payoffs`) }}>Analyze in Risk</Button>}
      {e && <Button variant="primary" icon="flask" title={`Choose a scenario for these ${e.positions.length} position${e.positions.length > 1 ? 's' : ''}`}
        onClick={() => sim.go(e.positions.map((p) => p.id), `${full.event.name} · ${SCOPE_LABEL[view]}`)}>{sim.label}{e.positions.length > 1 ? ` (${e.positions.length})` : ''}</Button>}
    </div>
  </>)
}

/** Figures for one event's holdings in a given scope. Settlement is shown per outcome (YES / NO) from each holding's own side. */
function EventFigures({ e, committed, scopeLabel, open }: { e: EventExposure; committed: number; scopeLabel: string; open: (d: Detail) => void }) {
  const value = e.positions.reduce((a, p) => a + p.value, 0)
  return (<>
    <div className="cov-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <div><span className="t3">Capital committed</span><b>{fmt(e.cost)}</b><span className="t3">{pct((e.cost / committed) * 100)} of committed · {scopeLabel}</span></div>
      <div><span className="t3">Value at mark</span><b>{fmt(value)}</b></div>
      <div><span className="t3">Unrealized</span><b className={tone(value - e.cost)}>{sfmt(value - e.cost)}</b></div>
    </div>
    <h5 className="caps">Settlement payoff (vs. cost basis)</h5>
    <div className="cov-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      {(['YES', 'NO'] as const).map((o) => <div key={o}><span className="t3">{outcomeLabel(e, o)}</span><b className={tone(e.pnl[o])}>{sfmt(e.pnl[o])}</b></div>)}
    </div>
    {e.side === 'Mixed' && <Callout tone="warn">You hold both sides of this event. Payoffs use each position’s own side, so opposing holdings offset; capital committed is still the gross amount paid.</Callout>}
    <h5 className="caps">Positions on this event</h5>
    <PosList ps={e.positions} open={open} right={(p) => <><b>{fmt(p.value)}</b><small className="t3">cost {fmt(p.cost)}</small></>} />
  </>)
}

function GroupBody({ ids, open }: { ids: string[]; open: (d: Detail) => void }) {
  const ps = ids.map((i) => POS_BY_ID[i]).filter(Boolean).sort((a, b) => b.value - a.value)
  if (!ps.length) return <div className="empty"><p>No open positions in this group.</p></div>
  const value = ps.reduce((a, p) => a + p.value, 0), cost = ps.reduce((a, p) => a + p.cost, 0)
  return (<>
    <div className="cov-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <div><span className="t3">Positions</span><b>{ps.length}</b></div>
      <div><span className="t3">Value at mark</span><b>{fmt(value)}</b></div>
      <div><span className="t3">Capital committed</span><b>{fmt(cost)}</b></div>
    </div>
    <PosList ps={ps} open={open} right={(p) => <><b>{fmt(p.value)} <span className="t3">· {pct((p.value / value) * 100, 0)}</span></b><small className="loss">{sfmt(p.ifLose)} if against</small></>} />
  </>)
}

/** Compact, keyboard-accessible list of positions; each row opens that position's panel (stacked, with Back). */
function PosList({ ps, open, right }: { ps: Position[]; open: (d: Detail) => void; right: (p: Position) => ReactNode }) {
  return (
    <div className="pos-list">
      {ps.map((p) => (
        <button type="button" key={p.id} className="list-btn pos-li" aria-label={`${p.market}: open details`} onClick={() => open({ kind: 'position', id: p.id })}>
          <PlatformBadge p={p.platform} />
          <span className="pos-li-m"><b>{p.market}</b><small className="t3"><SideChip side={p.side} /> {int(p.shares)} @ {p.avg.toFixed(2)} → {p.mark.toFixed(2)} · {PLATFORM_NAME[p.platform]}</small></span>
          <span className="pos-li-r">{right(p)}</span>
        </button>
      ))}
    </div>
  )
}

function TradesBody({ trades }: { trades: ClosedTrade[] }) {
  if (!trades.length) return <div className="empty"><p>No trades in this selection.</p></div>
  return (<>
    {trades.map((r) => (
      <div className="list-row" key={r.id}><PlatformBadge p={r.platform} />
        <div><b style={{ fontWeight: 'var(--font-weight-medium)' }}>{r.market}</b><div className="t3" style={{ fontSize: 'var(--font-size-xs)' }}><SideChip side={r.side} /> {int(r.shares)} @ {r.entry.toFixed(2)} → {r.exit.toFixed(2)} · {r.outcome} · {fmtDate(r.closed, { month: 'short', day: 'numeric', year: 'numeric' })}{r.fees ? ` · fees ${fmt(r.fees, 2)}${r.feeKnown ? '' : ' est.'}` : ''}</div></div>
        <span className={cx('r', tradeNet(r) >= 0 ? 'gain' : 'loss')}>{sfmt(tradeNet(r), 2)}</span>
      </div>
    ))}
    <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>{trades.length} trade{trades.length > 1 ? 's' : ''} · total {sfmt(trades.reduce((a, t) => a + tradeNet(t), 0), 2)} after fees.</p>
  </>)
}

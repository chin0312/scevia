/* Shared, context-preserving detail panels for positions, events, groups of holdings and closed trades.
   Inspecting never navigates or changes scenario state; cross-module actions are explicit buttons.
   Panels stack (event → position) with a Back button and return focus to where the user was. */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PLATFORM_NAME } from '../data/labels'
import { REL_TEXT, useRelations } from '../data/relations'
import type { ClosedTrade, Platform } from '../data/types'
import { POS_BY_ID, coverage, eventRelations, exposures, fmtDate, sourceOf, tradeNet, type Position } from '../lib/finance'
import { fmt, int, pct, sfmt } from '../lib/format'
import { Icon } from './Icon'
import { Drawer } from './overlays'
import { RelationshipModal } from './relationships'
import { Button, Callout, Chip, PlatformBadge, SideChip, cx } from './ui'

export type Detail =
  | { kind: 'position'; id: string }
  | { kind: 'event'; id: string }
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
  const title = d.kind === 'position' ? POS_BY_ID[d.id]?.market ?? 'Position'
    : d.kind === 'event' ? exposures('all').find((e) => e.event.id === d.id)?.event.name ?? 'Event' : d.title
  const sub = d.kind === 'position' ? positionSub(POS_BY_ID[d.id]) : d.kind === 'event' ? 'Event exposure across platforms' : d.sub
  return (
    <Drawer title={title} sub={sub} onClose={onClose}>
      {depth > 1 && <button type="button" className="link back-link" onClick={onBack}><Icon name="arrowRight" size={12} className="flip" /> Back</button>}
      {d.kind === 'position' && <PositionBody p={POS_BY_ID[d.id]} open={open} close={onClose} />}
      {d.kind === 'event' && <EventBody id={d.id} open={open} close={onClose} />}
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
    go: (q: string) => { close(); nav(`/scenario-lab?${q}`) },
  }
}

function PositionBody({ p, open, close }: { p?: Position; open: (d: Detail) => void; close: () => void }) {
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
      <div><span className="t3">Unrealized (before fees)</span><b className={p.upl >= 0 ? 'gain' : 'loss'}>{sfmt(p.upl, 2)}</b></div>
    </div>
    <h5 className="caps">If it resolves</h5>
    <div className="cov-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <div><span className="t3">For you ({p.side})</span><b className="gain">{sfmt(p.ifWin, 2)}</b><span className="t3">{int(p.shares)} × $1 − cost basis</span></div>
      <div><span className="t3">Against you</span><b className="loss">{sfmt(p.ifLose, 2)}</b><span className="t3">the cost basis is lost</span></div>
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
      <Button icon="shield" onClick={() => open({ kind: 'event', id: p.eventId })}>View event exposure</Button>
      <Button variant="primary" icon="flask" onClick={() => sim.go(`add=${p.id}`)}>{sim.label}</Button>
    </div>
  </>)
}

function EventBody({ id, open, close }: { id: string; open: (d: Detail) => void; close: () => void }) {
  const sim = useSimulate(close)
  const nav = useNavigate(), { pathname } = useLocation()
  const { rels, crypto } = useRelations()
  const [classify, setClassify] = useState(false)
  const all = exposures('all'), e = all.find((x) => x.event.id === id)
  if (!e) return <div className="empty"><p>No open positions on this event.</p></div>
  const committed = all.reduce((a, x) => a + x.cost, 0)
  const value = e.positions.reduce((a, p) => a + p.value, 0)
  const sides = [...new Set(e.positions.map((p) => p.side))]
  const related = eventRelations(id, rels)
  const platforms = [...new Set(e.positions.map((p) => p.platform))] as Platform[]
  return (<>
    <div className="row"><Chip>Resolves {fmtDate(e.resolves, { month: 'short', day: 'numeric', year: 'numeric' })} · in {e.days} days</Chip>{e.positions.length > 1 && <Chip tone="yes">{e.positions.length} contracts · equivalent</Chip>}</div>
    <div className="cov-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <div><span className="t3">Capital committed</span><b>{fmt(e.cost)}</b><span className="t3">{pct((e.cost / committed) * 100)} of portfolio</span></div>
      <div><span className="t3">Value at mark</span><b>{fmt(value)}</b></div>
      <div><span className="t3">Unrealized</span><b className={value - e.cost >= 0 ? 'gain' : 'loss'}>{sfmt(value - e.cost)}</b></div>
    </div>
    <h5 className="caps">Settlement payoff (vs. cost basis)</h5>
    <div className="cov-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <div><span className="t3">If it resolves {e.side} (for you)</span><b className="gain">{sfmt(e.pnlFor)}</b></div>
      <div><span className="t3">If it resolves {e.side === 'YES' ? 'NO' : 'YES'} (against you)</span><b className="loss">{sfmt(e.pnlAgainst)}</b></div>
    </div>
    {sides.length > 1 && <Callout tone="warn">These positions hold different sides of the event; payoffs above use each position’s own side.</Callout>}
    <h5 className="caps">Positions on this event</h5>
    <PosList ps={e.positions} open={open} right={(p) => <><b>{fmt(p.value)}</b><small className="t3">cost {fmt(p.cost)}</small></>} />
    <h5 className="caps">Relationships</h5>
    {related.length === 0 && <p className="t3" style={{ fontSize: 'var(--font-size-xs)' }}>Not classified against other events: every combination with them is treated as possible.</p>}
    {related.map((r) => (
      <div className="list-row" key={r.other.id}><span>{r.other.name}</span><span className="r row"><Chip tone={REL_TEXT[r.cls].tone}>{REL_TEXT[r.cls].label}</Chip>
        {((id === 'btc' && r.other.id === 'eth') || (id === 'eth' && r.other.id === 'btc')) && <button type="button" className="link" onClick={() => setClassify(true)}>Change</button>}</span></div>
    ))}
    <h5 className="caps">Data</h5>
    {platforms.map((pl) => { const s = sourceOf(pl), c = coverage(pl); return <div className="cov" key={pl}><PlatformBadge p={pl} /><span>{c.fills} fills · {c.settlements} settlements</span><span className={s.stale ? 'stale' : 't3'}>as of {fmtDate(s.asOf)}{s.stale ? ' · stale' : ''}</span></div> })}
    <div className="drawer-actions">
      {!pathname.startsWith('/risk') && <Button icon="shield" onClick={() => { close(); nav(`/risk?event=${id}#payoffs`) }}>Analyze in Risk</Button>}
      <Button variant="primary" icon="flask" onClick={() => sim.go(`addEvent=${id}`)}>{sim.label}</Button>
    </div>
    {classify && <RelationshipModal current={crypto} onClose={() => setClassify(false)} />}
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

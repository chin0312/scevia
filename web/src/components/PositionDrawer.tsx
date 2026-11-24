/* Position detail: drill-down to fills, how each number is derived, and the settlement payoff. */
import { useNavigate } from 'react-router-dom'
import { PLATFORM_NAME, SOURCES } from '../data/sample'
import { fmtDate, type Position } from '../lib/finance'
import { fmt, int, sfmt } from '../lib/format'
import { Drawer } from './overlays'
import { Button, Callout, Chip, PlatformBadge, SideChip, cx } from './ui'

export function PositionDrawer({ p, onClose }: { p: Position; onClose: () => void }) {
  const nav = useNavigate()
  const src = SOURCES[p.platform]
  return (
    <Drawer title={p.market} sub={`${PLATFORM_NAME[p.platform]} · ${p.category} · resolves ${fmtDate(p.resolves, { month: 'short', day: 'numeric', year: 'numeric' })} (in ${p.days} days)`} onClose={onClose}>
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
      <Callout>Average cost = Σ(shares × price) ÷ shares. Fees aren’t in the average cost; {p.fees ? `the ${fmt(p.fees, 2)} paid on these fills is subtracted once in net P&L.` : 'this sample charged no fees on these fills.'} The mark is the last traded price on {PLATFORM_NAME[p.platform]} in the sample.</Callout>

      <div className="row" style={{ marginTop: 'var(--space-2)' }}>
        <Button variant="primary" icon="flask" onClick={() => nav(`/scenario-lab?add=${p.id}`)}>Simulate a change</Button>
        <Button icon="shield" onClick={() => nav(`/risk?event=${p.eventId}#payoffs`)}>See event risk</Button>
      </div>
    </Drawer>
  )
}

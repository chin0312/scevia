/* Position detail: drill-down to fills, how each number is derived, and the payoff (concept doc §5.1, §6.3). */
import { useNavigate } from 'react-router-dom'
import { PLATFORM_ACCOUNT, PLATFORM_NAME, fillsFor, type DerivedPosition } from '../data/portfolio'
import { fmt, int, sfmt } from '../lib/format'
import { Drawer } from './overlays'
import { Button, Callout, Chip, PlatformBadge, SideChip, cx } from './ui'

export function PositionDrawer({ p, onClose }: { p: DerivedPosition; onClose: () => void }) {
  const nav = useNavigate()
  const fills = fillsFor(p)
  const fees = fills.reduce((a, f) => a + f.fee, 0)
  const src = PLATFORM_ACCOUNT[p.platform]
  return (
    <Drawer title={p.market} sub={`${PLATFORM_NAME[p.platform]} · ${p.category} · resolves ${p.resolves} (in ${p.days} days)`} onClose={onClose}>
      <div className="row"><PlatformBadge p={p.platform} /><SideChip side={p.side} /><Chip>{int(p.shares)} shares</Chip><span className="spacer" />
        <span className={cx('stale', !src.stale && 't3')}>{src.source}{src.stale && ' · may be stale'}</span></div>

      <div className="cov-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div><span className="t3">Cost basis</span><b>{fmt(p.cost, 2)}</b></div>
        <div><span className="t3">Value at mark {p.mark.toFixed(2)}</span><b>{fmt(p.value, 2)}</b></div>
        <div><span className="t3">Unrealized</span><b className={p.upl >= 0 ? 'gain' : 'loss'}>{sfmt(p.upl, 2)}</b></div>
      </div>

      <h5 className="caps">If it resolves</h5>
      <div className="cov-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div><span className="t3">For you ({p.side})</span><b className="gain">{sfmt(p.ifWin, 2)}</b><span className="t3">{int(p.shares)} × $1 − cost</span></div>
        <div><span className="t3">Against you</span><b className="loss">{sfmt(p.ifLose, 2)}</b><span className="t3">you lose the cost basis</span></div>
      </div>

      <h5 className="caps">Fills · how the average cost is calculated</h5>
      <table className="dt">
        <thead><tr><th>Date</th><th>Action</th><th className="r">Shares</th><th className="r">Price</th><th className="r">Fee</th></tr></thead>
        <tbody>{fills.map((f) => (
          <tr key={f.date}><td>{f.date}</td><td>{f.action}</td><td className="r">{int(f.shares)}</td><td className="r">{f.price.toFixed(3)}</td><td className="r t3">{f.fee ? fmt(f.fee, 2) : '—'}</td></tr>
        ))}
          <tr><td colSpan={2}><b>Weighted average</b></td><td className="r">{int(p.shares)}</td><td className="r"><b>{p.avg.toFixed(3)}</b></td><td className="r t3">{fees ? fmt(fees, 2) : '—'}</td></tr>
        </tbody>
      </table>
      <Callout>Average cost = Σ(shares × price) ÷ shares. {fees ? 'Fees are counted in realized P&L when the position closes, not in the average price.' : 'Polymarket charged no trading fees on these fills.'} Mark price is the last trade on {PLATFORM_NAME[p.platform]}.</Callout>

      <div className="row" style={{ marginTop: 'var(--space-2)' }}>
        <Button variant="primary" icon="flask" onClick={() => nav(`/scenario-lab?add=${p.id}`)}>Simulate a change</Button>
        <Button icon="shield" onClick={() => nav(`/risk?event=${p.eventId}#payoffs`)}>See event risk</Button>
      </div>
    </Drawer>
  )
}

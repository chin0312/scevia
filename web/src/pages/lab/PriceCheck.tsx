/* "Check latest prices": compares each row's frozen reference (captured when the scenario started or the market was
   added) with the latest market reference, next to the user's assumed execution price. Nothing changes unless the
   user confirms; confirming updates only the frozen references of moved instruments. Assumed prices and targets stay. */
import { useEffect, useState } from 'react'
import { useMarketCatalog } from '../../lib/marketContext'
import { Modal } from '../../components/overlays'
import { Button, Chip } from '../../components/ui'
import { fmtDate, instrumentKey, type Adjustment, type Finance } from '../../lib/finance'
import { refStatus, type RefCheck } from '../../lib/scenarios'

const px = (v: number | null) => (v == null ? '—' : v.toFixed(2))
const STATUS: Record<RefCheck['status'], string> = { same: 'Unchanged', moved: 'Moved', 'no-latest': 'No latest price', 'no-frozen': 'New price available' }

export function PriceCheckModal({ adjs, baseAsOf, latest: latestF, titleOf, onClose, onApply }: { adjs: Adjustment[]; baseAsOf: string | null; latest: Finance | null; titleOf: (a: Adjustment) => string; onClose: () => void; onApply: (checks: RefCheck[]) => void }) {
  const MARKET_CATALOG = useMarketCatalog()
  // Latest marks come from the portfolio the scenario started from, when it's the one selected; otherwise there is no
  // latest portfolio mark (never another portfolio's).
  const POS_BY_ID = latestF?.POS_BY_ID ?? {}, sourceOf = latestF?.sourceOf
  const [checks, setChecks] = useState<RefCheck[] | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    MARKET_CATALOG.search('').then((events) => {
      if (!live) return
      const latest = new Map<string, { price: number | null; at: string | null }>()
      for (const ev of events) for (const m of ev.markets) for (const o of m.outcomes) latest.set(`${m.provider}:${m.marketId}:${o.outcome}`, { price: o.refPrice, at: m.refAsOf })
      setChecks(adjs.map((a) => {
        // A held position's latest reference is the selected workspace's current mark; a new instrument's comes from
        // the market service. Its frozen reference is what the row stored when it was added.
        const held = POS_BY_ID[a.id]
        const l = held && sourceOf ? { price: held.mark, at: sourceOf(held.platform).asOf } : a.instrument ? latest.get(instrumentKey(a.instrument)) ?? { price: null, at: null } : { price: null, at: null }
        const frozen = a.instrument?.refPrice ?? null, frozenAt = a.instrument?.refAsOf ?? baseAsOf
        return { id: a.id, frozen, frozenAt, latest: l.price, latestAt: l.at, assumed: a.price, status: refStatus(frozen, l.price) }
      }))
    }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [adjs, baseAsOf])
  const noLatest = checks?.filter((c) => c.status === 'no-latest').length ?? 0
  const moved = checks?.filter((c) => c.status === 'moved' || c.status === 'no-frozen').length ?? 0
  return (
    <Modal title="Check latest prices" sub="Compare the prices saved with this scenario with the latest ones. Nothing changes unless you confirm." onClose={onClose} width={680}
      footer={<><Button variant="ghost" onClick={onClose}>{moved ? 'Keep frozen prices' : 'Close'}</Button>{moved > 0 && <Button variant="primary" onClick={() => onApply(checks!)}>Update {moved} reference price{moved === 1 ? '' : 's'}</Button>}</>}>
      {error ? <div className="empty"><p>Latest prices couldn’t be loaded. The scenario is unchanged.</p></div> : !checks ? <div className="skeleton" style={{ height: 160 }} aria-busy="true" aria-label="Loading latest prices" /> : (<>
        <p className="t2" style={{ marginBottom: 'var(--space-3)' }}>{noLatest ? `${noLatest} position${noLatest === 1 ? ' has' : 's have'} no latest price; ${noLatest === 1 ? 'it isn’t' : 'they aren’t'} counted as unchanged. ` : ''}{moved ? `${moved} reference price${moved === 1 ? ' has' : 's have'} moved since this scenario started. Updating changes reference values and valuation. Your assumed execution prices and targets stay as they are.` : `${noLatest ? 'No other' : 'No'} reference price has moved since this scenario started. Its results stay as they are.`}</p>
        {checks.length > 0 && <div className="dt-wrap"><table className="dt">
          <thead><tr><th scope="col">Position</th><th scope="col" className="r">Frozen reference</th><th scope="col" className="r">Latest reference</th><th scope="col" className="r">Your assumed price</th><th scope="col">Status</th></tr></thead>
          <tbody>{checks.map((c) => { const a = adjs.find((x) => x.id === c.id)!; return (
            <tr key={c.id}><td>{titleOf(a)}</td><td className="r">{px(c.frozen)}<small className="t3" style={{ display: 'block' }}>{c.frozenAt ? fmtDate(c.frozenAt) : ''}</small></td><td className="r">{px(c.latest)}<small className="t3" style={{ display: 'block' }}>{c.latestAt ? fmtDate(c.latestAt) : ''}</small></td><td className="r">{c.assumed == null ? <span className="t3">not set</span> : px(c.assumed)}</td><td>{c.status === 'moved' ? <Chip tone="warn">{STATUS[c.status]}</Chip> : <span className="t3">{STATUS[c.status]}</span>}</td></tr>
          ) })}</tbody>
        </table></div>}
        <small className="t3" style={{ display: 'block', marginTop: 'var(--space-3)' }}>References are sample market data. A reference is the last recorded price, not an executable quote.</small>
      </>)}
    </Modal>
  )
}

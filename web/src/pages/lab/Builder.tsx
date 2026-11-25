/* The scenario's portfolio: one editable row per position (held or new). Quantities and prices are typed directly and
   parsed strictly (lib/inputs.ts): while a field is empty, still being typed or invalid, the row has no value for it,
   so results never keep using a previous number. Notional and fee come from the simulation (one fee formula). */
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Chip, PlatformBadge, SideChip, cx } from '../../components/ui'
import { fmtDate, type Adjustment, type Holding, type Simulation } from '../../lib/finance'
import { fmt, int } from '../../lib/format'
import { fmtPrice, parsePrice, parseShares, type Parsed } from '../../lib/inputs'
import { describe } from './model'

const valueOf = (p: Parsed) => (p.state === 'ok' ? p.value : p.state === 'invalid' ? Number.NaN : null)
const textOf = (v: number | null, fmt: (n: number) => string) => (v == null || !Number.isFinite(v) ? '' : fmt(v))

export function PositionRow({ a, start, after, sim, error, onChange, onRemove }: {
  a: Adjustment; start?: Holding; after?: Holding; sim: Simulation; error?: string
  onChange: (a: Adjustment) => void; onRemove: () => void
}) {
  const d = describe(a)
  const [qty, setQty] = useState(textOf(a.to, String))
  const [px, setPx] = useState(textOf(a.price, fmtPrice))
  const qp = parseShares(qty), pp = parsePrice(px)
  // Follow external changes (Reset, Revert, "Use reference") without fighting the user's typing.
  useEffect(() => { if (!Object.is(valueOf(parseShares(qty)), a.to) && !(a.to == null && parseShares(qty).state !== 'ok')) setQty(textOf(a.to, String)) }, [a.to]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!Object.is(valueOf(parsePrice(px)), a.price) && !(a.price == null && parsePrice(px).state !== 'ok')) setPx(textOf(a.price, fmtPrice)) }, [a.price]) // eslint-disable-line react-hooks/exhaustive-deps
  const commitQty = (t: string) => { setQty(t); onChange({ ...a, to: valueOf(parseShares(t)) }) }
  const commitPx = (t: string) => { setPx(t); onChange({ ...a, price: valueOf(parsePrice(t)) }) }

  const from = start?.shares ?? 0
  const pending = qp.state === 'partial' || pp.state === 'partial'
  const traded = a.id in sim.feeStatusBy
  const complete = !error && a.to != null && a.price != null
  const delta = qp.state === 'ok' ? qp.value - from : null
  const act = delta == null ? ['—', 'none'] : delta < 0 ? (a.to === 0 ? ['Exit', 'exit'] : [`Sell ${int(-delta)}`, 'sell']) : delta > 0 ? [`Buy ${int(delta)}`, 'buy'] : ['No change', 'none']
  const notional = complete && delta ? Math.abs(delta) * a.price! : complete ? 0 : null
  const feeStatus = sim.feeStatusBy[a.id]
  const fee = !traded ? (complete ? 0 : null) : feeStatus === 'unavailable' ? null : sim.feesBy[a.id]
  const localErr = qp.state === 'invalid' ? qp.message : pp.state === 'invalid' ? pp.message : null
  // Missing inputs are 'incomplete' (neutral), not errors; out-of-range or malformed values are errors.
  const missing = !!error && /^Enter (a target quantity|an assumed price)$/.test(error)
  const msg = localErr ?? (pending || missing ? null : error)
  const isNew = !start
  return (
    <div className={cx('brow', msg && 'has-error', !complete && !msg && 'incomplete')} role="row">
      <div className="brow-i" role="cell">
        <PlatformBadge p={d.platform} />
        <span className="brow-t"><b title={d.title}>{d.title}</b>
          <small className="t3"><SideChip side={d.side} />{isNew ? <Chip tone="accent">New</Chip> : <Chip>Held</Chip>}
            {d.refPrice != null ? `ref ${fmtPrice(d.refPrice)}${d.refAsOf ? ` · ${fmtDate(d.refAsOf)}` : ''}${d.sample ? ' (sample)' : ''}` : 'no reference price'}{d.resolves ? ` · resolves ${fmtDate(d.resolves)}` : ''}</small></span>
      </div>
      <div className="brow-n r" role="cell"><span className="brow-l">Current</span>{int(from)}</div>
      <div className="brow-f" role="cell"><label className="brow-l" htmlFor={`q-${a.id}`}>Target shares</label>
        <input id={`q-${a.id}`} className="num-input" inputMode="numeric" placeholder="qty" aria-label={`Target shares of ${d.title}`} value={qty}
          aria-invalid={qp.state === 'invalid' || (!!error && /quantity|whole/i.test(error))} onChange={(e) => commitQty(e.target.value)} />
        <span className="brow-quick">
          {from > 0 && <button type="button" className="link" onClick={() => commitQty('0')}>Exit</button>}
          {from > 0 && <button type="button" className="link" onClick={() => commitQty(String(from))}>Current</button>}
        </span>
      </div>
      <div className="brow-n" role="cell"><span className="brow-l">Trade</span><span className={cx('act', act[1])}>{act[0]}</span></div>
      <div className="brow-f" role="cell"><label className="brow-l" htmlFor={`p-${a.id}`}>Assumed price</label>
        <input id={`p-${a.id}`} className="num-input" inputMode="decimal" placeholder={d.refPrice != null ? `ref ${fmtPrice(d.refPrice)}` : '0.01–0.99'} aria-label={`Assumed price for ${d.title}`} value={px}
          aria-invalid={pp.state === 'invalid' || (!!error && /price/i.test(error))} onChange={(e) => commitPx(e.target.value)} />
        {pp.state === 'empty' && d.refPrice != null && <button type="button" className="link brow-quick" onClick={() => commitPx(fmtPrice(d.refPrice!))}>Use reference {fmtPrice(d.refPrice)}</button>}
      </div>
      <div className="brow-n r" role="cell"><span className="brow-l">Notional</span>{notional == null ? '—' : fmt(notional, 2)}</div>
      <div className="brow-n r" role="cell"><span className="brow-l">Est. fee</span>
        {fee == null ? (traded ? <span className="stale" title="No fee parameters for this market: not included in cash or P&L">Unavailable</span> : '—') : feeStatus === 'excluded' ? <span className="t3">Excluded</span> : fmt(fee, fee > 0 && fee < 0.01 ? 4 : 2)}
        {feeStatus === 'custom' && <small className="t3"> custom</small>}</div>
      <div className="brow-x" role="cell"><button type="button" className="icon-btn" aria-label={`Remove ${d.title} from scenario`} onClick={onRemove}><Icon name="x" size={14} /></button></div>
      {(msg || pending || !complete || (traded && feeStatus === 'unavailable') || (delta != null && delta > 0 && sim.shortfall[d.platform] > 0) || (after && after.mark == null && after.shares > 0)) && (
        <div className="brow-msg" role="cell">
          {msg ? <span role="alert" className="loss">{msg}. Left out of the results until fixed.</span>
            : pending ? <span className="t3">{qp.state === 'partial' ? qp.message : pp.state === 'partial' ? pp.message : ''}: not included yet.</span>
              : !complete ? <span className="t3">Enter a target quantity{a.price == null ? ' and an assumed price' : ''} to include this position.</span>
                : traded && feeStatus === 'unavailable' ? <span className="stale">No fee parameters for this market: cash and P&amp;L for this trade are before fees. Choose a custom fee in Setup to include one.</span>
                  : delta != null && delta > 0 && sim.shortfall[d.platform] > 0 ? <span role="status" className="stale">{d.platform === 'pm' ? 'Polymarket' : 'Kalshi'} purchases in this scenario exceed available cash; included as if funded.</span>
                    : <span className="stale">No reference price: this position’s value at mark is unavailable.</span>}
        </div>
      )}
    </div>
  )
}

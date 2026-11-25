/* The scenario's portfolio: one editable row per position (held or new). Quantities and prices are typed directly;
   nothing is filled in silently, and incomplete or invalid rows are excluded from results until fixed. */
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Chip, PlatformBadge, SideChip, cx } from '../../components/ui'
import { FEE_RATE } from '../../data/portfolio'
import { MAX_SHARES, fmtDate, type Adjustment, type Holding } from '../../lib/finance'
import { fmt, int } from '../../lib/format'
import { describe } from './model'

export function PositionRow({ a, start, after, error, includeFees, shortfall, onChange, onRemove }: {
  a: Adjustment; start?: Holding; after?: Holding; error?: string; includeFees: boolean; shortfall: number
  onChange: (a: Adjustment) => void; onRemove: () => void
}) {
  const d = describe(a)
  const [qty, setQty] = useState(a.to == null ? '' : String(a.to))
  const [px, setPx] = useState(a.price == null ? '' : a.price.toFixed(2))
  useEffect(() => { setQty(a.to == null ? '' : String(a.to)) }, [a.to])
  useEffect(() => { if (a.price == null || Number(px) !== a.price) setPx(a.price == null ? '' : a.price.toFixed(2)) }, [a.price]) // eslint-disable-line react-hooks/exhaustive-deps
  const from = start?.shares ?? 0
  const complete = a.to != null && a.price != null && !error
  const delta = a.to == null ? null : a.to - from
  const act = delta == null ? ['—', 'none'] : delta < 0 ? (a.to === 0 ? ['Exit', 'exit'] : [`Sell ${int(-delta)}`, 'sell']) : delta > 0 ? [`Buy ${int(delta)}`, 'buy'] : ['No change', 'none']
  const notional = complete && delta ? Math.abs(delta) * a.price! : null
  const fee = notional != null && includeFees ? notional * FEE_RATE[d.platform] : notional != null ? 0 : null
  const commitQty = (t: string) => {
    setQty(t)
    const clean = t.replace(/[,\s]/g, '')
    onChange({ ...a, to: clean === '' ? null : /^\d+(\.\d+)?$/.test(clean) ? Number(clean) : NaN })
  }
  const commitPx = (t: string) => {
    setPx(t)
    const clean = t.replace('$', '').trim()
    if (clean === '' ) { onChange({ ...a, price: null }); return }
    if (/^0?\.?0?$/.test(clean)) return // still typing
    const v = Number(clean)
    onChange({ ...a, price: Number.isFinite(v) ? Math.round(v * 1000) / 1000 : NaN })
  }
  const isNew = !start
  return (
    <div className={cx('brow', error && 'has-error', !complete && !error && 'incomplete')} role="row">
      <div className="brow-i" role="cell">
        <PlatformBadge p={d.platform} />
        <span className="brow-t"><b title={d.title}>{d.title}</b>
          <small className="t3"><SideChip side={d.side} />{isNew ? <Chip tone="accent">New</Chip> : <Chip>Held</Chip>}
            {d.refPrice != null ? `ref ${d.refPrice.toFixed(2)}${d.refAsOf ? ` · ${fmtDate(d.refAsOf)}` : ''}${d.sample ? ' (sample)' : ''}` : 'no reference price'}{d.resolves ? ` · resolves ${fmtDate(d.resolves)}` : ''}</small></span>
      </div>
      <div className="brow-n r" role="cell"><span className="brow-l">Current</span>{int(from)}</div>
      <div className="brow-f" role="cell"><label className="brow-l" htmlFor={`q-${a.id}`}>Target shares</label>
        <input id={`q-${a.id}`} className="num-input" inputMode="numeric" placeholder="qty" aria-label={`Target shares of ${d.title}`} value={qty}
          aria-invalid={!!error && /quantity|whole/i.test(error)} onChange={(e) => commitQty(e.target.value)} />
        <span className="brow-quick">
          {from > 0 && <button type="button" className="link" onClick={() => commitQty('0')}>Exit</button>}
          {from > 0 && <button type="button" className="link" onClick={() => commitQty(String(from))}>Current</button>}
        </span>
      </div>
      <div className="brow-n" role="cell"><span className="brow-l">Trade</span><span className={cx('act', act[1])}>{act[0]}</span></div>
      <div className="brow-f" role="cell"><label className="brow-l" htmlFor={`p-${a.id}`}>Assumed price</label>
        <input id={`p-${a.id}`} className="num-input" inputMode="decimal" placeholder={d.refPrice != null ? `ref ${d.refPrice.toFixed(2)}` : '0.01–0.99'} aria-label={`Assumed price for ${d.title}`} value={px}
          aria-invalid={!!error && /price/i.test(error)} onChange={(e) => commitPx(e.target.value)} />
        {a.price == null && d.refPrice != null && <button type="button" className="link brow-quick" onClick={() => commitPx(d.refPrice!.toFixed(2))}>Use reference {d.refPrice.toFixed(2)}</button>}
      </div>
      <div className="brow-n r" role="cell"><span className="brow-l">Notional</span>{notional == null ? '—' : fmt(notional, 2)}</div>
      <div className="brow-n r" role="cell"><span className="brow-l">Est. fee</span>{fee == null ? '—' : fee ? fmt(fee, 2) : '$0'}</div>
      <div className="brow-x" role="cell"><button type="button" className="icon-btn" aria-label={`Remove ${d.title} from scenario`} onClick={onRemove}><Icon name="x" size={14} /></button></div>
      {(error || !complete || (shortfall > 0 && delta != null && delta > 0) || (after && after.mark == null && (after.shares ?? 0) > 0)) && (
        <div className="brow-msg" role="cell">
          {error ? <span role="alert" className="loss">{error}. Left out of the results until fixed.</span>
            : !complete ? <span className="t3">Enter a target quantity{a.price == null ? ' and an assumed price' : ''} to include this position.</span>
              : shortfall > 0 && delta! > 0 ? <span role="status" className="stale">{d.platform === 'pm' ? 'Polymarket' : 'Kalshi'} purchases in this scenario exceed available cash; included as if funded.</span>
                : <span className="stale">No reference price: this position’s value at mark is unavailable.</span>}
        </div>
      )}
    </div>
  )
}

export const QTY_HELP = `Whole shares, 0–${MAX_SHARES.toLocaleString('en-US')}.`

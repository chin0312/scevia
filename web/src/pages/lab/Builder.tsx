/* Scenario Lab › Build: the scenario's positions and a live cash / value summary.
   A position's target can be typed as shares, as a $ amount at the assumed price, or as a % of the scenario's starting
   value. They are three views of the same position (lib/finance.ts `targetShares`): switching the view converts the
   display and never changes the position; typing in a view sets the target in that unit.
   Inputs are parsed strictly (lib/inputs.ts): while a field is empty, still being typed or invalid, the row has no value,
   so results never keep using a previous number. Notional and fee come from the simulation (one fee formula). */
import { useState, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { InfoTip } from '../../components/overlays'
import { Button, Card, CardHeader, Chip, PlatformBadge, Seg, SideChip, cx } from '../../components/ui'
import { PLATFORM_NAME } from '../../data/labels'
import type { Platform } from '../../data/types'
import { fmtDate, type Adjustment, type Holding, type Simulation } from '../../lib/finance'
import { useFinance } from '../../lib/financeContext'
import { fmt, pct, qty, sfmt } from '../../lib/format'
import { fmtPrice, parseMoney, parsePct, parsePrice, parseShares, type Parsed } from '../../lib/inputs'
import { SIZE_LABEL, describe, type Evaluation, type SizeMode } from './model'
import { accountName } from '../../lib/useWorkspace'

const valueOf = (p: Parsed) => (p.state === 'ok' ? p.value : p.state === 'invalid' ? Number.NaN : null)
const PARSE: Record<SizeMode, (t: string) => Parsed> = { shares: parseShares, amount: parseMoney, weight: parsePct }

/** A number input that shows the committed value when not being edited and the user's own text while editing,
 *  so external changes (Revert, bulk actions, another view) are reflected without fighting the user's typing. */
function useEditable(value: number | null, show: (v: number) => string, parse: (t: string) => Parsed) {
  const [text, setText] = useState<string | null>(null)
  const display = text ?? (value == null || !Number.isFinite(value) ? '' : show(value))
  return {
    value: display, parsed: parse(display),
    onFocus: () => setText(display),
    onBlur: () => { if (parse(text ?? '').state === 'ok' || (text ?? '') === '') setText(null) },
    set: (t: string | null) => setText(t),
  }
}

export interface RowView { a: Adjustment; start?: Holding; after?: Holding; error?: string }

export function PositionRow({ a, start, after, sim, error, mode, selected, onSelect, onChange, onRemove }: RowView & {
  sim: Simulation; mode: SizeMode; selected: boolean; onSelect: (on: boolean) => void
  onChange: (a: Adjustment) => void; onRemove: () => void
}) {
  const F = useFinance()
  const d = describe(a, F)
  const from = start?.shares ?? 0
  const target = sim.targets[a.id] ?? (a.size ? null : a.to)
  const priceOk = a.price != null && Number.isFinite(a.price)
  // The target in the current view (converted for display only).
  const shown: number | null = mode === 'shares' ? target
    : a.size?.by === mode ? a.size.value
      : target == null || !priceOk ? null
        : mode === 'amount' ? Math.round(target * a.price! * 100) / 100
          : sim.startValue ? Math.round(((target * a.price!) / sim.startValue) * 100000) / 1000 : null
  const tq = useEditable(shown, String, PARSE[mode])
  const px = useEditable(a.price, fmtPrice, parsePrice)
  const setTarget = (t: string) => {
    tq.set(t)
    const v = valueOf(PARSE[mode](t))
    onChange(mode === 'shares' ? { ...a, to: v, size: undefined } : { ...a, to: null, size: { by: mode, value: v ?? Number.NaN } })
  }
  const setPrice = (t: string) => { px.set(t); onChange({ ...a, price: valueOf(parsePrice(t)) }) }

  const pending = tq.parsed.state === 'partial' || px.parsed.state === 'partial'
  const traded = a.id in sim.feeStatusBy
  const complete = !error && target != null && a.price != null
  const delta = complete ? target! - from : mode === 'shares' && tq.parsed.state === 'ok' ? tq.parsed.value - from : null
  const act = delta == null ? ['—', 'none'] : delta < -1e-9 ? (target === 0 ? ['Exit', 'exit'] : [`Sell ${qty(-delta)}`, 'sell']) : delta > 1e-9 ? [`Buy ${qty(delta)}`, 'buy'] : ['No change', 'none']
  const t = sim.trades[a.id]
  const notional = t ? Math.abs(t.qty) * t.price : complete ? 0 : null
  const feeStatus = sim.feeStatusBy[a.id]
  const fee = !traded ? (complete ? 0 : null) : feeStatus === 'unavailable' ? null : sim.feesBy[a.id]
  const localErr = tq.parsed.state === 'invalid' ? tq.parsed.message : px.parsed.state === 'invalid' ? px.parsed.message : null
  // Missing inputs are 'incomplete' (neutral), not errors; out-of-range or malformed values are errors.
  const missing = !!error && /^Enter (a target quantity|an assumed price|a target amount|a percentage)$/.test(error)
  const msg = localErr ?? (pending || missing ? null : error)
  const isNew = !start
  const derived = !complete ? null
    : mode === 'shares' ? `≈ ${fmt(target! * a.price!)}${sim.startValue ? `, ${pct((target! * a.price! / sim.startValue) * 100, 1)}` : ''}`
      : mode === 'amount' ? `= ${qty(target!)} shares${a.size?.by === 'amount' ? '' : ' (set in shares)'}`
        : `= ${qty(target!)} shares, ${fmt(target! * a.price!)}`
  const shortfall = delta != null && delta > 0 && sim.shortfall[d.platform] > 0
  return (
    <div id={`row-${a.id}`} className={cx('brow', 'brow-sel', msg && 'has-error', !complete && !msg && 'incomplete', selected && 'is-sel')} role="row">
      <div className="brow-c" role="cell"><input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${d.title}`} /></div>
      <div className="brow-i" role="cell">
        <PlatformBadge p={d.platform} />
        <span className="brow-t"><b title={d.title}>{d.title}</b>
          <small className="t3"><SideChip side={d.side} />{isNew ? <Chip tone="accent">New</Chip> : <Chip>Held</Chip>}
            {d.refPrice != null ? `Price ${fmtPrice(d.refPrice)}` : 'No price'}{d.resolves ? `, resolves ${fmtDate(d.resolves)}` : ''}</small>
          <small className="t3">{d.account ? `${accountName(d.account.id)} on ${PLATFORM_NAME[d.platform]}` : `Virtual funds on ${PLATFORM_NAME[d.platform]}`}</small></span>
      </div>
      <div className="brow-n r" role="cell"><span className="brow-l">Current</span>{qty(from)}</div>
      <div className="brow-f" role="cell"><label className="brow-l" htmlFor={`q-${a.id}`}>Target ({SIZE_LABEL[mode]})</label>
        <span className="num-wrap">{mode === 'amount' && <span className="num-pre">$</span>}
          <input id={`q-${a.id}`} className="num-input" inputMode="decimal" placeholder={mode === 'shares' ? 'shares' : mode === 'amount' ? 'amount' : '% of start'}
            aria-label={mode === 'shares' ? `Target shares of ${d.title}` : mode === 'amount' ? `Target amount for ${d.title}` : `Target % of starting value for ${d.title}`}
            value={tq.value} onFocus={tq.onFocus} onBlur={tq.onBlur} onChange={(e) => setTarget(e.target.value)}
            aria-invalid={tq.parsed.state === 'invalid' || (!!error && /quantity|decimals|amount|%/i.test(error) && !missing)} />
          {mode === 'weight' && <span className="num-post">%</span>}</span>
        {(derived || (from > 0 && mode === 'shares')) && <span className="brow-quick">{derived && <small className="t3">{derived}</small>}
          {from > 0 && mode === 'shares' && <><button type="button" className="link" onClick={() => setTarget('0')}>Exit</button><button type="button" className="link" onClick={() => setTarget(String(from))}>Current</button></>}</span>}
      </div>
      <div className="brow-n" role="cell"><span className="brow-l">Trade</span><span className={cx('act', act[1])}>{act[0]}</span></div>
      <div className="brow-f" role="cell"><label className="brow-l" htmlFor={`p-${a.id}`}>Assumed price</label>
        <input id={`p-${a.id}`} className="num-input" inputMode="decimal" placeholder={d.refPrice != null ? `ref ${fmtPrice(d.refPrice)}` : '0.01–0.99'} aria-label={`Assumed price for ${d.title}`}
          value={px.value} onFocus={px.onFocus} onBlur={px.onBlur} onChange={(e) => setPrice(e.target.value)} aria-invalid={px.parsed.state === 'invalid' || (!!error && /price/i.test(error) && !missing)} />
        {px.parsed.state === 'empty' && d.refPrice != null && <button type="button" className="link brow-quick" onClick={() => { px.set(null); onChange({ ...a, price: d.refPrice }) }}>Use reference {fmtPrice(d.refPrice)}</button>}
      </div>
      <div className="brow-n r" role="cell"><span className="brow-l">Notional</span>{notional == null ? '—' : fmt(notional, 2)}</div>
      <div className="brow-n r" role="cell"><span className="brow-l">Est. fee</span>
        {fee == null ? (traded ? <span className="stale" title="No fee parameters for this market: not included in cash or P&L">Unavailable</span> : '—') : feeStatus === 'excluded' ? <span className="t3">Excluded</span> : fmt(fee, fee > 0 && fee < 0.01 ? 4 : 2)}
        {feeStatus === 'custom' && <small className="t3"> custom</small>}</div>
      <div className="brow-x" role="cell"><button type="button" className="icon-btn" aria-label={`Remove ${d.title} from scenario`} title={isNew ? 'Remove from scenario' : 'Remove the change (back to your current holding)'} onClick={onRemove}><Icon name="x" size={14} /></button></div>
      {(msg || pending || !complete || (traded && feeStatus === 'unavailable') || shortfall || (after && after.mark == null && after.shares > 0)) && (
        <div className="brow-msg" role="cell">
          {msg ? <span role="alert" className="loss">{msg}. Left out of the results until fixed.</span>
            : pending ? <span className="t3">{tq.parsed.state === 'partial' ? tq.parsed.message : px.parsed.state === 'partial' ? px.parsed.message : ''}: not included yet.</span>
              : !complete ? <span className="t3">Enter a target{a.price == null ? ' and an assumed price' : ''} to include this position.</span>
                : traded && feeStatus === 'unavailable' ? <span className="stale">No fee parameters for this market: this trade’s cash and P&amp;L are before fees.</span>
                  : shortfall ? <span role="status" className="stale">Purchases on {PLATFORM_NAME[d.platform]} exceed this scenario’s cash there. They’re included as if funded.</span>
                    : <span className="stale">No reference price: this position’s value at mark is unavailable.</span>}
        </div>
      )}
    </div>
  )
}

/** The positions table with its view switch, selection and bulk actions. */
export function PositionsCard({ E, adjs, baseline, mode, onMode, onAdjs, onAdd, onBulk }: {
  E: Evaluation; adjs: Adjustment[]; baseline: 'portfolio' | 'scratch'; mode: SizeMode; onMode: (m: SizeMode) => void
  onAdjs: (fn: (a: Adjustment[]) => Adjustment[]) => void; onAdd: () => void; onBulk: (msg: string, prev: Adjustment[]) => void
}) {
  const F = useFinance()
  const { start, sim: S } = E
  const [sel, setSel] = useState<Set<string>>(new Set())
  const live = new Set(adjs.map((a) => a.id)), picked = [...sel].filter((id) => live.has(id))
  const all = adjs.length > 0 && picked.length === adjs.length
  const toggle = (id: string, on: boolean) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const bulk = (label: string, fn: (a: Adjustment) => Adjustment | null) => {
    const ids = new Set(picked), prev = adjs
    onAdjs((list) => list.flatMap((a) => (ids.has(a.id) ? (fn(a) ? [fn(a)!] : []) : [a])))
    setSel(new Set()); onBulk(label, prev)
  }
  const heldPicked = picked.filter((id) => start.holdings[id])
  const refOf = (a: Adjustment) => describe(a, F).refPrice
  return (
    <Card id="positions" flush>
      <CardHeader pad title={`Positions${adjs.length ? ` (${adjs.length})` : ''}`} sub={baseline === 'scratch' ? 'Bought from zero with this scenario’s capital' : 'Only positions you change are listed. The rest of your portfolio stays as it is.'}
        right={<div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className="t3 seg-label">Size by <InfoTip text="Three ways to set the same position. Shares: the quantity. $ Amount: target position value at your assumed price (shares = amount ÷ price, rounded down to 0.01). % of start: share of this scenario’s starting value at reference marks, cash and added capital included. Switching only changes how targets are shown. Typing sets the target in that unit." /></span>
          <Seg label="Size positions by" options={[SIZE_LABEL.shares, SIZE_LABEL.amount, SIZE_LABEL.weight]} value={SIZE_LABEL[mode]} onChange={(v) => onMode((Object.keys(SIZE_LABEL) as SizeMode[]).find((k) => SIZE_LABEL[k] === v)!)} />
          <Button size="sm" variant="primary" icon="plus" onClick={onAdd}>Add markets…</Button></div>} />
      {picked.length > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected positions">
          <b>{picked.length} selected</b>
          <Button size="sm" onClick={() => bulk('Used reference prices', (a) => (refOf(a) != null ? { ...a, price: refOf(a) } : a))}>Use reference prices</Button>
          <Button size="sm" onClick={() => bulk(`Set ${picked.length} target${picked.length > 1 ? 's' : ''} to 0`, (a) => ({ ...a, to: 0, size: undefined }))} title="Simulates exiting (held) or not buying (new) these positions">Set target to 0</Button>
          {heldPicked.length > 0 && <Button size="sm" onClick={() => bulk('Reset to current size', (a) => (start.holdings[a.id] ? { ...a, to: start.holdings[a.id].shares, size: undefined } : a))} title="Keeps the rows, with targets equal to what you hold (no trade)">Reset to current size</Button>}
          <Button size="sm" variant="ghost" icon="trash" onClick={() => bulk(`Removed ${picked.length} position${picked.length > 1 ? 's' : ''} from the scenario`, () => null)}
            title={baseline === 'portfolio' ? 'Removing a held position’s row restores your current holding. It isn’t an exit' : 'Removes these rows'}>Remove from scenario</Button>
          <button type="button" className="link" onClick={() => setSel(new Set())}>Clear selection</button>
          <small className="t3 bulk-note">{baseline === 'portfolio' && heldPicked.length ? 'Remove restores your current holding. To simulate selling everything, set the target to 0.' : ''}</small>
        </div>
      )}
      {adjs.length > 1 && picked.length === 0 && <div className="sel-all"><label className="check"><input type="checkbox" checked={all} aria-label="Select all positions" onChange={(e) => setSel(e.target.checked ? new Set(adjs.map((a) => a.id)) : new Set())} />Select all</label><small className="t3">to change several positions at once</small></div>}
      {picked.length > 0 && <div className="sel-all"><label className="check"><input type="checkbox" checked={all} aria-label="Select all positions" onChange={(e) => setSel(e.target.checked ? new Set(adjs.map((a) => a.id)) : new Set())} />{all ? 'All selected' : 'Select all'}</label></div>}
      <div role="table" aria-label="Scenario positions" className="builder">
        {adjs.length > 0 && <div className="brow brow-sel brow-h" role="row">
          <span role="columnheader"><span className="sr-only">Select</span></span>
          <span role="columnheader">Position</span><span role="columnheader" className="r">Current</span><span role="columnheader">Target ({SIZE_LABEL[mode]})</span><span role="columnheader">Trade</span>
          <span role="columnheader">Assumed price</span><span role="columnheader" className="r">Notional</span><span role="columnheader" className="r">Est. fee</span><span role="columnheader"><span className="sr-only">Remove</span></span></div>}
        {adjs.map((a, k) => <PositionRow key={`${a.id}:${mode}`} a={a} start={start.holdings[a.id]} after={S.holdings[a.id]} sim={S} error={S.errors[a.id]} mode={mode}
          selected={sel.has(a.id)} onSelect={(on) => toggle(a.id, on)}
          onChange={(next) => onAdjs((list) => list.map((x, i) => (i === k ? next : x)))} onRemove={() => onAdjs((list) => list.filter((_, i) => i !== k))} />)}
      </div>
      {adjs.length === 0 && <div className="empty" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
        <p>{baseline === 'scratch' ? 'An empty portfolio. Add markets and size them with this scenario’s capital.' : 'No changes yet: this scenario equals your current portfolio.'}</p>
        <Button size="sm" variant="primary" icon="plus" onClick={onAdd}>Add markets…</Button></div>}
    </Card>
  )
}

const Line = ({ l, v, tone, sub }: { l: ReactNode; v: ReactNode; tone?: string; sub?: boolean }) => <div className={cx('bs-line', sub && 'sub')}><span>{l}</span><span className={cx('r', tone)}>{v}</span></div>

/** Live cash and value summary beside the positions. Each figure has one definition, shared with Analyze. */
export function BuildSummary({ E, onAnalyze, onCover }: { E: Evaluation; onAnalyze: () => void; onCover?: (p: Platform, amount: number) => void }) {
  const { start, sim: S, A, B } = E
  const plats = (['pm', 'ks'] as Platform[]).filter((p) => start.cash[p] !== 0 || S.cash[p] !== 0 || Object.values(S.holdings).some((h) => h.platform === p))
  const buys = Object.values(S.trades).reduce((s, t) => s + (t.qty > 0 ? t.qty * t.price : 0), 0)
  const sells = Object.values(S.trades).reduce((s, t) => s + (t.qty < 0 ? -t.qty * t.price : 0), 0)
  const dv = A.totalValue != null && B.totalValue != null ? A.totalValue - B.totalValue : null
  return (
    <Card id="build-summary" className="build-summary">
      <CardHeader title="Cash & value" sub="Updates as you type" />
      <div className="card-b bs">
        <Line l="Starting cash" v={fmt(B.cash, 2)} />
        {E.funding > 0 && <Line sub l="incl. added capital" v={fmt(E.funding)} />}
        <Line l="Purchases" v={buys ? `−${fmt(buys, 2)}` : '$0'} />
        <Line l="Sales" v={sells ? `+${fmt(sells, 2)}` : '$0'} />
        <Line l={<>Est. fees{A.feesUnavailable ? <span className="stale"> + {A.feesUnavailable} unavailable</span> : null}</>} v={A.fees ? `−${fmt(A.fees, 2)}` : '$0'} />
        <Line l={<b>Cash after trades</b>} v={<b>{fmt(A.cash, 2)}</b>} tone={A.cash < -0.005 ? 'loss' : undefined} />
        {plats.length > 1 && plats.map((p) => <Line key={p} sub l={PLATFORM_NAME[p]} v={fmt(S.cash[p], 2)} tone={S.cash[p] < -0.005 ? 'loss' : undefined} />)}
        {A.shortfall > 0 && <div className="bs-warn" role="status"><Icon name="alert" size={14} /><span><b>Funding shortfall.</b> Needs {fmt(A.shortfall, 2)} more on {plats.filter((p) => S.shortfall[p] > 0).map((p) => PLATFORM_NAME[p]).join(' and ')}. Results are shown as if funded. Cash isn’t moved between platforms and nothing is borrowed.
          {onCover && <span className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>{plats.filter((p) => S.shortfall[p] > 0).map((p) => <Button key={p} size="sm" onClick={() => onCover(p, Math.ceil(S.shortfall[p]))}>Add {fmt(Math.ceil(S.shortfall[p]))} virtual capital on {PLATFORM_NAME[p]}</Button>)}</span>}</span></div>}
        <div className="bs-sep" />
        <Line l={<>Value at reference marks <InfoTip text="Cash + positions × reference price. A trade at your assumed price changes it only by the gap to the mark and fees." /></>} v={A.totalValue == null ? 'Unavailable' : fmt(A.totalValue)} />
        <Line sub l="change from start" v={dv == null ? 'n/a' : Math.abs(dv) < 0.5 ? '—' : sfmt(dv)} tone={dv == null || Math.abs(dv) < 0.5 ? undefined : dv > 0 ? 'gain' : 'loss'} />
        <Line l="Settlement range" v={A.worstValue == null || A.bestValue == null ? 'Unavailable' : `${fmt(A.worstValue)} – ${fmt(A.bestValue)}`} />
        <Button size="sm" icon="compare" onClick={onAnalyze}>Analyze this scenario</Button>
      </div>
    </Card>
  )
}

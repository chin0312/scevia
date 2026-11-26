/* Scenario setup. Essentials (starting portfolio, added capital) sit at the top of Build; less frequent assumptions
   (fees, hypothetical settlement constraints) and the methodology live in a drawer, summarized in one line. */
import { useEffect, useState } from 'react'
import { Drawer } from '../../components/overlays'
import { Button, Card, Chip, PlatformBadge, Seg, cx } from '../../components/ui'
import { PLATFORM_NAME } from '../../data/labels'
import { PROVENANCE_TEXT, REL_TEXT } from '../../data/relations'
import type { Platform } from '../../data/types'
import { MAX_FUNDING, fmtDate, validFunding, type Baseline, type Constraint } from '../../lib/finance'
import { DEFAULT_ASSET } from '../../lib/replay'
import { DEFAULT_FEES, MAX_CUSTOM_FEE_PCT, feeLabel, validFeePct, type FeeAssumption } from '../../lib/fees'
import { fmt } from '../../lib/format'
import { parseMoney, parsePct } from '../../lib/inputs'
import type { Scenario } from '../../lib/scenarios'
import { eventsIn, type Evaluation } from './model'
import { accountName } from '../../lib/useWorkspace'
import { useFinance } from '../../lib/financeContext'

type Patch = Partial<Pick<Scenario, 'baseline' | 'funding' | 'assumptions'>>

/** The one-line summary of a scenario's assumptions, with the editor one click away. */
export function AssumptionsBar({ s, E, onEdit, onCheckPrices }: { s: Scenario; E: Evaluation; onEdit: () => void; onCheckPrices?: () => void }) {
  const fees = s.assumptions.fees ?? DEFAULT_FEES, cs = s.assumptions.constraints ?? []
  return (
    <div className="assume-bar" role="group" aria-label="Scenario assumptions">
      <span><span className="t3">Starts from</span> {s.baseline === 'scratch' ? 'empty portfolio' : 'current portfolio'}</span>
      <span><span className="t3">Added capital</span> {E.funding ? fmt(E.funding) : 'none'}</span>
      <span><span className="t3">Fees</span> {feeLabel(fees).toLowerCase()}</span>
      <span><span className="t3">Constraints</span> {cs.length ? `${cs.length} hypothetical` : 'none'}</span>
      <span><span className="t3">References</span> frozen{s.baseAsOf ? ` ${fmtDate(s.baseAsOf)}` : ' when added'}{onCheckPrices && <> · <button type="button" className="link" onClick={onCheckPrices}>Check latest</button></>}</span>
      <span><span className="t3">Execution</span> your assumed prices</span>
      <button type="button" className="link" onClick={onEdit}>Edit assumptions</button>
    </div>
  )
}

/** Essentials at the top of Build. */
export function StartSetup({ s, E, canPortfolio = true, onChange, onBaseline }: { s: Scenario; E: Evaluation; canPortfolio?: boolean; onChange: (p: Patch) => void; onBaseline: (b: Baseline) => void }) {
  const { accountsOn } = useFinance()
  const heldRows = s.adjs.filter((a) => !a.instrument).length
  return (
    <Card id="setup">
      <div className="card-b start-setup">
        <fieldset className="setup-f"><legend className="l">Starting portfolio</legend>
          <Seg label="Starting portfolio" options={['Current portfolio', 'Empty portfolio'] as const} value={s.baseline === 'scratch' ? 'Empty portfolio' : 'Current portfolio'} disabled={(o) => (o === 'Current portfolio' && !canPortfolio && s.baseline === 'scratch' ? 'No portfolio data to start from in the selected portfolio' : null)} onChange={(v) => onBaseline(v === 'Empty portfolio' ? 'scratch' : 'portfolio')} />
          <small className="t3">{s.baseline === 'scratch' ? 'No holdings, cash or history.' : `Your holdings and cash · ${fmt(E.B.totalValue ?? 0)} at marks${E.funding ? ' incl. added capital' : ''}.`}{heldRows > 0 && s.baseline === 'scratch' ? ` ${heldRows} older position${heldRows > 1 ? 's' : ''} can’t be used from scratch.` : ''}</small>
        </fieldset>
        <fieldset className="setup-f"><legend className="l">{s.baseline === 'scratch' ? 'Virtual starting capital' : 'Additional virtual capital'} <span className="t3">(by venue · simulated, not profit)</span></legend>
          <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {(['pm', 'ks'] as Platform[]).map((p) => <FundingInput key={p} p={p} value={s.funding[p]} onChange={(v) => onChange({ funding: { ...s.funding, [p]: v } })} />)}
          </div>
          <small className="t3">Simulated capital in each venue’s virtual funding{s.baseline === 'portfolio' ? <> ({(['pm', 'ks'] as Platform[]).map((p) => `${PLATFORM_NAME[p]} · ${accountsOn(p)[0] ? accountName(accountsOn(p)[0].id, accountsOn(p)) : `virtual ${DEFAULT_ASSET[p]}`}`).join(' and ')})</> : ''}. No account or deposit is needed. It raises cash and the starting value, is never a gain, and isn’t moved between venues.</small>
        </fieldset>
      </div>
    </Card>
  )
}

export function AssumptionsDrawer({ s, E, onChange, onClose }: { s: Scenario; E: Evaluation; onChange: (p: Patch) => void; onClose: () => void }) {
  return (
    <Drawer title="Scenario assumptions" sub={`${s.name} · apply to this scenario only`} onClose={onClose}>
      <FeeSetup value={s.assumptions.fees ?? DEFAULT_FEES} onChange={(fees) => onChange({ assumptions: { ...s.assumptions, fees } })} />
      <Constraints s={s} E={E} onChange={(constraints) => onChange({ assumptions: { ...s.assumptions, constraints: constraints.length ? constraints : undefined } })} />
      <Methodology baseline={s.baseline} />
    </Drawer>
  )
}

/** Fee treatment for this scenario's hypothetical trades. Every option changes the calculation. */
function FeeSetup({ value, onChange }: { value: FeeAssumption; onChange: (v: FeeAssumption) => void }) {
  const [pctText, setPctText] = useState(value.mode === 'custom' && Number.isFinite(value.pct) ? String(value.pct) : '')
  const parsed = parsePct(pctText)
  const mode = value.mode === 'provider' ? 'Provider estimate' : value.mode === 'custom' ? 'Custom' : 'Excluded'
  const setPct = (t: string) => { setPctText(t); const p = parsePct(t); onChange({ mode: 'custom', pct: p.state === 'ok' ? p.value : Number.NaN }) }
  return (
    <fieldset className="setup-f drawer-sec"><legend className="l">Trading fees</legend>
      <Seg label="Trading fees" options={['Provider estimate', 'Custom', 'Excluded'] as const} value={mode}
        onChange={(v) => onChange(v === 'Excluded' ? { mode: 'excluded' } : v === 'Custom' ? { mode: 'custom', pct: parsed.state === 'ok' ? parsed.value : Number.NaN } : DEFAULT_FEES)} />
      {value.mode === 'provider' && <>
        <Seg label="Assumed order role" options={['Taker', 'Maker'] as const} value={value.role === 'maker' ? 'Maker' : 'Taker'} onChange={(v) => onChange({ mode: 'provider', role: v === 'Maker' ? 'maker' : 'taker' })} />
        <small className="t3">Uses each market’s fee parameters. Taker: your order fills against a resting one. Maker: your resting order is filled; most standard markets charge makers nothing. Markets without parameters show the fee as unavailable, never $0.</small>
      </>}
      {value.mode === 'custom' && <>
        <label className="fund"><input className="num-input" inputMode="decimal" aria-label="Custom fee, % of notional" placeholder="% of notional" value={pctText} aria-invalid={parsed.state === 'invalid' || (parsed.state === 'ok' && !validFeePct(parsed.value))} onChange={(e) => setPct(e.target.value)} /><span className="t3">% of notional</span></label>
        <small className={cx(!validFeePct(value.pct) ? 'loss' : 't3')}>{parsed.state === 'empty' ? 'Enter a percentage to apply to every trade in this scenario.' : parsed.state === 'partial' || parsed.state === 'invalid' ? parsed.message : !validFeePct(parsed.value) ? `Between 0 and ${MAX_CUSTOM_FEE_PCT}%.` : `Every hypothetical trade pays ${parsed.value}% of its notional (rounded up to the cent).`}</small>
      </>}
      {value.mode === 'excluded' && <small className="t3">Hypothetical trades are shown before any fees. Fees already paid on your holdings are unaffected.</small>}
    </fieldset>
  )
}

/** Optional hypothetical settlement constraints between events in this scenario. Verified source relationships apply
 *  automatically and can't be overridden here; a hypothetical constraint never changes Risk or other scenarios. */
function Constraints({ s, E, onChange }: { s: Scenario; E: Evaluation; onChange: (cs: Constraint[]) => void }) {
  const events = eventsIn(E.start, E.sim)
  const cs = s.assumptions.constraints ?? []
  const [a, setA] = useState(''), [b, setB] = useState(''), [cls, setCls] = useState<Constraint['cls']>('mutex')
  const title = (id: string) => events.find((e) => e.id === id)?.title ?? id
  const verified = E.rels.filter((r) => r.provenance === 'verified' && events.some((e) => e.id === r.a) && events.some((e) => e.id === r.b))
  const pairTaken = a && b && (cs.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a)) || verified.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a)))
  const stale = cs.filter((c) => !events.some((e) => e.id === c.a) || !events.some((e) => e.id === c.b))
  return (
    <fieldset className="setup-f drawer-sec"><legend className="l">Settlement constraints <span className="t3">(optional)</span></legend>
      <small className="t3">Say which joint outcomes can’t happen under the markets’ settlement rules. It changes this scenario’s best/worst cases only. It isn’t a correlation or a probability, and never changes Risk or other scenarios.</small>
      {verified.map((r) => <div className="list-row" key={`${r.a}-${r.b}`}><span>{title(r.a)} × {title(r.b)}</span><span className="r row"><Chip tone={REL_TEXT[r.cls].tone}>{REL_TEXT[r.cls].label}</Chip><small className="t3">{PROVENANCE_TEXT.verified}</small></span></div>)}
      {cs.map((c, i) => (
        <div className="list-row" key={`${c.a}-${c.b}`}><span>{title(c.a)} × {title(c.b)}{stale.includes(c) && <small className="stale"> · not in this portfolio, no effect</small>}</span>
          <span className="r row"><Chip tone={REL_TEXT[c.cls].tone}>{REL_TEXT[c.cls].label}</Chip><small className="t3">{PROVENANCE_TEXT.hypothetical}</small>
            <button type="button" className="link" onClick={() => onChange(cs.filter((_, k) => k !== i))} aria-label={`Remove constraint ${title(c.a)} × ${title(c.b)}`}>Remove</button></span></div>
      ))}
      {!cs.length && !verified.length && <small className="t3">None: every combination of different events is possible.</small>}
      {events.length < 2 ? <small className="t3">Needs at least two events in this scenario.</small> : (
        <div className="adv-add">
          <select className="select" aria-label="Constraint: first event" value={a} onChange={(e) => setA(e.target.value)}><option value="">First event…</option>{events.filter((e) => e.id !== b).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select>
          <select className="select" aria-label="Constraint: type" value={cls} onChange={(e) => setCls(e.target.value as Constraint['cls'])}>
            <option value="mutex">can’t both resolve YES</option><option value="equivalent">always resolve the same way</option></select>
          <select className="select" aria-label="Constraint: second event" value={b} onChange={(e) => setB(e.target.value)}><option value="">Second event…</option>{events.filter((e) => e.id !== a).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}</select>
          <Button size="sm" disabled={!a || !b || !!pairTaken} title={pairTaken ? 'This pair already has a relationship' : undefined} onClick={() => { onChange([...cs, { a, b, cls }]); setA(''); setB('') }}>Add constraint</Button>
          {pairTaken && <small className="t3">This pair already has a relationship.</small>}
        </div>
      )}
    </fieldset>
  )
}

function Methodology({ baseline }: { baseline: Baseline }) {
  return (
    <details className="adv drawer-sec">
      <summary><span>Methodology</span><span className="t3">how results are calculated</span></summary>
      <div className="adv-b t2 method">
        <p>Contracts settle at $1 or $0. Your assumed price applies to the whole quantity; slippage and order-book depth aren’t modelled. Quantities use a 0.01-share step; venue lot sizes aren’t enforced.</p>
        <p>Cost basis is a weighted average including acquisition fees; sale proceeds are after fees. Cash stays on its venue. Added capital is contributed capital, never a gain.</p>
        <p>Provider fee estimates follow each market’s parameters (Polymarket: rate × p × (1 − p), takers; Kalshi: 0.07 × p × (1 − p), rounded up to the cent). In this build the parameters are sample values.</p>
        <p>{baseline === 'portfolio' ? 'Starts from the sample portfolio’s holdings and cash at their reference marks.' : 'Starts empty: no holdings, cash or history from your accounts.'} Best and worst cases enumerate every feasible joint outcome (up to 16 events); none is weighted by likelihood.</p>
      </div>
    </details>
  )
}

function FundingInput({ p, value, onChange }: { p: Platform; value?: number; onChange: (v: number | undefined) => void }) {
  const { accountsOn } = useFinance()
  const [text, setText] = useState(value == null || !Number.isFinite(value) ? '' : String(value))
  const parsed = parseMoney(text)
  useEffect(() => { const cur = parseMoney(text); if ((cur.state === 'ok' ? cur.value : undefined) !== value && !(value != null && !Number.isFinite(value))) setText(value == null ? '' : String(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  const invalid = parsed.state === 'invalid' || (value != null && !validFunding(value))
  const acct = accountsOn(p)
  return (
    <label className={cx('fund', invalid && 'has-error')} title={acct.length === 1 ? `${PLATFORM_NAME[p]} · ${accountName(acct[0].id)}` : undefined}><PlatformBadge p={p} size={18} />
      <span className="sr-only">Added capital on {PLATFORM_NAME[p]}</span>
      <input className="num-input" inputMode="decimal" placeholder={`${PLATFORM_NAME[p]} ${DEFAULT_ASSET[p]}`} aria-label={`Added capital on ${PLATFORM_NAME[p]}`} aria-invalid={invalid} value={text}
        onChange={(e) => { const t = e.target.value; setText(t); const r = parseMoney(t); onChange(r.state === 'empty' ? undefined : r.state === 'ok' ? r.value : Number.NaN) }} />
      {invalid && <span role="alert" className="loss" style={{ fontSize: 'var(--font-size-xs)' }}>{parsed.state === 'invalid' ? parsed.message : `0–${fmt(MAX_FUNDING)}`}</span>}
    </label>
  )
}
export { FundingInput }

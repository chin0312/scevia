/* Scenario Lab › Compare: the scenarios the user picks, side by side. Each scenario is measured against its own
   starting point, so a $10,000 scratch portfolio isn't "worse" than an inherited $50,000 one because it is smaller.
   Normalized views are shown only where the denominator (the scenario's own starting value) is positive. */
import { useState } from 'react'
import { Callout, Card, CardHeader, Seg, cx } from '../../components/ui'
import { CAT_COLOR, PLATFORM_NAME } from '../../data/labels'
import type { Category, Platform } from '../../data/types'
import { fmtDate, holdingsAllocation } from '../../lib/finance'
import { feeLabel } from '../../lib/fees'
import { fmt, pct, sfmt } from '../../lib/format'
import * as SC from '../../lib/scenarios'
import type { Scenario } from '../../lib/scenarios'
import { RangeRows, StackBars, type StackSeg } from './charts'
import { ROWS, judge, rowValue, type Evaluation, type Row } from './model'

type Basis = 'Absolute' | 'Change from start' | '% of own start'
const MAX_PICK = 5

const fundingText = (s: Scenario) => (['pm', 'ks'] as Platform[]).filter((p) => (s.funding[p] ?? 0) > 0).map((p) => `${PLATFORM_NAME[p]} ${fmt(s.funding[p]!)}`).join(', ') || 'None'
/** Everything that makes two scenarios' starting assumptions different (not just total capital). */
export const assumptionKey = (s: Scenario, e: Evaluation) => JSON.stringify([s.baseline, s.funding.pm ?? 0, s.funding.ks ?? 0, e.fees, e.constraints.map((c) => `${c.a}|${c.b}|${c.cls}`).sort(), s.baseline === 'portfolio' ? s.baseAsOf ?? null : null])

export function CompareView({ scenarios, evals, actual, activeKey, onOpen }: { scenarios: Scenario[]; evals: Record<string, Evaluation>; actual: Evaluation; activeKey: string; onOpen: (k: string) => void }) {
  const [picked, setPicked] = useState<string[]>(() => [activeKey, ...scenarios.map((s) => s.key).filter((k) => k !== activeKey)].filter((k) => scenarios.some((s) => s.key === k)).slice(0, 4))
  const [withActual, setWithActual] = useState(true)
  const [basis, setBasis] = useState<Basis>('Absolute')
  const list = scenarios.filter((s) => picked.includes(s.key))
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : p.length >= MAX_PICK ? p : [...p, k]))
  const differs = list.length > 1 && new Set(list.map((s) => assumptionKey(s, evals[s.key]))).size > 1
  if (scenarios.length === 0) return <Card id="c-pick"><div className="empty"><p>No scenarios yet. Create one to compare it with your current portfolio.</p></div></Card>

  const norm = (v: number | null, e: Evaluation) => {
    const s0 = e.B.totalValue
    if (v == null) return null
    if (basis === 'Absolute') return v
    if (s0 == null) return null
    if (basis === 'Change from start') return v - s0
    return s0 > 0 ? ((v - s0) / s0) * 100 : null
  }
  const fmtN = (v: number) => (basis === '% of own start' ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%` : basis === 'Absolute' ? fmt(v) : sfmt(v))
  const entries = [...(withActual ? [{ key: 'actual', name: 'Current portfolio', color: 'var(--color-text-tertiary)', e: actual, s: null as Scenario | null }] : []), ...list.map((s) => ({ key: s.key, name: s.name, color: s.color, e: evals[s.key], s }))]
  const legendName = (x: (typeof entries)[number]) => <tspan><tspan style={{ fill: x.color }}>● </tspan>{x.name.length > 22 ? `${x.name.slice(0, 21)}…` : x.name}</tspan>
  return (<>
    <Card id="c-pick">
      <CardHeader title="Scenarios to compare" sub={`Pick up to ${MAX_PICK}. Each is measured against its own starting point.`}
        right={<Seg label="Comparison basis" options={['Absolute', 'Change from start', '% of own start'] as const} value={basis} onChange={setBasis} />} />
      <div className="card-b cmp-pick">
        <label className={cx('pick-chip', withActual && 'on')}><input type="checkbox" checked={withActual} onChange={(e) => setWithActual(e.target.checked)} /><i style={{ background: 'var(--color-text-tertiary)' }} />Current portfolio <small>actual</small></label>
        {scenarios.map((s) => {
          const on = picked.includes(s.key), e = evals[s.key]
          return (
            <label key={s.key} className={cx('pick-chip', on && 'on')} title={!on && picked.length >= MAX_PICK ? `Up to ${MAX_PICK} at a time` : undefined}>
              <input type="checkbox" checked={on} disabled={!on && picked.length >= MAX_PICK} onChange={() => toggle(s.key)} aria-label={`Compare ${s.name}`} />
              <i style={{ background: s.color }} />{s.name}<small>{s.adjs.length} position{s.adjs.length === 1 ? '' : 's'}{Object.keys(e.sim.errors).length ? ', incomplete' : ''}</small>
            </label>
          )
        })}
      </div>
      {differs && <div className="cmp-note"><Callout icon="info">These scenarios start from different portfolios, capital, funding venues or assumptions. Compare their <b>change from start</b> or <b>% of own start</b>; a larger absolute value can simply mean more starting capital.</Callout></div>}
    </Card>

    <div className="grid g-lab anchor" id="c-charts">
      <Card id="c-range">
        <CardHeader title="Settlement range" sub={basis === 'Absolute' ? 'Range from worst to best value. The tick is the value at reference prices' : basis === 'Change from start' ? 'Worst → best feasible value minus each scenario’s own starting value' : 'Worst → best feasible value as a change in % of each scenario’s own starting value'} />
        <div className="card-b">
          <RangeRows label="Settlement range by scenario" rows={entries.map((x) => {
            const lo = norm(x.e.A.worstValue, x.e), hi = norm(x.e.A.bestValue, x.e), ref = norm(x.e.A.totalValue, x.e)
            return { key: x.key, label: legendName(x), text: `${x.name}: ${lo == null || hi == null ? 'unavailable' : `${fmtN(lo)} to ${fmtN(hi)}`}`, lo, hi, ref, color: x.color }
          })} />
          {basis === '% of own start' && entries.some((x) => x.e.B.totalValue == null || x.e.B.totalValue <= 0) && <p className="t3 chart-note">% is unavailable for a scenario whose starting value is zero or unknown (an empty portfolio with no added capital).</p>}
          <p className="t3 chart-note">Ranges aren’t distributions and aren’t weighted by likelihood. Constraints apply only to their own scenario.</p>
        </div>
      </Card>
      <Card id="c-deploy">
        <CardHeader title="Capital deployment" sub="Scenario value at reference marks: positions vs. cash" />
        <div className="card-b">
          <StackBars label="Positions and cash by scenario" rows={entries.map((x) => {
            const pv = x.e.A.positionsValue, cash = x.e.A.cash
            const segs: StackSeg[] | null = pv == null ? null : [{ key: 'pos', label: 'Positions', value: pv, color: x.color }, { key: 'cash', label: 'Cash', value: Math.max(0, cash), color: 'var(--color-border-strong)' }]
            return { key: x.key, label: <span className="row"><i className="sw" style={{ background: x.color }} />{x.name}</span>, segs, total: pv == null ? null : pv + Math.max(0, cash), note: x.e.A.shortfall > 0 ? <span className="stale">needs {fmt(x.e.A.shortfall)} funding</span> : x.e.A.fees ? `fees ${fmt(x.e.A.fees, 2)}${x.e.A.feesUnavailable ? ' + n/a' : ''}` : undefined }
          })} />
        </div>
      </Card>
      <Card id="c-alloc" className="span-all">
        <CardHeader title="Allocation by category" sub="% of open-position value at reference marks" />
        <div className="card-b">
          <StackBars label="Category allocation by scenario" rows={entries.map((x) => {
            const a = holdingsAllocation(Object.values(x.e.sim.holdings), 'category')
            return { key: x.key, label: <span className="row"><i className="sw" style={{ background: x.color }} />{x.name}</span>, segs: a.total == null ? null : a.segments.map((s) => ({ key: s.key, label: s.label, value: s.value, color: CAT_COLOR[s.key as Category] })), total: a.total }
          })} />
          <div className="legend chart-note">{(Object.keys(CAT_COLOR) as Category[]).map((c) => <span key={c}><i style={{ background: CAT_COLOR[c] }} />{c}</span>)}</div>
        </div>
      </Card>
    </div>

    <Card id="c-table" flush>
      <CardHeader pad title="Detailed comparison" sub="Each value with its change from that scenario’s own start" />
      <div className="dt-wrap">
        <table className="dt cmp-table">
          <thead><tr>
            <th scope="col" className="sticky">Metric</th>
            {withActual && <th scope="col" className="r">Current portfolio<small>actual</small></th>}
            {list.map((s) => (
              <th scope="col" key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>
                <button type="button" className="col-btn" aria-pressed={s.key === activeKey} onClick={() => onOpen(s.key)}><i style={{ background: s.color }} />{s.name}</button>
                <small>{s.adjs.length} position{s.adjs.length === 1 ? '' : 's'}, {SC.statusLabel(s).toLowerCase()}{Object.keys(evals[s.key].sim.errors).length ? ', incomplete' : ''}</small>
              </th>
            ))}
          </tr></thead>
          <tbody>
            <Meta label="Starts from" actual="—" list={list} cell={(s) => (s.baseline === 'scratch' ? 'Empty portfolio' : `Current portfolio${s.baseAsOf ? ` (${fmtDate(s.baseAsOf)})` : ''}`)} withActual={withActual} activeKey={activeKey} />
            <Meta label="Added capital by venue" actual="—" list={list} cell={fundingText} withActual={withActual} activeKey={activeKey} />
            <Meta label="Starting value" actual={actual.B.totalValue == null ? 'Unavailable' : fmt(actual.B.totalValue)} list={list} cell={(s) => (evals[s.key].B.totalValue == null ? 'Unavailable' : fmt(evals[s.key].B.totalValue!))} withActual={withActual} activeKey={activeKey} />
            <Meta label="Fees" actual="—" list={list} cell={(s) => feeLabel(evals[s.key].fees)} withActual={withActual} activeKey={activeKey} />
            <Meta label="Hypothetical constraints" actual="None" list={list} cell={(s) => String(evals[s.key].constraints.length || 'None')} withActual={withActual} activeKey={activeKey} />
            {ROWS.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="sticky" style={{ fontWeight: 'var(--font-weight-regular)' }}>{r.label}</th>
                {withActual && <td className="r t2">{show(r, rowValue(r, actual.A, actual.sim), actual.A.feesUnavailable)}</td>}
                {list.map((s) => {
                  const e = evals[s.key], a = rowValue(r, e.A, e.sim), b = rowValue(r, e.B, e.start), { d, good } = judge(r, a, b)
                  return (
                    <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>
                      <span style={s.key === activeKey ? { fontWeight: 'var(--font-weight-semibold)' } : undefined}>{show(r, a, e.A.feesUnavailable)}</span>
                      <small className={cx(d == null || Math.abs(d) < 0.5 || good == null ? 't3' : good ? 'gain' : 'loss')}>{d == null ? 'change unavailable' : Math.abs(d) < 0.5 ? 'no change' : `${r.key === 'events' ? `${d > 0 ? '+' : '−'}${Math.abs(d)}` : sfmt(d)} vs. start`}</small>
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr><th scope="row" className="sticky" style={{ fontWeight: 'var(--font-weight-regular)' }}>Value change, % of own start</th>{withActual && <td className="r t2">—</td>}{list.map((s) => {
              const e = evals[s.key], s0 = e.B.totalValue, a = e.A.totalValue
              return <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>{s0 == null || a == null || s0 <= 0 ? <span className="t3">n/a</span> : pct(((a - s0) / s0) * 100, 2)}</td>
            })}</tr>
          </tbody>
        </table>
      </div>
      <div className="foot"><span>Changes exclude added capital: each scenario is measured against its own start. Green = better for you, red = worse, grey = a transfer or a count.</span><span>{list.length} of {scenarios.length} scenario{scenarios.length === 1 ? '' : 's'}</span></div>
    </Card>
  </>)
}

function Meta({ label, actual, list, cell, withActual, activeKey }: { label: string; actual: string; list: Scenario[]; cell: (s: Scenario) => string; withActual: boolean; activeKey: string }) {
  return <tr className="cmp-setup"><th scope="row" className="sticky">{label}</th>{withActual && <td className="r t2">{actual}</td>}{list.map((s) => <td key={s.key} className={cx('r', s.key === activeKey && 'is-active')}>{cell(s)}</td>)}</tr>
}

export function show(r: Row, v: number | null, feesUnavailable = 0) {
  if (v == null) return 'Unavailable'
  if (r.key === 'events') return String(v)
  if (r.key === 'largestEventLoss') return sfmt(v)
  if (r.key === 'fees') return `${Math.abs(v) < 0.005 ? '$0' : fmt(v, 2)}${feesUnavailable ? ' + unavailable' : ''}`
  if (r.key === 'realized') return Math.abs(v) < 0.005 ? '$0' : sfmt(v, 2)
  if (r.key === 'shortfall') return v < 0.005 ? 'None' : fmt(v, 2)
  return fmt(v)
}

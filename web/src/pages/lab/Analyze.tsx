/* Scenario Lab › Analyze: what the scenario changes, as visual answers backed by exact tables.
   Every chart compares the scenario with its own starting point (baseline + added capital). Allocation uses one
   denominator per view (stated on the chart); settlement ranges show worst and best feasible values without implying
   a midpoint or any probability. Unavailable values stay unavailable. */
import { useMemo, useState } from 'react'
import { InfoTip } from '../../components/overlays'
import { Button, Card, CardHeader, Chip, PlatformBadge, Seg, SideChip, cx } from '../../components/ui'
import { CAT_COLOR, PLATFORM_NAME } from '../../data/labels'
import type { Category, Platform } from '../../data/types'
import { MAX_JOINT_EVENTS, daysBetween, eventProfiles, fmtDate, holdingsAllocation, type AllocationBy, type EventProfile, type Holding } from '../../lib/finance'
import { fmt, pct, qty, sfmt } from '../../lib/format'
import { HELP } from '../../lib/help'
import { count } from '../../lib/text'
import { fmtPrice } from '../../lib/inputs'
import { PairBars, RangeRows, StackBars, Waterfall, type StackSeg } from './charts'
import { Dumbbell, OutcomeMatrix } from './Impact'
import type { Evaluation } from './model'
import { accountName } from '../../lib/useWorkspace'
import { useFinance } from '../../lib/financeContext'

const DATA = ['var(--color-data-1)', 'var(--color-data-2)', 'var(--color-data-3)', 'var(--color-data-4)', 'var(--color-data-5)', 'var(--color-data-6)']
const PLAT_COLOR: Record<Platform, string> = { pm: 'var(--color-data-1)', ks: 'var(--color-data-3)' }
const CASH_COLOR = 'var(--color-border-strong)'
const BY: Record<'Category' | 'Platform' | 'Event', AllocationBy> = { Category: 'category', Platform: 'platform', Event: 'event' }

export function AnalyzeView({ E, onEdit }: { E: Evaluation; onEdit: (id: string) => void }) {
  const { valueBridge } = useFinance()
  const { start, sim: S, A, B } = E
  const [focus, setFocus] = useState<{ by: AllocationBy; key: string; label: string } | null>(null)
  const bridge = useMemo(() => valueBridge(start, S, E.funding), [start, S, E.funding])
  const dv = A.totalValue != null && B.totalValue != null ? A.totalValue - B.totalValue : null
  const errs = Object.keys(S.errors).length
  return (<>
    {errs > 0 && <div className="callout warn"><span><b>{errs} position{errs > 1 ? 's are' : ' is'} incomplete or invalid</b> and left out of this analysis. <button type="button" className="link" onClick={() => onEdit(Object.keys(S.errors)[0])}>Fix in Build</button></span></div>}
    <section className="an-summary anchor" id="a-summary" aria-label="Scenario summary">
      <div className="an-primary">
        <div className="an-big">
          <div className="l">Value at reference marks <InfoTip text="Cash plus positions at reference prices. These are sample prices, not quotes. Trades at your assumed price move value between cash and contracts. Only the gap to the mark and fees change it. Added capital is part of the start, never a gain." /></div>
          <div className="v">{A.totalValue == null ? 'Unavailable' : fmt(A.totalValue)}</div>
          <div className="f">{B.totalValue == null ? 'Start unavailable' : `Start ${fmt(B.totalValue)}`}, <span className={cx(dv == null || Math.abs(dv) < 0.5 ? 't3' : dv > 0 ? 'gain' : 'loss')}>{dv == null ? 'change unavailable' : Math.abs(dv) < 0.5 ? 'no change' : `${sfmt(dv)} from start`}</span></div>
        </div>
        <div className="an-big">
          <div className="l">Feasible settlement range <InfoTip text="Cash + $1 per winning share, in the worst and best joint outcome that verified relationships and this scenario’s constraints allow. Not a forecast: no outcome is weighted by likelihood." /></div>
          <div className="v">{A.worstValue == null || A.bestValue == null ? 'Unavailable' : <>{fmt(A.worstValue)} <span className="t3">to</span> {fmt(A.bestValue)}</>}</div>
          <div className="f">{B.worstValue == null || B.bestValue == null ? 'Start unavailable' : `Start ${fmt(B.worstValue)} to ${fmt(B.bestValue)}`}{A.rangeIssue === 'too-many-events' ? `. More than ${MAX_JOINT_EVENTS} events` : A.rangeIssue === 'no-feasible-outcome' ? '. The constraints leave no possible outcome' : ''}</div>
        </div>
      </div>
      <div className="an-secondary">
        <Mini l="Cash after trades" v={fmt(A.cash)} f={`start ${fmt(B.cash)}`} tone={A.cash < -0.005 ? 'loss' : undefined} />
        <Mini l="Capital committed" v={fmt(A.committed)} f={`start ${fmt(B.committed)}`} info="Cost basis of open positions, including acquisition fees." />
        <Mini l="Est. fees on trades" v={fmt(A.fees, 2)} f={A.feesUnavailable ? `+ ${A.feesUnavailable} unavailable` : 'hypothetical trades only'} tone={A.feesUnavailable ? 'warn' : undefined} />
        <Mini l="Funding required" v={A.shortfall > 0 ? fmt(A.shortfall, 2) : 'None'} f={A.shortfall > 0 ? 'beyond cash on its venue' : 'fits available cash'} tone={A.shortfall > 0 ? 'warn' : undefined} />
      </div>
    </section>

    <div className="grid g-lab anchor" id="a-value">
      <Card id="a-bridge">
        <CardHeader title="Value bridge" sub="From start to scenario value at reference prices" info={HELP.valueBridge} />
        <div className="card-b">{bridge == null ? <p className="t3">Unavailable: a position has no reference price, so value at mark can’t be computed.</p> : (<>
          <Waterfall label="Value bridge" steps={[
            { label: 'Start', value: bridge.before, kind: 'total' },
            { label: 'Added capital', value: bridge.added, kind: 'step', note: 'contributed', muted: !bridge.added },
            { label: 'Price vs. mark', value: bridge.execution, kind: 'step', note: 'your prices', muted: Math.abs(bridge.execution) < 0.005 },
            { label: 'Est. fees', value: -bridge.fees, kind: 'step', note: bridge.feesUnavailable ? '+ unavailable' : undefined, muted: !bridge.fees },
            { label: 'Scenario', value: bridge.after, kind: 'total' },
          ]} />
          {bridge.feesUnavailable > 0 && <p className="t3 chart-note stale">{count(bridge.feesUnavailable, 'trade fee')} unavailable and not included.</p>}
        </>)}</div>
      </Card>
      <Card id="a-range">
        <CardHeader title="Settlement range" sub="Worst and best value at settlement, before and after" info={HELP.settlementRange} />
        <div className="card-b">
          <RangeRows label="Settlement range" rows={[
            { key: 'b', label: 'Start', text: rangeText('Start', B.worstValue, B.bestValue), lo: B.worstValue, hi: B.bestValue, ref: B.totalValue, color: 'var(--color-text-tertiary)' },
            { key: 'a', label: 'Scenario', text: rangeText('Scenario', A.worstValue, A.bestValue), lo: A.worstValue, hi: A.bestValue, ref: A.totalValue, color: 'var(--color-accent-solid)' },
          ]} />
          <div className="dt-wrap range-tbl"><table className="dt">
            <thead><tr><th scope="col" /><th scope="col" className="r">Worst feasible</th><th scope="col" className="r">At reference marks</th><th scope="col" className="r">Best feasible</th></tr></thead>
            <tbody>{([['Start', B], ['Scenario', A]] as const).map(([l, m]) => <tr key={l}><th scope="row">{l}</th><td className="r">{m.worstValue == null ? 'Unavailable' : fmt(m.worstValue)}</td><td className="r">{m.totalValue == null ? 'Unavailable' : fmt(m.totalValue)}</td><td className="r">{m.bestValue == null ? 'Unavailable' : fmt(m.bestValue)}</td></tr>)}</tbody>
          </table></div>
          <div className="legend chart-note"><span><i style={{ background: 'var(--color-accent-solid)' }} />worst ○ to ● best</span><span><i className="ln" style={{ background: 'var(--color-text-primary)' }} />value at reference marks</span></div>
          {A.excluded > 0 && <p className="t3 chart-note">{count(A.excluded, 'impossible joint outcome')} excluded by constraints.</p>}
        </div>
      </Card>
    </div>

    <Allocation E={E} focus={focus} onFocus={setFocus} />

    <div className="grid g-lab anchor" id="a-events">
      <Exposure E={E} onFocus={(ev) => setFocus(ev ? { by: 'event', key: ev.id, label: ev.title } : null)} />
      <Timeline E={E} />
    </div>

    <div className="grid g-lab anchor" id="a-settle">
      <Card id="matrix">
        <CardHeader title="Outcome matrix" sub="Settlement P&L of two events’ positions in each joint outcome" />
        <div className="card-b"><OutcomeMatrix start={start} after={S} rels={E.rels} /></div>
      </Card>
      <Card id="payoff">
        <CardHeader title="Payoff by event" sub="Settlement P&L by outcome for each event this scenario changes" />
        <div className="card-b"><Dumbbell eventIds={[...new Set(Object.keys(S.trades).map((id) => S.holdings[id]?.eventId).filter((x): x is string => !!x))]} start={start} after={S} /></div>
      </Card>
    </div>

    <PositionDetail E={E} focus={focus} onClear={() => setFocus(null)} onEdit={onEdit} />
  </>)
}

const rangeText = (l: string, lo: number | null, hi: number | null) => `${l}: ${lo == null || hi == null ? 'unavailable' : `${fmt(lo)} to ${fmt(hi)}`}`
function Mini({ l, v, f, tone, info }: { l: string; v: string; f: string; tone?: 'loss' | 'warn'; info?: string }) {
  return <div className="an-mini"><div className="l">{l}{info && <InfoTip text={info} />}</div><div className={cx('v', tone === 'loss' && 'loss', tone === 'warn' && 'warn-fg')}>{v}</div><div className="f">{f}</div></div>
}

/* ── Allocation before / after ───────────────────────────── */
function segsOf(hs: Holding[], by: AllocationBy, withCash: number | null) {
  const a = holdingsAllocation(hs, by)
  if (a.total == null) return { segs: null, total: null }
  const segs: StackSeg[] = a.segments.map((s, i) => ({ key: s.key, label: s.label, value: s.value, color: by === 'category' ? CAT_COLOR[s.key as Category] : by === 'platform' ? PLAT_COLOR[s.key as Platform] : DATA[i % DATA.length] }))
  if (withCash != null) segs.push({ key: 'cash', label: 'Cash', value: Math.max(0, withCash), color: CASH_COLOR })
  return { segs, total: a.total + (withCash != null ? Math.max(0, withCash) : 0) }
}
function Allocation({ E, focus, onFocus }: { E: Evaluation; focus: { key: string } | null; onFocus: (f: { by: AllocationBy; key: string; label: string } | null) => void }) {
  const { start, sim: S } = E
  const [by, setBy] = useState<'Category' | 'Platform' | 'Event'>('Category')
  const [basis, setBasis] = useState<'Open positions' | 'Incl. cash'>('Open positions')
  const cashB = start.cash.pm + start.cash.ks, cashA = S.cash.pm + S.cash.ks
  const withCash = basis === 'Incl. cash', negCash = withCash && (cashA < -0.005 || cashB < -0.005)
  const b = segsOf(Object.values(start.holdings), BY[by], withCash ? cashB : null), a = segsOf(Object.values(S.holdings), BY[by], withCash ? cashA : null)
  const keys = [...new Set([...(b.segs ?? []), ...(a.segs ?? [])].map((s) => s.key))]
  const rows = keys.map((k) => {
    const x = b.segs?.find((s) => s.key === k), y = a.segs?.find((s) => s.key === k)
    return { key: k, label: (y ?? x)!.label, color: (y ?? x)!.color, bv: x?.value ?? 0, av: y?.value ?? 0, bs: b.total ? (x?.value ?? 0) / b.total : null, as: a.total ? (y?.value ?? 0) / a.total : null, status: !x?.value ? 'new' : !y?.value ? 'exited' : null }
  }).sort((p, q) => q.av - p.av || q.bv - p.bv)
  const top = (r: typeof rows) => r.filter((x) => x.key !== 'cash').reduce((m, x) => Math.max(m, x.as ?? 0), 0)
  const topB = rows.filter((x) => x.key !== 'cash').reduce((m, x) => Math.max(m, x.bs ?? 0), 0)
  return (
    <Card id="a-alloc">
      <CardHeader title="Allocation" sub={withCash ? '% of total value at reference marks (cash + positions)' : '% of open-position value at reference marks (cash excluded)'}
        info="Market-value allocation at reference marks. It differs from capital committed (cost) and from settlement exposure, and a more even allocation isn’t necessarily less risk."
        right={<div className="row" style={{ flexWrap: 'wrap' }}><Seg label="Allocation basis" options={['Open positions', 'Incl. cash'] as const} value={basis} onChange={setBasis} /><Seg label="Allocation by" options={['Category', 'Platform', 'Event'] as const} value={by} onChange={(v) => { setBy(v); onFocus(null) }} /></div>} />
      <div className="card-b">
        {negCash ? <p className="t3">Cash-inclusive allocation is unavailable: purchases exceed cash (a funding requirement), so there is no positive cash share. Use “Open positions”.</p> : (<>
          <StackBars label="Allocation before and after" selected={focus?.key ?? null} onSelect={(k) => onFocus(k && k !== 'cash' ? { by: BY[by], key: k, label: rows.find((r) => r.key === k)?.label ?? k } : null)}
            rows={[{ key: 'b', label: 'Start', segs: b.segs, total: b.total, note: b.total != null ? fmt(b.total) : undefined }, { key: 'a', label: 'Scenario', segs: a.segs, total: a.total, note: a.total != null ? fmt(a.total) : undefined }]} />
          {b.segs && a.segs && rows.length > 0 && (
            <div className="dt-wrap"><table className="dt alloc-impact">
              <thead><tr><th scope="col">{by}</th><th scope="col" className="r">Start</th><th scope="col" className="r">%</th><th scope="col" className="r">Scenario</th><th scope="col" className="r">%</th><th scope="col" className="r">Change</th></tr></thead>
              <tbody>{rows.map((r) => {
                const d = r.as != null && r.bs != null ? r.as - r.bs : null
                return (
                  <tr key={r.key} className={cx(focus?.key === r.key && 'sel')}>
                    <td>{r.key === 'cash' ? <span className="row"><i className="sw" style={{ background: r.color }} />Cash</span> : <button type="button" className="al-btn row" aria-pressed={focus?.key === r.key} onClick={() => onFocus(focus?.key === r.key ? null : { by: BY[by], key: r.key, label: r.label })}><i className="sw" style={{ background: r.color }} />{r.label}{r.status === 'new' && <Chip tone="accent">New</Chip>}{r.status === 'exited' && <Chip>Exited</Chip>}</button>}</td>
                    <td className="r t2">{r.bv ? fmt(r.bv) : '—'}</td><td className="r t3">{r.bs == null ? '—' : pct(r.bs * 100, 0)}</td>
                    <td className="r">{r.av ? fmt(r.av) : '—'}</td><td className="r">{r.as == null ? '—' : pct(r.as * 100, 0)}</td>
                    <td className={cx('r', d == null || Math.abs(d) < 0.0005 ? 't3' : 't2')}>{d == null ? '—' : Math.abs(d) < 0.0005 ? '0 pts' : `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)} pts`}</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          )}
          {a.segs && b.segs && <p className="t3 chart-note">Largest {by.toLowerCase()}{basis === 'Incl. cash' ? ' (excluding cash)' : ''}: {b.total ? pct(topB * 100, 0) : 'nothing held'} at the start → {a.total ? pct(top(rows) * 100, 0) : 'nothing held'} in the scenario.</p>}
        </>)}
        {(b.segs == null || a.segs == null) && !negCash && <p className="t3">Allocation is unavailable: a position has no reference price, so its market value is unknown.</p>}
      </div>
    </Card>
  )
}

/* ── Event exposure ──────────────────────────────────────── */
function Exposure({ E, onFocus }: { E: Evaluation; onFocus: (e: EventProfile | null) => void }) {
  const [metric, setMetric] = useState<'Worst settlement' | 'Committed'>('Worst settlement')
  const before = eventProfiles(E.start), after = eventProfiles(E.sim)
  const ids = [...new Set([...after.map((e) => e.id), ...before.map((e) => e.id)])]
  const get = (xs: EventProfile[], id: string) => xs.find((x) => x.id === id) ?? null
  const val = (e: EventProfile | null) => (e == null ? 0 : metric === 'Committed' ? e.cost : e.worst)
  const rows = ids.map((id) => ({ id, b: get(before, id), a: get(after, id) }))
    .sort((p, q) => (metric === 'Committed' ? val(q.a) - val(p.a) : val(p.a) - val(q.a))).slice(0, 10)
  const total = after.reduce((s, e) => s + e.cost, 0), largest = [...after].sort((p, q) => q.cost - p.cost)[0]
  const worstOne = [...after].sort((p, q) => p.worst - q.worst)[0]
  return (
    <Card id="a-exposure">
      <CardHeader title="Event exposure" sub={metric === 'Committed' ? 'Capital committed per event (cost basis incl. fees)' : 'Settlement P&L if the event resolves against these positions'}
        info="Per event, every holding on it netted: YES and NO positions on the same event offset at settlement. Committed capital is cost. Worst settlement is the outcome that pays least, compared with cost."
        right={<Seg label="Exposure metric" options={['Worst settlement', 'Committed'] as const} value={metric} onChange={setMetric} />} />
      <div className="card-b">
        {rows.length === 0 ? <div className="empty"><p>No open positions.</p></div> : (<>
          <PairBars label="Event exposure before and after" fmtV={(v) => (metric === 'Committed' ? fmt(v) : sfmt(v))}
            rows={rows.map((r) => ({ key: r.id, label: (r.a ?? r.b)!.title, before: r.b ? val(r.b) : null, after: r.a ? val(r.a) : 0, tag: r.a?.mixed ? <Chip>Both sides</Chip> : !r.b ? <Chip tone="accent">New</Chip> : !r.a ? <Chip>Exited</Chip> : null, onClick: () => onFocus(r.a ?? r.b) }))} />
          <p className="t3 chart-note">{largest && total > 0 ? `Largest event: ${largest.title}, ${pct((largest.cost / total) * 100, 0)} of committed capital. ` : ''}{worstOne ? `Worst single event: ${worstOne.title} at ${sfmt(worstOne.worst)}.` : ''} Select an event to list its positions.</p>
        </>)}
      </div>
    </Card>
  )
}

/* ── Resolution timeline ─────────────────────────────────── */
function Timeline({ E }: { E: Evaluation }) {
  const { TODAY } = useFinance()
  const after = eventProfiles(E.sim), before = eventProfiles(E.start)
  const ids = [...new Set([...after, ...before].map((e) => e.id))]
  const rows = ids.map((id) => ({ id, a: after.find((e) => e.id === id) ?? null, b: before.find((e) => e.id === id) ?? null }))
    .map((r) => ({ ...r, when: (r.a ?? r.b)!.resolves, title: (r.a ?? r.b)!.title })).sort((p, q) => p.when.localeCompare(q.when))
  const months = [...new Set(rows.map((r) => r.when.slice(0, 7)))]
  const cum = months.map((m) => ({ m, b: rows.filter((r) => r.when.slice(0, 7) <= m).reduce((s, r) => s + (r.b?.cost ?? 0), 0), a: rows.filter((r) => r.when.slice(0, 7) <= m).reduce((s, r) => s + (r.a?.cost ?? 0), 0) }))
  const totalA = rows.reduce((s, r) => s + (r.a?.cost ?? 0), 0), totalB = rows.reduce((s, r) => s + (r.b?.cost ?? 0), 0)
  return (
    <Card id="a-timeline">
      <CardHeader title="Resolution timeline" sub="Committed capital by scheduled resolution date" info="Dates are scheduled resolution dates from market data. Markets can resolve later than scheduled, and redemption into cash can come later still: exposure isn’t guaranteed to end on these dates." />
      <div className="card-b">
        {rows.length === 0 ? <div className="empty"><p>No open positions.</p></div> : (<>
          <div className="tl-months" role="list" aria-label="Committed capital scheduled to resolve after each month">
            {cum.map((c) => {
              const left = totalA - c.a, leftB = totalB - c.b
              return (
                <div role="listitem" key={c.m} className="tl-m">
                  <span className="t3">{fmtDate(`${c.m}-01`, { month: 'short', year: '2-digit' })}</span>
                  <div className="tl-track"><i className="b" style={{ width: `${totalB ? (leftB / Math.max(totalA, totalB)) * 100 : 0}%` }} /><i className="a" style={{ width: `${totalA ? (left / Math.max(totalA, totalB)) * 100 : 0}%` }} /></div>
                  <span className="r">{fmt(left)}<small className="t3"> scheduled after</small></span>
                </div>
              )
            })}
          </div>
          <div className="tl-list">
            {rows.map((r) => (
              <div key={r.id} className="tl-li"><span className="t3 tnum">{fmtDate(r.when, { month: 'short', day: 'numeric', year: '2-digit' })}</span><span className="tl-t">{r.title}</span>
                <span className="r tnum"><span className="t3">{r.b ? fmt(r.b.cost) : '—'}</span> → {r.a ? fmt(r.a.cost) : '—'}</span><small className="t3 r">{daysBetween(TODAY, r.when)}d</small></div>
            ))}
          </div>
          <div className="legend chart-note"><span><i style={{ background: 'var(--color-border-strong)' }} />start</span><span><i style={{ background: 'var(--color-accent-solid)' }} />scenario</span></div>
        </>)}
      </div>
    </Card>
  )
}

/* ── Position detail ─────────────────────────────────────── */
function PositionDetail({ E, focus, onClear, onEdit }: { E: Evaluation; focus: { by: AllocationBy; key: string; label: string } | null; onClear: () => void; onEdit: (id: string) => void }) {
  const { start, sim: S } = E
  const ids = [...new Set([...Object.keys(S.holdings), ...Object.keys(start.holdings)])]
  const rows = ids.map((id) => ({ id, b: start.holdings[id], a: S.holdings[id], t: S.trades[id] }))
    .filter((r) => (r.a?.shares ?? 0) > 0 || (r.b?.shares ?? 0) > 0 || r.t)
    .filter((r) => { const h = r.a ?? r.b; if (!focus) return true; return focus.by === 'category' ? h.category === focus.key : focus.by === 'platform' ? h.platform === focus.key : h.eventId === focus.key })
    .sort((p, q) => Number(!!q.t) - Number(!!p.t) || ((q.a?.shares ?? 0) * (q.a?.mark ?? 0)) - ((p.a?.shares ?? 0) * (p.a?.mark ?? 0)))
  return (
    <Card id="a-positions" flush>
      <CardHeader pad title="Positions in detail" />
      {focus && <div className="filter-bar"><span>Showing <b>{focus.label}</b></span><button type="button" className="link" onClick={onClear}>Show all</button></div>}
      <div className="dt-wrap"><table className="dt">
        <thead><tr><th scope="col">Position</th><th scope="col" className="r">Start</th><th scope="col" className="r">Scenario</th><th scope="col" className="r">Trade</th><th scope="col" className="r">Notional</th><th scope="col" className="r">Est. fee</th><th scope="col" className="r">Value at mark</th><th scope="col" className="r">Cost basis</th><th scope="col"><span className="sr-only">Edit</span></th></tr></thead>
        <tbody>{rows.map((r) => {
          const h = r.a ?? r.b, val = r.a && r.a.shares > 0 ? (r.a.mark == null ? null : r.a.shares * r.a.mark) : 0, fs = S.feeStatusBy[r.id]
          return (
            <tr key={r.id}>
              <td className="mkt"><span className="row"><PlatformBadge p={h.platform} size={18} /><span>{h.title}</span><SideChip side={h.side} />{h.isNew && <Chip tone="accent">New</Chip>}</span><small className="t3 cell-sub">{h.accountId ? accountName(h.accountId) : `Virtual funds on ${PLATFORM_NAME[h.platform]}`}</small></td>
              <td className="r t2">{qty(r.b?.shares ?? 0)}</td><td className="r">{qty(r.a?.shares ?? 0)}</td>
              <td className="r">{r.t ? `${r.t.qty > 0 ? 'Buy' : 'Sell'} ${qty(Math.abs(r.t.qty))} @ ${fmtPrice(r.t.price)}` : <span className="t3">—</span>}</td>
              <td className="r">{r.t ? fmt(Math.abs(r.t.qty) * r.t.price, 2) : '—'}</td>
              <td className="r">{!r.t ? '—' : fs === 'unavailable' ? <span className="stale">Unavailable</span> : fs === 'excluded' ? <span className="t3">Excluded</span> : fmt(S.feesBy[r.id] ?? 0, 2)}</td>
              <td className="r">{val == null ? <span className="stale">Unavailable</span> : fmt(val)}</td>
              <td className="r t2">{fmt(r.a?.cost ?? 0)}</td>
              <td className="r">{(r.t || S.errors[r.id] || r.a?.isNew) ? <Button size="sm" variant="ghost" onClick={() => onEdit(r.id)}>Edit</Button> : <span className="t3">unchanged</span>}</td>
            </tr>
          )
        })}</tbody>
      </table></div>
      <div className="foot"><span /><span>{count(rows.length, 'position')}</span></div>
    </Card>
  )
}

/* Period control: presets 1W · 1M · 3M · 6M · YTD · 1Y · All plus a custom date range. A preset the history doesn't
   cover is disabled with the reason; a custom range is validated against the history before it applies. On phones
   the presets collapse into one select. */
import { useId, useState } from 'react'
import { PERIODS, fmtDate, type Period, type Range } from '../lib/finance'
import { Button, cx } from './ui'
import { useFinance } from '../lib/financeContext'

export type PeriodValue = Period | Range
export const isCustom = (v: PeriodValue): v is Range => typeof v !== 'string'
export const periodName = (v: PeriodValue) => (isCustom(v) ? 'Custom' : v)

export function PeriodControl({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  const { HISTORY_START, TODAY, customRangeIssue, periodAvailable } = useFinance()
  const [editing, setEditing] = useState(isCustom(value))
  const [start, setStart] = useState(isCustom(value) ? value.start : HISTORY_START)
  const [end, setEnd] = useState(isCustom(value) ? value.end : TODAY)
  const [tried, setTried] = useState(false)
  const id = useId()
  const issue = customRangeIssue({ start, end })
  const custom = isCustom(value) || editing
  const pick = (p: Period) => { setEditing(false); setTried(false); onChange(p) }
  return (
    <div className="period-ctl">
      <div className="seg" role="radiogroup" aria-label="Period">
        {PERIODS.map((p) => {
          const ok = periodAvailable(p)
          return <button key={p} type="button" role="radio" aria-checked={!custom && value === p} className={cx(!custom && value === p && 'on')} disabled={!ok} title={ok ? undefined : 'Your history doesn’t cover this period'} onClick={() => pick(p)}>{p}</button>
        })}
        <button type="button" role="radio" aria-checked={custom} className={cx(custom && 'on')} onClick={() => setEditing(true)}>Custom</button>
      </div>
      <select className="select period-select" aria-label="Period" value={custom ? 'Custom' : (value as string)} onChange={(e) => (e.target.value === 'Custom' ? setEditing(true) : pick(e.target.value as Period))}>
        {PERIODS.map((p) => <option key={p} value={p} disabled={!periodAvailable(p)}>{p}</option>)}
        <option value="Custom">Custom…</option>
      </select>
      {custom && (
        <form className="custom-range" aria-label="Custom period" onSubmit={(e) => { e.preventDefault(); setTried(true); if (!issue) onChange({ start, end }) }}>
          <label htmlFor={`${id}-s`}>From<input id={`${id}-s`} type="date" min={HISTORY_START} max={TODAY} value={start} aria-invalid={tried && !!issue} onChange={(e) => setStart(e.target.value)} /></label>
          <label htmlFor={`${id}-e`}>To<input id={`${id}-e`} type="date" min={HISTORY_START} max={TODAY} value={end} aria-invalid={tried && !!issue} onChange={(e) => setEnd(e.target.value)} /></label>
          <Button type="submit" size="sm" disabled={isCustom(value) && value.start === start && value.end === end}>Apply</Button>
          {tried && issue ? <small className="loss" role="alert">{issue}</small> : <small className="t3">History: {fmtDate(HISTORY_START, { month: 'short', day: 'numeric', year: 'numeric' })} – {fmtDate(TODAY, { month: 'short', day: 'numeric', year: 'numeric' })}</small>}
        </form>
      )}
    </div>
  )
}

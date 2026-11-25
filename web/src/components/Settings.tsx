/* Workspace preferences: how Scevia displays and analyzes your portfolio. Each control takes effect immediately.
   Each section has its own Restore defaults; resetting everything is separate and asks first. Personal data and
   privacy are in the account menu; data sources are in Portfolio. */
import { useState } from 'react'
import { PERIODS, type Period, type PlatformFilter } from '../lib/finance'
import { DEFAULT_SETTINGS, GUARDRAIL_RANGE, SECTION_FIELDS, resetSection, useSettings, type SettingsTab } from '../lib/settings'
import { Modal, useToast } from './overlays'
import { Button, Seg, Tabs, cx } from './ui'

const SCOPE: Record<string, PlatformFilter> = { All: 'all', Polymarket: 'pm', Kalshi: 'ks' }
const SIZE = { Shares: 'shares', '$ Amount': 'amount', '% of start': 'weight' } as const
const RESOLVE = { Off: 0, '7 days': 7, '14 days': 14, '30 days': 30 } as const
const MOVE = { Off: 0, '$100': 100, '$250': 250, '$500': 500 } as const
const key = <T extends Record<string, unknown>>(m: T, v: unknown) => (Object.keys(m) as (keyof T & string)[]).find((k) => m[k] === v)

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return <div className="set-row"><div><b>{label}</b>{help && <small className="t3">{help}</small>}</div><div className="set-ctl">{children}</div></div>
}
function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx('switch', on && 'on')} onClick={() => set(!on)}><span /></button>
}

export function SettingsModal({ tab: initial, onClose }: { tab: SettingsTab; onClose: () => void }) {
  const { settings: s, update, replace } = useSettings()
  const toast = useToast()
  const [tab, setTab] = useState<SettingsTab>(initial)
  const [resetAll, setResetAll] = useState(false)
  const A = s.alerts, setA = (p: Partial<typeof A>) => update({ alerts: { ...A, ...p } })
  return (
    <Modal title="Settings" sub="Workspace preferences · applied immediately · kept in this browser tab" onClose={onClose} width={680}
      footer={resetAll
        ? <><span className="t3" style={{ marginRight: 'auto' }}>Reset every preference to its default? Scenarios and records aren’t affected.</span><Button variant="ghost" onClick={() => setResetAll(false)}>Cancel</Button><Button variant="primary" onClick={() => { replace({ ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts } }); setResetAll(false); toast('All preferences reset to defaults') }}>Reset all preferences</Button></>
        : <><Button variant="ghost" onClick={() => setResetAll(true)}>Reset all…</Button><span className="spacer" /><Button onClick={() => { replace(resetSection(s, tab)); toast(`${tab} preferences restored to defaults`) }}>Restore {tab} defaults</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <Tabs label="Settings sections" options={Object.keys(SECTION_FIELDS) as SettingsTab[]} value={tab} onChange={setTab} />
      <div className="set-body">
        {tab === 'General' && <>
          <Row label="Default platform scope" help="Overview opens in this scope. Switching on the page is a view filter: it never changes the portfolio.">
            <Seg label="Default platform scope" options={['All', 'Polymarket', 'Kalshi'] as const} value={(key(SCOPE, s.defaultScope) ?? 'All') as 'All'} onChange={(v) => update({ defaultScope: SCOPE[v] })} /></Row>
          <Row label="Amounts" help="Prediction-market balances are in USD or USD stablecoins. Scevia doesn’t convert between currencies or collateral assets."><span className="t2">USD</span></Row>
        </>}
        {tab === 'Analytics' && <>
          <Row label="Default period" help="Overview’s chart and Analytics open with this period.">
            <Seg label="Default period" options={PERIODS} value={s.defaultPeriod} onChange={(v: Period) => update({ defaultPeriod: v })} /></Row>
          <Row label="Default grouping" help="Overview’s allocation and Analytics’ attribution open grouped this way.">
            <Seg label="Default grouping" options={['Category', 'Platform'] as const} value={s.defaultGrouping === 'platform' ? 'Platform' : 'Category'} onChange={(v) => update({ defaultGrouping: v === 'Platform' ? 'platform' : 'category' })} /></Row>
        </>}
        {tab === 'Risk' && <>
          <Row label="Single-event guardrail" help="Flag any event above this share of committed capital (cost basis of all open positions). It only flags: settlement facts and positions don’t change.">
            <span className="row"><input className="slider" type="range" aria-label="Single-event guardrail" min={GUARDRAIL_RANGE[0]} max={GUARDRAIL_RANGE[1]} step={1} value={s.guardrail} onChange={(e) => update({ guardrail: Number(e.target.value) })} /><b className="tnum">{s.guardrail}%</b></span></Row>
          <small className="t3">Used by Risk (concentration, filters, summary) and by concentration notifications.</small>
        </>}
        {tab === 'Scenario Lab' && <>
          <Row label="Show targets as" help="How position targets are shown when Scenario Lab opens. It’s a view: each saved scenario keeps the unit every target was typed in.">
            <Seg label="Default sizing" options={Object.keys(SIZE) as (keyof typeof SIZE)[]} value={(key(SIZE, s.labSize) ?? 'Shares') as keyof typeof SIZE} onChange={(v) => update({ labSize: SIZE[v] })} /></Row>
          <small className="t3">Fees, capital and constraints are set per scenario, in its assumptions.</small>
        </>}
        {tab === 'Notifications' && <>
          <Row label="Upcoming resolutions" help="Events scheduled to resolve within this window (one notification per event).">
            <Seg label="Resolution alerts" options={Object.keys(RESOLVE) as (keyof typeof RESOLVE)[]} value={(key(RESOLVE, A.resolvingWithin) ?? '30 days') as keyof typeof RESOLVE} onChange={(v) => setA({ resolvingWithin: RESOLVE[v] })} /></Row>
          <Row label="Position value moves" help="Any position whose value moved at least this much since your last visit.">
            <Seg label="Price move alerts" options={Object.keys(MOVE) as (keyof typeof MOVE)[]} value={(key(MOVE, A.priceMove) ?? '$100') as keyof typeof MOVE} onChange={(v) => setA({ priceMove: MOVE[v] })} /></Row>
          <Row label="Concentration" help="Events above your single-event guardrail."><Toggle label="Concentration alerts" on={A.concentration} set={(v) => setA({ concentration: v })} /></Row>
          <Row label="Settlements" help="Trades settled in the last 7 days."><Toggle label="Settlement alerts" on={A.settlements} set={(v) => setA({ settlements: v })} /></Row>
          <Row label="Data quality" help="Estimated fees, stale sources and records that need review."><Toggle label="Data quality alerts" on={A.dataQuality} set={(v) => setA({ dataQuality: v })} /></Row>
          <Row label="Imports & reconciliation" help="Imports you confirm in this tab."><Toggle label="Import alerts" on={A.imports} set={(v) => setA({ imports: v })} /></Row>
          <small className="t3">Notifications appear in the bell while Scevia is open. Email and push aren’t available yet.</small>
        </>}
      </div>
    </Modal>
  )
}

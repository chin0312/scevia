/* Workspace preferences: how Scevia displays and analyzes your portfolio. Each control takes effect immediately.
   Each section has its own Restore defaults; resetting everything is separate and asks first. Personal data and
   privacy are in the account menu; data sources are in Portfolio. */
import { useState } from 'react'
import { PERIODS, type Period, type PlatformFilter } from '../lib/finance'
import { DEFAULT_SETTINGS, GUARDRAIL_RANGE, SECTION_FIELDS, resetSection, useSettings, type SettingsTab } from '../lib/settings'
import { Modal, useToast } from './overlays'
import { Button, Seg, Tabs, cx } from './ui'
import { CURRENCIES, assetLabel, rateWarning, sourceName, type ReportingCurrency } from '../lib/fx'
import { useReporting } from '../lib/reporting'
import { useActiveWorkspace } from '../lib/workspaceContext'
import { phrase } from '../lib/text'
import { fmtDate } from '../lib/finance'

const SCOPE: Record<string, PlatformFilter> = { All: 'all', Polymarket: 'pm', Kalshi: 'ks' }
const SIZE = { Shares: 'shares', Amount: 'amount', '% of start': 'weight' } as const
const RESOLVE = { Off: 0, '7 days': 7, '14 days': 14, '30 days': 30 } as const
const REFRESH = { 'On request': 0, '5 min': 5, '15 min': 15, '1 hour': 60 } as const
const MOVE = { Off: 0, '$100': 100, '$250': 250, '$500': 500 } as const
const key = <T extends Record<string, unknown>>(m: T, v: unknown) => (Object.keys(m) as (keyof T & string)[]).find((k) => m[k] === v)

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return <div className="set-row"><div><b>{label}</b>{help && <small className="t3">{help}</small>}</div><div className="set-ctl">{children}</div></div>
}
function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx('switch', on && 'on')} onClick={() => set(!on)}><span /></button>
}

/** The rates used to show values in the reporting currency, read from the same exchange-rate service as every
 *  figure. Rates are selected automatically and listed on request. Each rate that can't be used as is gets its own
 *  short warning, shown without opening the list. Legs follow the assets the selected portfolio actually holds. */
function RatesInUse({ currency }: { currency: ReportingCurrency }) {
  const { fx } = useReporting()
  const accounts = useActiveWorkspace().snapshot.data?.accounts ?? []
  const assets = [...new Set(accounts.map((a) => a.denomination))].filter((a) => a !== 'USD').sort()
  const legs = [...assets.map((a) => fx.reference(a, 'USD')), ...(currency === 'USD' ? [] : [fx.reference('USD', currency)])]
  const date = (iso: string) => fmtDate(iso.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' })
  const warnings = legs.map((r) => rateWarning(r, date)).filter((w): w is string => !!w)
  if (legs.length === 0) return <small className="t3">No conversion is needed for this portfolio.</small>
  return (<>
    {warnings.length > 0 && <ul className="set-warn" role="status">{warnings.map((w) => <li key={w} className="stale">{w}</li>)}</ul>}
    <details className="adv set-adv">
      <summary>Rates in use</summary>
      <ul className="fx-legs" aria-label="Exchange rates in use">
        {legs.map((r) => <li key={`${r.base}${r.quote}`}><span>{assetLabel(r.base)} to {assetLabel(r.quote)}</span><span>{phrase(r.rate == null ? 'Unavailable' : r.rate.toFixed(4), sourceName(r), r.fallback && 'fallback source', r.observedAt && date(r.observedAt))}</span></li>)}
      </ul>
      {!fx.live && <small className="t3">{fx.label}. They are fixed, not live.</small>}
    </details>
  </>)
}

export function SettingsModal({ tab: initial, onClose }: { tab: SettingsTab; onClose: () => void }) {
  const { settings: s, update, replace } = useSettings()
  const toast = useToast()
  const [tab, setTab] = useState<SettingsTab>(initial)
  const [resetAll, setResetAll] = useState(false)
  const A = s.alerts, setA = (p: Partial<typeof A>) => update({ alerts: { ...A, ...p } })
  return (
    <Modal title="Settings" sub="Changes apply right away." onClose={onClose} width={680}
      footer={resetAll
        ? <><span className="t3" style={{ marginRight: 'auto' }}>Reset all settings? Your scenarios and records stay as they are.</span><Button variant="ghost" onClick={() => setResetAll(false)}>Cancel</Button><Button variant="primary" onClick={() => { replace({ ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts } }); setResetAll(false); toast('Settings reset') }}>Reset all preferences</Button></>
        : <><Button variant="ghost" onClick={() => setResetAll(true)}>Reset all…</Button><span className="spacer" /><Button onClick={() => { replace(resetSection(s, tab)); toast(`${tab} settings restored`) }}>Restore {tab} defaults</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <Tabs label="Settings sections" options={Object.keys(SECTION_FIELDS) as SettingsTab[]} value={tab} onChange={setTab} />
      <div className="set-body">
        {tab === 'General' && <>
          <Row label="Reporting currency" help="Currency for portfolio values.">
            <span className="set-col">
              <select className="select" aria-label="Reporting currency" value={s.reportingCurrency} onChange={(e) => update({ reportingCurrency: e.target.value as ReportingCurrency })}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
              </select>
              <small className="t3">Exchange rates are selected automatically.</small>
              <RatesInUse currency={s.reportingCurrency} />
            </span></Row>
          <Row label="Default platform" help="Used when Overview opens.">
            <Seg label="Default platform scope" options={['All', 'Polymarket', 'Kalshi'] as const} value={(key(SCOPE, s.defaultScope) ?? 'All') as 'All'} onChange={(v) => update({ defaultScope: SCOPE[v] })} /></Row>
          <Row label="Automatic refresh" help="How often to check for new data while Scevia is open.">
            <Seg label="Automatic refresh" options={Object.keys(REFRESH) as (keyof typeof REFRESH)[]} value={(key(REFRESH, s.autoRefresh) ?? '15 min') as keyof typeof REFRESH} onChange={(v) => update({ autoRefresh: REFRESH[v] })} /></Row>
          <Row label="Show prices as" help="A YES/NO price is also the market’s implied probability. It isn’t a forecast by Scevia.">
            <Seg label="Market prices" options={['$0.64', '64%'] as const} value={s.priceDisplay === 'implied' ? '64%' : '$0.64'} onChange={(v) => update({ priceDisplay: v === '64%' ? 'implied' : 'price' })} /></Row>
        </>}
        {tab === 'Analytics' && <>
          <Row label="Default period" help="Used when Overview and Analytics open.">
            <Seg label="Default period" options={PERIODS} value={s.defaultPeriod} onChange={(v: Period) => update({ defaultPeriod: v })} /></Row>
          <Row label="Default grouping" help="Used for allocation and attribution.">
            <Seg label="Default grouping" options={['Category', 'Platform'] as const} value={s.defaultGrouping === 'platform' ? 'Platform' : 'Category'} onChange={(v) => update({ defaultGrouping: v === 'Platform' ? 'platform' : 'category' })} /></Row>
        </>}
        {tab === 'Risk' && <>
          <Row label="Concentration limit" help="Flag any event above this share of your capital committed.">
            <span className="row"><input className="slider" type="range" aria-label="Concentration limit" min={GUARDRAIL_RANGE[0]} max={GUARDRAIL_RANGE[1]} step={1} value={s.guardrail} onChange={(e) => update({ guardrail: Number(e.target.value) })} /><b className="tnum">{s.guardrail}%</b></span></Row>
        </>}
        {tab === 'Scenario Lab' && <>
          <Row label="Size positions by" help="The unit Scenario Lab shows first. Saved scenarios keep theirs.">
            <Seg label="Default sizing" options={Object.keys(SIZE) as (keyof typeof SIZE)[]} value={(key(SIZE, s.labSize) ?? 'Shares') as keyof typeof SIZE} onChange={(v) => update({ labSize: SIZE[v] })} /></Row>
          <Row label="Fees on new scenarios" help="Saved scenarios and replays keep their own setting.">
            <Seg label="Fees on new scenarios" options={['Provider estimate', 'Excluded'] as const} value={s.newFees === 'excluded' ? 'Excluded' : 'Provider estimate'} onChange={(v) => update({ newFees: v === 'Excluded' ? 'excluded' : 'provider' })} /></Row>
        </>}
        {tab === 'Notifications' && <>
          <Row label="Upcoming resolutions" help="Events resolving within this window.">
            <Seg label="Resolution alerts" options={Object.keys(RESOLVE) as (keyof typeof RESOLVE)[]} value={(key(RESOLVE, A.resolvingWithin) ?? '30 days') as keyof typeof RESOLVE} onChange={(v) => setA({ resolvingWithin: RESOLVE[v] })} /></Row>
          <Row label="Price moves" help="Positions whose value changed at least this much since your last visit.">
            <Seg label="Price move alerts" options={Object.keys(MOVE) as (keyof typeof MOVE)[]} value={(key(MOVE, A.priceMove) ?? '$100') as keyof typeof MOVE} onChange={(v) => setA({ priceMove: MOVE[v] })} /></Row>
          <Row label="Concentration" help="Events above your concentration limit."><Toggle label="Concentration alerts" on={A.concentration} set={(v) => setA({ concentration: v })} /></Row>
          <Row label="Settlements" help="Trades settled in the last week."><Toggle label="Settlement alerts" on={A.settlements} set={(v) => setA({ settlements: v })} /></Row>
          <Row label="Data quality" help="Estimated fees, out-of-date sources and records to review."><Toggle label="Data quality alerts" on={A.dataQuality} set={(v) => setA({ dataQuality: v })} /></Row>
          <Row label="Imports" help="Imports you confirm."><Toggle label="Import alerts" on={A.imports} set={(v) => setA({ imports: v })} /></Row>
          <small className="t3">Notifications appear while Scevia is open. Email and push aren’t available yet.</small>
        </>}
      </div>
    </Modal>
  )
}

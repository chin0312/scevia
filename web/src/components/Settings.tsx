/* User settings: preferences that change what Scevia shows, alerts, the Risk guardrail, and the data kept in this
   browser. Each control takes effect immediately. Data sources live in the portfolio menu, not here. */
import { useState } from 'react'
import { PERIODS, type Period, type PlatformFilter } from '../lib/finance'
import { DEFAULT_SETTINGS, GUARDRAIL_RANGE, useSettings, type SettingsTab } from '../lib/settings'
import { clearScevia, sceviaKeys } from '../lib/storage'
import { Modal, useToast } from './overlays'
import { Button, Callout, Seg, Tabs, cx } from './ui'

const SCOPE: Record<string, PlatformFilter> = { All: 'all', Polymarket: 'pm', Kalshi: 'ks' }
const SIZE = { Shares: 'shares', '$ Amount': 'amount', '% of start': 'weight' } as const
const RESOLVE = { Off: 0, '7 days': 7, '14 days': 14, '30 days': 30 } as const
const MOVE = { Off: 0, '$100': 100, '$250': 250, '$500': 500 } as const
const key = <T extends Record<string, unknown>>(m: T, v: unknown) => (Object.keys(m) as (keyof T & string)[]).find((k) => m[k] === v)!

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return <div className="set-row"><div><b>{label}</b>{help && <small className="t3">{help}</small>}</div><div className="set-ctl">{children}</div></div>
}

export function SettingsModal({ tab: initial, onClose }: { tab: SettingsTab; onClose: () => void }) {
  const { settings: s, update } = useSettings()
  const [tab, setTab] = useState<SettingsTab>(initial)
  return (
    <Modal title="Settings" sub="Changes apply immediately and are kept in this browser tab" onClose={onClose} width={640}
      footer={<><Button variant="ghost" onClick={() => update({ ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts } })}>Restore defaults</Button><span className="spacer" /><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <Tabs label="Settings sections" options={['General', 'Alerts', 'Risk', 'Data & privacy'] as const} value={tab} onChange={setTab} />
      <div className="set-body">
        {tab === 'General' && <>
          <Row label="Default platform scope" help="Overview opens in this scope. You can still switch on the page.">
            <Seg label="Default platform scope" options={['All', 'Polymarket', 'Kalshi'] as const} value={key(SCOPE, s.defaultScope) as 'All'} onChange={(v) => update({ defaultScope: SCOPE[v] })} /></Row>
          <Row label="Default period" help="Overview’s chart and Analytics open with this period.">
            <Seg label="Default period" options={PERIODS} value={s.defaultPeriod} onChange={(v: Period) => update({ defaultPeriod: v })} /></Row>
          <Row label="Scenario Lab sizing" help="How positions are sized when you open Scenario Lab. Each scenario keeps the unit you typed.">
            <Seg label="Default sizing" options={Object.keys(SIZE) as (keyof typeof SIZE)[]} value={key(SIZE, s.labSize) as keyof typeof SIZE} onChange={(v) => update({ labSize: SIZE[v] })} /></Row>
          <Row label="Currency" help="Prediction-market balances are in USD or USD stablecoins; no conversion is applied."><span className="t2">USD</span></Row>
        </>}
        {tab === 'Alerts' && <>
          <Row label="Upcoming resolutions" help="Notify about positions that resolve within this window.">
            <Seg label="Resolution alerts" options={Object.keys(RESOLVE) as (keyof typeof RESOLVE)[]} value={(key(RESOLVE, s.alerts.resolvingWithin) ?? '30 days') as keyof typeof RESOLVE} onChange={(v) => update({ alerts: { ...s.alerts, resolvingWithin: RESOLVE[v] } })} /></Row>
          <Row label="Price moves since your last visit" help="Notify when a position’s value moved by at least this much.">
            <Seg label="Price move alerts" options={Object.keys(MOVE) as (keyof typeof MOVE)[]} value={(key(MOVE, s.alerts.priceMove) ?? '$100') as keyof typeof MOVE} onChange={(v) => update({ alerts: { ...s.alerts, priceMove: MOVE[v] } })} /></Row>
          <Row label="Data quality" help="Notify when figures rely on estimated fees.">
            <button type="button" role="switch" aria-checked={s.alerts.feeEstimates} aria-label="Data quality alerts" className={cx('switch', s.alerts.feeEstimates && 'on')} onClick={() => update({ alerts: { ...s.alerts, feeEstimates: !s.alerts.feeEstimates } })}><span /></button></Row>
          <small className="t3">Alerts appear in the bell menu while you use Scevia. Email and push delivery aren’t available in this version.</small>
        </>}
        {tab === 'Risk' && <>
          <Row label="Single-event guardrail" help="Flag any event that holds more than this share of committed capital. Guardrails only flag; Scevia never trades.">
            <span className="row"><input className="slider" type="range" aria-label="Single-event guardrail" min={GUARDRAIL_RANGE[0]} max={GUARDRAIL_RANGE[1]} step={1} value={s.guardrail} onChange={(e) => update({ guardrail: Number(e.target.value) })} /><b className="tnum">{s.guardrail}%</b></span></Row>
          <small className="t3">The same guardrail is used in Risk (concentration, filters) and in its summary.</small>
        </>}
        {tab === 'Data & privacy' && <Privacy onDone={onClose} />}
      </div>
    </Modal>
  )
}

/* Describes what the app does today. Clearing removes only Scevia's own keys, asks first, and reports failure. */
function Privacy({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const held = sceviaKeys().length
  const clear = () => {
    const r = clearScevia()
    if (!r.ok) { toast('Couldn’t clear Scevia’s saved data in this browser', 'info'); setConfirm(false); return }
    onDone(); location.reload()
  }
  return (<>
    <p className="t2">You’re viewing a <b>sample portfolio</b>: its positions and trades are fictional. No Polymarket, Kalshi or other account is connected, and no file has been imported.</p>
    <p className="t2">Scenarios, settings and the sample records workspace are kept only in this browser tab (session storage) and are removed when the tab closes. They aren’t sent to a server.</p>
    <p className="t2">Scevia is read-only. It never places trades, holds funds, or asks for private keys, seed phrases or trading permissions.</p>
    {confirm
      ? <><Callout tone="warn" icon="alert">This removes your saved scenarios and settings in this tab ({held} item{held === 1 ? '' : 's'}). It can’t be undone. Other sites’ data isn’t affected.</Callout>
        <div className="row"><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="primary" onClick={clear}>Clear and reload</Button></div></>
      : <div><Button onClick={() => setConfirm(true)} disabled={held === 0} title={held === 0 ? 'Nothing is saved in this tab' : undefined}>Clear saved scenarios & settings…</Button></div>}
  </>)
}

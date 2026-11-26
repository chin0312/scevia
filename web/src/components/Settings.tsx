/* Workspace preferences: how Scevia displays and analyzes your portfolio. Each control takes effect immediately.
   Each section has its own Restore defaults; resetting everything is separate and asks first. Personal data and
   privacy are in the account menu; data sources are in Portfolio. */
import { useState } from 'react'
import { PERIODS, type Period, type PlatformFilter } from '../lib/finance'
import { DEFAULT_SETTINGS, GUARDRAIL_RANGE, SECTION_FIELDS, resetSection, useSettings, type SettingsTab } from '../lib/settings'
import { Modal, useToast } from './overlays'
import { Button, Seg, Tabs, cx } from './ui'
import { CURRENCIES, FIAT_SOURCES, FRESHNESS_LABEL, SOURCE_LABEL, STABLECOIN_SOURCES, fixtureFx, type FxPreferences, type ReportingCurrency } from '../lib/fx'

const SCOPE: Record<string, PlatformFilter> = { All: 'all', Polymarket: 'pm', Kalshi: 'ks' }
const SIZE = { Shares: 'shares', '$ Amount': 'amount', '% of start': 'weight' } as const
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

/** The reference behind the selected reporting currency, with its source and age. Not a live quote. */
/** The effective source of each conversion leg under the current preferences (fixture values, labelled). */
function EffectiveSources({ currency, prefs }: { currency: ReportingCurrency; prefs: FxPreferences }) {
  const fx = fixtureFx(undefined, prefs)
  const legs = [['USDC', 'USD'], ['PUSD', 'USD'], ...(currency === 'USD' ? [] : [['USD', currency]])].map(([b, q]) => fx.reference(b, q))
  return (
    <ul className="fx-legs" aria-label="Effective reference sources">
      {legs.map((r) => <li key={`${r.base}${r.quote}`}><span>{r.base} → {r.quote}</span><span>{r.rate == null ? FRESHNESS_LABEL[r.freshness] : r.rate.toFixed(4)} · {r.source.split(' + ').map((x) => SOURCE_LABEL[x as keyof typeof SOURCE_LABEL] ?? x).join(' + ')}{r.fallback ? ' · fallback' : ''} · {FRESHNESS_LABEL[r.freshness].toLowerCase()}{r.observedAt ? ` · ${r.observedAt}` : ''} · development fixture</span></li>)}
    </ul>
  )
}

function RateLine({ currency, prefs }: { currency: ReportingCurrency; prefs: FxPreferences }) {
  const fx = fixtureFx(undefined, prefs)
  const r = fx.reference('USD', currency)
  if (currency === 'USD') return <small className="t3">No conversion needed. Stablecoin balances use their own USD references.</small>
  return <small className={r.freshness === 'stale' ? 'stale' : 't3'}>{r.rate == null ? FRESHNESS_LABEL[r.freshness] : `1 USD = ${r.rate.toFixed(4)} ${currency}`} · {FRESHNESS_LABEL[r.freshness].toLowerCase()} · {fx.label.toLowerCase()}{r.observedAt ? `, as of ${r.observedAt}` : ''}. Not a live rate.</small>
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
          <Row label="Reporting currency" help="All portfolio values, charts and comparisons are shown in this currency, converted at the latest eligible reference rate. Converting never moves funds: balances, quantities, prices and native funding keep their own units.">
            <span className="set-col">
              <select className="select" aria-label="Reporting currency" value={s.reportingCurrency} onChange={(e) => update({ reportingCurrency: e.target.value as ReportingCurrency })}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
              </select>
              <RateLine currency={s.reportingCurrency} prefs={s.fx} />
            </span></Row>
          <details className="adv set-adv">
            <summary>Reference sources (advanced)</summary>
            <p className="t3">Automatic picks an eligible reference for each conversion. A preferred source is used where it supports that conversion; otherwise another eligible source is used and marked as a fallback. Sources don’t all cover every asset.</p>
            <Row label="Fiat reference" help="Used for USD ↔ SGD, EUR, GBP and MYR.">
              <select className="select" aria-label="Fiat reference source" value={s.fx.fiatSource} onChange={(e) => update({ fx: { ...s.fx, fiatSource: e.target.value as FxPreferences['fiatSource'] } })}>
                <option value="auto">Automatic</option>{FIAT_SOURCES.map((x) => <option key={x} value={x}>{SOURCE_LABEL[x]}</option>)}
              </select></Row>
            <Row label="Stablecoin reference" help="Used for USDC and PUSD in USD. Kraken covers USDC; CoinGecko covers PUSD.">
              <select className="select" aria-label="Stablecoin reference source" value={s.fx.stablecoinSource} onChange={(e) => update({ fx: { ...s.fx, stablecoinSource: e.target.value as FxPreferences['stablecoinSource'] } })}>
                <option value="auto">Automatic</option>{STABLECOIN_SOURCES.map((x) => <option key={x} value={x}>{SOURCE_LABEL[x]}</option>)}
              </select></Row>
            <EffectiveSources currency={s.reportingCurrency} prefs={s.fx} />
          </details>
          <Row label="Default platform scope" help="Overview opens in this scope. Switching on the page is a view filter: it never changes the portfolio.">
            <Seg label="Default platform scope" options={['All', 'Polymarket', 'Kalshi'] as const} value={(key(SCOPE, s.defaultScope) ?? 'All') as 'All'} onChange={(v) => update({ defaultScope: SCOPE[v] })} /></Row>
          <Row label="Automatic refresh" help="How often Scevia checks the selected portfolio’s sources while it’s open. Figures change only when a source has new data; scenarios, filters and inputs are never changed.">
            <Seg label="Automatic refresh" options={Object.keys(REFRESH) as (keyof typeof REFRESH)[]} value={(key(REFRESH, s.autoRefresh) ?? '15 min') as keyof typeof REFRESH} onChange={(v) => update({ autoRefresh: REFRESH[v] })} /></Row>
          <Row label="Market prices" help="For a standard YES/NO contract the price and the market-implied probability are the same number. It’s the market’s price, not Scevia’s forecast.">
            <Seg label="Market prices" options={['$0.64', '64%'] as const} value={s.priceDisplay === 'implied' ? '64%' : '$0.64'} onChange={(v) => update({ priceDisplay: v === '64%' ? 'implied' : 'price' })} /></Row>
          <Row label="Native assets" help="Each account keeps its native asset (USD, USDC or PUSD). Combined totals convert each asset at its own reference (stablecoins aren’t assumed to equal the dollar); conversion never funds a trade or changes a saved scenario."><span className="t2">Shown first, then converted</span></Row>
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
          <Row label="Fees on new scenarios" help="The fee assumption a new scenario or historical replay starts with. Saved ones keep their own; change it per scenario in its assumptions.">
            <Seg label="Fees on new scenarios" options={['Provider estimate', 'Excluded'] as const} value={s.newFees === 'excluded' ? 'Excluded' : 'Provider estimate'} onChange={(v) => update({ newFees: v === 'Excluded' ? 'excluded' : 'provider' })} /></Row>
          <small className="t3">Capital and constraints are set per scenario, in its assumptions.</small>
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

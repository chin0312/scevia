/* Help centre: getting started, guides, methodology & glossary, keyboard shortcuts, feedback and about.
   Concise, linked back into the app. Methodology is organized by concept from lib/help.ts, the same definitions used
   by info tips. Product-level statements (read-only, no advice) live once in About. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from './overlays'
import { Tabs } from './ui'
import { METHODOLOGY, PRODUCT_POLICIES } from '../lib/help'

export type HelpTab = 'Getting started' | 'Guides' | 'Methodology' | 'Shortcuts' | 'About'
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

const GUIDES: { title: string; body: string; to: string; cta: string }[] = [
  { title: 'Overview', body: 'Portfolio value, P&L, allocation and what resolves next. Select a row or segment to inspect it in place.', to: '/overview', cta: 'Open Overview' },
  { title: 'Analytics', body: 'Where results came from over a period: realized vs. unrealized, attribution, entry prices and patterns. Every figure keeps its period and platform scope.', to: '/analytics', cta: 'Open Analytics' },
  { title: 'Risk', body: 'Exposure by event (the same outcome on two venues counts once), concentration against your limit, settlement outcomes and the resolution calendar.', to: '/risk', cta: 'Open Risk' },
  { title: 'Scenario Lab', body: 'Build a hypothetical portfolio from your holdings or from scratch in current markets, analyze it, and compare scenarios. Nothing is traded and your actual holdings never change.', to: '/scenario-lab', cta: 'Open Scenario Lab' },
  { title: 'Historical replay', body: 'Inside Scenario Lab: a hypothetical portfolio over a past period, with markets that traded then and prices you assume. It’s hindsight analysis, not your performance or a strategy test.', to: '/scenario-lab/replay', cta: 'Open historical replay' },
  { title: 'Portfolios & data status', body: 'Switch between the Sample portfolio (fictional), the Demo portfolio (real markets, virtual capital) and your own. The status pill beside it shows how current each data stream is.', to: '/portfolio/coverage', cta: 'Open data coverage' },
  { title: 'Accounts & sources', body: 'Each wallet or venue login is an account. API sync, CSV and manual entry are sources. One account can combine several sources.', to: '/portfolio/accounts', cta: 'Manage accounts' },
  { title: 'Transactions & reconciliation', body: 'Inspect records, include or exclude them, correct imported or manual rows, and resolve possible duplicates. Original records are never deleted.', to: '/portfolio/transactions', cta: 'Open transactions' },
  { title: 'Data coverage', body: 'What the figures are based on: source freshness, history, opening state and estimated values. Unknown values stay unavailable, never $0.', to: '/portfolio/coverage', cta: 'Open coverage' },
]

export function HelpCentre({ tab: initial, onClose }: { tab: HelpTab; onClose: () => void }) {
  const nav = useNavigate()
  const [tab, setTab] = useState<HelpTab>(initial)
  const go = (to: string) => { onClose(); nav(to) }
  return (
    <Modal title="Help" sub="How Scevia works and how it calculates" onClose={onClose} width={720}>
      <Tabs label="Help sections" options={['Getting started', 'Guides', 'Methodology', 'Shortcuts', 'About'] as const} value={tab} onChange={setTab} />
      <div className="help-body">
        {tab === 'Getting started' && <ol className="help-steps">
          <li><b>Explore a portfolio.</b> Overview shows value and what changed. Analytics explains results. Risk shows what you’re exposed to. <button type="button" className="link" onClick={() => go('/overview')}>Start in Overview</button></li>
          <li><b>See what it’s made of.</b> Accounts, sources and coverage are in the Portfolio menu. <button type="button" className="link" onClick={() => go('/portfolio/accounts')}>Open Portfolio</button></li>
          <li><b>Manage records.</b> Import a sample CSV, add a manual record, and review overlaps. <button type="button" className="link" onClick={() => go('/portfolio/imports')}>Imports & reconciliation</button></li>
          <li><b>Try a scenario.</b> Modify your portfolio or build one from scratch. <button type="button" className="link" onClick={() => go('/scenario-lab')}>Open Scenario Lab</button></li>
          <li><b>Read incomplete data correctly.</b> “Estimated”, “Partial” and “Unavailable” mark values that aren’t fully known. Scevia never fills them with $0. <button type="button" className="link" onClick={() => setTab('Methodology')}>Methodology</button></li>
        </ol>}
        {tab === 'Guides' && <div className="help-guides">{GUIDES.map((g) => (
          <div key={g.title} className="help-guide"><b>{g.title}</b><p className="t2">{g.body}</p><button type="button" className="link" onClick={() => go(g.to)}>{g.cta} →</button></div>
        ))}</div>}
        {tab === 'Methodology' && <>
          {METHODOLOGY.map((m) => <section key={m.section} aria-label={m.section}>
            <h5 className="caps">{m.section}</h5>
            <dl className="kv help-kv">{m.items.map(([k, v]) => <div key={k} className="help-term"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          </section>)}
        </>}
        {tab === 'Shortcuts' && <dl className="kv help-kv">
          {([[`${MOD} K`, 'Open search'], ['↑ ↓ and Enter', 'Move through and open search results'], ['Esc', 'Close the top panel, menu or dialog'], ['← →', 'Switch tabs when a tab is focused'], ['Tab or Shift Tab', 'Move between controls']] as const).map(([k, v]) => <div key={k} className="help-term"><dt><kbd className="kbd">{k}</kbd></dt><dd>{v}</dd></div>)}
        </dl>}
        {tab === 'About' && <>
          <p className="t2"><b>Scevia</b> is portfolio intelligence for prediction markets: performance, event-level risk and scenarios across platforms.</p>
          <ul className="help-policies">{PRODUCT_POLICIES.map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="t2">Found a problem or have an idea? <a className="link" href="https://github.com/chin0312/scevia/issues" target="_blank" rel="noreferrer">Open an issue on GitHub ↗</a></p>
        </>}
      </div>
    </Modal>
  )
}

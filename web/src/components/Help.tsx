/* Help centre: getting started, guides, methodology & glossary, keyboard shortcuts, feedback and about.
   Concise, linked back into the app. Methodology distinguishes what this workspace calculates today from what
   arrives with connected accounts; it never presents a sample identity as a universal definition. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from './overlays'
import { Tabs } from './ui'

export type HelpTab = 'Getting started' | 'Guides' | 'Methodology' | 'Shortcuts' | 'About'
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

const GUIDES: { title: string; body: string; to: string; cta: string }[] = [
  { title: 'Overview', body: 'Portfolio value, P&L, allocation and what resolves next. Select a row or segment to inspect it in place.', to: '/overview', cta: 'Open Overview' },
  { title: 'Analytics', body: 'Where results came from over a period: realized vs. unrealized, attribution, entry prices and patterns. Every figure keeps its period and platform scope.', to: '/analytics', cta: 'Open Analytics' },
  { title: 'Risk', body: 'Exposure by event (the same outcome on two venues counts once), concentration against your guardrail, settlement outcomes and the resolution calendar.', to: '/risk', cta: 'Open Risk' },
  { title: 'Scenario Lab', body: 'Build a hypothetical portfolio from your holdings or from scratch, analyze it, and compare scenarios. Nothing is traded and your actual holdings never change.', to: '/scenario-lab', cta: 'Open Scenario Lab' },
  { title: 'Accounts & sources', body: 'Each wallet or venue login is an account; API sync, CSV and manual entry are sources. One account can combine several sources.', to: '/portfolio/accounts', cta: 'Manage accounts' },
  { title: 'Transactions & reconciliation', body: 'Inspect records, include or exclude them, correct imported or manual rows, and resolve possible duplicates. Original records are never deleted.', to: '/portfolio/transactions', cta: 'Open transactions' },
  { title: 'Data coverage', body: 'What the figures are based on: source freshness, history, opening state and estimated values. Unknown values stay unavailable, never $0.', to: '/portfolio/coverage', cta: 'Open coverage' },
]

const NOW: [string, string][] = [
  ['Portfolio value', 'Cash + open positions at their mark (last traded price). With connected accounts, settlement entitlements not yet redeemed are added as their own component.'],
  ['Cash', 'Per venue account, in its collateral asset. USD and USD stablecoins aren’t converted into each other.'],
  ['Cost basis', 'Weighted-average cost of open positions, including purchase fees. Sale fees reduce proceeds.'],
  ['Realized / unrealized P&L', 'Realized: closed trades after their fees. Unrealized: open positions at mark minus cost basis.'],
  ['Net P&L', 'Realized + unrealized. Deposits and withdrawals (external capital flows) are never performance.'],
  ['Fees', 'Reported, estimated (labelled) or unavailable. Hypothetical fees in Scenario Lab use each market’s published formula.'],
  ['Allocation', 'Market value at marks grouped by category, platform or event. The denominator is stated on each view: open positions, or cash included.'],
  ['Concentration', 'Capital committed to one event ÷ capital committed to all events. The guardrail flags; it never trades.'],
  ['Event exposure', 'All holdings on one event netted: YES and NO positions offset at settlement.'],
  ['Settlement payout / gain', 'A contract pays $1 per share if its outcome wins, $0 otherwise. Settlement gain or loss is payout − cost basis.'],
  ['Feasible outcome', 'A combination of event results that can happen given verified relationships (and, in a scenario, its hypothetical constraints). Not a probability.'],
  ['Drawdown', 'Largest fall of cumulative net P&L from a previous high, on weekly history.'],
]
const LATER: [string, string][] = [
  ['Time-weighted return', 'Return with external capital flows removed, linking periods between flows. Needs complete valuation history.'],
  ['Money-weighted return', 'The return that accounts for when and how much capital you added or withdrew.'],
  ['Settlement entitlements', 'Resolved positions awaiting redemption: neither open positions nor cash.'],
  ['Provider-reported vs. reconstructed', 'What a venue reports, and what your records (with your decisions) reconstruct. Both are shown with their scope.'],
  ['Partial results', 'When some components are known and others aren’t, known parts are shown as such and totals are unavailable.'],
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
          <li><b>Explore the sample portfolio.</b> Overview shows value and what changed; Analytics explains results; Risk shows what you’re exposed to. <button type="button" className="link" onClick={() => go('/overview')}>Start in Overview</button></li>
          <li><b>See what it’s made of.</b> Accounts, sources and coverage are in the Portfolio menu. <button type="button" className="link" onClick={() => go('/portfolio/accounts')}>Open Portfolio</button></li>
          <li><b>Manage records.</b> Import a sample CSV, add a manual record, and review overlaps. <button type="button" className="link" onClick={() => go('/portfolio/imports')}>Imports & reconciliation</button></li>
          <li><b>Try a scenario.</b> Modify your portfolio or build one from scratch. <button type="button" className="link" onClick={() => go('/scenario-lab')}>Open Scenario Lab</button></li>
          <li><b>Read incomplete data correctly.</b> “Estimated”, “Partial” and “Unavailable” mark values that aren’t fully known; Scevia never fills them with $0. <button type="button" className="link" onClick={() => setTab('Methodology')}>Methodology</button></li>
        </ol>}
        {tab === 'Guides' && <div className="help-guides">{GUIDES.map((g) => (
          <div key={g.title} className="help-guide"><b>{g.title}</b><p className="t2">{g.body}</p><button type="button" className="link" onClick={() => go(g.to)}>{g.cta} →</button></div>
        ))}</div>}
        {tab === 'Methodology' && <>
          <h5 className="caps">Calculated in this workspace</h5>
          <dl className="kv help-kv">{NOW.map(([k, v]) => <div key={k} className="help-term"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <h5 className="caps">With connected accounts</h5>
          <dl className="kv help-kv">{LATER.map(([k, v]) => <div key={k} className="help-term"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <p className="t3 help-note">Figures here come from a fictional sample portfolio. Scevia shows outcomes and ranges without probabilities and never gives investment advice.</p>
        </>}
        {tab === 'Shortcuts' && <dl className="kv help-kv">
          {([[`${MOD} K`, 'Open search'], ['↑ ↓ · Enter', 'Move through search results · open'], ['Esc', 'Close the top panel, menu or dialog'], ['← →', 'Switch tabs when a tab is focused'], ['Tab · Shift Tab', 'Move between controls']] as const).map(([k, v]) => <div key={k} className="help-term"><dt><kbd className="kbd">{k}</kbd></dt><dd>{v}</dd></div>)}
        </dl>}
        {tab === 'About' && <>
          <p className="t2"><b>Scevia</b> is read-only portfolio intelligence for prediction markets: performance, event-level risk and scenarios across venues. It never places trades, holds funds, or asks for private keys or seed phrases.</p>
          <p className="t2">Found a problem or have an idea? <a className="link" href="https://github.com/chin0312/scevia/issues" target="_blank" rel="noreferrer">Open an issue on GitHub ↗</a></p>
        </>}
      </div>
    </Modal>
  )
}

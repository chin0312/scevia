/* Portfolio selector, data status and the workspace gate.
   - PortfolioSelector (top bar chip): which portfolio is analyzed — Sample (fictional), Demo (real markets, virtual
     capital) or your own — its accounts with native denominations, and links to Portfolio management.
   - DataStatus (status pill beside it): each data stream's own freshness, a Refresh action and a link to Data
     coverage. There is no single "Live" light: the pill shows the least current of market, account and valuation.
   - WorkspaceGate: shows loading, unavailable and error states for a workspace without figures, instead of the page.
   Switching or refreshing never changes a scenario, a record or an input. */
import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FIXTURE_ID, MODE_LABEL, type WorkspaceSnapshot } from '../data/workspace'
import { PLATFORM_NAME } from '../data/labels'
import { fmtDate } from '../lib/finance'
import { STATE_LABEL, STATE_TONE, STREAM_LABEL, ago, summaryState } from '../lib/freshness'
import { accountName } from '../lib/useWorkspace'
import { hasData, useActiveWorkspace } from '../lib/workspaceContext'
import { Icon, type IconName } from './Icon'
import { Menu, useToast } from './overlays'
import { Button, PlatformBadge, cx } from './ui'

export const PORTFOLIO_SECTIONS: { id: string; label: string; icon: IconName; sub: string }[] = [
  { id: 'accounts', label: 'Accounts', icon: 'db', sub: 'wallets and venue logins' },
  { id: 'sources', label: 'Sources', icon: 'link', sub: 'connections, CSV, manual' },
  { id: 'transactions', label: 'Transactions', icon: 'list', sub: 'records and decisions' },
  { id: 'imports', label: 'Imports & reconciliation', icon: 'download', sub: 'batches and review' },
  { id: 'coverage', label: 'Data coverage', icon: 'shield', sub: 'what figures are based on' },
]

/** Re-render every 30 s so relative times ("2 min ago") stay true without touching data. */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])
  return now
}

const shortName = (s: WorkspaceSnapshot) => (s.summary.mode === 'fixture' ? 'Sample' : s.summary.mode === 'demo' ? 'Demo' : s.summary.name)

export function PortfolioSelector() {
  const nav = useNavigate()
  const { list, snapshot: s, select } = useActiveWorkspace()
  const mine = list.filter((x) => x.mode === 'actual')
  return (
    <Menu label="Portfolio" width={360} trigger={(t) => (
      <button type="button" className="chip accent chip-btn" aria-label={`Portfolio: ${s.summary.name}`} {...t}>
        <span className="chip-long">{s.summary.name}</span><span className="chip-short">{shortName(s)}</span>
        {s.valuationAsOf && <span className="chip-date"> · {fmtDate(s.valuationAsOf.slice(0, 10))}</span>}
      </button>)}>
      {(close) => (<>
        <div className="menu-h">Portfolios</div>
        {list.filter((x) => x.mode !== 'actual').map((w) => {
          const on = w.id === s.summary.id
          return (
            <button key={w.id} type="button" role="menuitemradio" aria-checked={on} className={cx('menu-i ws-opt', on && 'on')} onClick={() => { close(); select(w.id) }}>
              <Icon name={w.mode === 'demo' ? 'spark' : 'flask'} />
              <span className="ws-opt-t"><b>{w.name}</b><small className="t3">{w.blurb}</small></span>
              <small className="ws-mode">{MODE_LABEL[w.mode]}</small>
              {on && <Icon name="check" size={14} />}
            </button>
          )
        })}
        <div className="menu-h ws-sub">My portfolios</div>
        {mine.length === 0 && <div className="menu-row t3 menu-note">None yet. Your own portfolios from connected accounts, CSV imports and manual records appear here once you have a Scevia account.</div>}
        {mine.map((w) => (
          <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === s.summary.id} className={cx('menu-i ws-opt', w.id === s.summary.id && 'on')} onClick={() => { close(); select(w.id) }}>
            <Icon name="db" /><span className="ws-opt-t"><b>{w.name}</b><small className="t3">{w.blurb}</small></span>
          </button>
        ))}
        <button type="button" role="menuitem" className="menu-i" disabled title="Creating portfolios needs a Scevia account"><Icon name="plus" />Create portfolio<small className="t3" style={{ marginLeft: 'auto' }}>needs an account</small></button>
        {s.accounts.length > 0 && <>
          <div className="menu-sep" />
          <div className="menu-h">{s.summary.name} · accounts</div>
          {s.accounts.map((a) => (
            <div className="menu-row acct-row" key={a.id}><span className="row"><PlatformBadge p={a.venue} size={18} /><span className="acct-name">{accountName(a.id, s.accounts)}</span></span><small className="t3">{PLATFORM_NAME[a.venue]} · {a.denomination}</small></div>
          ))}
        </>}
        <div className="menu-sep" />
        <div className="menu-h">Manage portfolio</div>
        {PORTFOLIO_SECTIONS.map((x) => <button key={x.id} type="button" role="menuitem" className="menu-i" onClick={() => { close(); nav(`/portfolio/${x.id}`) }}><Icon name={x.icon} />{x.label}<small className="t3" style={{ marginLeft: 'auto' }}>{x.sub}</small></button>)}
      </>)}
    </Menu>
  )
}

export function DataStatus() {
  const nav = useNavigate()
  const toast = useToast()
  const { snapshot: s, refresh, lastRefresh } = useActiveWorkspace()
  const now = useNow()
  const state = s.status === 'loading' ? 'refreshing' : s.status === 'refreshing' ? 'refreshing' : s.status === 'unavailable' || s.status === 'error' ? 'unavailable' : summaryState(s.streams)
  const busy = s.status === 'loading' || s.status === 'refreshing'
  const failed = s.reason === 'refresh_failed' && !busy
  const doRefresh = async () => {
    const r = await refresh()
    if (r?.failed) toast('Couldn’t refresh. Showing the last data, not newly checked.', 'info')
    else if (r) toast(r.changed ? 'Updated with new data' : s.summary.mode === 'fixture' ? 'Checked · the sample portfolio has no new data' : 'Checked · no new data')
  }
  return (
    <Menu label="Data status" width={380} trigger={(t) => (
      <button type="button" className={cx('ds-pill', `tone-${failed ? 'warn' : STATE_TONE[state]}`)} aria-label={`Data status: ${failed ? 'Refresh failed' : STATE_LABEL[state]}`} {...t}>
        <span className={cx('ds-dot', busy && 'spin')} aria-hidden="true" /><span className="ds-text">{failed ? 'Refresh failed' : STATE_LABEL[state]}</span>
      </button>)}>
      {(close) => (<>
        <div className="menu-h"><span>Data status<small>{s.summary.name}{s.valuationAsOf ? ` · valued as of ${fmtDate(s.valuationAsOf.slice(0, 10), { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</small></span></div>
        {s.streams.length === 0 && <div className="menu-row t3">{s.status === 'loading' ? 'Loading…' : 'No data to report.'}</div>}
        <ul className="ds-list" aria-label="Data streams">
          {s.streams.map((x) => (
            <li key={x.id} className="ds-row">
              <span className="ds-l">{STREAM_LABEL[x.id]}<small className="t3">{x.detail}</small></span>
              <span className="ds-r"><span className={cx('ds-state', `tone-${STATE_TONE[s.status === 'refreshing' && (x.id === 'market' || x.id === 'account') ? 'refreshing' : x.state]}`)}>{STATE_LABEL[s.status === 'refreshing' && (x.id === 'market' || x.id === 'account') ? 'refreshing' : x.state]}</span>
                {x.asOf && <small className="t3">{x.id === 'history' ? 'from' : 'as of'} {fmtDate(x.asOf.slice(0, 10), x.id === 'history' ? { month: 'short', day: 'numeric', year: 'numeric' } : undefined)}</small>}</span>
            </li>
          ))}
        </ul>
        {failed
          ? <div className="menu-row menu-note" role="status"><span className="stale">The last refresh failed {ago(lastRefresh?.at ?? null, now)}.</span> <span className="t3">Showing data from the previous successful check{s.checkedAt ? ` (${ago(s.checkedAt, now)})` : ''}; it isn’t newly synchronized.</span></div>
          : <div className="menu-row t3 menu-note">{s.checkedAt ? `Last checked ${ago(s.checkedAt, now)}${lastRefresh ? (lastRefresh.changed ? ' · new data' : ' · no new data') : ''}.` : 'Not checked in this tab yet.'} Refreshing keeps your filters, selections and inputs.</div>}
        <div className="menu-sep" />
        <button type="button" role="menuitem" className="menu-i" disabled={busy || s.status === 'unavailable'} onClick={() => { void doRefresh() }}><Icon name="reset" />{busy ? 'Refreshing…' : failed ? 'Try again' : 'Refresh now'}</button>
        <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); nav('/portfolio/coverage') }}><Icon name="shield" />Data coverage<small className="t3" style={{ marginLeft: 'auto' }}>what figures are based on</small></button>
      </>)}
    </Menu>
  )
}

/** Shows the page only when the selected workspace has figures; otherwise its loading, unavailable or error state. */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { snapshot: s, select, list } = useActiveWorkspace()
  const { pathname } = useLocation()
  // Scenario Lab needs no portfolio: building from scratch and historical replays use virtual capital only.
  if (hasData(s) || pathname.startsWith('/scenario-lab')) return <>{children}</>
  if (s.status === 'loading') return <div className="page-loading" aria-busy="true" aria-label={`Loading ${s.summary.name}`}><div className="skeleton" style={{ height: 240 }} /><div className="skeleton" style={{ height: 480 }} /></div>
  const demo = s.summary.mode === 'demo'
  return (
    <main className="ws-state" aria-labelledby="ws-state-h">
      <div className="ws-state-card">
        <div className="start-ic"><Icon name={demo ? 'spark' : 'info'} size={18} /></div>
        <h1 id="ws-state-h">{s.status === 'error' ? `${s.summary.name} couldn’t be loaded` : `${s.summary.name} isn’t available`}</h1>
        {demo ? <>
          <p className="t2">The Demo portfolio tracks virtual capital in real, currently listed markets, using the same calculations as your own portfolios. It needs Scevia’s approved real-market data, which isn’t available right now, so there are no figures to show.</p>
          <p className="t3">Nothing is substituted: the Sample portfolio’s fictional markets are never shown as the demo. Your Sample portfolio, scenarios and settings are unchanged.</p>
        </> : <p className="t2">{s.status === 'error' ? 'Something went wrong while loading. Your other portfolios, scenarios and settings are unchanged.' : 'This portfolio has no data to show yet.'}</p>}
        <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {list.some((x) => x.id === FIXTURE_ID) && <Button variant="primary" icon="flask" onClick={() => select(FIXTURE_ID)}>Open Sample portfolio</Button>}
          <Button icon="reset" onClick={() => select(s.summary.id)}>Try again</Button>
        </div>
      </div>
    </main>
  )
}

/** The selected portfolio's name and data basis, for page footers ("Sample portfolio · fictional data"). */
export function WorkspaceLabel({ suffix }: { suffix?: string }) {
  const { snapshot: s } = useActiveWorkspace()
  const basis = s.summary.mode === 'fixture' ? 'fictional data' : s.summary.mode === 'demo' ? 'real markets, virtual capital' : 'your records'
  return <>{s.summary.name} · {suffix ?? basis}</>
}

/** The reporting assumption behind a combined total, shown only when the figures mix native assets. USD-only figures
 *  need none. It is a reporting convention for the development fixture; actual conversion comes from the backend
 *  (`/analytics/denominations`, with its own availability). It never moves funds between accounts. */
export function ReportingNote({ denominations }: { denominations: string[] }) {
  const others = [...new Set(denominations)].filter((d) => d !== 'USD')
  if (!others.length || new Set(denominations).size < 2) return null
  return <span>Combined in USD at 1 {others.join(' = 1 ')} = 1 USD (indicative reporting; funds aren’t converted)</span>
}

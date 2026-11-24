/* AppShell: TopNav (4 areas + utilities), SectionRail (page sections, scroll-spy), command palette. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LAST_VISIT, PLATFORM_NAME, TODAY } from '../data/sample'
import { POSITIONS, account, exposures, fmtDate } from '../lib/finance'
import { fmt, sfmt } from '../lib/format'
import { ConnectProvider, useConnect } from './ConnectSources'
import { Icon, type IconName } from './Icon'
import { Layer, Menu, Modal, ToastProvider, useToast } from './overlays'
import { Button, Callout, cx } from './ui'

const AREAS = [
  { to: '/overview', label: 'Overview' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/risk', label: 'Risk' },
  { to: '/scenario-lab', label: 'Scenario Lab', lab: true },
]

function Logo() {
  return <img className="brand-logo" src="/brand/scevia-logo.png" srcSet="/brand/scevia-logo@2x.png 2x" alt="Scevia" height={28} />
}

function useNotifications() {
  return useMemo(() => {
    const soonest = [...POSITIONS].sort((a, b) => a.days - b.days)[0]
    const mover = [...POSITIONS].sort((a, b) => Math.abs((b.mark - b.markAtLastVisit) * b.shares) - Math.abs((a.mark - a.markAtLastVisit) * a.shares))[0]
    const moved = (mover.mark - mover.markAtLastVisit) * mover.shares
    const est = account().feeEstimates
    return [
      { icon: 'cal' as IconName, tone: 'warn', title: `${soonest.market} resolves in ${soonest.days} days`, sub: `${fmt(soonest.cost)} at stake · ${PLATFORM_NAME[soonest.platform]}`, to: `/risk?event=${soonest.eventId}#payoffs` },
      { icon: 'trend' as IconName, tone: moved >= 0 ? 'gain' : 'loss', title: `${mover.market} ${mover.side}: ${mover.markAtLastVisit.toFixed(2)} → ${mover.mark.toFixed(2)}`, sub: `${sfmt(moved)} since ${fmtDate(LAST_VISIT)}`, to: '/overview#holdings' },
      ...(est ? [{ icon: 'alert' as IconName, tone: 'warn', title: `${est} settlements have estimated fees`, sub: 'Sample Kalshi CSV · net P&L shows them as estimates', to: '/overview#coverage' }] : []),
    ]
  }, [])
}

const DEFINITIONS: [string, string][] = [
  ['Portfolio value', 'Cash + open positions at their mark price (last traded price on the platform).'],
  ['Net deposits', 'Deposits − withdrawals. Never counted as performance.'],
  ['Net P&L', 'Realized P&L + unrealized P&L − fees paid on open fills. Equals portfolio value − net deposits.'],
  ['Realized P&L', 'Closed trades: shares × (exit − entry) − that trade’s fees.'],
  ['Unrealized P&L', 'Open positions: shares × (mark − average cost), before fees.'],
  ['Cost basis / committed', 'Shares × fill price of open positions. The most an open position can lose at settlement.'],
  ['Settlement payoff', 'A contract pays $1 per share if its side wins and $0 otherwise. Scevia never assigns probabilities.'],
]

function TopNav({ onSearch, onInfo }: { onSearch: () => void; onInfo: (k: 'calc' | 'privacy') => void }) {
  const nav = useNavigate()
  const connect = useConnect()
  const notifs = useNotifications()
  const [read, setRead] = useState(false)
  return (
    <header className="topbar">
      <NavLink className="brand" to="/overview" aria-label="Scevia home"><Logo /></NavLink>
      <nav className="nav" aria-label="Primary">
        {AREAS.map((a) => (
          <NavLink key={a.to} to={a.to} className={({ isActive }) => cx(isActive && 'on')}>
            {a.lab && <span className="lab-dot" />}{a.label}
          </NavLink>
        ))}
      </nav>
      <div className="utils">
        <button type="button" className="search" onClick={onSearch} aria-keyshortcuts="Meta+K"><Icon name="search" size={15} /><span>Search markets, positions…</span><kbd>⌘K</kbd></button>
        <span className="chip accent" title="Fictional sample portfolio. Nothing is synced from a real account.">Sample data · as of {fmtDate(TODAY)}</span>
        <Menu label="Help" width={300} trigger={(t) => <button type="button" className="icon-btn" aria-label="Help" {...t}><Icon name="help" size={18} /></button>}>
          {(close) => (<>
            <div className="menu-h">Help</div>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); onSearch() }}><Icon name="search" />Search & jump <kbd className="kbd">⌘K</kbd></button>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); onInfo('calc') }}><Icon name="info" />How Scevia calculates P&amp;L</button>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); onInfo('privacy') }}><Icon name="shield" />Data & privacy in this prototype</button>
          </>)}
        </Menu>
        <Menu label="Notifications" width={360} trigger={(t) => <button type="button" className={cx('icon-btn', !read && 'has-badge')} aria-label={`Notifications${read ? '' : `, ${notifs.length} unread`}`} {...t}><Icon name="bell" size={18} />{!read && <span className="badge" />}</button>}>
          {(close) => (<>
            <div className="menu-h">Notifications <button type="button" role="menuitem" className="link" onClick={() => setRead(true)} disabled={read}>{read ? 'All read' : 'Mark all read'}</button></div>
            {notifs.map((n) => (
              <button type="button" role="menuitem" key={n.title} className="menu-i notif" onClick={() => { close(); setRead(true); nav(n.to) }}>
                <span className={`ic ${n.tone}`}><Icon name={n.icon} size={14} /></span><span><b>{n.title}</b><small>{n.sub}</small></span>
              </button>
            ))}
          </>)}
        </Menu>
        <Menu label="Settings" width={280} trigger={(t) => <button type="button" className="icon-btn" aria-label="Settings" {...t}><Icon name="gear" size={18} /></button>}>
          {(close) => (<>
            <div className="menu-h">Settings</div>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); connect() }}><Icon name="link" />Data sources (demo)</button>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); nav('/risk#conc') }}><Icon name="shield" />Guardrails</button>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); onInfo('privacy') }}><Icon name="db" />Data & privacy</button>
          </>)}
        </Menu>
        <Menu label="Account" width={260} trigger={(t) => <button type="button" className="avatar" aria-label="Account" {...t}>AR</button>}>
          {() => (<>
            <div className="menu-h"><span>Sample user<small>No account · prototype</small></span></div>
            <button type="button" role="menuitem" className="menu-i" disabled title="There are no accounts in this prototype"><Icon name="logout" />Sign out (not available)</button>
          </>)}
        </Menu>
      </div>
    </header>
  )
}

function InfoModal({ kind, onClose }: { kind: 'calc' | 'privacy'; onClose: () => void }) {
  const toast = useToast()
  if (kind === 'calc') return (
    <Modal title="How Scevia calculates" sub="The same definitions are used on every page" onClose={onClose} width={600}>
      {DEFINITIONS.map(([k, v]) => <div className="list-row" key={k}><b style={{ minWidth: 170, fontWeight: 'var(--font-weight-medium)' }}>{k}</b><span className="t2">{v}</span></div>)}
    </Modal>
  )
  return (
    <Modal title="Data & privacy in this prototype" onClose={onClose} width={560}
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button onClick={() => { sessionStorage.clear(); toast('Saved scenarios and choices cleared for this session'); onClose(); location.reload() }}>Clear my session data</Button></>}>
      <p className="t2">This is a prototype running on a <b>fictional sample portfolio</b>. It doesn’t connect to Polymarket or Kalshi, doesn’t read wallets or files, and doesn’t send anything to a server.</p>
      <p className="t2">Scenarios you save and relationships you classify are kept only in this browser tab’s session storage. They disappear when the tab closes, or you can clear them now.</p>
      <Callout>How a real version would store and delete account data is still to be designed. Nothing here should be read as a privacy commitment for that product.</Callout>
    </Modal>
  )
}

/* ⌘K palette: pages, positions, events */
function CommandPalette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const items = useMemo(() => {
    const all = [
      ...AREAS.map((a) => ({ group: 'Go to', label: a.label, sub: '', to: a.to, icon: 'arrowRight' as IconName })),
      ...POSITIONS.map((p) => ({ group: 'Positions', label: p.market, sub: `${p.side} · ${p.shares.toLocaleString()} shares`, to: `/scenario-lab?add=${p.id}`, icon: 'flask' as IconName })),
      ...exposures().map((x) => ({ group: 'Events', label: x.event.name, sub: `resolves ${fmtDate(x.resolves)}`, to: `/risk?event=${x.event.id}#payoffs`, icon: 'shield' as IconName })),
    ]
    const s = q.trim().toLowerCase()
    return (s ? all.filter((x) => x.label.toLowerCase().includes(s)) : all).slice(0, 12)
  }, [q])
  const go = (to: string) => { onClose(); nav(to) }
  return (
    <Layer onClose={onClose} kind="palette" label="Search">
      <div className="palette">
        <div className="palette-in"><Icon name="search" size={16} />
          <input data-autofocus aria-label="Search markets, positions and events" aria-controls="palette-list" placeholder="Search markets, positions, events…" value={q}
            onChange={(e) => { setQ(e.target.value); setI(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, items.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)) }
              if (e.key === 'Enter' && items[i]) go(items[i].to)
            }} />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Results">
          {items.length === 0 && <div className="empty"><p>No matches for “{q}”.</p></div>}
          {items.map((it, k) => (
            <div key={it.group + it.label}>
              {(k === 0 || items[k - 1].group !== it.group) && <div className="palette-g">{it.group}</div>}
              <button type="button" role="option" aria-selected={k === i} className={cx('palette-i', k === i && 'on')} onMouseEnter={() => setI(k)} onClick={() => go(it.to)}>
                <Icon name={it.icon} size={15} /><span>{it.label}</span><small>{it.sub}</small>
              </button>
            </div>
          ))}
        </div>
        <div className="palette-f"><span><kbd className="kbd">↑↓</kbd> navigate</span><span><kbd className="kbd">↵</kbd> open</span><span>Positions open in Scenario Lab</span></div>
      </div>
    </Layer>
  )
}

export function AppLayout() {
  const [palette, setPalette] = useState(false)
  const [info, setInfo] = useState<'calc' | 'privacy' | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <ToastProvider>
      <ConnectProvider>
        <TopNav onSearch={() => setPalette(true)} onInfo={setInfo} />
        <Outlet />
        {palette && <CommandPalette onClose={() => setPalette(false)} />}
        {info && <InfoModal kind={info} onClose={() => setInfo(null)} />}
      </ConnectProvider>
    </ToastProvider>
  )
}

/* Section rail with scroll-spy */
export interface RailSection { id: string; label: string; icon: IconName; count?: number; flag?: number | string }
export function SectionRail({ title, sections, children }: { title?: string; sections: RailSection[]; children?: ReactNode }) {
  const [active, setActive] = useState(sections[0]?.id)
  useEffect(() => {
    const onScroll = () => {
      let cur = sections[0]?.id
      for (const s of sections) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top < 160) cur = s.id
      }
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) cur = sections[sections.length - 1].id
      setActive(cur)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [sections])
  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    history.replaceState(null, '', `#${id}`)
  }
  return (
    <aside className="rail" aria-label="Sections on this page">
      {title && <h6 className="caps">{title}</h6>}
      <ol>
        {sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} aria-current={active === s.id ? 'location' : undefined} className={cx(active === s.id && 'on')} onClick={(e) => { e.preventDefault(); jump(s.id) }}>
              <Icon name={s.icon} />{s.label}
              {s.count != null && <span className="count">{s.count}</span>}
              {s.flag != null && <span className="flag">{s.flag}</span>}
            </a>
          </li>
        ))}
      </ol>
      {children}
    </aside>
  )
}

/* Scroll to hash target after route change */
export function useHashScroll() {
  const { hash, search } = useLocation()
  useEffect(() => {
    const id = hash.slice(1)
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 60)
    else if (!search) window.scrollTo(0, 0)
  }, [hash, search])
}

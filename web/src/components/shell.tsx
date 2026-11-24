/* AppShell: TopNav (4 areas + utilities), SectionRail (page sections, scroll-spy), command palette. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { EVENTS, POSITIONS } from '../data/portfolio'
import { ConnectProvider, useConnect } from './ConnectSources'
import { Icon, type IconName } from './Icon'
import { Layer, Menu, ToastProvider, useToast } from './overlays'
import { cx } from './ui'

const AREAS = [
  { to: '/overview', label: 'Overview' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/risk', label: 'Risk' },
  { to: '/scenario-lab', label: 'Scenario Lab', lab: true },
]

function Logo() {
  return <img className="brand-logo" src="/brand/scevia-logo.png" srcSet="/brand/scevia-logo@2x.png 2x" alt="Scevia" height={28} />
}

const NOTIFS = [
  { icon: 'cal' as IconName, tone: 'warn', title: 'ETH ETF flows resolves in 8 days', sub: '$1,575 at stake · Kalshi', to: '/risk#calendar' },
  { icon: 'trend' as IconName, tone: 'gain', title: 'Shutdown YES moved 0.41 → 0.47', sub: '+$420 unrealized', to: '/overview#holdings' },
  { icon: 'alert' as IconName, tone: 'warn', title: '2 settlements missing fee detail', sub: 'Kalshi CSV · net P&L may be off ≤ $6', to: '/overview#coverage' },
]

function TopNav({ onSearch }: { onSearch: () => void }) {
  const nav = useNavigate()
  const toast = useToast()
  const connect = useConnect()
  const [synced, setSynced] = useState('4m ago')
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
        <button type="button" className="search" onClick={onSearch}><Icon name="search" size={15} /><span>Search markets, positions…</span><kbd>⌘K</kbd></button>
        <button type="button" className="sync" title="Sync now" onClick={() => { setSynced('just now'); toast('Synced Polymarket · no new fills', 'info') }}>
          <span className="dot" />Synced {synced}
        </button>
        <span className="chip accent">Sample data</span>
        <Menu width={300} trigger={({ toggle }) => <button type="button" className="icon-btn" aria-label="Help" onClick={toggle}><Icon name="help" size={18} /></button>}>
          {(close) => (<>
            <div className="menu-h">Help</div>
            <button type="button" className="menu-i" onClick={() => { close(); onSearch() }}><Icon name="search" />Search & jump <kbd className="kbd">⌘K</kbd></button>
            <button type="button" className="menu-i" onClick={close}><Icon name="info" />How Scevia calculates P&amp;L</button>
            <button type="button" className="menu-i" onClick={close}><Icon name="shield" />Privacy & data deletion</button>
          </>)}
        </Menu>
        <Menu width={340} trigger={({ toggle }) => <button type="button" className="icon-btn has-badge" aria-label="Notifications" onClick={toggle}><Icon name="bell" size={18} /><span className="badge" /></button>}>
          {(close) => (<>
            <div className="menu-h">Notifications <button type="button" className="link" onClick={close}>Mark all read</button></div>
            {NOTIFS.map((n) => (
              <button type="button" key={n.title} className="menu-i notif" onClick={() => { close(); nav(n.to) }}>
                <span className={`ic ${n.tone}`}><Icon name={n.icon} size={14} /></span><span><b>{n.title}</b><small>{n.sub}</small></span>
              </button>
            ))}
          </>)}
        </Menu>
        <Menu width={260} trigger={({ toggle }) => <button type="button" className="icon-btn" aria-label="Settings" onClick={toggle}><Icon name="gear" size={18} /></button>}>
          {(close) => (<>
            <div className="menu-h">Settings</div>
            <button type="button" className="menu-i" onClick={() => { close(); connect() }}><Icon name="link" />Connected sources</button>
            <button type="button" className="menu-i" onClick={close}><Icon name="shield" />Guardrails</button>
            <button type="button" className="menu-i" onClick={close}><Icon name="db" />Data & privacy</button>
          </>)}
        </Menu>
        <Menu width={250} trigger={({ toggle }) => <button type="button" className="avatar" aria-label="Account" onClick={toggle}>AR</button>}>
          {(close) => (<>
            <div className="menu-h"><span>Alex R.<small>Sample workspace</small></span></div>
            <button type="button" className="menu-i" onClick={close}><Icon name="logout" />Sign out</button>
          </>)}
        </Menu>
      </div>
    </header>
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
      ...EVENTS.map((e) => ({ group: 'Events', label: e.name, sub: `resolves ${e.resolves}`, to: `/risk?event=${e.id}#payoffs`, icon: 'shield' as IconName })),
    ]
    const s = q.trim().toLowerCase()
    return (s ? all.filter((x) => x.label.toLowerCase().includes(s)) : all).slice(0, 12)
  }, [q])
  const go = (to: string) => { onClose(); nav(to) }
  return (
    <Layer onClose={onClose} kind="palette">
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette-in"><Icon name="search" size={16} />
          <input autoFocus placeholder="Search markets, positions, events…" value={q}
            onChange={(e) => { setQ(e.target.value); setI(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, items.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)) }
              if (e.key === 'Enter' && items[i]) go(items[i].to)
            }} />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="palette-list">
          {items.length === 0 && <div className="empty"><p>No matches for “{q}”.</p></div>}
          {items.map((it, k) => (
            <div key={it.group + it.label}>
              {(k === 0 || items[k - 1].group !== it.group) && <div className="palette-g">{it.group}</div>}
              <button type="button" className={cx('palette-i', k === i && 'on')} onMouseEnter={() => setI(k)} onClick={() => go(it.to)}>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <ToastProvider>
      <ConnectProvider>
        <TopNav onSearch={() => setPalette(true)} />
        <Outlet />
        {palette && <CommandPalette onClose={() => setPalette(false)} />}
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
    <aside className="rail">
      {title && <h6 className="caps">{title}</h6>}
      <ol>
        {sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} className={cx(active === s.id && 'on')} onClick={(e) => { e.preventDefault(); jump(s.id) }}>
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

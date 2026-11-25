/* AppShell: TopNav (4 areas + utilities), SectionRail (page sections, scroll-spy), command palette. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LAST_VISIT, TODAY } from '../data/portfolio'
import { PLATFORM_NAME } from '../data/labels'
import { ACCOUNTS, POSITIONS, account, exposures, fmtDate, sourceOf } from '../lib/finance'
import { fmt, sfmt } from '../lib/format'
import { ConnectProvider, useConnect } from './ConnectSources'
import { DetailProvider, useDetails, type Detail } from './details'
import { SettingsProvider, useSettings, type SettingsTab } from '../lib/settings'
import { SettingsModal } from './Settings'
import { Icon, type IconName } from './Icon'
import { Layer, Menu, Modal, ToastProvider } from './overlays'
import { PlatformBadge, cx } from './ui'

const AREAS = [
  { to: '/overview', label: 'Overview' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/risk', label: 'Risk' },
  { to: '/scenario-lab', label: 'Scenario Lab', lab: true },
]

function Logo() {
  return <img className="brand-logo" src="/brand/scevia-logo.png" srcSet="/brand/scevia-logo@2x.png 2x" alt="Scevia" height={28} />
}

/** Alerts, filtered by the user's alert settings. Each one opens the thing it is about in place. */
function useNotifications() {
  const { settings } = useSettings()
  const { resolvingWithin, priceMove, feeEstimates } = settings.alerts
  return useMemo(() => {
    const out: { icon: IconName; tone: string; title: string; sub: string; detail?: Detail; to?: string }[] = []
    if (resolvingWithin > 0) for (const p of [...POSITIONS].filter((x) => x.days <= resolvingWithin).sort((x, y) => x.days - y.days).slice(0, 2))
      out.push({ icon: 'cal', tone: 'warn', title: `${p.market} resolves in ${p.days} days`, sub: `${fmt(p.cost)} at stake · ${PLATFORM_NAME[p.platform]} · view event`, detail: { kind: 'event', id: p.eventId } })
    if (priceMove > 0) {
      const mover = [...POSITIONS].sort((x, y) => Math.abs((y.mark - y.markAtLastVisit) * y.shares) - Math.abs((x.mark - x.markAtLastVisit) * x.shares))[0]
      const moved = (mover.mark - mover.markAtLastVisit) * mover.shares
      if (Math.abs(moved) >= priceMove) out.push({ icon: 'trend', tone: moved >= 0 ? 'gain' : 'loss', title: `${mover.market} ${mover.side}: ${mover.markAtLastVisit.toFixed(2)} → ${mover.mark.toFixed(2)}`, sub: `${sfmt(moved)} since ${fmtDate(LAST_VISIT)} · view position`, detail: { kind: 'position', id: mover.id } })
    }
    const est = account().feeEstimates
    if (feeEstimates && est) out.push({ icon: 'alert', tone: 'warn', title: `${est} settlements have estimated fees`, sub: 'Kalshi · marked as estimates in net P&L · go to Overview › Data coverage', to: '/overview#coverage' })
    return out
  }, [resolvingWithin, priceMove, feeEstimates])
}

const DEFINITIONS: [string, string][] = [
  ['Portfolio value', 'Cash + open positions at their mark price (last traded price on the platform).'],
  ['Net deposits', 'Deposits − withdrawals. Never counted as performance.'],
  ['Net P&L', 'Realized P&L + unrealized P&L. Equals portfolio value − net deposits.'],
  ['Realized P&L', 'Closed trades: shares × (exit − entry) − that trade’s fees.'],
  ['Unrealized P&L', 'Open positions: shares × mark − cost basis (after purchase fees).'],
  ['Cost basis / committed', 'Shares × fill price + purchase fees of open positions (weighted average). The most an open position can lose at settlement.'],
  ['Settlement payoff', 'A contract pays $1 per share if its side wins and $0 otherwise. Scevia never assigns probabilities.'],
]

function TopNav({ onSearch, onInfo }: { onSearch: () => void; onInfo: () => void }) {
  const nav = useNavigate()
  const details = useDetails()
  const connect = useConnect()
  const { open: openSettings } = useSettings()
  const notifs = useNotifications()
  const sig = notifs.map((n) => n.title).join('|')
  const [readSig, setReadSig] = useState<string | null>(null)
  const read = notifs.length === 0 || readSig === sig
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
        <button type="button" className="search" onClick={onSearch} aria-keyshortcuts="Meta+K" aria-label="Search pages, positions, events"><Icon name="search" size={15} /><span>Search pages, positions, events…</span><kbd>⌘K</kbd></button>
        {/* Portfolio: what the figures are based on, its accounts and their freshness, and where to manage them. */}
        <Menu label="Portfolio" width={320} trigger={(t) => <button type="button" className="chip accent chip-btn" aria-label="Portfolio and data sources" {...t}>Sample portfolio<span className="chip-date"> · {fmtDate(TODAY)}</span></button>}>
          {(close) => (<>
            <div className="menu-h"><span>Sample portfolio<small>Fictional data · as of {fmtDate(TODAY)} · no account connected</small></span></div>
            {ACCOUNTS.map((a) => { const src = sourceOf(a.venue); return (
              <div className="menu-row acct-row" key={a.id}><span className="row"><PlatformBadge p={a.venue} size={18} />{PLATFORM_NAME[a.venue]} · {a.label}</span><small className={src.stale ? 'stale' : 't3'}>{src.stale ? 'stale · ' : ''}{fmtDate(src.asOf)}</small></div>
            ) })}
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); connect() }}><Icon name="link" />Data sources</button>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); nav('/accounts') }}><Icon name="list" />Accounts &amp; records<small className="t3" style={{ marginLeft: 'auto' }}>sample</small></button>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); nav('/overview#coverage') }}><Icon name="db" />Data coverage</button>
          </>)}
        </Menu>
        <Menu label="Help" width={300} trigger={(t) => <button type="button" className="icon-btn" aria-label="Help" {...t}><Icon name="help" size={18} /></button>}>
          {(close) => (<>
            <div className="menu-h">Help</div>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); onSearch() }}><Icon name="search" />Search<kbd className="kbd" style={{ marginLeft: 'auto' }}>⌘K</kbd></button>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); onInfo() }}><Icon name="info" />How Scevia calculates</button>
            <div className="menu-sep" />
            <div className="menu-row t3"><span>Close a panel or dialog</span><kbd className="kbd">esc</kbd></div>
          </>)}
        </Menu>
        <Menu label="Notifications" width={360} trigger={(t) => <button type="button" className={cx('icon-btn', !read && 'has-badge')} aria-label={`Notifications${read ? '' : `, ${notifs.length} unread`}`} {...t}><Icon name="bell" size={18} />{!read && <span className="badge" />}</button>}>
          {(close) => (<>
            <div className="menu-h">Notifications <button type="button" role="menuitem" className="link" onClick={() => setReadSig(sig)} disabled={read}>{read ? 'All read' : 'Mark all read'}</button></div>
            {notifs.length === 0 && <div className="menu-row t3">No alerts with your current settings.</div>}
            {notifs.map((n) => (
              <button type="button" role="menuitem" key={n.title} className="menu-i notif" onClick={() => { close(); setReadSig(sig); if (n.detail) details.open(n.detail); else if (n.to) nav(n.to) }}>
                <span className={`ic ${n.tone}`}><Icon name={n.icon} size={14} /></span><span><b>{n.title}</b><small>{n.sub}</small></span>
              </button>
            ))}
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); openSettings('Alerts') }}><Icon name="gear" />Alert settings</button>
          </>)}
        </Menu>
        <button type="button" className="icon-btn" aria-label="Settings" onClick={() => openSettings('General')}><Icon name="gear" size={18} /></button>
        <Menu label="Profile" width={280} trigger={(t) => <button type="button" className="avatar" aria-label="Profile" {...t}><Icon name="user" size={16} /></button>}>
          {(close) => (<>
            <div className="menu-h"><span>Not signed in<small>Sample workspace in this browser tab</small></span></div>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); openSettings('General') }}><Icon name="gear" />Settings</button>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); openSettings('Data & privacy') }}><Icon name="shield" />Data &amp; privacy</button>
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-i" disabled title="Accounts and sign-in aren’t available in this version"><Icon name="user" />Sign in<small className="t3" style={{ marginLeft: 'auto' }}>not available yet</small></button>
          </>)}
        </Menu>
      </div>
    </header>
  )
}

function CalcModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="How Scevia calculates" sub="The same definitions are used on every page" onClose={onClose} width={600}>
      {DEFINITIONS.map(([k, v]) => <div className="list-row" key={k}><b style={{ minWidth: 170, fontWeight: 'var(--font-weight-medium)' }}>{k}</b><span className="t2">{v}</span></div>)}
    </Modal>
  )
}

/* ⌘K palette. Pages navigate; positions and events open their detail panel in place (never change a scenario). */
type PaletteItem = { group: string; label: string; sub: string; icon: IconName } & ({ to: string } | { detail: Detail })
function CommandPalette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate()
  const details = useDetails()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const items = useMemo(() => {
    const all: PaletteItem[] = [
      ...AREAS.map((a) => ({ group: 'Go to page', label: a.label, sub: 'page', to: a.to, icon: 'arrowRight' as IconName })),
      ...POSITIONS.map((p) => ({ group: 'Positions · view details', label: p.market, sub: `${p.side} · ${p.shares.toLocaleString()} shares`, detail: { kind: 'position', id: p.id } as Detail, icon: 'layers' as IconName })),
      ...exposures().map((x) => ({ group: 'Events · view exposure', label: x.event.name, sub: `resolves ${fmtDate(x.resolves)}`, detail: { kind: 'event', id: x.event.id } as Detail, icon: 'shield' as IconName })),
    ]
    const s = q.trim().toLowerCase()
    return (s ? all.filter((x) => x.label.toLowerCase().includes(s)) : all).slice(0, 12)
  }, [q])
  const go = (it: PaletteItem) => { onClose(); if ('to' in it) nav(it.to); else details.open(it.detail) }
  return (
    <Layer onClose={onClose} kind="palette" label="Search">
      <div className="palette">
        <div className="palette-in"><Icon name="search" size={16} />
          <input data-autofocus aria-label="Search pages, positions and events" aria-controls="palette-list" placeholder="Search pages, positions, events…" value={q}
            onChange={(e) => { setQ(e.target.value); setI(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, items.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)) }
              if (e.key === 'Enter' && items[i]) { e.preventDefault(); go(items[i]) }
            }} />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Results">
          {items.length === 0 && <div className="empty"><p>No matches for “{q}”.</p></div>}
          {items.map((it, k) => (
            <div key={it.group + it.label}>
              {(k === 0 || items[k - 1].group !== it.group) && <div className="palette-g">{it.group}</div>}
              <button type="button" role="option" aria-selected={k === i} className={cx('palette-i', k === i && 'on')} onMouseEnter={() => setI(k)} onClick={() => go(it)}>
                <Icon name={it.icon} size={15} /><span>{it.label}</span><small>{it.sub}</small>
              </button>
            </div>
          ))}
        </div>
        <div className="palette-f"><span><kbd className="kbd">↑↓</kbd> navigate</span><span><kbd className="kbd">↵</kbd> open</span><span>Positions and events open in a panel on this page</span></div>
      </div>
    </Layer>
  )
}

export function AppLayout() {
  const [palette, setPalette] = useState(false)
  const [calc, setCalc] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <ToastProvider>
      <SettingsProvider onOpen={setSettingsTab}>
      <ConnectProvider>
        <DetailProvider>
        <TopNav onSearch={() => setPalette(true)} onInfo={() => setCalc(true)} />
        <Outlet />
        {palette && <CommandPalette onClose={() => setPalette(false)} />}
        {calc && <CalcModal onClose={() => setCalc(false)} />}
        {settingsTab && <SettingsModal tab={settingsTab} onClose={() => setSettingsTab(null)} />}
        </DetailProvider>
      </ConnectProvider>
      </SettingsProvider>
    </ToastProvider>
  )
}

/* Section rail.
   Sections that share a row are one group (the row container) with child entries for each card.
   Clicking an entry scrolls to it, focuses and briefly highlights the card, and keeps that entry active
   until the user scrolls on their own. Scroll-spy works on groups (rows), so cards side by side never
   compete, and reaching the bottom of the page never overrides an explicit choice. */
export interface RailChild { id: string; label: string }
export interface RailSection { id: string; label: string; icon: IconName; count?: number; flag?: number | string; children?: RailChild[] }

/** Distance from the top of the viewport at which a section counts as "current": below whatever is sticky
 *  (top bar, and the rail itself when it becomes a horizontal bar on narrow screens) plus some reading room. */
function spyOffset() {
  const bottomIfSticky = (sel: string, wide = false) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el || getComputedStyle(el).position !== 'sticky') return 0
    const r = el.getBoundingClientRect()
    return !wide || r.width > window.innerWidth / 2 ? r.bottom : 0
  }
  return Math.max(bottomIfSticky('.topbar'), bottomIfSticky('.rail', true)) + 96
}
const SECTION_EVENT = 'scevia:section'
/** Jump to a section from anywhere on the page (e.g. "Show in Holdings"). Goes through the rail so its active
 *  entry, focus and highlight behave exactly like a rail click. */
export function scrollToSection(id: string) {
  window.dispatchEvent(new CustomEvent(SECTION_EVENT, { detail: id }))
}
function flash(el: HTMLElement) {
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
  el.classList.remove('section-flash')
  void el.offsetWidth
  el.classList.add('section-flash')
  window.setTimeout(() => el.classList.remove('section-flash'), 1400)
}

export function SectionRail({ title, sections, children }: { title?: string; sections: RailSection[]; children?: ReactNode }) {
  const [active, setActive] = useState<{ group: string; child: string | null }>({ group: sections[0]?.id, child: null })
  const locked = useRef(false)
  const { hash } = useLocation()

  const resolve = useCallback((id: string) => {
    for (const s of sections) {
      if (s.id === id) return { group: s.id, child: null }
      if (s.children?.some((c) => c.id === id)) return { group: s.id, child: id }
    }
    return null
  }, [sections])

  const go = useCallback((id: string, smooth = true) => {
    const target = resolve(id), el = document.getElementById(id)
    if (!target || !el) return
    locked.current = true
    setActive(target)
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
    flash(el)
  }, [resolve])

  // Scroll-spy on groups; paused while an explicit choice is locked in.
  useEffect(() => {
    const onScroll = () => {
      if (locked.current) return
      let cur = sections[0]?.id
      const offset = spyOffset()
      for (const s of sections) { const el = document.getElementById(s.id); if (el && el.getBoundingClientRect().top < offset) cur = s.id }
      setActive((a) => (a.group === cur ? a : { group: cur, child: null }))
    }
    const release = () => { locked.current = false }
    const releaseKeys = (e: KeyboardEvent) => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key) && !(e.target as HTMLElement).closest('input, textarea, select, [role="slider"]')) release() }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('wheel', release, { passive: true })
    window.addEventListener('touchmove', release, { passive: true })
    window.addEventListener('keydown', releaseKeys)
    // Dragging the page scrollbar (a press on the document itself) and Back/Forward are the user's own navigation too.
    const releaseBar = (e: PointerEvent) => { if (e.target === document.documentElement) release() }
    const releaseNav = () => { release(); onScroll() }
    window.addEventListener('pointerdown', releaseBar)
    window.addEventListener('popstate', releaseNav)
    return () => {
      window.removeEventListener('scroll', onScroll); window.removeEventListener('wheel', release); window.removeEventListener('touchmove', release); window.removeEventListener('keydown', releaseKeys)
      window.removeEventListener('pointerdown', releaseBar); window.removeEventListener('popstate', releaseNav)
    }
  }, [sections])

  // Programmatic jumps from page content.
  useEffect(() => {
    const onJump = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (resolve(id)) { history.replaceState(null, '', `${location.pathname}${location.search}#${id}`); go(id) } else document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
    window.addEventListener(SECTION_EVENT, onJump)
    return () => window.removeEventListener(SECTION_EVENT, onJump)
  }, [resolve, go])

  // Direct links (#section) use the same path as clicks.
  useEffect(() => {
    const id = hash.slice(1)
    if (id && resolve(id)) { const t = window.setTimeout(() => go(id, false), 60); return () => window.clearTimeout(t) }
  }, [hash, resolve, go])

  const click = (e: React.MouseEvent, id: string) => { e.preventDefault(); history.replaceState(null, '', `${location.pathname}${location.search}#${id}`); go(id) }
  return (
    <aside className="rail" aria-label="Sections on this page">
      {title && <h6 className="caps">{title}</h6>}
      <ol>
        {sections.map((s) => {
          const on = active.group === s.id
          return (
            <li key={s.id}>
              <a href={`#${s.id}`} aria-current={on && !active.child ? 'location' : undefined} className={cx(on && 'on', on && active.child && 'on-parent')} onClick={(e) => click(e, s.id)}>
                <Icon name={s.icon} />{s.label}
                {s.count != null && <span className="count">{s.count}</span>}
                {s.flag != null && <span className="flag">{s.flag}</span>}
              </a>
              {s.children && (
                <ol className="rail-sub">
                  {s.children.map((c) => (
                    <li key={c.id}><a href={`#${c.id}`} aria-current={on && active.child === c.id ? 'location' : undefined} className={cx(on && active.child === c.id && 'on')} onClick={(e) => click(e, c.id)}>{c.label}</a></li>
                  ))}
                </ol>
              )}
            </li>
          )
        })}
      </ol>
      {children}
    </aside>
  )
}

/* Scroll to the top on page entry; #hash targets are handled by SectionRail. */
export function useHashScroll() {
  const { hash, search, pathname } = useLocation()
  useEffect(() => { if (!hash) window.scrollTo(0, 0) }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps
  void hash; void search
}

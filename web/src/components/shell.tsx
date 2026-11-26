/* AppShell: TopNav (4 analytical areas + one utility per user need), global search, help, settings, account.
   Utilities: Search (find anything) · Portfolio (what you're analyzing and what it's made of) · Help (how Scevia works) ·
   Notifications (what happened) · Settings (how the workspace behaves) · Account (who you are, your data). */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { TODAY } from '../data/portfolio'
import { PLATFORM_NAME } from '../data/labels'
import { ACCOUNTS, POSITIONS, exposures, fmtDate, sourceOf } from '../lib/finance'
import { qty } from '../lib/format'
import { TYPE_LABEL } from '../lib/records'
import { SettingsProvider, useSettings, type SettingsTab } from '../lib/settings'
import { readStored } from '../lib/storage'
import { accountName, useWorkspaceSnapshot } from '../lib/useWorkspace'
import { AccountMenu, PrivacyDialog } from './Account'
import { DetailProvider, useDetails, type Detail } from './details'
import { HelpCentre, type HelpTab } from './Help'
import { Icon, type IconName } from './Icon'
import { NotificationCentre } from './Notifications'
import { Layer, Menu, ToastProvider } from './overlays'
import { SettingsModal } from './Settings'
import { PlatformBadge, cx } from './ui'

const AREAS = [
  { to: '/overview', label: 'Overview' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/risk', label: 'Risk' },
  { to: '/scenario-lab', label: 'Scenario Lab', lab: true },
]
const PORTFOLIO_SECTIONS: { id: string; label: string; icon: IconName; sub: string }[] = [
  { id: 'accounts', label: 'Accounts', icon: 'db', sub: 'wallets and venue logins' },
  { id: 'sources', label: 'Sources', icon: 'link', sub: 'connections, CSV, manual' },
  { id: 'transactions', label: 'Transactions', icon: 'list', sub: 'records and decisions' },
  { id: 'imports', label: 'Imports & reconciliation', icon: 'download', sub: 'batches and review' },
  { id: 'coverage', label: 'Data coverage', icon: 'shield', sub: 'what figures are based on' },
]

function Logo() {
  return <img className="brand-logo" src="/brand/scevia-logo.png" srcSet="/brand/scevia-logo@2x.png 2x" alt="Scevia" height={28} />
}

interface Overlays { search: () => void; help: (t: HelpTab) => void; privacy: () => void }

function TopNav({ open }: { open: Overlays }) {
  const nav = useNavigate()
  const { open: openSettings } = useSettings()
  const stale = ACCOUNTS.filter((a) => sourceOf(a.venue).stale).length
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
        <button type="button" className="search" onClick={open.search} aria-keyshortcuts="Meta+K Control+K" aria-label="Search"><Icon name="search" size={15} /><span>Search Scevia…</span><kbd>⌘K</kbd></button>
        <Menu label="Portfolio" width={340} trigger={(t) => <button type="button" className="chip accent chip-btn" aria-label="Portfolio: Sample portfolio" {...t}><span className="chip-long">Sample portfolio</span><span className="chip-short">Sample</span><span className="chip-date"> · {fmtDate(TODAY)}</span></button>}>
          {(close) => (<>
            <div className="menu-h"><span>Sample portfolio<small>Fictional data · valued at {fmtDate(TODAY)} marks · {ACCOUNTS.length} accounts{stale ? ` · ${stale} stale` : ''}</small></span></div>
            {ACCOUNTS.map((a) => { const src = sourceOf(a.venue); return (
              <div className="menu-row acct-row" key={a.id}><span className="row"><PlatformBadge p={a.venue} size={18} /><span className="acct-name">{accountName(a.id)}</span></span><small className={src.stale ? 'stale' : 't3'}>{src.stale ? 'stale · ' : ''}{fmtDate(src.asOf)}</small></div>
            ) })}
            <div className="menu-row t3 menu-note">This is your only portfolio. Separate portfolios come with a Scevia account.</div>
            <div className="menu-sep" />
            {PORTFOLIO_SECTIONS.map((s) => <button key={s.id} type="button" role="menuitem" className="menu-i" onClick={() => { close(); nav(`/portfolio/${s.id}`) }}><Icon name={s.icon} />{s.label}<small className="t3" style={{ marginLeft: 'auto' }}>{s.sub}</small></button>)}
          </>)}
        </Menu>
        <Menu label="Help" width={280} trigger={(t) => <button type="button" className="icon-btn" aria-label="Help" {...t}><Icon name="help" size={18} /></button>}>
          {(close) => (<>
            <div className="menu-h">Help</div>
            {(['Getting started', 'Guides', 'Methodology', 'Shortcuts'] as HelpTab[]).map((t) => <button key={t} type="button" role="menuitem" className="menu-i" onClick={() => { close(); open.help(t) }}><Icon name={t === 'Methodology' ? 'info' : t === 'Shortcuts' ? 'list' : t === 'Guides' ? 'layers' : 'flask'} />{t === 'Methodology' ? 'Methodology & glossary' : t === 'Shortcuts' ? 'Keyboard shortcuts' : t === 'Guides' ? 'User guide' : t}</button>)}
            <div className="menu-sep" />
            <a role="menuitem" className="menu-i" href="https://github.com/chin0312/scevia/issues" target="_blank" rel="noreferrer" onClick={() => close()}><Icon name="link" />Send feedback<small className="t3" style={{ marginLeft: 'auto' }}>GitHub ↗</small></a>
            <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); open.help('About') }}><Icon name="help" />About Scevia</button>
          </>)}
        </Menu>
        <NotificationCentre />
        <button type="button" className="icon-btn" aria-label="Settings" onClick={() => openSettings('General')}><Icon name="gear" size={18} /></button>
        <AccountMenu onPrivacy={open.privacy} />
      </div>
    </header>
  )
}

/* ⌘K global search: pages, portfolio sections, accounts, positions, events, records, scenarios, help and actions.
   Results are keyed by stable identity and carry the context that tells similar items apart (account, outcome).
   Positions and events open in a panel on the current page; nothing changes a scenario or a record. */
type Item = { id: string; group: string; label: string; sub: string; icon: IconName; keys: string; go: () => void }
const GROUPS = ['Actions', 'Pages', 'Portfolio', 'Accounts', 'Positions', 'Events', 'Transactions', 'Scenarios', 'Help']
const PER_GROUP = 5
function score(it: Item, terms: string[]) {
  const label = it.label.toLowerCase(), hay = `${label} ${it.sub.toLowerCase()} ${it.keys}`
  if (!terms.every((t) => hay.includes(t))) return 0
  const q = terms.join(' ')
  return (label.startsWith(q) ? 4 : label.split(/\W+/).some((w) => w.startsWith(terms[0])) ? 3 : label.includes(terms[0]) ? 2 : 1) + (it.group === 'Actions' ? 0.5 : 0)
}
function CommandPalette({ onClose, open }: { onClose: () => void; open: Overlays }) {
  const nav = useNavigate()
  const details = useDetails()
  const { open: openSettings } = useSettings()
  const ws = useWorkspaceSnapshot()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const [more, setMore] = useState<string | null>(null)
  const listId = useId()
  const items = useMemo(() => {
    const to = (path: string) => () => { onClose(); nav(path) }
    const det = (d: Detail) => () => { onClose(); details.open(d) }
    const run = (f: () => void) => () => { onClose(); f() }
    const scenarios = readStored<{ key: string; name: string; baseline?: string; adjs?: unknown[] }[]>('scevia-scenarios-v4', [], (v) => (Array.isArray(v) ? (v as { key: string; name: string }[]).filter((x) => x && typeof x.key === 'string' && typeof x.name === 'string') : null))
    const all: Item[] = [
      { id: 'act:manual', group: 'Actions', label: 'Add a manual record', sub: 'Portfolio · transactions', icon: 'plus', keys: 'new transaction trade deposit', go: to('/portfolio/transactions?action=manual') },
      { id: 'act:import', group: 'Actions', label: 'Import transactions (CSV)', sub: 'Portfolio · imports', icon: 'download', keys: 'csv file upload import', go: to('/portfolio/imports?action=import') },
      { id: 'act:review', group: 'Actions', label: 'Review records that need attention', sub: 'Portfolio · reconciliation', icon: 'list', keys: 'unresolved duplicates reconcile review', go: to('/portfolio/transactions?status=review') },
      { id: 'act:sources', group: 'Actions', label: 'Manage data sources', sub: 'Portfolio · sources', icon: 'link', keys: 'connect wallet kalshi polymarket', go: to('/portfolio/sources') },
      { id: 'act:scenario', group: 'Actions', label: 'Create a scenario', sub: 'Scenario Lab', icon: 'flask', keys: 'new what-if simulate', go: to('/scenario-lab') },
      { id: 'act:settings', group: 'Actions', label: 'Open settings', sub: 'Workspace preferences', icon: 'gear', keys: 'preferences defaults guardrail', go: run(() => openSettings('General')) },
      { id: 'act:notif', group: 'Actions', label: 'Notification preferences', sub: 'Settings', icon: 'bell', keys: 'alerts notifications', go: run(() => openSettings('Notifications')) },
      { id: 'act:privacy', group: 'Actions', label: 'Data & privacy', sub: 'Account', icon: 'shield', keys: 'clear data storage privacy', go: run(open.privacy) },
      ...AREAS.map((a) => ({ id: `page:${a.to}`, group: 'Pages', label: a.label, sub: 'Page', icon: 'home' as IconName, keys: '', go: to(a.to) })),
      ...PORTFOLIO_SECTIONS.map((s) => ({ id: `pf:${s.id}`, group: 'Portfolio', label: s.label, sub: s.sub, icon: s.icon, keys: 'portfolio manage', go: to(`/portfolio/${s.id}`) })),
      ...ws.accounts.map((a) => ({ id: `acct:${a.id}`, group: 'Accounts', label: a.label, sub: `${PLATFORM_NAME[a.venue]} · ${a.kind}${a.inAnalytics ? '' : ' · records only'}`, icon: 'db' as IconName, keys: `${PLATFORM_NAME[a.venue]} ${a.connection ?? ''} account wallet`.toLowerCase(), go: to(`/portfolio/transactions?account=${encodeURIComponent(a.id)}`) })),
      ...POSITIONS.map((p) => ({ id: `pos:${p.id}`, group: 'Positions', label: p.market, sub: `${p.side} · ${qty(p.shares)} shares · ${PLATFORM_NAME[p.platform]} · ${accountName(p.accountId)}`, icon: 'layers' as IconName, keys: `${p.category} ${p.eventId} ${p.side}`.toLowerCase(), go: det({ kind: 'position', id: p.id }) })),
      ...exposures().map((x) => ({ id: `evt:${x.event.id}`, group: 'Events', label: x.event.name, sub: `${x.positions.length} contract${x.positions.length > 1 ? 's' : ''} · resolves ${fmtDate(x.resolves)}`, icon: 'target' as IconName, keys: `${x.event.short} ${x.event.category}`.toLowerCase(), go: det({ kind: 'event', id: x.event.id }) })),
      ...ws.records.map((r) => { const a = ws.accounts.find((x) => x.id === r.accountId); return { id: `rec:${r.key}`, group: 'Transactions', label: `${TYPE_LABEL[r.type]}${r.instrument ? ` · ${r.instrument} ${r.side ?? ''}` : ''}`, sub: `${a?.label ?? ''} · ${fmtDate(r.time.slice(0, 10))} · ${r.key}`, icon: 'list' as IconName, keys: `${r.key} ${r.sourceRef} ${r.batchId ?? ''} record transaction`.toLowerCase(), go: to(`/portfolio/transactions?q=${encodeURIComponent(r.key)}`) } }),
      ...scenarios.map((s) => ({ id: `scn:${s.key}`, group: 'Scenarios', label: s.name, sub: `Scenario · ${s.baseline === 'scratch' ? 'from scratch' : 'from current portfolio'} · ${s.adjs?.length ?? 0} positions`, icon: 'flask' as IconName, keys: 'scenario', go: to(`/scenario-lab?open=${encodeURIComponent(s.key)}`) })),
      ...([['Getting started', 'Getting started', 'how start tour'], ['Methodology', 'Methodology & glossary', 'cost basis pnl return drawdown definition calculate fees'], ['Shortcuts', 'Keyboard shortcuts', 'keys keyboard'], ['Guides', 'User guide', 'help guide']] as [HelpTab, string, string][])
        .map(([t, l, k]) => ({ id: `help:${t}`, group: 'Help', label: l, sub: 'Help', icon: 'help' as IconName, keys: k, go: run(() => open.help(t)) })),
    ]
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return all.filter((x) => x.group === 'Actions' || x.group === 'Pages' || x.group === 'Portfolio').map((x) => ({ ...x, more: 0 }))
    const ranked = all.map((x) => ({ x, s: score(x, terms) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s)
    return GROUPS.flatMap((g) => {
      const inG = ranked.filter((r) => r.x.group === g)
      const shown = more === g ? inG : inG.slice(0, PER_GROUP)
      return shown.map((r, k) => ({ ...r.x, more: k === shown.length - 1 ? inG.length - shown.length : 0 }))
    })
  }, [q, more, ws, nav, details, onClose, openSettings, open])
  const sel = Math.min(i, items.length - 1)
  const activeId = items[sel] ? `${listId}-${sel}` : undefined
  return (
    <Layer onClose={onClose} kind="palette" label="Search">
      <div className="palette">
        <div className="palette-in"><Icon name="search" size={16} />
          <input data-autofocus role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label="Search Scevia" aria-controls={listId} aria-activedescendant={activeId} placeholder="Search positions, events, accounts, records, scenarios, help…" value={q}
            onChange={(e) => { setQ(e.target.value); setI(0); setMore(null) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, items.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)) }
              if (e.key === 'Enter' && items[sel]) { e.preventDefault(); items[sel].go() }
            }} />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="palette-list" id={listId} role="listbox" aria-label="Results">
          {items.length === 0 && <div className="empty"><p>No matches for “{q}”.</p><small className="t3">Searches pages, portfolio, accounts, positions, events, records, scenarios and help. To find markets to add, use Add markets in Scenario Lab.</small></div>}
          {items.map((it, k) => (
            <div key={it.id}>
              {(k === 0 || items[k - 1].group !== it.group) && <div className="palette-g" role="presentation">{q.trim() ? it.group : k === 0 ? 'Suggested' : it.group === 'Pages' ? 'Pages' : it.group}</div>}
              <button type="button" role="option" id={`${listId}-${k}`} aria-selected={k === sel} className={cx('palette-i', k === sel && 'on')} onMouseEnter={() => setI(k)} onClick={it.go} tabIndex={-1}>
                <Icon name={it.icon} size={15} /><span className="pi-l">{it.label}</span><small>{it.sub}</small>
              </button>
              {it.more > 0 && <button type="button" className="link palette-more" onClick={() => setMore(it.group)}>Show {it.more} more {it.group.toLowerCase()}</button>}
            </div>
          ))}
        </div>
        <div className="palette-f" aria-live="polite"><span><kbd className="kbd">↑↓</kbd> navigate</span><span><kbd className="kbd">↵</kbd> open</span><span>{q.trim() ? `${items.length} result${items.length === 1 ? '' : 's'} shown` : 'Positions and events open in a panel on this page'}</span></div>
      </div>
    </Layer>
  )
}

export function AppLayout() {
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState<HelpTab | null>(null)
  const [privacy, setPrivacy] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const open = useMemo<Overlays>(() => ({ search: () => setPalette(true), help: (t) => setHelp(t), privacy: () => setPrivacy(true) }), [])
  return (
    <ToastProvider>
      <SettingsProvider onOpen={setSettingsTab}>
        <DetailProvider>
        <TopNav open={open} />
        <Outlet />
        {palette && <CommandPalette onClose={() => setPalette(false)} open={open} />}
        {help && <HelpCentre tab={help} onClose={() => setHelp(null)} />}
        {privacy && <PrivacyDialog onClose={() => setPrivacy(false)} />}
        {settingsTab && <SettingsModal tab={settingsTab} onClose={() => setSettingsTab(null)} />}
        </DetailProvider>
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

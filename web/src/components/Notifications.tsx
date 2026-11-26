/* Notification centre (bell). All / Unread, a category filter, per-notification read state, mark all read, and a link
   to the notification preferences in Settings. Opening a notification marks only that one as read. */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CATEGORY_LABEL, deriveNotifications, type NotifCategory, type Notif } from '../lib/notifications'
import { useSettings } from '../lib/settings'
import { useSessionState } from '../lib/useSessionState'
import { WORKSPACE_EVENT, readLocalEvents, useWorkspaceSnapshot } from '../lib/useWorkspace'
import { useDetails } from './details'
import { Icon } from './Icon'
import { Menu } from './overlays'
import { cx } from './ui'

const ago = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function useNotificationsList() {
  const { settings } = useSettings()
  const ws = useWorkspaceSnapshot()
  const [local, setLocal] = useState(readLocalEvents)
  useEffect(() => { const on = () => setLocal(readLocalEvents()); window.addEventListener(WORKSPACE_EVENT, on); return () => window.removeEventListener(WORKSPACE_EVENT, on) }, [])
  const list = useMemo(() => deriveNotifications(settings, ws.records, local, new Set(ws.batches.map((b) => b.id))), [settings, ws.records, ws.batches, local])
  const [read, setRead] = useSessionState<string[]>('scevia-notif-read', [], (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null))
  const readSet = new Set(read)
  const markRead = (ids: string[]) => setRead((r) => [...new Set([...r, ...ids])].slice(-500))
  return { list, isRead: (n: Notif) => readSet.has(n.id), markRead, unread: list.filter((n) => !readSet.has(n.id)).length }
}

export function NotificationCentre() {
  const nav = useNavigate()
  const details = useDetails()
  const { open: openSettings } = useSettings()
  const { list, isRead, markRead, unread } = useNotificationsList()
  const [show, setShow] = useState<'All' | 'Unread'>('All')
  const [cat, setCat] = useState<NotifCategory | 'all'>('all')
  const cats = [...new Set(list.map((n) => n.category))]
  const shown = list.filter((n) => (show === 'All' || !isRead(n)) && (cat === 'all' || n.category === cat))
  return (
    <Menu label="Notifications" width={400} trigger={(t) => <button type="button" className={cx('icon-btn', unread > 0 && 'has-badge')} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} {...t}><Icon name="bell" size={18} />{unread > 0 && <span className="badge" />}</button>}>
      {(close) => (<>
        <div className="menu-h">Notifications <button type="button" role="menuitem" className="link" onClick={() => markRead(list.map((n) => n.id))} disabled={!unread}>{unread ? 'Mark all read' : 'All read'}</button></div>
        <div className="notif-filters">
          <div className="seg" role="group" aria-label="Show">{(['All', 'Unread'] as const).map((o) => <button key={o} type="button" role="menuitemradio" aria-checked={show === o} className={cx(show === o && 'on')} onClick={() => setShow(o)}>{o}{o === 'Unread' && unread ? ` · ${unread}` : ''}</button>)}</div>
          {cats.length > 1 && <select className="select" aria-label="Notification category" value={cat} onChange={(e) => setCat(e.target.value as NotifCategory | 'all')}><option value="all">All categories</option>{cats.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>}
        </div>
        <div className="notif-list">
          {shown.length === 0 && <div className="menu-row t3">{list.length === 0 ? 'No notifications with your current preferences.' : show === 'Unread' ? 'You’re all caught up.' : 'Nothing in this category.'}</div>}
          {shown.map((n) => (
            <div key={n.id} className={cx('notif-item', !isRead(n) && 'unread')}>
              <button type="button" role="menuitem" className="menu-i notif" onClick={() => { close(); markRead([n.id]); if (n.detail) details.open(n.detail); else if (n.to) nav(n.to) }}>
                <span className={`ic ${n.tone}`}><Icon name={n.icon} size={14} /></span>
                <span><b>{n.title}</b><small>{n.body}</small><small className="notif-meta">{CATEGORY_LABEL[n.category]} · {ago(n.at)} · {n.origin === 'sample' ? 'sample portfolio' : 'this tab'}</small></span>
              </button>
              {!isRead(n) && <button type="button" role="menuitem" className="icon-btn notif-dot" aria-label={`Mark “${n.title}” as read`} title="Mark as read" onClick={() => markRead([n.id])}><span /></button>}
            </div>
          ))}
        </div>
        <div className="menu-sep" />
        <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); openSettings('Notifications') }}><Icon name="gear" />Notification preferences</button>
        <div className="menu-row t3 notif-note">Shown while Scevia is open. Email and push aren’t available yet.</div>
      </>)}
    </Menu>
  )
}

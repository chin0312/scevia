/* Your Scevia account: personal identity, sign-in and data control. Not a financial account (those are in Portfolio).
   Sign-in isn't available yet, so the menu shows the guest state honestly and offers the one control that works:
   seeing and clearing what this browser tab keeps. */
import { useState } from 'react'
import { DATA_GROUPS, clearGroup, groupKeys, sceviaKeys, clearScevia, type DataGroup } from '../lib/storage'
import { Icon } from './Icon'
import { Menu, Modal, useToast } from './overlays'
import { Button, Callout } from './ui'

export function AccountMenu({ onPrivacy }: { onPrivacy: () => void }) {
  return (
    <Menu label="Account" width={280} trigger={(t) => <button type="button" className="avatar" aria-label="Account" {...t}><Icon name="user" size={16} /></button>}>
      {(close) => (<>
        <div className="menu-h"><span>Guest<small>Not signed in. Your workspace is kept in this tab</small></span></div>
        <button type="button" role="menuitem" className="menu-i" onClick={() => { close(); onPrivacy() }}><Icon name="shield" />Data &amp; privacy</button>
        <div className="menu-sep" />
        <button type="button" role="menuitem" className="menu-i" disabled title="Scevia accounts aren’t available yet"><Icon name="user" />Sign in<small className="t3" style={{ marginLeft: 'auto' }}>not available yet</small></button>
      </>)}
    </Menu>
  )
}

const GROUP_DESC: Record<DataGroup, string> = {
  preferences: 'Settings such as default scope, period, sizing, guardrail and notification preferences.',
  scenarios: 'Saved and unsaved Scenario Lab scenarios.',
  records: 'Sample accounts, records, decisions, corrections and import history in Portfolio.',
  notifications: 'Which notifications you’ve read, and local import activity.',
}

export function PrivacyDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [confirm, setConfirm] = useState<DataGroup | 'all' | null>(null)
  const total = sceviaKeys().length
  const run = () => {
    if (!confirm) return
    const r = confirm === 'all' ? clearScevia() : clearGroup(confirm)
    if (!r.ok) { toast('Couldn’t clear that data in this browser', 'info'); setConfirm(null); return }
    // Reload so no open view writes the cleared state back.
    onClose(); location.reload()
  }
  const label = confirm === 'all' ? 'everything Scevia keeps in this tab' : confirm ? DATA_GROUPS[confirm].label.toLowerCase() : ''
  return (
    <Modal title="Data & privacy" sub="Guest workspace in this browser tab" onClose={onClose} width={600}
      footer={confirm
        ? <><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" onClick={run}>Clear {confirm === 'all' ? 'everything' : DATA_GROUPS[confirm].label.toLowerCase()}</Button></>
        : <><Button variant="ghost" onClick={onClose}>Close</Button><Button onClick={() => setConfirm('all')} disabled={total === 0}>Clear everything…</Button></>}>
      <p className="t2">You’re viewing a <b>sample portfolio</b>; no Polymarket, Kalshi or other account is connected and no file has been uploaded. Scevia is read-only: it never places trades, holds funds, or asks for private keys or seed phrases.</p>
      <p className="t2">Everything below is kept only in this browser tab (session storage), isn’t sent to a server, and is removed when the tab closes. Signing in, cloud sync, export and account deletion aren’t available yet.</p>
      <div className="data-groups">
        {(Object.keys(DATA_GROUPS) as DataGroup[]).map((g) => { const n = groupKeys(g).length; return (
          <div key={g} className="src-row"><div><b>{DATA_GROUPS[g].label}</b><small className="t3">{GROUP_DESC[g]}</small></div>
            <span className="t3">{n ? 'Saved' : 'Nothing saved'}</span>
            <Button size="sm" variant="ghost" disabled={!n} onClick={() => setConfirm(g)} aria-label={`Clear ${DATA_GROUPS[g].label}`}>Clear…</Button></div>
        ) })}
      </div>
      {confirm && <Callout tone="warn" icon="alert">This removes {label}. It can’t be undone. {confirm === 'all' ? 'Other sites’ data isn’t affected.' : 'Your other data stays.'}</Callout>}
    </Modal>
  )
}

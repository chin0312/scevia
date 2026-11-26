/* Your Scevia account: personal identity, sign-in and data control. Not a financial account (those are in Portfolio).
   Sign-in isn't available yet, so the menu shows the guest state honestly and offers the one control that works:
   seeing and clearing what this browser tab keeps. */
import { useState } from 'react'
import { DATA_GROUPS, clearGroup, groupKeys, sceviaKeys, clearScevia, type DataGroup } from '../lib/storage'
import { Icon } from './Icon'
import { Menu, Modal, useToast } from './overlays'
import { Button, Callout } from './ui'
import { useActiveWorkspace } from '../lib/workspaceContext'
import { PRODUCT_POLICIES } from '../lib/help'
import { joinList } from '../lib/text'
import type { WorkspaceMode } from '../data/workspace'

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

/** What this build can actually do. The dialog describes current behaviour from these and the selected portfolio,
 *  so the integrated product changes the flags (and the portfolio data), not the text. */
const CAPABILITIES = { accounts: false, serverStorage: false, readUserFiles: false } as const
const MODE_DESC: Record<WorkspaceMode, string> = { fixture: 'fictional sample data', demo: 'real market data, virtual capital', actual: 'your records' }

const GROUP_DESC: Record<DataGroup, string> = {
  preferences: 'Settings such as default scope, period, sizing, concentration limit and notification preferences.',
  scenarios: 'Saved and unsaved Scenario Lab scenarios.',
  records: 'Accounts, records, decisions, corrections and import history in Portfolio.',
  notifications: 'Which notifications you’ve read, and local import activity.',
}

export function PrivacyDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [confirm, setConfirm] = useState<DataGroup | 'all' | null>(null)
  const total = sceviaKeys().length
  const { snapshot } = useActiveWorkspace()
  const connected = (snapshot.data?.accounts ?? []).filter((x) => x.kind === 'connected')
  const run = () => {
    if (!confirm) return
    const r = confirm === 'all' ? clearScevia() : clearGroup(confirm)
    if (!r.ok) { toast('Couldn’t clear that data in this browser', 'info'); setConfirm(null); return }
    // Reload so no open view writes the cleared state back.
    onClose(); location.reload()
  }
  const label = confirm === 'all' ? 'everything Scevia keeps in this tab' : confirm ? DATA_GROUPS[confirm].label.toLowerCase() : ''
  return (
    <Modal title="Data & privacy" sub={CAPABILITIES.accounts ? undefined : 'Not signed in'} onClose={onClose} width={600}
      footer={confirm
        ? <><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" onClick={run}>Clear {confirm === 'all' ? 'everything' : DATA_GROUPS[confirm].label.toLowerCase()}</Button></>
        : <><Button variant="ghost" onClick={onClose}>Close</Button><Button onClick={() => setConfirm('all')} disabled={total === 0}>Clear everything…</Button></>}>
      <dl className="kv privacy-state">
        <dt>Selected portfolio</dt><dd>{snapshot.summary.name} ({MODE_DESC[snapshot.summary.mode]})</dd>
        <dt>Connected accounts</dt><dd>{snapshot.summary.mode === 'actual' ? (connected.length ? joinList(connected.map((x) => x.label)) : 'None') : 'None. This portfolio doesn’t use your accounts.'}</dd>
        <dt>Your files</dt><dd>{CAPABILITIES.readUserFiles ? 'Imported files are kept with this portfolio.' : 'Not read. Only bundled sample files can be imported.'}</dd>
        <dt>Stored data</dt><dd>{CAPABILITIES.serverStorage ? 'Kept with your Scevia account.' : 'Kept only in this browser tab and removed when it closes. Nothing is sent to a server.'}</dd>
      </dl>
      <p className="t3">{PRODUCT_POLICIES[0]}{CAPABILITIES.accounts ? '' : ' Signing in, cloud sync, export and account deletion aren’t available yet.'}</p>
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

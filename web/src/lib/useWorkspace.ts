/* Records workspaces (accounts, records, import batches), one per portfolio workspace. The in-memory copy is the
   source of truth while the page is open; it is written to this browser tab under `scevia-records-v2@<workspace>`
   (the Sample portfolio keeps `scevia-records-v2`). If the browser refuses the write, the in-memory changes stay
   (they are never replaced by older stored data) and `persisted` turns false so the UI can say so.
   The active records workspace follows the selected portfolio (set by the finance provider); a portfolio's records
   are never shown for another. Other surfaces (notifications, search, account names) read the same copy. */
import { useEffect, useState } from 'react'
import { SAMPLE_ACCOUNTS, SAMPLE_BATCHES, SAMPLE_RECORDS, type ImportBatch, type WorkspaceAccount } from '../data/sampleRecords'
import { fromRecords, readWorkspace, type ManagedRecord } from './records'
import { SAMPLE_WORKSPACE_ID, readStored, scopedKey, writeStored } from './storage'

export interface Workspace { accounts: WorkspaceAccount[]; records: ManagedRecord[]; batches: ImportBatch[] }
export const WORKSPACE_KEY = 'scevia-records-v2'
export const initialWorkspace = (): Workspace => ({ accounts: SAMPLE_ACCOUNTS.map((a) => ({ ...a })), records: fromRecords(SAMPLE_RECORDS), batches: SAMPLE_BATCHES.map((b) => ({ ...b })) })
export const emptyRecords = (): Workspace => ({ accounts: [], records: [], batches: [] })
const EVT = 'scevia:workspace'

let activeId = SAMPLE_WORKSPACE_ID
let seedFor: () => Workspace = initialWorkspace
const current = new Map<string, Workspace>()
const persisted = new Map<string, boolean>()
/** Select whose records the records views show. `seed` is that workspace's initial records (the Sample portfolio's
 *  sample records; another workspace's own seed, or none). */
export function setActiveRecords(id: string, seed: () => Workspace) {
  if (id === activeId) return false
  activeId = id; seedFor = seed
  return true
}
/** Tell subscribed surfaces (search, notifications) that the active records changed. */
export const notifyRecords = () => window.dispatchEvent(new Event(EVT))
export const activeRecordsId = () => activeId
/** Read (once per workspace) from storage, validated; after that, the in-memory copy. */
export function readWorkspaceState(): Workspace {
  let w = current.get(activeId)
  if (!w) {
    w = readStored<Workspace>(scopedKey(WORKSPACE_KEY, activeId), seedFor(), (raw) => { const r = readWorkspace(raw); return r ? { accounts: r.accounts, records: r.records, batches: r.batches } : null })
    current.set(activeId, w)
  }
  return w
}
/** Forget the in-memory copies (tests, and after clearing local data). */
export function resetWorkspaceCache() { current.clear(); persisted.clear(); localEvents.clear() }

export function useWorkspace() {
  const [ws, setWs] = useState<Workspace>(readWorkspaceState)
  const [ok, setOk] = useState(persisted.get(activeId) ?? true)
  useEffect(() => { const on = () => { setWs(readWorkspaceState()); setOk(persisted.get(activeId) ?? true) }; on(); window.addEventListener(EVT, on); return () => window.removeEventListener(EVT, on) }, [])
  const save = (next: Workspace) => {
    current.set(activeId, next)
    const ok = writeStored(scopedKey(WORKSPACE_KEY, activeId), { v: 2, ...next })
    persisted.set(activeId, ok)
    setWs(next); setOk(ok)
    window.dispatchEvent(new Event(EVT))
  }
  return [ws, save, ok] as const
}
/** Read-only subscription for other surfaces. */
export function useWorkspaceSnapshot() { return useWorkspace()[0] }

/** One display name per financial account everywhere (portfolio menu, analytics, search, records): the records
 *  workspace's label when the account exists there (it may have been renamed), otherwise the portfolio's own label. */
export function accountName(id: string | null | undefined, fallback: { id: string; label: string }[] = []): string {
  if (!id) return ''
  return readWorkspaceState().accounts.find((a) => a.id === id)?.label ?? fallback.find((a) => a.id === id)?.label ?? 'Unknown account'
}

/* Local activity events (e.g. an import was confirmed), per workspace, shown in the notification centre while what
   they describe still exists (an undone import's event disappears with its batch). */
export interface LocalEvent { id: string; at: string; category: 'imports'; title: string; body: string; to: string; batchId?: string }
export const LOCAL_EVENTS_KEY = 'scevia-notif-local'
const localEvents = new Map<string, LocalEvent[]>()
export function pushLocalEvent(e: LocalEvent) {
  const next = [e, ...readLocalEvents().filter((x) => x.id !== e.id)].slice(0, 30)
  localEvents.set(activeId, next)
  writeStored(scopedKey(LOCAL_EVENTS_KEY, activeId), next)
  window.dispatchEvent(new Event(EVT))
}
export const readLocalEvents = (): LocalEvent[] => {
  let l = localEvents.get(activeId)
  if (!l) { l = readStored<LocalEvent[]>(scopedKey(LOCAL_EVENTS_KEY, activeId), [], (v) => (Array.isArray(v) ? (v as LocalEvent[]).filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string') : null)); localEvents.set(activeId, l) }
  return l
}
export const WORKSPACE_EVENT = EVT

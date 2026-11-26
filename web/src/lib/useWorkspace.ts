/* The sample records workspace (accounts, records, import batches) as shared state. The in-memory copy is the source
   of truth while the page is open; it is written to this browser tab under `scevia-records-v2`. If the browser refuses
   the write, the in-memory changes stay (they are never replaced by older stored data) and `persisted` turns false so
   the UI can say so. Other surfaces (notifications, search, account names) read the same copy. */
import { useEffect, useState } from 'react'
import { SAMPLE_ACCOUNTS, SAMPLE_BATCHES, SAMPLE_RECORDS, type ImportBatch, type WorkspaceAccount } from '../data/sampleRecords'
import { ACCOUNTS } from './finance'
import { fromRecords, readWorkspace, type ManagedRecord } from './records'
import { readStored, writeStored } from './storage'

export interface Workspace { accounts: WorkspaceAccount[]; records: ManagedRecord[]; batches: ImportBatch[] }
export const WORKSPACE_KEY = 'scevia-records-v2'
export const initialWorkspace = (): Workspace => ({ accounts: SAMPLE_ACCOUNTS.map((a) => ({ ...a })), records: fromRecords(SAMPLE_RECORDS), batches: SAMPLE_BATCHES.map((b) => ({ ...b })) })
const EVT = 'scevia:workspace'

let current: Workspace | null = null
let persisted = true
/** Read (once) from storage, validated; after that, the in-memory copy. */
export function readWorkspaceState(): Workspace {
  if (!current) current = readStored<Workspace>(WORKSPACE_KEY, initialWorkspace(), (raw) => { const w = readWorkspace(raw); return w ? { accounts: w.accounts, records: w.records, batches: w.batches } : null })
  return current
}
/** Forget the in-memory copy (tests, and after clearing local data). */
export function resetWorkspaceCache() { current = null; persisted = true }

export function useWorkspace() {
  const [ws, setWs] = useState<Workspace>(readWorkspaceState)
  const [ok, setOk] = useState(persisted)
  useEffect(() => { const on = () => { setWs(readWorkspaceState()); setOk(persisted) }; window.addEventListener(EVT, on); return () => window.removeEventListener(EVT, on) }, [])
  const save = (next: Workspace) => {
    current = next
    persisted = writeStored(WORKSPACE_KEY, { v: 2, ...next })
    setWs(next); setOk(persisted)
    window.dispatchEvent(new Event(EVT))
  }
  return [ws, save, ok] as const
}
/** Read-only subscription for other surfaces. */
export function useWorkspaceSnapshot() { return useWorkspace()[0] }

/** One display name per financial account everywhere (portfolio menu, analytics, search, records): the workspace's
 *  label when the account exists there (it may have been renamed), otherwise the portfolio's own label. */
export function accountName(id: string | null | undefined): string {
  if (!id) return ''
  return readWorkspaceState().accounts.find((a) => a.id === id)?.label ?? ACCOUNTS.find((a) => a.id === id)?.label ?? 'Unknown account'
}

/* Local activity events (e.g. an import was confirmed), shown in the notification centre while what they describe still
   exists (an undone import's event disappears with its batch). */
export interface LocalEvent { id: string; at: string; category: 'imports'; title: string; body: string; to: string; batchId?: string }
export const LOCAL_EVENTS_KEY = 'scevia-notif-local'
let localEvents: LocalEvent[] | null = null
export function pushLocalEvent(e: LocalEvent) {
  localEvents = [e, ...readLocalEvents().filter((x) => x.id !== e.id)].slice(0, 30)
  writeStored(LOCAL_EVENTS_KEY, localEvents)
  window.dispatchEvent(new Event(EVT))
}
export const readLocalEvents = (): LocalEvent[] => localEvents ?? (localEvents = readStored<LocalEvent[]>(LOCAL_EVENTS_KEY, [], (v) => (Array.isArray(v) ? (v as LocalEvent[]).filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string') : null)))
export const WORKSPACE_EVENT = EVT

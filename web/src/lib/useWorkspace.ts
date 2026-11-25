/* The sample records workspace (accounts, records, import batches) as shared state. Kept in this browser tab under
   `scevia-records-v2`; other surfaces (notifications, search) read it and are told when it changes. */
import { useEffect, useState } from 'react'
import { SAMPLE_ACCOUNTS, SAMPLE_BATCHES, SAMPLE_RECORDS, type ImportBatch, type WorkspaceAccount } from '../data/sampleRecords'
import { fromRecords, readWorkspace, type ManagedRecord } from './records'
import { readStored, writeStored } from './storage'

export interface Workspace { accounts: WorkspaceAccount[]; records: ManagedRecord[]; batches: ImportBatch[] }
export const WORKSPACE_KEY = 'scevia-records-v2'
export const initialWorkspace = (): Workspace => ({ accounts: SAMPLE_ACCOUNTS.map((a) => ({ ...a })), records: fromRecords(SAMPLE_RECORDS), batches: SAMPLE_BATCHES.map((b) => ({ ...b })) })
const EVT = 'scevia:workspace'

export function readWorkspaceState(): Workspace {
  return readStored<Workspace>(WORKSPACE_KEY, initialWorkspace(), (raw) => { const w = readWorkspace(raw); return w ? { accounts: w.accounts, records: w.records, batches: w.batches } : null })
}
export function useWorkspace() {
  const [ws, setWs] = useState<Workspace>(readWorkspaceState)
  useEffect(() => { const on = () => setWs(readWorkspaceState()); window.addEventListener(EVT, on); return () => window.removeEventListener(EVT, on) }, [])
  const save = (next: Workspace) => { setWs(next); writeStored(WORKSPACE_KEY, { v: 2, ...next }); window.dispatchEvent(new Event(EVT)) }
  return [ws, save] as const
}
/** Read-only subscription for other surfaces. */
export function useWorkspaceSnapshot() { return useWorkspace()[0] }

/* Local activity events (e.g. an import was confirmed), shown in the notification centre. */
export interface LocalEvent { id: string; at: string; category: 'imports'; title: string; body: string; to: string }
export const LOCAL_EVENTS_KEY = 'scevia-notif-local'
export function pushLocalEvent(e: LocalEvent) {
  const cur = readStored<LocalEvent[]>(LOCAL_EVENTS_KEY, [], (v) => (Array.isArray(v) ? (v as LocalEvent[]) : null))
  writeStored(LOCAL_EVENTS_KEY, [e, ...cur.filter((x) => x.id !== e.id)].slice(0, 30))
  window.dispatchEvent(new Event(EVT))
}
export const readLocalEvents = () => readStored<LocalEvent[]>(LOCAL_EVENTS_KEY, [], (v) => (Array.isArray(v) ? (v as LocalEvent[]).filter((x) => x && typeof x.id === 'string' && typeof x.title === 'string') : null))
export const WORKSPACE_EVENT = EVT

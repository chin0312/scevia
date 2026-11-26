/* The selected workspace, provided through React context. Pages read its identity, mode, revisions and freshness from
   here instead of assuming one global sample. Switching loads the other workspace asynchronously; refreshing keeps
   the current data on screen (no remount), so filters, selections, scroll position, open panels and inputs survive.
   The selection is remembered in this tab (`scevia-workspace`); each workspace's own state (scenarios, records)
   stays in storage untouched while another workspace is open. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FIXTURE_ID, bundledService, fixtureSnapshot, type WorkspaceService, type WorkspaceSnapshot, type WorkspaceSummary } from '../data/workspace'
import { readStored, writeStored } from './storage'

export const WORKSPACE_KEY = 'scevia-workspace'

interface Ctx {
  list: WorkspaceSummary[]
  snapshot: WorkspaceSnapshot
  select: (id: string) => void
  refresh: () => Promise<{ changed: boolean } | null>
  /** Result of the last refresh in this tab, for "Checked · no new data". */
  lastRefresh: { at: string; changed: boolean } | null
}

const placeholder = (s: WorkspaceSummary): WorkspaceSnapshot => ({
  summary: s, status: 'loading', reason: null, financialRevision: null, marketRevision: null, valuationAsOf: null, historyStart: null, accounts: [], streams: [], checkedAt: null,
})

const WorkspaceCtx = createContext<Ctx | null>(null)

export function WorkspaceProvider({ children, service: given, autoRefreshMin = 0 }: { children: ReactNode; service?: WorkspaceService; autoRefreshMin?: number }) {
  const service = useMemo(() => given ?? bundledService(), [given])
  const [list, setList] = useState<WorkspaceSummary[]>(() => [fixtureSnapshot().summary])
  const [selected] = useState(() => readStored<string>(WORKSPACE_KEY, FIXTURE_ID, (v) => (typeof v === 'string' && v.length < 100 ? v : null)))
  // The bundled fixture is available synchronously, so the first paint never flashes a loading state for it.
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(() => (selected === FIXTURE_ID ? fixtureSnapshot() : placeholder({ id: selected, name: 'Portfolio', mode: 'actual', blurb: '', accountCount: null })))
  const [lastRefresh, setLastRefresh] = useState<Ctx['lastRefresh']>(null)
  const req = useRef(0)
  const snapRef = useRef(snapshot)
  snapRef.current = snapshot

  useEffect(() => { let live = true; service.list().then((l) => { if (live) setList(l) }).catch(() => {}); return () => { live = false } }, [service])

  const load = useCallback((id: string) => {
    const n = ++req.current
    service.load(id).then((s) => { if (req.current === n) setSnapshot(s) }).catch(() => {
      if (req.current === n) setSnapshot((cur) => ({ ...cur, status: 'error', reason: 'load_failed' }))
    })
  }, [service])

  // A non-fixture selection (restored from storage) loads on mount.
  useEffect(() => { if (snapRef.current.status === 'loading') load(snapRef.current.summary.id) }, [load])
  // Fill in the real summary once the list arrives.
  useEffect(() => { const s = list.find((x) => x.id === snapshot.summary.id); if (s && s !== snapshot.summary && snapshot.status === 'loading') setSnapshot((c) => ({ ...c, summary: s })) }, [list, snapshot.summary, snapshot.status])

  const select = useCallback((id: string) => {
    if (id === snapRef.current.summary.id && hasData(snapRef.current)) return
    writeStored(WORKSPACE_KEY, id)
    setLastRefresh(null)
    const s = list.find((x) => x.id === id) ?? { id, name: 'Portfolio', mode: 'actual' as const, blurb: '', accountCount: null }
    setSnapshot(placeholder(s))
    load(id)
  }, [list, load])

  const refresh = useCallback(async () => {
    const cur = snapRef.current
    if (cur.status === 'loading' || cur.status === 'refreshing') return null
    const n = ++req.current
    setSnapshot({ ...cur, status: 'refreshing' })
    try {
      const r = await service.refresh(cur)
      if (req.current !== n) return null
      setSnapshot(r.snapshot)
      const res = { at: r.snapshot.checkedAt ?? new Date().toISOString(), changed: r.changed }
      setLastRefresh(res)
      return { changed: r.changed }
    } catch {
      if (req.current === n) setSnapshot({ ...cur, reason: 'refresh_failed' })
      return null
    }
  }, [service])

  // Optional periodic check while the tab is visible. It never changes a scenario or an input; only new revisions
  // change figures, and the page stays mounted.
  useEffect(() => {
    if (!autoRefreshMin) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, autoRefreshMin * 60_000)
    return () => clearInterval(t)
  }, [autoRefreshMin, refresh])

  const value = useMemo(() => ({ list, snapshot, select, refresh, lastRefresh }), [list, snapshot, select, refresh, lastRefresh])
  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>
}

/** The selected workspace. Outside a provider (unit tests of isolated components) it is the fixture. */
export function useActiveWorkspace(): Ctx {
  const c = useContext(WorkspaceCtx)
  return c ?? { list: [fixtureSnapshot().summary], snapshot: fixtureSnapshot(), select: () => {}, refresh: async () => null, lastRefresh: null }
}

/** True when the selected workspace has figures to show (ready, or refreshing with the previous data). */
export const hasData = (s: WorkspaceSnapshot) => s.status === 'ready' || (s.status === 'refreshing' && s.financialRevision !== null)

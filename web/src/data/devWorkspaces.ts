/* Development-only workspace service for integration tests and local review of workspace isolation. Enabled only in
   a development build when this tab sets `scevia-dev-workspaces` (or opens any page with `?devWorkspaces=1`).
   It offers distinct fixture portfolios with different accounts, holdings, cash, records and valuations, one that is
   slow to load (to prove a late response can't overwrite a newer selection), one that fails, and one whose refresh
   fails. Production builds never include it. Nothing here is real data. */
import { bundledService, staticSnapshot, type WorkspaceService, type WorkspaceSummary } from './workspace'
import { SAMPLE_PORTFOLIO } from './sample'
import type { PortfolioData } from './types'

export const DEV_FLAG = 'scevia-dev-workspaces'
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Fixture B: one Polymarket wallet in PUSD with three of the sample's markets, its own cash and short history. */
export const FIXTURE_B: PortfolioData = (() => {
  const picked = SAMPLE_PORTFOLIO.openPositions.filter((p) => p.platform === 'pm').slice(0, 3)
  return {
    asOf: SAMPLE_PORTFOLIO.asOf, historyStart: '2026-06-01', lastVisit: '2026-11-17', isSample: true,
    accounts: [{ id: 'pm-b', venue: 'pm', label: 'Fixture B wallet', kind: 'imported', sources: ['csv'], denomination: 'PUSD' }],
    cashFlows: [{ date: '2026-06-01', platform: 'pm', amount: 8000 }],
    openPositions: picked.map((p) => ({ ...p, id: `b-${p.id}`, accountId: 'pm-b', fills: p.fills.map((f) => ({ ...f, date: f.date < '2026-06-02' ? '2026-06-02' : f.date, shares: Math.round(f.shares / 4) })) })),
    closedTrades: [],
    events: SAMPLE_PORTFOLIO.events.filter((e) => picked.some((p) => p.eventId === e.id)),
    relations: [],
    sources: { pm: { label: 'Polymarket', asOf: SAMPLE_PORTFOLIO.asOf, stale: false } },
  }
})()

const SUM = (id: string, name: string, blurb: string): WorkspaceSummary => ({ id, name, mode: 'fixture', blurb, accountCount: 1 })
const B = SUM('dev-b', 'Development fixture B', 'Development fixture · slow to load')
const C = SUM('dev-fail', 'Development fixture C', 'Development fixture · fails to load')
const D = SUM('dev-flaky', 'Development fixture D', 'Development fixture · refresh fails')
const seedB = () => ({ accounts: [{ id: 'pm-b', venue: 'pm' as const, label: 'Fixture B wallet', kind: 'imported' as const, sources: ['csv' as const], openingDeclared: false, inAnalytics: true, lastObserved: null }], records: [], batches: [] })

export function devWorkspaceService(): WorkspaceService {
  const base = bundledService({ latencyMs: 50 })
  const now = () => new Date().toISOString()
  return {
    async list() { return [...await base.list(), B, C, D] },
    async load(id) {
      if (id === 'dev-b') { await wait(1200); return staticSnapshot(B, FIXTURE_B, now(), seedB) }
      if (id === 'dev-fail') { await wait(100); throw new Error('load_failed') }
      if (id === 'dev-flaky') { await wait(50); return staticSnapshot(D, FIXTURE_B, now(), seedB) }
      return base.load(id)
    },
    async refresh(cur) {
      if (cur.summary.id === 'dev-flaky') { await wait(100); throw new Error('refresh_failed') }
      if (cur.summary.id === 'dev-b') { await wait(100); return { snapshot: staticSnapshot(B, FIXTURE_B, now(), seedB), changed: false } }
      return base.refresh(cur)
    },
  }
}

/** The development service when this tab asked for it in a development build; otherwise undefined (bundled service). */
export function devService(): WorkspaceService | undefined {
  if (!import.meta.env.DEV || typeof window === 'undefined') return undefined
  try {
    if (new URLSearchParams(window.location.search).get('devWorkspaces') === '1') window.sessionStorage.setItem(DEV_FLAG, '1')
    return window.sessionStorage.getItem(DEV_FLAG) === '1' ? (cached ??= devWorkspaceService()) : undefined
  } catch { return undefined }
}
let cached: WorkspaceService | undefined

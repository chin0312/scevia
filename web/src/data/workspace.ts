/**
 * Workspace boundary: which portfolio is being analyzed, what kind it is, and how current each of its data streams is.
 *
 * Three kinds are kept apart (backend `GET /v1/portfolios` → `mode`):
 * - `fixture`: the bundled fictional Sample portfolio (deterministic, for exploring and tests). Its markets are fictional.
 * - `demo`: the Demo portfolio — virtual capital and hypothetical records on approved real-market evidence (`/v1/demo`).
 * - `actual`: the user's own portfolios from connected accounts, CSV imports and manual records.
 *
 * Loading is asynchronous through `WorkspaceService`, so the bundled service can be replaced by an API client without
 * changing the pages. The bundled service knows only the fixture; the demo reports itself unavailable and there are no
 * actual portfolios until a backend is connected. Nothing here claims a connection, refresh or live feed it doesn't have.
 */
import type { Denomination, Platform, PortfolioData } from './types'
import type { StreamState, StreamStatus } from '../lib/freshness'
import { PORTFOLIO } from './portfolio'

export type WorkspaceMode = 'fixture' | 'demo' | 'actual'
export const MODE_LABEL: Record<WorkspaceMode, string> = { fixture: 'Sample', demo: 'Demo', actual: 'My portfolio' }

export interface WorkspaceSummary {
  id: string
  name: string
  mode: WorkspaceMode
  /** One short line: what the data is. */
  blurb: string
  accountCount: number | null
}

/** Load lifecycle of the selected workspace. Data stays on screen while refreshing. */
export type LoadState = 'loading' | 'ready' | 'refreshing' | 'unavailable' | 'error'

export interface WorkspaceAccount { id: string; venue: Platform; label: string; denomination: Denomination; capability: 'api' | 'address' | 'import_only' | 'manual' | 'fixture' | 'hypothetical' }

export interface WorkspaceSnapshot {
  summary: WorkspaceSummary
  status: LoadState
  /** Machine-readable reason when unavailable or failed (e.g. `authorized_demo_dataset_unavailable`). */
  reason: string | null
  /** Revision of the financial records (ledger). Changes only when records change. */
  financialRevision: string | null
  /** Revision of market observations. Changes only when new marks arrive. */
  marketRevision: string | null
  /** Valuation cutoff of the figures shown (ISO date or timestamp), or null when there is no valuation. */
  valuationAsOf: string | null
  /** First date with financial history, or null when unknown. */
  historyStart: string | null
  accounts: WorkspaceAccount[]
  streams: StreamStatus[]
  /** When Scevia last asked the source for this workspace (ISO). */
  checkedAt: string | null
  /** The workspace's portfolio read model, or null when it has none (loading, unavailable, failed, not connected).
   *  Never another workspace's data. */
  data: PortfolioData | null
  /** The workspace's own initial records (records management), when it provides them. */
  recordsSeed?: (() => RecordsSeed) | null
}
export interface RecordsSeed { accounts: import('./sampleRecords').WorkspaceAccount[]; records: import('../lib/records').ManagedRecord[]; batches: import('./sampleRecords').ImportBatch[] }

export interface RefreshResult { snapshot: WorkspaceSnapshot; changed: boolean }

export interface WorkspaceService {
  list(): Promise<WorkspaceSummary[]>
  load(id: string): Promise<WorkspaceSnapshot>
  /** Ask the source for newer data. `changed` is true only when a revision moved. */
  refresh(current: WorkspaceSnapshot): Promise<RefreshResult>
}

/* ───────────── Backend contract readers (PR #8) ─────────────
   Decimal strings and nullable availability are read without inventing values: an invalid decimal is unavailable. */

/** A backend decimal string (or number) → number; null, empty and malformed values are unavailable (null). */
export function readDecimal(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v.trim())) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isMode = (v: unknown): v is WorkspaceMode => v === 'fixture' || v === 'demo' || v === 'actual'

/** `GET /v1/portfolios` → summaries. Items with an unknown mode are dropped, never guessed. */
export function readPortfolioList(raw: unknown): WorkspaceSummary[] | null {
  if (!isObj(raw) || !Array.isArray(raw.items)) return null
  return raw.items.flatMap((it) => {
    if (!isObj(it) || typeof it.id !== 'string' || typeof it.name !== 'string' || !isMode(it.mode)) return []
    const n = typeof it.providerAccountCount === 'number' ? it.providerAccountCount : null
    return [{ id: it.id, name: it.name, mode: it.mode, accountCount: n,
      blurb: it.mode === 'demo' ? 'Real markets, virtual capital' : it.mode === 'fixture' ? 'Fictional markets and records' : `${n ?? 'Unknown'} account${n === 1 ? '' : 's'}` }]
  })
}

export type DemoState =
  | { status: 'available'; portfolioId: string; mode: 'demo' | 'fixture'; revision: string; catalogRevision: string; capturedAt: string; quotes: { retrievedAt: string; effectiveAt: string | null; freshness: 'recent_capture' | 'stale_capture' }[] }
  | { status: 'initialization_required' }
  | { status: 'unavailable'; reason: string }

/** `GET /v1/demo` → demo state. Anything unrecognized is treated as unavailable, never as a fixture fallback. */
export function readDemo(raw: unknown): DemoState {
  if (!isObj(raw)) return { status: 'unavailable', reason: 'invalid_response' }
  if (raw.status === 'initialization_required') return { status: 'initialization_required' }
  if (raw.status === 'available' && typeof raw.portfolioId === 'string' && typeof raw.revision === 'string' && typeof raw.capturedAt === 'string' && (raw.mode === 'demo' || raw.mode === 'fixture')) {
    const quotes = Array.isArray(raw.quotes) ? raw.quotes.flatMap((q) => (isObj(q) && typeof q.retrievedAt === 'string' && (q.freshness === 'recent_capture' || q.freshness === 'stale_capture')
      ? [{ retrievedAt: q.retrievedAt, effectiveAt: typeof q.effectiveAt === 'string' ? q.effectiveAt : null, freshness: q.freshness as 'recent_capture' | 'stale_capture' }] : [])) : []
    return { status: 'available', portfolioId: raw.portfolioId, mode: raw.mode, revision: raw.revision, catalogRevision: typeof raw.catalogRevision === 'string' ? raw.catalogRevision : raw.revision, capturedAt: raw.capturedAt, quotes }
  }
  return { status: 'unavailable', reason: typeof raw.reason === 'string' ? raw.reason : 'unknown' }
}

/** Streams of an available demo. Market evidence is a cached capture (never streaming); each quote keeps its source
 *  time (`effectiveAt`) apart from when it was retrieved. Market freshness follows the OLDEST quote (different held
 *  instruments can differ), and valuation completeness is never inferred from a capture: the backend's valuation
 *  availability decides it, so it stays partial here. */
export function demoStreams(d: Extract<DemoState, { status: 'available' }>, checkedAt: string): StreamStatus[] {
  const times = d.quotes.map((q) => q.effectiveAt ?? q.retrievedAt).sort()
  const oldest = times[0] ?? null, newest = times.at(-1) ?? null
  const stale = d.quotes.some((q) => q.freshness === 'stale_capture')
  const market: StreamState = !d.quotes.length ? 'unavailable' : stale ? 'stale' : 'cached_snapshot'
  const span = oldest && newest && oldest !== newest ? ` Quotes range from ${oldest.slice(0, 10)} to ${newest.slice(0, 10)}.` : ''
  return [
    { id: 'market', state: market, asOf: oldest, checkedAt, classifiedBy: 'source', detail: `Approved real-market capture. Prices keep their source time and aren’t streamed.${span}` },
    { id: 'account', state: 'fixture', asOf: d.capturedAt, checkedAt, classifiedBy: 'source', detail: 'Hypothetical demo records with virtual capital. No personal account is connected.' },
    { id: 'valuation', state: market === 'unavailable' ? 'unavailable' : 'partial', asOf: d.capturedAt, checkedAt, detail: 'Valued at the capture cutoff. Completeness comes from the valuation service.' },
    { id: 'history', state: 'partial', asOf: d.capturedAt, checkedAt, detail: 'History covers the captured period only.' },
    { id: 'fx', state: 'unavailable', asOf: null, checkedAt, detail: 'Exchange-rate references come with the demo’s valuation from the backend.' },
    { id: 'sync', state: 'unavailable', asOf: null, checkedAt, detail: 'The demo has no account sync.' },
    { id: 'sources', state: 'unavailable', asOf: null, checkedAt, detail: 'No personal sources are connected to the demo.' },
  ]
}

/* ───────────── Bundled service ───────────── */

export const FIXTURE_ID = 'sample', DEMO_ID = 'demo'

const FIXTURE_SUMMARY: WorkspaceSummary = { id: FIXTURE_ID, name: 'Sample portfolio', mode: 'fixture', blurb: 'Fictional markets and records', accountCount: PORTFOLIO.accounts.length }
const DEMO_SUMMARY: WorkspaceSummary = { id: DEMO_ID, name: 'Demo portfolio', mode: 'demo', blurb: 'Real markets, virtual capital', accountCount: null }

/** The fixture snapshot. Its data never changes, so every stream is "Fixed sample" with the sample's own dates. */
export function fixtureSnapshot(checkedAt: string | null = null): WorkspaceSnapshot { return staticSnapshot(FIXTURE_SUMMARY, PORTFOLIO, checkedAt) }
/** A snapshot of fixed development data (no live source): every stream is "Fixed sample" or unavailable. */
export function staticSnapshot(summary: WorkspaceSummary, data: PortfolioData, checkedAt: string | null, recordsSeed?: WorkspaceSnapshot['recordsSeed']): WorkspaceSnapshot {
  const PORTFOLIO = data, asOf = data.asOf
  const staleVenues = Object.values(PORTFOLIO.sources).filter((s) => s?.stale).length
  return {
    summary, status: 'ready', reason: null, recordsSeed,
    financialRevision: `fixture:${summary.id}:${asOf}`, marketRevision: `fixture:${summary.id}:${asOf}`, valuationAsOf: asOf, historyStart: PORTFOLIO.historyStart,
    accounts: PORTFOLIO.accounts.map((a) => ({ id: a.id, venue: a.venue, label: a.label, denomination: a.denomination, capability: 'fixture' as const })),
    streams: [
      { id: 'market', state: 'fixture', asOf, checkedAt, detail: 'Fictional sample prices fixed at the sample date. They never update.' },
      { id: 'account', state: 'fixture', asOf, checkedAt, detail: staleVenues ? `Fictional records. ${staleVenues} sample source is marked stale to show how that looks.` : 'Fictional records.' },
      { id: 'valuation', state: 'fixture', asOf, checkedAt, detail: 'Valued at the sample’s fixed marks.' },
      { id: 'history', state: 'fixture', asOf: PORTFOLIO.historyStart, checkedAt, detail: 'Sample history with weekly sample marks.' },
      { id: 'fx', state: 'fixture', asOf, checkedAt, detail: 'Development fixture exchange and stablecoin references (constant). Not live rates.' },
      { id: 'sync', state: 'unavailable', asOf: null, checkedAt, detail: 'The sample has no background sync.' },
      { id: 'sources', state: 'unavailable', asOf: null, checkedAt, detail: 'The sample isn’t connected to any provider.' },
    ],
    checkedAt, data,
  }
}

const unavailableDemo = (checkedAt: string): WorkspaceSnapshot => ({
  summary: DEMO_SUMMARY, status: 'unavailable', reason: 'authorized_demo_dataset_unavailable',
  financialRevision: null, marketRevision: null, valuationAsOf: null, historyStart: null, accounts: [],
  streams: (['market', 'account', 'valuation', 'history', 'fx', 'sync', 'sources'] as const).map((id) => ({ id, state: 'unavailable' as const, asOf: null, checkedAt, detail: 'The demo’s approved real-market data isn’t available.' })),
  checkedAt, data: null,
})

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The service bundled with the app: the fixture, and a demo that is unavailable without approved market data. */
export function bundledService(opts: { latencyMs?: number; now?: () => string } = {}): WorkspaceService {
  const latency = opts.latencyMs ?? 250, now = opts.now ?? (() => new Date().toISOString())
  return {
    async list() { return [FIXTURE_SUMMARY, DEMO_SUMMARY] },
    async load(id) {
      await wait(latency)
      if (id === FIXTURE_ID) return fixtureSnapshot(now())
      if (id === DEMO_ID) return unavailableDemo(now())
      throw new Error('workspace_not_found')
    },
    async refresh(current) {
      await wait(latency)
      // The fixture has nothing newer: the check is recorded, the revisions stay the same.
      if (current.summary.id === FIXTURE_ID) return { snapshot: fixtureSnapshot(now()), changed: false }
      return { snapshot: unavailableDemo(now()), changed: false }
    },
  }
}

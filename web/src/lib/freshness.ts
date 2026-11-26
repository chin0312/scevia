/* Data freshness: one explicit state per data stream (market data, account data, valuation, history, sync, sources).
   Streams are reported independently, so a current quote never makes a stale balance look current, and there is no
   single "Live" state. A state is shown only when the source establishes it: a static fixture is "Fixed sample", never
   "Streaming". The backend reports these per stream (coverage, sync runs, quote freshness) during integration. */

export type StreamId = 'market' | 'account' | 'valuation' | 'history' | 'sync' | 'sources'
export type StreamState =
  | 'streaming' | 'recent' | 'refreshing' | 'delayed' | 'stale' | 'disconnected' | 'partial' | 'unavailable'
  | 'import_only' | 'cached_snapshot' | 'fixture'

export interface StreamStatus {
  id: StreamId
  state: StreamState
  /** Source time of the newest observation in this stream (ISO), or null when unknown. */
  asOf: string | null
  /** When Scevia last checked this stream (ISO), or null when it never has. */
  checkedAt: string | null
  /** One short sentence: what the state is based on. */
  detail: string
}

export const STREAM_LABEL: Record<StreamId, string> = {
  market: 'Market data', account: 'Account data', valuation: 'Portfolio valuation', history: 'Historical coverage', sync: 'Background sync', sources: 'Source connections',
}
export const STATE_LABEL: Record<StreamState, string> = {
  streaming: 'Streaming', recent: 'Recently refreshed', refreshing: 'Refreshing', delayed: 'Delayed', stale: 'Stale', disconnected: 'Disconnected',
  partial: 'Partial', unavailable: 'Unavailable', import_only: 'Import only', cached_snapshot: 'Cached market snapshot', fixture: 'Fixed sample',
}
/** Visual tone of a state. Only established, current states are "ok"; nothing is "ok" by default. */
export const STATE_TONE: Record<StreamState, 'ok' | 'info' | 'warn' | 'bad' | 'muted'> = {
  streaming: 'ok', recent: 'ok', refreshing: 'info', delayed: 'warn', stale: 'warn', disconnected: 'bad', partial: 'warn', unavailable: 'muted',
  import_only: 'info', cached_snapshot: 'info', fixture: 'muted',
}

/** Age thresholds (minutes) for classifying a refreshed stream. Market data ages faster than account data. */
export const AGE_LIMITS: Record<'market' | 'account', { recent: number; delayed: number }> = {
  market: { recent: 5, delayed: 60 },
  account: { recent: 60, delayed: 24 * 60 },
}

/** Classify a refreshed stream by the age of its newest observation. Unknown time is unavailable, never recent. */
export function classifyAge(asOf: string | null, now: number, kind: 'market' | 'account'): 'recent' | 'delayed' | 'stale' | 'unavailable' {
  if (!asOf) return 'unavailable'
  const t = Date.parse(asOf)
  if (!Number.isFinite(t)) return 'unavailable'
  const mins = (now - t) / 60000
  if (mins < 0) return 'recent'
  return mins <= AGE_LIMITS[kind].recent ? 'recent' : mins <= AGE_LIMITS[kind].delayed ? 'delayed' : 'stale'
}

const SEVERITY: StreamState[] = ['disconnected', 'stale', 'partial', 'delayed', 'unavailable', 'refreshing', 'import_only', 'cached_snapshot', 'fixture', 'recent', 'streaming']

/** The compact summary for the top bar: the most severe state among the streams that matter for current figures
 *  (market, account, valuation). It reads "Streaming" only when all three stream. */
export function summaryState(streams: StreamStatus[]): StreamState {
  const core = streams.filter((s) => s.id === 'market' || s.id === 'account' || s.id === 'valuation')
  if (!core.length) return 'unavailable'
  if (core.every((s) => s.state === 'streaming')) return 'streaming'
  return core.map((s) => s.state).sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b))[0]
}

/** "2 min ago", "3 h ago", "Nov 24" — relative to `now`. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

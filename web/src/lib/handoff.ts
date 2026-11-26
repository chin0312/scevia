/* Scenario hand-offs: another module asks Scenario Lab to consider specific holdings.
   The request names the exact positions chosen where the user acted (so scope never widens silently),
   says where it came from, and carries a one-time request id. Scenario Lab asks before changing anything,
   processes each request id once (StrictMode, Back/Forward, reload), and removes it from the URL. */

export interface HandoffRequest {
  /** Position ids, in the order shown to the user. */
  ids: string[]
  /** Where the request came from, e.g. "Dec 2026 FOMC decision · Polymarket only". */
  from: string | null
  /** One-time request id; a new one is generated for every deliberate user action. */
  req: string | null
  /** Legacy/direct links: whole events (all platforms). */
  events: string[]
}

let counter = 0
const nonce = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

/** URL for a deliberate “add to a scenario” action. Each call produces a new request id. */
export function handoffPath(ids: string[], from: string) {
  const q = new URLSearchParams({ add: ids.join(','), from, req: nonce() })
  return `/scenario-lab?${q.toString()}`
}

export function readHandoff(params: URLSearchParams): HandoffRequest | null {
  const add = params.get('add'), addEvent = params.get('addEvent')
  if (!add && !addEvent) return null
  const list = (v: string | null) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  return { ids: list(add), events: list(addEvent), from: params.get('from'), req: params.get('req') }
}

const SEEN_KEY = 'scevia-handoffs-seen'
/** True the first time a request id is seen in this tab. Requests without an id are always treated as new. */
export function claimHandoff(req: string | null): boolean {
  if (!req) return true
  try {
    const seen: string[] = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]')
    if (Array.isArray(seen) && seen.includes(req)) return false
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...(Array.isArray(seen) ? seen : []), req].slice(-50)))
  } catch { /* storage unavailable: the in-memory guard in Scenario Lab still prevents double processing */ }
  return true
}

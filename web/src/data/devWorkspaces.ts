/* Development-only workspace service for integration tests and local review of workspace isolation. Enabled only in
   a development build when this tab sets `scevia-dev-workspaces` (or opens any page with `?devWorkspaces=1`).
   It offers distinct fixture portfolios with different accounts, holdings, cash, records and valuations, one that is
   slow to load (to prove a late response can't overwrite a newer selection), one that fails, and one whose refresh
   fails. Production builds never include it. Nothing here is real data. */
import { bundledService, staticSnapshot, type WorkspaceService, type WorkspaceSummary } from './workspace'
import { SAMPLE_PORTFOLIO } from './sample'
import type { PortfolioData } from './types'
import { fixtureCatalog, type CatalogEvent, type MarketCatalog } from '../lib/markets'
import { SAMPLE_MARKET_EVENTS } from './sampleMarkets'

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

/* Development discovery service: the sample catalog plus markets that are NOT in it (as a backend search would
   return), with deterministic behaviours for testing the discovery states. Labelled; never shown as real data.
   - "ECB rate decision (Jan 2027)": a multi-market Kalshi event, one market with partial evidence (no price yet).
   - Query containing "slow": answers after 1.5 s; "outage": the service is temporarily unavailable.
   - Links: kalshi.com/markets/kxscalar → unsupported market type; kalshi.com/markets/kxdown → temporarily unavailable. */
const EXTRA: CatalogEvent[] = [
  { provider: 'ks', eventId: 'ks-ev-ecb-jan', eventTitle: 'ECB rate decision (Jan 2027)', url: 'https://kalshi.com/markets/kxecb-27jan', available: true, markets: [
    { provider: 'ks', marketId: 'KXECB-27JAN-CUT', marketTitle: 'ECB cuts rates in Jan 2027', settlementGroup: 'ks-ecb-cut', category: 'Economics', status: 'open', resolves: '2027-01-29', rules: 'Development fixture.', outcomes: [{ outcome: 'YES', refPrice: 0.38 }, { outcome: 'NO', refPrice: 0.63 }], refAsOf: '2026-11-24', fee: null, listedAt: '2026-10-01', closesAt: null, resolution: null, denomination: 'USD', identity: 'fixture',
      evidence: { price: 'available', history: 'unavailable', fee: 'unavailable', resolution: 'not-resolved' } },
    { provider: 'ks', marketId: 'KXECB-27JAN-HOLD', marketTitle: 'ECB holds rates in Jan 2027', settlementGroup: 'ks-ecb-hold', category: 'Economics', status: 'open', resolves: '2027-01-29', rules: 'Development fixture.', outcomes: [{ outcome: 'YES', refPrice: null }, { outcome: 'NO', refPrice: null }], refAsOf: null, fee: null, listedAt: '2026-10-01', closesAt: null, resolution: null, denomination: 'USD', identity: 'fixture',
      evidence: { price: 'unavailable', history: 'unavailable', fee: 'unavailable', resolution: 'not-resolved' } },
  ] },
  { provider: 'pm', eventId: 'pm-ev-pusd', eventTitle: 'Brent above $90 on Mar 31 (PUSD)', url: 'https://polymarket.com/event/brent-above-90-mar-31', available: true, markets: [
    { provider: 'pm', marketId: 'pm-brent-90-mar', marketTitle: 'Brent above $90 on Mar 31', settlementGroup: 'pm-brent-90', category: 'Economics', status: 'open', resolves: '2027-03-31', rules: 'Development fixture.', outcomes: [{ outcome: 'YES', refPrice: 0.22 }, { outcome: 'NO', refPrice: 0.79 }], refAsOf: '2026-11-24', fee: null, listedAt: '2026-06-01', closesAt: null, resolution: null, denomination: 'PUSD', identity: 'fixture',
      evidence: { price: 'available', history: 'unavailable', fee: 'unavailable', resolution: 'not-resolved' } },
  ] },
  { provider: 'pm', eventId: 'pm-ev-unknown', eventTitle: 'Copper above $5 on Dec 31 (asset unknown)', url: 'https://polymarket.com/event/copper-above-5', available: true, markets: [
    { provider: 'pm', marketId: 'pm-copper-5', marketTitle: 'Copper above $5 on Dec 31', settlementGroup: 'pm-copper-5', category: 'Economics', status: 'open', resolves: '2026-12-31', rules: 'Development fixture.', outcomes: [{ outcome: 'YES', refPrice: 0.4 }, { outcome: 'NO', refPrice: 0.61 }], refAsOf: '2026-11-24', fee: null, listedAt: '2026-04-01', closesAt: null, resolution: null, denomination: null, identity: 'fixture',
      evidence: { price: 'available', history: 'unavailable', fee: 'unavailable', resolution: 'not-resolved' } },
  ] },
]
export function devDiscovery(): MarketCatalog {
  const base = fixtureCatalog([...SAMPLE_MARKET_EVENTS, ...EXTRA], 'Development discovery fixture', 150)
  return {
    label: base.label, live: false,
    async search(q, opts) {
      if (/outage/i.test(q)) { await wait(150); throw new Error('temporarily_unavailable') }
      if (/slow/i.test(q)) { await wait(1500); return base.search(q.replace(/slow/ig, '').trim(), opts) }
      return base.search(q, opts)
    },
    async resolveLink(raw) {
      if (/kalshi\.com\/markets\/kxscalar/i.test(raw)) { await wait(150); return { status: 'unsupported-market', provider: 'ks', reason: 'Scalar (range) markets pay out on a scale, not $1 or $0.' } }
      if (/kalshi\.com\/markets\/kxdown/i.test(raw)) { await wait(150); return { status: 'temporarily-unavailable', provider: 'ks' } }
      return base.resolveLink(raw)
    },
  }
}
export function devCatalog(): MarketCatalog | undefined {
  return devService() ? (catalogCached ??= devDiscovery()) : undefined
}
let catalogCached: MarketCatalog | undefined

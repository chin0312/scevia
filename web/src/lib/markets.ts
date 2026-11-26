/* Public market lookup for scenario construction: search markets and resolve supported market links.

   This is the boundary the Scenario Lab UI talks to. Today it is backed by a small, deterministic SAMPLE catalog
   (data/sampleMarkets.ts), clearly labelled as such. In Phase 2 a backend implementation replaces it: provider
   APIs are called by trusted backend adapters, never from the browser, and the browser never fetches the pasted URL.
   Public market data is independent of the user's private portfolio. */
import type { Category, Platform } from '../data/types'
import type { InstrumentRef, Outcome } from './finance'
import type { FeeSchedule } from './fees'

export type MarketStatus = 'open' | 'closed' | 'resolved'
export interface CatalogOutcome { outcome: Outcome; refPrice: number | null }
export interface CatalogMarket {
  provider: Platform
  /** Provider-native market id. */
  marketId: string
  marketTitle: string
  /** Settlement group used by the binary calculations: contracts that settle together share it (reviewed equivalence). */
  settlementGroup: string
  category: Category
  status: MarketStatus
  resolves: string
  rules: string
  outcomes: CatalogOutcome[]
  /** When the reference prices were observed (UTC date); null when unknown. */
  refAsOf: string | null
  /** Fee parameters for this market (Phase 2: from the provider, e.g. Polymarket `feeRateBps`); null = unavailable. */
  fee: FeeSchedule | null
  /** Lifecycle (UTC date or timestamp; null = not recorded). `listedAt`: trading opened. `closesAt`: trading closed —
   *  this alone ends execution eligibility; it is never inferred from `resolves` (the expected resolution) or from the
   *  resolution, which can come later. */
  listedAt?: string | null
  closesAt?: string | null
  /** Verified resolution (outcome and time), or null while unresolved. Settlement payouts follow it. */
  resolution?: { outcome: Outcome; at: string } | null
  /** Native settlement asset of the market (USD, USDC, PUSD); null = not reported. */
  denomination?: string | null
  /** Which supporting evidence the market service has. A market can be found even when pricing it isn't possible. */
  evidence?: MarketEvidence
}
export type EvidenceState = 'available' | 'partial' | 'unavailable' | 'loading'
export interface MarketEvidence { price: EvidenceState; history: EvidenceState; fee: EvidenceState; resolution: EvidenceState | 'not-resolved' }
/** Evidence a market carries: explicit when the service reports it, otherwise derived from the fields present. */
export function evidenceOf(m: CatalogMarket): MarketEvidence {
  return m.evidence ?? {
    price: m.outcomes.every((o) => o.refPrice != null) ? 'available' : m.outcomes.some((o) => o.refPrice != null) ? 'partial' : 'unavailable',
    history: 'unavailable', fee: m.fee ? 'available' : 'unavailable',
    resolution: m.resolution ? 'available' : m.status === 'resolved' ? 'unavailable' : 'not-resolved',
  }
}
export interface CatalogEvent { provider: Platform; eventId: string; eventTitle: string; url: string; markets: CatalogMarket[]; available: boolean }

export type LinkResolution =
  | { status: 'invalid'; message: string }
  | { status: 'unsupported'; host: string }
  | { status: 'not-found'; provider: Platform }
  | { status: 'unavailable'; provider: Platform; eventTitle: string }
  | { status: 'resolved'; event: CatalogEvent }
  /** A supported provider, but a market type Scevia can't model (e.g. scalar or multi-outcome payouts). */
  | { status: 'unsupported-market'; provider: Platform; reason: string }
  /** The market service couldn't answer right now / isn't accessible in this build; never replaced by other data. */
  | { status: 'temporarily-unavailable' | 'access-unavailable'; provider?: Platform }

export interface MarketCatalog {
  /** Shown wherever results appear, e.g. "Sample market data". */
  readonly label: string
  /** True only for a live provider-backed implementation. */
  readonly live: boolean
  search(query: string, opts?: { provider?: Platform }): Promise<CatalogEvent[]>
  /** Resolve a supported provider URL or a provider-native market id / ticker (never an internal database id). */
  resolveLink(url: string): Promise<LinkResolution>
}

/** Recognise a supported provider from a pasted link without fetching it. */
export function parseMarketLink(raw: string): { ok: true; provider: Platform; path: string } | { ok: false; res: LinkResolution } {
  const text = raw.trim()
  let url: URL
  try { url = new URL(text) } catch { return { ok: false, res: { status: 'invalid', message: 'That doesn’t look like a link. Paste the full address, starting with https://' } } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, res: { status: 'invalid', message: 'Only web links (https://) can be resolved.' } }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  const provider: Platform | null = host === 'polymarket.com' ? 'pm' : host === 'kalshi.com' ? 'ks' : null
  if (!provider) return { ok: false, res: { status: 'unsupported', host } }
  return { ok: true, provider, path: url.pathname.replace(/\/+$/, '').toLowerCase() }
}

/** Build an instrument reference for one outcome of a catalog market (what a scenario stores). */
export function instrumentFrom(ev: CatalogEvent, m: CatalogMarket, o: CatalogOutcome, source: InstrumentRef['source']): InstrumentRef {
  return {
    provider: m.provider, eventId: m.settlementGroup, eventTitle: ev.eventTitle, marketId: m.marketId, marketTitle: m.marketTitle,
    outcome: o.outcome, category: m.category, resolves: m.resolves, refPrice: o.refPrice, refAsOf: m.refAsOf, source, fee: m.fee,
  }
}

/** Catalog backed by an in-memory list (the bundled sample). Async on purpose, so callers handle loading like a real service. */
export function fixtureCatalog(events: CatalogEvent[], label: string, delayMs = 200): MarketCatalog {
  const wait = () => new Promise((r) => setTimeout(r, delayMs))
  return {
    label, live: false,
    async search(query, opts) {
      await wait()
      const q = query.trim().toLowerCase()
      return events.filter((e) => (!opts?.provider || e.provider === opts.provider) && e.available &&
        (!q || e.eventTitle.toLowerCase().includes(q) || e.markets.some((m) => m.marketTitle.toLowerCase().includes(q))))
    },
    async resolveLink(raw) {
      // A provider-native market id or ticker (e.g. KXFED-26DEC or pm-btc-150k) resolves directly.
      const id = raw.trim()
      if (id && !/[/:\s]/.test(id)) {
        await wait()
        const ev = events.find((e) => e.markets.some((m) => m.marketId.toLowerCase() === id.toLowerCase()))
        return ev ? { status: 'resolved', event: { ...ev, markets: ev.markets.filter((m) => m.marketId.toLowerCase() === id.toLowerCase()) } } : { status: 'invalid', message: 'No market with that id. Paste a full market link, or a Polymarket or Kalshi market id.' }
      }
      const parsed = parseMarketLink(raw)
      if (!parsed.ok) return parsed.res
      await wait()
      const ev = events.find((e) => e.provider === parsed.provider && new URL(e.url).pathname.toLowerCase() === parsed.path)
      if (!ev) return { status: 'not-found', provider: parsed.provider }
      if (!ev.available) return { status: 'unavailable', provider: ev.provider, eventTitle: ev.eventTitle }
      return { status: 'resolved', event: ev }
    },
  }
}

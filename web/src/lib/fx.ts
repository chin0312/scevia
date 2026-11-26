/* Reporting currency and exchange-rate references.

   The reporting currency is a presentation and analytical choice: amounts are converted for display and comparison,
   never transferred. Balances, quantities, contract prices, payout units, execution prices and native funding keep their
   own units. The authoritative exchange-rate service belongs to the backend; this module defines the contract the
   frontend consumes and a deterministic development fixture that is labelled as such and never described as live.

   Kinds of reference (never mixed up):
   - fiat: a foreign-exchange reference (USD→SGD …);
   - stablecoin: a market reference price of a stablecoin in USD (USDC, PUSD). Never assumed to be exactly 1;
   - hypothetical: an explicit user assumption (e.g. a replay's override), labelled as such.
   Methodology: current tracking uses the latest eligible reference; historical performance needs the reference for
   each valuation date (the backend supplies it); a constant-rate view must say so. */

export type ReportingCurrency = 'USD' | 'SGD' | 'EUR' | 'GBP' | 'MYR'
export interface CurrencyInfo { code: ReportingCurrency; name: string; symbol: string }
/** Initial selection, subject to backend rate coverage. Extend by adding an entry. */
export const CURRENCIES: CurrencyInfo[] = [
  { code: 'USD', name: 'US dollar', symbol: '$' },
  { code: 'SGD', name: 'Singapore dollar', symbol: 'S$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British pound', symbol: '£' },
  { code: 'MYR', name: 'Malaysian ringgit', symbol: 'RM' },
]
export const currencyInfo = (c: string) => CURRENCIES.find((x) => x.code === c) ?? CURRENCIES[0]
export const isReportingCurrency = (v: unknown): v is ReportingCurrency => CURRENCIES.some((c) => c.code === v)

export type RateKind = 'fiat' | 'stablecoin' | 'hypothetical'
export type RateFreshness = 'current' | 'recent' | 'last_known' | 'stale' | 'unavailable' | 'unsupported' | 'override' | 'identity'
/* Reference sources, mirroring the merged backend (`backend/src/fx/reference.ts`, `PUT /v1/preferences/reporting`).
   Each source supports specific legs only: ECB publishes fiat euro references; Kraken a USDC/USD market reference;
   CoinGecko the Polygon PUSD/USD reference family (daily alias included). `auto` (null at the API) selects among
   eligible stored evidence; if the preferred family has no eligible reference for a leg, another may be used with
   `fallback: true`. Preferences select from evidence; they don't enable a collector or grant data rights. */
export const FIAT_SOURCES = ['ecb_euro_reference'] as const
export const STABLECOIN_SOURCES = ['kraken_usdc_usd_ohlc', 'coingecko_polygon_pusd_usd'] as const
export type FiatSource = (typeof FIAT_SOURCES)[number]
export type StablecoinSource = (typeof STABLECOIN_SOURCES)[number]
export interface FxPreferences { fiatSource: FiatSource | 'auto'; stablecoinSource: StablecoinSource | 'auto' }
export const AUTO_FX: FxPreferences = { fiatSource: 'auto', stablecoinSource: 'auto' }
export const SOURCE_LABEL: Record<FiatSource | StablecoinSource, string> = { ecb_euro_reference: 'ECB euro reference rates', kraken_usdc_usd_ohlc: 'Kraken USDC/USD', coingecko_polygon_pusd_usd: 'CoinGecko Polygon PUSD/USD' }
/** Which legs a source can supply (the backend's capability mapping). */
export const SOURCE_SUPPORTS: Record<FiatSource | StablecoinSource, string[]> = { ecb_euro_reference: ['fiat'], kraken_usdc_usd_ohlc: ['USDC'], coingecko_polygon_pusd_usd: ['PUSD'] }
export const readFxPreferences = (v: unknown): FxPreferences => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return { fiatSource: (FIAT_SOURCES as readonly string[]).includes(o.fiatSource as string) ? (o.fiatSource as FiatSource) : 'auto', stablecoinSource: (STABLECOIN_SOURCES as readonly string[]).includes(o.stablecoinSource as string) ? (o.stablecoinSource as StablecoinSource) : 'auto' }
}

export interface FxReference {
  base: string; quote: string
  /** Units of `quote` per 1 `base`, or null when unavailable / unsupported. Never defaulted to 1. */
  rate: number | null
  kind: RateKind
  source: string
  methodology: string
  observedAt: string | null
  retrievedAt: string | null
  freshness: RateFreshness
  /** Evidence revision of the reference set, when the source reports one. */
  revision: string | null
  /** The preferred source couldn't supply this leg; another eligible source was used (qualified). */
  fallback?: boolean
  /** True for development fixture values (never live). */
  fixture?: boolean
}
export const FRESHNESS_LABEL: Record<RateFreshness, string> = {
  current: 'Current reference', recent: 'Recently refreshed', last_known: 'Last-known reference', stale: 'Stale reference', unavailable: 'Conversion unavailable',
  unsupported: 'Unsupported currency', override: 'Your hypothetical rate', identity: 'Same currency',
}

/** The frontend's view of the backend exchange-rate service. Synchronous here because the fixture is local; the
 *  integrated service supplies references with each read model (current valuation, each historical date, a scenario's
 *  evaluation) rather than being called from components. */
export interface FxService {
  readonly label: string
  /** Whether references are live (backend) or fixed development values. */
  readonly live: boolean
  reference(base: string, quote: string): FxReference
}

const FIXTURE_DATE = '2026-11-24'
const FIXTURE_REV = 'fixture-fx-2026-11-24'
/** Development fixture references (fixed numbers, not market data). MYR is deliberately older to show a stale state;
 *  the stablecoin references are fixture values, not a claim that the stablecoins trade at par. */
const FIXTURE_USD_TO: Record<string, { rate: number; observedAt: string }> = {
  SGD: { rate: 1.34, observedAt: FIXTURE_DATE }, EUR: { rate: 0.92, observedAt: FIXTURE_DATE }, GBP: { rate: 0.79, observedAt: FIXTURE_DATE }, MYR: { rate: 4.47, observedAt: '2026-11-10' },
}
const FIXTURE_STABLE_USD: Record<string, number> = { USDC: 1, PUSD: 1 }
const STALE_DAYS = 3

export function fixtureFx(today = FIXTURE_DATE, prefs: FxPreferences = AUTO_FX): FxService {
  // The fixture uses the backend's source identifiers so the presentation matches integration, but every value is a
  // labelled development fixture. Kraken has no PUSD leg and CoinGecko no USDC leg: preferring one for the other
  // falls back to the eligible source, qualified.
  const stableSource = (asset: string): { source: string; fallback: boolean } => {
    const natural = asset === 'USDC' ? 'kraken_usdc_usd_ohlc' : 'coingecko_polygon_pusd_usd'
    if (prefs.stablecoinSource === 'auto') return { source: natural, fallback: false }
    return SOURCE_SUPPORTS[prefs.stablecoinSource].includes(asset) ? { source: prefs.stablecoinSource, fallback: false } : { source: natural, fallback: true }
  }
  const ref = (base: string, quote: string, rate: number | null, kind: RateKind, observedAt: string | null, freshness?: RateFreshness, source = 'ecb_euro_reference', fallback = false): FxReference => ({
    base, quote, rate, kind, source, methodology: kind === 'stablecoin' ? 'stablecoin_market_reference' : 'fiat_reference', fixture: true, fallback,
    observedAt, retrievedAt: observedAt, revision: FIXTURE_REV,
    freshness: freshness ?? (rate == null ? 'unavailable' : observedAt && (Date.parse(today) - Date.parse(observedAt)) / 86400000 > STALE_DAYS ? 'stale' : 'last_known'),
  })
  const toUsd = (a: string): FxReference => {
    if (a === 'USD') return ref('USD', 'USD', 1, 'fiat', null, 'identity')
    if (a in FIXTURE_STABLE_USD) { const s = stableSource(a); return ref(a, 'USD', FIXTURE_STABLE_USD[a], 'stablecoin', FIXTURE_DATE, undefined, s.source, s.fallback) }
    return ref(a, 'USD', null, 'fiat', null, 'unsupported')
  }
  const fromUsd = (c: string): FxReference => (c === 'USD' ? ref('USD', 'USD', 1, 'fiat', null, 'identity') : FIXTURE_USD_TO[c] ? ref('USD', c, FIXTURE_USD_TO[c].rate, 'fiat', FIXTURE_USD_TO[c].observedAt) : ref('USD', c, null, 'fiat', null, 'unsupported'))
  return {
    label: 'Development fixture rates', live: false,
    reference(base, quote) {
      if (base === quote) return ref(base, quote, 1, 'fiat', null, 'identity')
      if (quote === 'USD') return toUsd(base)
      if (base === 'USD') return fromUsd(quote)
      const a = toUsd(base), b = fromUsd(quote)
      const rate = a.rate != null && b.rate != null ? a.rate * b.rate : null
      return { ...b, base, rate, kind: a.kind, source: `${a.source} + ${b.source}`, fallback: !!(a.fallback || b.fallback), freshness: rate == null ? 'unavailable' : a.freshness === 'stale' || b.freshness === 'stale' ? 'stale' : b.freshness, methodology: `${a.methodology} × ${b.methodology}` }
    },
  }
}

/** Convert an amount between assets/currencies with a reference; null when the reference is unavailable (never 0).
 *  A confirmed zero is zero in any currency, so it needs no rate. */
export function convert(amount: number | null, ref: FxReference): number | null {
  if (amount === 0) return 0
  return amount == null || ref.rate == null ? null : amount * ref.rate
}

/* ───────────── Kinds of money in the UI ─────────────
   Three different things, never mixed:
   1. native   — an amount in its own asset (a USDC balance, a PUSD payout). Shown with fmtNative; never converted
                 implicitly.
   2. reporting — an amount the backend already reports in the reporting currency (integrated read models). Shown as is
                 with that currency (fmtReporting); multiplying it by a rate again would double-convert.
   3. display  — a USD-basis amount from the development fixture, converted for display at the current reference
                 (fmt / sfmt / kfmt). Labelled as fixture-based.
   Integration adapters wrap backend values as `reporting` (with their methodology) or `native`; only fixture values use
   display conversion. */
export type MoneyKind = 'native' | 'reporting' | 'display'
export interface Money { amount: number | null; kind: MoneyKind; unit: string }

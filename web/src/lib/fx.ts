/* Reporting currency and exchange-rate references.

   The reporting currency is a presentation and analytical choice: amounts are converted for display and comparison,
   never transferred. Balances, quantities, contract prices, payout units, execution prices and native funding keep their
   own units. The authoritative exchange-rate service belongs to the backend; this module defines the contract the
   frontend consumes and a deterministic development fixture that is labelled as such and never described as live.

   Kinds of reference (never mixed up):
   - fiat: a foreign-exchange reference (USD to EUR, GBP);
   - stablecoin: a market reference price of a stablecoin in USD (USDC, PUSD). Never assumed to be exactly 1;
   - hypothetical: an explicit user assumption (e.g. a replay's override), labelled as such.
   Methodology: current tracking uses the latest eligible reference; historical performance needs the reference for
   each valuation date (the backend supplies it); a constant-rate view must say so. */

/** Currencies the product can represent and format (an existing value in any of them can still be shown). */
export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'SGD' | 'MYR'
/** Reporting currencies users can choose. Starts with USD (default), EUR and GBP; more are added when there is real
 *  demand and reliable reference coverage. The backend schema may accept more; that doesn't make them selectable. */
export type ReportingCurrency = 'USD' | 'EUR' | 'GBP'
export interface CurrencyInfo { code: CurrencyCode; name: string; symbol: string }
export const ALL_CURRENCIES: CurrencyInfo[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$' },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM' },
]
export const REPORTING_CURRENCIES: ReportingCurrency[] = ['USD', 'EUR', 'GBP']
export const CURRENCIES = ALL_CURRENCIES.filter((c) => (REPORTING_CURRENCIES as string[]).includes(c.code))
export const currencyInfo = (c: string) => ALL_CURRENCIES.find((x) => x.code === c) ?? ALL_CURRENCIES[0]
export const isReportingCurrency = (v: unknown): v is ReportingCurrency => (REPORTING_CURRENCIES as unknown[]).includes(v)
/** How a native asset is written for people (canonical ids stay `USD`, `USDC`, `PUSD`). */
export const assetLabel = (a: string) => (a === 'PUSD' ? 'pUSD' : a)

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
export const SOURCE_LABEL: Record<FiatSource | StablecoinSource, string> = { ecb_euro_reference: 'ECB', kraken_usdc_usd_ohlc: 'Kraken', coingecko_polygon_pusd_usd: 'CoinGecko' }
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
  /** The provider's display name, from the service (e.g. a source registry). Absent when the service has none, in
   *  which case the source id is shown. Presentation never maps source ids to names itself. */
  sourceName?: string
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
/** Development fixture references (fixed numbers, not market data). The stablecoin references are fixture values,
 *  not a claim that the stablecoins trade at par. Tests pass their own table (e.g. a stale or missing rate). */
export type FixtureRates = Record<string, { rate: number; observedAt: string }>
const FIXTURE_USD_TO: FixtureRates = { EUR: { rate: 0.92, observedAt: FIXTURE_DATE }, GBP: { rate: 0.79, observedAt: FIXTURE_DATE } }
const FIXTURE_STABLE_USD: Record<string, number> = { USDC: 1, PUSD: 1 }
const STALE_DAYS = 3

export function fixtureFx(today = FIXTURE_DATE, prefs: FxPreferences = AUTO_FX, table: FixtureRates = FIXTURE_USD_TO): FxService {
  // The fixture uses the backend's source identifiers so the presentation matches integration, but every value is a
  // labelled development fixture. Kraken has no PUSD leg and CoinGecko no USDC leg: preferring one for the other
  // falls back to the eligible source, qualified.
  const stableSource = (asset: string): { source: string; fallback: boolean } => {
    const natural = asset === 'USDC' ? 'kraken_usdc_usd_ohlc' : 'coingecko_polygon_pusd_usd'
    if (prefs.stablecoinSource === 'auto') return { source: natural, fallback: false }
    return SOURCE_SUPPORTS[prefs.stablecoinSource].includes(asset) ? { source: prefs.stablecoinSource, fallback: false } : { source: natural, fallback: true }
  }
  const ref = (base: string, quote: string, rate: number | null, kind: RateKind, observedAt: string | null, freshness?: RateFreshness, source = 'ecb_euro_reference', fallback = false): FxReference => ({
    base, quote, rate, kind, source, sourceName: source.split(' + ').map((x) => SOURCE_LABEL[x as keyof typeof SOURCE_LABEL] ?? x).join(' and '), methodology: kind === 'stablecoin' ? 'stablecoin_market_reference' : 'fiat_reference', fixture: true, fallback,
    observedAt, retrievedAt: observedAt, revision: FIXTURE_REV,
    freshness: freshness ?? (rate == null ? 'unavailable' : observedAt && (Date.parse(today) - Date.parse(observedAt)) / 86400000 > STALE_DAYS ? 'stale' : 'last_known'),
  })
  const toUsd = (a: string): FxReference => {
    if (a === 'USD') return ref('USD', 'USD', 1, 'fiat', null, 'identity')
    if (a in FIXTURE_STABLE_USD) { const s = stableSource(a); return ref(a, 'USD', FIXTURE_STABLE_USD[a], 'stablecoin', FIXTURE_DATE, undefined, s.source, s.fallback) }
    return ref(a, 'USD', null, 'fiat', null, 'unsupported')
  }
  const fromUsd = (c: string): FxReference => (c === 'USD' ? ref('USD', 'USD', 1, 'fiat', null, 'identity') : table[c] ? ref('USD', c, table[c].rate, 'fiat', table[c].observedAt) : ref('USD', c, null, 'fiat', null, 'unsupported'))
  return {
    label: 'Sample rates', live: false,
    reference(base, quote) {
      if (base === quote) return ref(base, quote, 1, 'fiat', null, 'identity')
      if (quote === 'USD') return toUsd(base)
      if (base === 'USD') return fromUsd(quote)
      const a = toUsd(base), b = fromUsd(quote)
      const rate = a.rate != null && b.rate != null ? a.rate * b.rate : null
      return { ...b, base, rate, kind: a.kind, source: `${a.source} + ${b.source}`, sourceName: `${a.sourceName ?? a.source} and ${b.sourceName ?? b.source}`, fallback: !!(a.fallback || b.fallback), freshness: rate == null ? 'unavailable' : a.freshness === 'stale' || b.freshness === 'stale' ? 'stale' : b.freshness, methodology: `${a.methodology} × ${b.methodology}` }
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

/** Display name of a reference's provider: the service's name, else its source id. */
export const sourceName = (r: Pick<FxReference, 'source' | 'sourceName'>) => r.sourceName ?? r.source

/** A short, specific warning for one conversion leg (an asset to USD, or USD to the reporting currency) that can't be
 *  used as is, or null when it's fine. A missing stablecoin or
 *  other asset leg leaves no reliable converted value; a missing USD to reporting-currency leg leaves the USD value. */
export function rateWarning(r: FxReference, fmtDay: (iso: string) => string): string | null {
  const pair = `${assetLabel(r.base)} to ${assetLabel(r.quote)}`
  if (r.rate == null) {
    if (r.base === 'USD') return `No ${pair} rate is available, so values are shown in USD.`
    return `No ${pair} rate is available, so totals that include ${assetLabel(r.base)} can’t be converted.`
  }
  if (r.freshness === 'stale') return `The ${pair} rate is out of date${r.observedAt ? ` (last observed ${fmtDay(r.observedAt)})` : ''}.`
  return null
}

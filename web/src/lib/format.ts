/** Money/number formatting. Uses a true minus sign (−) for negatives. */
const nf = (d: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

/* Reporting currency. Portfolio money (`fmt`, `sfmt`, `kfmt`) is held in the USD reporting basis and shown in the
   selected reporting currency at the active reference rate. The app sets this once, above all pages
   (ReportingProvider); conversion is presentation only and never changes any stored amount. Native balances use
   `fmtNative`; prices, quantities and payout units are never converted. When the reference is unavailable, values are
   shown in USD with the code (never as zero, never at an assumed rate). */
export interface ReportingFormat { code: string; symbol: string; rate: number | null }
let REPORT: ReportingFormat = { code: 'USD', symbol: '$', rate: 1 }
export function setReportingFormat(r: ReportingFormat) { REPORT = r }
export const reportingFormat = () => REPORT
const conv = (v: number) => (REPORT.rate == null ? v : v * REPORT.rate)
const sym = () => (REPORT.rate == null ? '$' : REPORT.symbol)
const suffix = () => (REPORT.rate == null && REPORT.code !== 'USD' ? ' USD' : '')

export const fmt = (v: number, d = 0) => { const x = conv(v); return `${x < 0 ? '−' : ''}${sym()}${nf(d).format(Math.abs(x))}${suffix()}` }
export const sfmt = (v: number, d = 0) => { const x = conv(v); return `${x > 0 ? '+' : x < 0 ? '−' : ''}${sym()}${nf(d).format(Math.abs(x))}${suffix()}` }
export const kfmt = (v: number) => {
  const x = conv(v), a = Math.abs(x)
  const s = a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : `${Math.round(a)}`
  return `${x < 0 ? '−' : ''}${sym()}${s}`
}
/** An amount the backend already reports in `currency` (authoritative): formatted with that currency's symbol and
 *  NEVER converted again. Unavailable stays unavailable. */
const SYMBOL: Record<string, string> = { USD: '$', SGD: 'S$', EUR: '€', GBP: '£', MYR: 'RM' }
export const fmtReporting = (v: number | null, currency: string, d = 2) => (v == null ? 'Unavailable' : `${v < 0 ? '−' : ''}${SYMBOL[currency] ?? ''}${nf(d).format(Math.abs(v))}${SYMBOL[currency] ? '' : ` ${currency}`}`)
/** The active reporting currency code (USD when conversion is unavailable). */
export const reportingCode = () => (REPORT.rate == null ? 'USD' : REPORT.code)
export const skfmt = (v: number) => `${v > 0 ? '+' : ''}${kfmt(v)}`
export const pct = (v: number, d = 1) => `${v.toFixed(d)}%`
export const int = (v: number) => nf(0).format(v)

/** Split a money value into integer and decimal parts for the HeroFigure. */
export const splitMoney = (v: number) => {
  const x = conv(v)
  const [i, d] = Math.abs(x).toFixed(2).split('.')
  return { sign: x < 0 ? '−' : '', int: nf(0).format(Number(i)), dec: d, symbol: sym() }
}

/** Deterministic pseudo-random generator so mock charts are stable between renders. */
export const rng = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647
/** Quantity: whole numbers without decimals, fractional ones with up to 2. */
export const qty = (v: number) => (Number.isInteger(v) ? nf(0).format(v) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v))

/** An amount in its native asset: "25,000.00 USDC". USD, USDC and PUSD are never silently treated as the same. */
export const fmtNative = (v: number, denom: string, d = 2) => `${v < 0 ? '−' : ''}${nf(d).format(Math.abs(v))} ${denom}`
/** A binary contract's market price, as a price (0.64) or as the market-implied probability (64%). Never a forecast. */
export const fmtPx = (p: number, mode: 'price' | 'implied' = 'price') => (mode === 'implied' ? `${Math.round(p * 100)}%` : p.toFixed(2))

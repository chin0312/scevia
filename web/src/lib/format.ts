/** Money/number formatting. Uses a true minus sign (−) for negatives. */
const nf = (d: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export const fmt = (v: number, d = 0) => `${v < 0 ? '−' : ''}$${nf(d).format(Math.abs(v))}`
export const sfmt = (v: number, d = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${nf(d).format(Math.abs(v))}`
export const kfmt = (v: number) => {
  const a = Math.abs(v)
  const s = a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : `${Math.round(a)}`
  return `${v < 0 ? '−' : ''}$${s}`
}
export const skfmt = (v: number) => `${v > 0 ? '+' : ''}${kfmt(v)}`
export const pct = (v: number, d = 1) => `${v.toFixed(d)}%`
export const int = (v: number) => nf(0).format(v)

/** Split a money value into integer and decimal parts for the HeroFigure. */
export const splitMoney = (v: number) => {
  const [i, d] = Math.abs(v).toFixed(2).split('.')
  return { sign: v < 0 ? '−' : '', int: nf(0).format(Number(i)), dec: d }
}

/** Deterministic pseudo-random generator so mock charts are stable between renders. */
export const rng = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647
/** Quantity: whole numbers without decimals, fractional ones with up to 2. */
export const qty = (v: number) => (Number.isInteger(v) ? nf(0).format(v) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v))

/** An amount in its native asset: "25,000.00 USDC". USD, USDC and PUSD are never silently treated as the same. */
export const fmtNative = (v: number, denom: string, d = 2) => `${v < 0 ? '−' : ''}${nf(d).format(Math.abs(v))} ${denom}`
/** A binary contract's market price, as a price (0.64) or as the market-implied probability (64%). Never a forecast. */
export const fmtPx = (p: number, mode: 'price' | 'implied' = 'price') => (mode === 'implied' ? `${Math.round(p * 100)}%` : p.toFixed(2))

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

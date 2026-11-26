/* Small helpers for user-facing text built from data: counts with the right plural, natural lists, and sentences
   assembled from optional parts. They keep punctuation and spacing out of call sites, so missing or extra fields
   never produce leading commas, doubled spaces or empty parentheses. */

const nf = new Intl.NumberFormat('en-US')

/** "1 position", "3 positions", "0 positions". The plural defaults to the singular plus "s". */
export const count = (n: number, one: string, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`

/** "A", "A and B", "A, B and C". Empty and blank items are dropped. */
export function joinList(items: readonly (string | null | undefined | false)[], conjunction = 'and'): string {
  const xs = items.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
  if (xs.length <= 1) return xs[0] ?? ''
  return `${xs.slice(0, -1).join(', ')} ${conjunction} ${xs[xs.length - 1]}`
}

/** Joins optional sentences, each ending with exactly one full stop (or its own ! or ?). */
export function sentences(...parts: (string | null | undefined | false)[]): string {
  return parts
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim().replace(/\s+/g, ' ').replace(/[,;:\s]+$/, ''))
    .map((x) => (/[.!?…]$/.test(x) ? x : `${x}.`))
    .join(' ')
}

/** Joins optional phrases of one clause with commas: "Polymarket, Politics". */
export const phrase = (...parts: (string | null | undefined | false)[]) => parts.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).join(', ')

/** Capitalizes the first letter only (keeps names and codes such as pUSD intact after the first character). */
export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

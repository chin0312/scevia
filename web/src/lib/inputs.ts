/* Parsing of typed numbers in Scenario Lab. Each parser says whether the text is empty, still being typed, invalid,
   or a committed value, so the simulation never keeps using a previous value while the field shows something else.
   Accepted formats are deliberately narrow: plain digits with optional thousands separators and a decimal point.
   Scientific notation, signs, units other than a leading "$", and extra decimals are rejected, not reinterpreted. */

export type Parsed = { state: 'empty' } | { state: 'partial'; message: string } | { state: 'invalid'; message: string } | { state: 'ok'; value: number }

const clean = (t: string) => t.trim().replace(/^\$/, '').replace(/,(?=\d{3}(\D|$))/g, '')

/** Whole shares. Fractional quantities aren't supported yet (provider lot sizes will define them in Phase 2). */
export function parseShares(text: string): Parsed {
  const t = clean(text)
  if (t === '') return { state: 'empty' }
  if (!/^\d+$/.test(t)) return /^\d+\.\d*$/.test(t) ? { state: 'invalid', message: 'Use whole shares' } : { state: 'invalid', message: 'Enter digits only, e.g. 2500' }
  return { state: 'ok', value: Number(t) }
}

/** Price per share in dollars, at most 3 decimals (finest tick in the sample data is 0.001). "0", "0." and "." are
 *  treated as still being typed. Range checks (0.01–0.99) are left to the engine so the message is the same everywhere. */
export function parsePrice(text: string): Parsed {
  const t = clean(text)
  if (t === '') return { state: 'empty' }
  if (/^0?\.?$/.test(t) || /^0?\.0{0,2}$/.test(t)) return { state: 'partial', message: 'Finish entering a price' }
  if (!/^\d*\.?\d+$/.test(t) && !/^\d+\.$/.test(t)) return { state: 'invalid', message: 'Enter a price such as 0.45' }
  const dec = t.split('.')[1] ?? ''
  if (dec.length > 3) return { state: 'invalid', message: 'Use at most 3 decimals' }
  return { state: 'ok', value: Number(t) }
}

/** Money with up to 2 decimals (added capital). */
export function parseMoney(text: string): Parsed {
  const t = clean(text)
  if (t === '') return { state: 'empty' }
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return { state: 'invalid', message: 'Enter an amount such as 5000 or 5,000.50' }
  return { state: 'ok', value: Number(t) }
}

/** Percentage with up to 3 decimals (custom fee). */
export function parsePct(text: string): Parsed {
  const t = clean(text).replace(/%$/, '')
  if (t === '') return { state: 'empty' }
  if (/^\d*\.$/.test(t)) return { state: 'partial', message: 'Finish entering a percentage' }
  if (!/^\d+(\.\d{1,3})?$/.test(t) && !/^\.\d{1,3}$/.test(t)) return { state: 'invalid', message: 'Enter a percentage such as 1.5' }
  return { state: 'ok', value: Number(t) }
}

/** Display a stored price with the precision it was entered with (2 or 3 decimals). */
export const fmtPrice = (p: number) => (Math.abs(p * 100 - Math.round(p * 100)) < 1e-9 ? p.toFixed(2) : p.toFixed(3))

import { and, desc, gte, inArray, lte } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { digest } from '../accounting/decisions.js'
import type { Database } from '../db/client.js'
import { fxReferences } from '../db/schema.js'

export const reportingCurrency = z.enum(['USD', 'SGD', 'EUR', 'GBP', 'MYR'])
export const fxEvidenceMode = z.enum(['knowledge', 'retrospective'])
export type FxMode = z.infer<typeof fxEvidenceMode>
export const referenceInput = z.object({
  base: z.enum(['USD', 'SGD', 'EUR', 'GBP', 'MYR', 'USDC', 'PUSD']), quote: reportingCurrency,
  rate: z.string().regex(/^\d{1,12}(?:\.\d{1,18})?$/).refine((rate) => new Decimal(rate).gt(0)),
  source: z.string().min(1).max(120), methodology: z.enum(['fiat_reference', 'stablecoin_market_reference']),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  observedAt: z.iso.datetime({ offset: true }), retrievedAt: z.iso.datetime({ offset: true }),
}).strict().refine((row) => row.base !== row.quote && Date.parse(row.observedAt) <= Date.parse(row.retrievedAt)
  && (!row.publishedAt || Date.parse(row.publishedAt) >= Date.parse(row.observedAt)
    && Date.parse(row.publishedAt) <= Date.parse(row.retrievedAt))
  && (row.methodology === 'stablecoin_market_reference') === ['USDC', 'PUSD'].includes(row.base))

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN })
type Row = Omit<typeof fxReferences.$inferSelect, 'publishedAt'> & { publishedAt?: Date | null }
type FxRows = Row[] & { truncated?: boolean }
export type FxScope = { assets: string[]; currency: string; mode?: FxMode; source?: string }
type Orientation = { row: Row; inverted: boolean }
const maxAge = (row: Row) => (row.methodology === 'fiat_reference' ? 5 : 1) * 86_400_000

export async function storeReferences(db: Pick<Database, 'insert'>, input: unknown[]) {
  const rows = z.array(referenceInput).min(1).max(600).parse(input)
  if (rows.some((row) => Date.parse(row.retrievedAt) > Date.now())) throw new Error('fx_future_evidence')
  await db.insert(fxReferences).values(rows.map((row) => ({
    ...row, observedAt: new Date(row.observedAt), retrievedAt: new Date(row.retrievedAt), publishedAt: row.publishedAt ? new Date(row.publishedAt) : null,
    revision: digest([row.base, row.quote, new D(row.rate).toFixed(), row.source, row.methodology, new Date(row.observedAt).toISOString(), row.publishedAt ?? null]),
  }))).onConflictDoNothing()
}

export async function loadFx(db: Pick<Database, 'select'>, from: string, through: string, scope?: FxScope): Promise<FxRows> {
  const relevant = scope ? [...new Set([...scope.assets, scope.currency, 'EUR', 'USD'])] : null
  const rows = await db.select().from(fxReferences).where(and(lte(fxReferences.observedAt, new Date(through)),
    gte(fxReferences.observedAt, new Date(Date.parse(from) - 30 * 86_400_000)),
    relevant ? inArray(fxReferences.base, relevant) : undefined, relevant ? inArray(fxReferences.quote, relevant) : undefined))
    .orderBy(desc(fxReferences.observedAt), desc(fxReferences.retrievedAt), desc(fxReferences.revision)).limit(6001)
  return Object.assign(rows.slice(0, 6000), { truncated: rows.length > 6000 })
}

export function selectRate(rows: FxRows, base: string, quote: string, asOf: string,
  options: { mode?: FxMode | undefined; source?: string | undefined } = {}) {
  if (base === quote) return { availability: 'identity' as const, rate: '1', legs: [] }
  if (!referenceInput.shape.base.safeParse(base).success || !reportingCurrency.safeParse(quote).success) {
    return { availability: 'unsupported' as const, rate: null, legs: [] }
  }
  if (rows.truncated) return { availability: 'work_limit' as const, rate: null, legs: [] }
  const cutoff = Date.parse(asOf)
  let stale = false
  let directLastKnown: Orientation | null = null
  let conflict = false
  const edge = (from: string, to: string): Orientation | null => {
    const matching = rows.filter((row) => (row.base === from && row.quote === to || row.base === to && row.quote === from)
      && (options.mode === 'retrospective' || (row.publishedAt ?? row.retrievedAt).getTime() <= cutoff)
      && row.observedAt.getTime() <= cutoff)
      .sort((a, b) => {
        const preferred = Number(b.source === options.source) - Number(a.source === options.source)
        return preferred || b.observedAt.getTime() - a.observedAt.getTime() || a.source.localeCompare(b.source)
          || a.retrievedAt.getTime() - b.retrievedAt.getTime()
      })
    const latest = matching[0]
    if (!latest) return null
    if (cutoff - latest.observedAt.getTime() > maxAge(latest)) {
      stale = true
      if (from === base && to === quote) directLastKnown = { row: latest, inverted: latest.base !== from }
      return null
    }
    const value = (row: Row) => row.base === from ? new D(row.rate) : new D(1).div(row.rate)
    if (matching.some((row) => row.source === latest.source && row.methodology === latest.methodology && row.observedAt.getTime() === latest.observedAt.getTime()
      && !value(row).eq(value(latest)))) { conflict = true; return null }
    return { row: latest, inverted: latest.base !== from }
  }
  const direct = edge(base, quote)
  let path = direct ? [direct] : []
  for (const cross of ['EUR', 'USD']) {
    if (base === cross || quote === cross || path.length || conflict) continue
    const a = edge(base, cross)
    const b = edge(cross, quote)
    if (a && b) path = [a, b]
  }
  if (!path.length && !conflict && ['USDC', 'PUSD'].includes(base) && !['USD', 'EUR'].includes(quote)) {
    const a = edge(base, 'USD'); const b = edge('USD', 'EUR'); const c = edge('EUR', quote)
    if (a && b && c) path = [a, b, c]
  }
  if (!path.length || conflict) {
    const previous = directLastKnown as Orientation | null
    return { availability: conflict ? 'conflict' as const : stale ? 'stale' as const : 'missing' as const, rate: null, legs: [],
      ...(previous && !conflict ? { lastKnown: { rate: previous.inverted ? new D(1).div(previous.row.rate).toFixed() : new D(previous.row.rate).toFixed(),
        revision: previous.row.revision, source: previous.row.source, observedAt: previous.row.observedAt.toISOString(),
        retrievedAt: previous.row.retrievedAt.toISOString(), qualification: 'stale_reference_only' } } : {}) }
  }
  const rate = path.reduce((product, { row, inverted }) => inverted ? product.div(row.rate) : product.mul(row.rate), new D(1))
  return { availability: 'available' as const, rate: rate.toFixed(), legs: path.map(({ row, inverted }) => ({
    ...row, rate: new D(row.rate).toFixed(), observedAt: row.observedAt.toISOString(), retrievedAt: row.retrievedAt.toISOString(), publishedAt: row.publishedAt?.toISOString() ?? null, inverted,
  })) }
}

export function reportAmounts(rows: FxRows, amounts: Array<{ asset: string; value: string | null }>, currency: string, asOf: string, options: { mode?: FxMode | undefined; source?: string | undefined } = {}) {
  const components = amounts.map((entry) => {
    const reference = selectRate(rows, entry.asset, currency, asOf, options)
    return { ...entry, reference, reportingValue: entry.value === null || reference.rate === null ? null
      : new D(entry.value).mul(reference.rate).toFixed() }
  })
  const known = components.filter((component) => component.reportingValue !== null)
  const sum = known.reduce((acc, component) => acc.plus(component.reportingValue!), new D(0)).toFixed()
  return { currency, methodology: options.mode === 'retrospective' ? 'retrospective_reference' : 'point_in_time_reference', fundsTransferable: false,
    completeValue: known.length && known.length === components.length ? sum : null,
    knownSubtotal: known.length ? sum : null, components, revision: digest([currency, components.map((row) => row.reference)]) }
}

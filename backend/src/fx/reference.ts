import { inArray, sql } from 'drizzle-orm'
import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { digest } from '../accounting/decisions.js'
import type { Database } from '../db/client.js'
import { polygonPusd } from '../providers/polymarket/collateral.js'
import { fxReferences } from '../db/schema.js'

export const reportingCurrency = z.enum(['USD', 'SGD', 'EUR', 'GBP', 'MYR'])
export const fiatReferenceSource = z.enum(['ecb_euro_reference'])
export const stablecoinReferenceSource = z.enum(['kraken_usdc_usd_ohlc', 'coingecko_polygon_pusd_usd', 'coingecko_polygon_pusd_usd_daily'])
export const fxReferenceSource = z.union([fiatReferenceSource, stablecoinReferenceSource])
export const referenceFamily = (source: string) => source === 'coingecko_polygon_pusd_usd_daily' ? 'coingecko_polygon_pusd_usd' : source
export const fxEvidenceMode = z.enum(['knowledge', 'retrospective'])
export type FxMode = z.infer<typeof fxEvidenceMode>
export const referenceInput = z.object({
  base: z.enum(['USD', 'SGD', 'EUR', 'GBP', 'MYR', 'USDC', 'PUSD']), quote: reportingCurrency,
  rate: z.string().regex(/^\d{1,12}(?:\.\d{1,18})?$/).refine((rate) => new Decimal(rate).gt(0)),
  source: z.string().min(1).max(120), methodology: z.enum(['fiat_reference', 'stablecoin_market_reference']),
  tokenIdentity: z.object({ chain: z.literal('polygon-pos'), contract: z.literal(polygonPusd),
    quoteBasis: z.literal('vendor_aggregated_fiat_usd') }).strict().optional(),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  observedAt: z.iso.datetime({ offset: true }), retrievedAt: z.iso.datetime({ offset: true }),
}).strict().refine((row) => row.base !== row.quote && Date.parse(row.observedAt) <= Date.parse(row.retrievedAt)
  && (!row.publishedAt || Date.parse(row.publishedAt) >= Date.parse(row.observedAt)
    && Date.parse(row.publishedAt) <= Date.parse(row.retrievedAt))
  && (!row.tokenIdentity || row.base === 'PUSD' && row.quote === 'USD')
  && (!row.source.startsWith('coingecko_polygon_pusd_usd') || !!row.tokenIdentity)
  && (row.methodology === 'stablecoin_market_reference') === ['USDC', 'PUSD'].includes(row.base))

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN })
type Row = Omit<typeof fxReferences.$inferSelect, 'publishedAt' | 'tokenIdentity'> & { publishedAt?: Date | null; tokenIdentity?: typeof fxReferences.$inferSelect.tokenIdentity }
type FxRows = Row[] & { truncated?: boolean }
export type FxScope = { assets: string[]; currency: string; mode?: FxMode; cutoffs?: string[] }
export type FxOptions = { mode?: FxMode | undefined; source?: string | undefined;
  fiatSource?: string | null | undefined; stablecoinSource?: string | null | undefined }
type Orientation = { row: Row; inverted: boolean }
function preferredReference(fiat: boolean, options: FxOptions) {
  const capabilities = fiat ? fiatReferenceSource : stablecoinReferenceSource
  const selected = capabilities.safeParse(options.source).data
    ?? capabilities.safeParse(fiat ? options.fiatSource : options.stablecoinSource).data
  return selected ? referenceFamily(selected) : null
}

const maxAge = (row: Row) => {
  if (row.methodology === 'fiat_reference') return 5 * 86_400_000
  if (row.source === 'coingecko_polygon_pusd_usd') return 6 * 3_600_000
  return 86_400_000
}

export async function storeReferences(db: Pick<Database, 'insert'>, input: unknown[]) {
  const rows = z.array(referenceInput).min(1).max(600).parse(input)
  if (rows.some((row) => Date.parse(row.retrievedAt) > Date.now())) throw new Error('fx_future_evidence')
  await db.insert(fxReferences).values(rows.map((row) => ({
    ...row, observedAt: new Date(row.observedAt), retrievedAt: new Date(row.retrievedAt), publishedAt: row.publishedAt ? new Date(row.publishedAt) : null,
    revision: digest([row.base, row.quote, new D(row.rate).toFixed(), row.source, row.methodology, new Date(row.observedAt).toISOString(), row.publishedAt ?? null, row.tokenIdentity ?? null]),
  }))).onConflictDoNothing()
}

export const fxAnchors = (times: string[]) => times.flatMap((time) => [new Date(Date.parse(time) - 1).toISOString(), time])

export async function loadFx(db: Pick<Database, 'select' | 'execute'>, from: string, through: string, scope: FxScope): Promise<FxRows> {
  const relevant = [...new Set([...scope.assets, scope.currency, 'EUR', 'USD'])]
  if (scope.assets.every((asset) => asset === scope.currency)) return []
  const day = 86_400_000
  const start = Date.parse(from); const end = Date.parse(through)
  const daily: string[] = []
  for (let time = Math.floor(start / day) * day + day - 1; time < end && daily.length <= 366; time += day) {
    if (time > start) daily.push(new Date(time).toISOString())
  }
  const clocks = [...new Set([from, through, ...daily, ...(scope.cutoffs ?? [])])]
  if (daily.length > 366 || clocks.length > 2000) return Object.assign([], { truncated: true })
  const keys = sql.join(relevant.map((value) => sql`${value}`), sql`, `)
  const floor = new Date(start - 30 * day)
  const clocksSql = sql.join(clocks.map((value) => sql`${value}`), sql`, `)
  const result = await db.execute<{ revision: string }>(sql`
    with pairs as (
      select distinct base, quote, source, methodology from ${fxReferences}
      where base in (${keys}) and quote in (${keys}) and observed_at between ${floor.toISOString()}::timestamptz and ${through}::timestamptz
    )
    select distinct chosen.revision
    from unnest(array[${clocksSql}]::timestamptz[]) as cutoffs(at)
    cross join pairs
    cross join lateral (
      select revision from ${fxReferences} as ref
      where ref.base = pairs.base and ref.quote = pairs.quote and ref.source = pairs.source and ref.methodology = pairs.methodology
        and ref.observed_at between ${floor.toISOString()}::timestamptz and cutoffs.at
        and (coalesce(ref.published_at, ref.retrieved_at) <= cutoffs.at or
          (${scope.mode === 'retrospective'} and (ref.source <> 'ecb_euro_reference'
            or (ref.observed_at at time zone 'UTC')::date < (cutoffs.at at time zone 'UTC')::date)))
      order by ref.observed_at desc fetch first 1 row with ties
    ) chosen limit 6001
  `)
  if (result.rows.length > 6000) return Object.assign([], { truncated: true })
  return result.rows.length ? db.select().from(fxReferences).where(inArray(fxReferences.revision, result.rows.map((row) => row.revision))) : []
}

export function selectRate(rows: FxRows, base: string, quote: string, asOf: string,
  options: FxOptions = {}) {
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
    const stablecoin = ['USDC', 'PUSD'].some((asset) => asset === from || asset === to)
    const preferredSource = preferredReference(!stablecoin, options)
    const preferred = (row: Row) => referenceFamily(row.source) === preferredSource
    const matching = rows.filter((row) => (row.base === from && row.quote === to || row.base === to && row.quote === from)
      && ((row.publishedAt ?? row.retrievedAt).getTime() <= cutoff || (options.mode === 'retrospective'
        && (row.source !== 'ecb_euro_reference' || Math.floor(row.observedAt.getTime() / 86_400_000) < Math.floor(cutoff / 86_400_000))))
      && row.observedAt.getTime() <= cutoff && row.observedAt <= row.retrievedAt
      && (!row.publishedAt || row.publishedAt >= row.observedAt && row.publishedAt <= row.retrievedAt)
      && (!row.source.startsWith('coingecko_polygon_pusd_usd') || row.base === 'PUSD' && row.quote === 'USD'
        && row.tokenIdentity?.chain === 'polygon-pos' && row.tokenIdentity.contract === polygonPusd
        && row.tokenIdentity.quoteBasis === 'vendor_aggregated_fiat_usd'))
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || a.source.localeCompare(b.source)
        || a.retrievedAt.getTime() - b.retrievedAt.getTime() || a.revision.localeCompare(b.revision))
    const staleRows = matching.filter((row) => cutoff - row.observedAt.getTime() > maxAge(row))
    const fresh = matching.filter((row) => cutoff - row.observedAt.getTime() <= maxAge(row))
    const latest = fresh.find(preferred) ?? fresh[0]
    const preferredLatest = matching.find(preferred)
    const previous = staleRows.find((row) => !latest || row.observedAt >= latest.observedAt
      || preferred(row) && !preferred(latest))
    const value = (row: Row) => row.base === from ? new D(row.rate) : new D(1).div(row.rate)
    const conflicting = (candidate: Row) => matching.some((row) => row.source === candidate.source
      && row.methodology === candidate.methodology && row.observedAt.getTime() === candidate.observedAt.getTime()
      && !value(row).eq(value(candidate)))
    if ([latest, preferredLatest, matching[0]].some((row) => row && conflicting(row))) {
      conflict = true
      return null
    }
    if (previous) {
      stale = true
      if (from === base && to === quote) directLastKnown = { row: previous, inverted: previous.base !== from }
    }
    if (!latest) return null
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
  const previous = directLastKnown as Orientation | null
  const lastKnown = previous && !conflict ? { rate: previous.inverted ? new D(1).div(previous.row.rate).toFixed() : new D(previous.row.rate).toFixed(),
    revision: previous.row.revision, source: previous.row.source, methodology: previous.row.methodology, tokenIdentity: previous.row.tokenIdentity,
    observedAt: previous.row.observedAt.toISOString(), retrievedAt: previous.row.retrievedAt.toISOString(), qualification: 'stale_reference_only' } : null
  if (!path.length || conflict) {
    return { availability: conflict ? 'conflict' as const : stale ? 'stale' as const : 'missing' as const, rate: null, legs: [],
      ...(lastKnown ? { lastKnown } : {}) }
  }
  const rate = path.reduce((product, { row, inverted }) => inverted ? product.div(row.rate) : product.mul(row.rate), new D(1))
  return { availability: 'available' as const,
    fallback: path.some(({ row }) => {
      const preferredSource = preferredReference(row.methodology === 'fiat_reference', options)
      return Boolean(preferredSource && preferredSource !== referenceFamily(row.source))
    }), ...(lastKnown ? { lastKnown } : {}), rate: rate.toFixed(), legs: path.map(({ row, inverted }) => ({
    ...row, rate: new D(row.rate).toFixed(), observedAt: row.observedAt.toISOString(), retrievedAt: row.retrievedAt.toISOString(), publishedAt: row.publishedAt?.toISOString() ?? null, inverted,
  })) }
}

export function convertAmount(value: string | null, rate: string | null) {
  if (value === null) return null
  const amount = new D(value)
  return amount.isZero() ? '0' : rate === null ? null : amount.mul(rate).toFixed()
}

export function reportAmounts(rows: FxRows, amounts: Array<{ asset: string; value: string | null }>, currency: string, asOf: string, options: FxOptions = {},
  assumedUsdPerUnit?: Partial<Record<'USDC' | 'PUSD', string>>) {
  const components = amounts.map((entry) => {
    const assumed = entry.asset === currency ? undefined : assumedUsdPerUnit?.[entry.asset as 'USDC' | 'PUSD']
    const reference = selectRate(rows, assumed ? 'USD' : entry.asset, currency, asOf, options)
    const rate = assumed && reference.rate ? new D(assumed).mul(reference.rate).toFixed() : reference.rate
    return { ...entry, reference: assumed ? { ...reference, rate, assumedUsdPerUnit: assumed, qualification: 'hypothetical_stablecoin_override' as const } : reference,
      reportingValue: convertAmount(entry.value, rate) }
  })
  const known = components.filter((component) => component.reportingValue !== null)
  const sum = known.reduce((acc, component) => acc.plus(component.reportingValue!), new D(0)).toFixed()
  return { currency, methodology: options.mode === 'retrospective' ? 'retrospective_reference' : 'point_in_time_reference', fundsTransferable: false,
    completeValue: known.length && known.length === components.length ? sum : null,
    knownSubtotal: known.length ? sum : null, components, revision: digest([currency, components.map((row) => row.reference)]) }
}

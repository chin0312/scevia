import { z } from 'zod'
import { ScenarioError, type ScenarioInstrument } from './engine.js'

const timestamp = z.iso.datetime({ offset: true })
const decimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/)
const publicLink = z.string().min(1).max(2048)
export const publicSelection = z.union([
  z.object({ url: publicLink, assetId: z.string().regex(/^\d{1,100}$/),
    assetIdType: z.enum(['position_id', 'clob_token_id']), captureCurrentQuote: z.boolean().optional() }).strict(),
  z.object({ url: publicLink, assetId: z.string().regex(/^(?:demo:)?[A-Z0-9][A-Z0-9_.-]{0,127}:(yes|no)$/),
    assetIdType: z.literal('kalshi_outcome'), captureCurrentQuote: z.boolean().optional() }).strict(),
])
export type PublicSelection = z.infer<typeof publicSelection>
const result = z.object({ item: z.object({ eventId: z.string().nullable().optional(), markets: z.array(z.object({
  providerMarketId: z.string(), conditionId: z.string(), lifecycle: z.string(), endDate: z.string().nullable(),
  feeMetadata: z.object({ status: z.string(), source: z.literal('gamma_market'), retrievedAt: timestamp,
    rate: decimal.nullable(), exponent: z.number().nullable(), takerOnly: z.boolean().nullable(), amountUnit: z.literal('USDC') }),
  outcomes: z.array(z.object({ assetId: z.string().nullable(), assetIdType: z.string(), name: z.string().nullable(), outcomeIndex: z.number().int().optional(),
    referencePrice: z.object({ value: decimal.nullable(), retrievedAt: timestamp.nullable(), freshness: z.string() }).optional() })),
})) }) })

export function selectPublicOutcome(raw: unknown, selection: PublicSelection, asset: string, asOf: string): ScenarioInstrument {
  if (selection.assetIdType === 'kalshi_outcome') return selectKalshiOutcome(raw, selection, asset, asOf)
  if (asset !== 'USDC') throw new ScenarioError('public_market_asset_mismatch')
  const parsed = result.safeParse(raw)
  if (!parsed.success) throw new ScenarioError('public_market_evidence_unavailable')
  const matches = parsed.data.item.markets.flatMap((market) => market.outcomes
    .filter((outcome) => outcome.assetId === selection.assetId && outcome.assetIdType === selection.assetIdType)
    .map((outcome) => ({ market, outcome })))
  if (matches.length !== 1) throw new ScenarioError('public_market_outcome_not_unique')
  const { market, outcome } = matches[0]!
  const fee = market.feeMetadata
  const latest = outcome.referencePrice
  const markAt = latest?.retrievedAt ? new Date(latest.retrievedAt).toISOString() : null
  const fresh = markAt !== null && latest?.value != null && latest.freshness === 'retrieved_now_source_time_unavailable'
  if (selection.captureCurrentQuote && !fresh) throw new ScenarioError('current_quote_unavailable')
  const usable = fresh && (markAt <= asOf || selection.captureCurrentQuote === true)
  const feeSchedule = fee.status === 'fee_free' || (fee.status === 'known' && fee.exponent === 1 && fee.takerOnly === true && fee.rate !== null)
    ? { version: 'polymarket-price-variance-v1' as const, rate: fee.status === 'fee_free' ? '0' : fee.rate!,
      retrievedAt: fee.retrievedAt, source: fee.source, denomination: fee.amountUnit } : undefined
  return { id: 'polymarket:' + selection.assetIdType + ':' + selection.assetId,
    mark: usable ? latest?.value ?? null : null, markAt: usable ? markAt : null, nativeIdType: selection.assetIdType,
    ...(outcome.outcomeIndex === undefined ? {} : { nativeOutcomeIndex: outcome.outcomeIndex }),
    ...(usable ? { markSource: markAt > asOf ? 'assumed_current_quote' as const : 'public_retrieval_at_cutoff' as const } : {}),
    market: 'polymarket:' + market.conditionId,
    ...(parsed.data.item.eventId ? { event: 'polymarket:' + parsed.data.item.eventId } : {}),
    venue: 'polymarket', provider: 'polymarket', nativeMarket: market.conditionId, nativeInstrument: selection.assetId, outcome: outcome.name, providerMarket: market.providerMarketId, lifecycle: market.lifecycle,
    settlementAsset: asset, latestPrice: latest?.value ?? null, latestPriceAt: markAt, resolvesAt: market.endDate,
    ...(feeSchedule ? { feeSchedule } : {}) }
}


const kalshiEnvelope = z.object({ items: z.array(z.object({ marketTicker: z.string(), eventTicker: z.string(), lifecycle: z.string(),
  settlementAsset: z.literal('USD'), expectedResolutionAt: timestamp.nullable().optional(), establishedPayoutUnit: z.literal('1').nullable().optional(), outcomes: z.array(z.object({ id: z.string(), side: z.enum(['yes', 'no']),
    name: z.string(), quote: z.object({ value: decimal, retrievedAt: timestamp, observedAt: z.null(), provenance: z.string() }).nullable() })) })) })

function selectKalshiOutcome(raw: unknown, selection: PublicSelection, asset: string, asOf: string): ScenarioInstrument {
  if (asset !== 'USD') throw new ScenarioError('public_market_asset_mismatch')
  const parsed = kalshiEnvelope.safeParse(raw)
  if (!parsed.success) throw new ScenarioError('public_market_evidence_unavailable')
  const matches = parsed.data.items.flatMap((item) => item.outcomes.filter((outcome) => outcome.id === selection.assetId).map((outcome) => ({ item, outcome })))
  if (matches.length !== 1) throw new ScenarioError('public_market_outcome_not_unique')
  const { item, outcome } = matches[0]!
  const markAt = outcome.quote?.retrievedAt ? new Date(outcome.quote.retrievedAt).toISOString() : null
  if (selection.captureCurrentQuote && !outcome.quote) throw new ScenarioError('current_quote_unavailable')
  const usable = markAt !== null && (markAt <= asOf || selection.captureCurrentQuote)
  return { id: 'kalshi:' + outcome.id, venue: 'kalshi', provider: 'kalshi', nativeMarket: item.marketTicker,
    nativeInstrument: outcome.id, nativeOutcomeIndex: outcome.side === 'yes' ? 0 : 1,
    market: 'kalshi:' + item.marketTicker, event: 'kalshi:' + item.eventTicker, outcome: outcome.name,
    lifecycle: item.lifecycle, settlementAsset: 'USD', mark: usable ? outcome.quote!.value : null, markAt: usable ? markAt : null,
    latestPrice: outcome.quote?.value ?? null, latestPriceAt: markAt, resolvesAt: item.expectedResolutionAt ?? null,
    ...(outcome.quote ? { quoteProvenance: outcome.quote.provenance } : {}),
    ...(item.establishedPayoutUnit ? { establishedPayoutUnit: item.establishedPayoutUnit } : {}),
    ...(usable ? { markSource: markAt > asOf ? 'assumed_current_quote' as const : 'public_retrieval_at_cutoff' as const } : {}) }
}

import { z } from 'zod'
import { ScenarioError, type ScenarioInstrument } from './engine.js'

const timestamp = z.iso.datetime({ offset: true })
const decimal = z.string().regex(/^\d{1,20}(?:\.\d{1,18})?$/)
export const publicSelection = z.object({ url: z.string().min(1).max(2048), assetId: z.string().regex(/^\d{1,100}$/),
  assetIdType: z.enum(['position_id', 'clob_token_id']), captureCurrentQuote: z.boolean().optional() }).strict()
export type PublicSelection = z.infer<typeof publicSelection>
const result = z.object({ item: z.object({ eventId: z.string().nullable().optional(), markets: z.array(z.object({
  providerMarketId: z.string(), conditionId: z.string(), lifecycle: z.string(), endDate: z.string().nullable(),
  feeMetadata: z.object({ status: z.string(), source: z.literal('gamma_market'), retrievedAt: timestamp,
    rate: decimal.nullable(), exponent: z.number().nullable(), takerOnly: z.boolean().nullable(), amountUnit: z.literal('USDC') }),
  outcomes: z.array(z.object({ assetId: z.string().nullable(), assetIdType: z.string(), name: z.string().nullable(), outcomeIndex: z.number().int().optional(),
    referencePrice: z.object({ value: decimal.nullable(), retrievedAt: timestamp.nullable(), freshness: z.string() }).optional() })),
})) }) })

export function selectPublicOutcome(raw: unknown, selection: PublicSelection, asset: string, asOf: string): ScenarioInstrument {
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

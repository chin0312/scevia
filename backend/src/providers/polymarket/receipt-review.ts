import { Decimal } from 'decimal.js'
import type { PolymarketCollateralReader } from './collateral.js'

type Source = { id: string; instrument: string | null; side: string | null; quantity: string | null; price: string | null; asset: string | null }
type Receipt = Awaited<ReturnType<PolymarketCollateralReader['transferEvidence']>>

export function proposeReceiptLinks(receipt: Receipt, candidates: Source[]) {
  const matches = receipt.fills.map((fill) => ({
    fill,
    sources: [...new Set(candidates.filter((source) => source.asset === fill.asset && source.instrument === fill.instrument
      && source.side?.toLowerCase() === fill.side && source.quantity !== null && source.price !== null
      && new Decimal(source.quantity).eq(fill.quantity) && new Decimal(source.quantity).mul(source.price).eq(fill.grossCollateral))
      .map((source) => source.id))],
  }))
  return matches.map(({ fill, sources }) => {
    const source = sources.length === 1 && matches.filter((candidate) => candidate.sources.includes(sources[0]!)).length === 1
      ? sources[0] : null
    return { executionId: fill.id, exchange: fill.exchange, logIndex: fill.logIndex, instrument: fill.instrument,
      sourceRecordId: source ?? null, status: source ? 'exact_review_candidate' : 'unresolved' } as const
  })
}

import { z } from 'zod'
import { polygonCtfV2 } from './collateral.js'

const hex = (length: number) => z.string().regex(new RegExp('^0x[0-9a-fA-F]{' + length + '}$')).transform((value) => value.toLowerCase())
const indexedRow = z.object({
  chainId: z.literal(137), exchange: hex(40).refine((value) => polygonCtfV2.has(value)),
  wallet: hex(40), transactionHash: hex(64), logIndex: z.number().int().nonnegative().max(2 ** 32 - 1),
  provider: z.string().trim().min(1).max(80), occurredAt: z.iso.datetime({ offset: true }),
}).strict()

export function indexedCandidates(input: unknown, wallet: string, start: Date, end: Date) {
  const rows = z.array(indexedRow).max(500).parse(input)
  const distinct = new Map<string, z.infer<typeof indexedRow>>()
  for (const row of rows) {
    const time = Date.parse(row.occurredAt)
    if (row.wallet !== wallet.toLowerCase() || time < start.getTime() || time > end.getTime()) {
      throw new Error('indexed_candidate_outside_approved_account_window')
    }
    const key = [row.chainId, row.exchange, row.transactionHash, row.logIndex, row.provider].join(':')
    const prior = distinct.get(key)
    if (prior && Date.parse(prior.occurredAt) !== time) throw new Error('indexed_candidate_timestamp_conflict')
    distinct.set(key, row)
  }
  return [...distinct.values()]
}

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

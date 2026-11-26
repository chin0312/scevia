import { and, eq, inArray } from 'drizzle-orm'
import type { Evidence } from '../accounting/model.js'
import type { Database } from '../db/client.js'
import { instruments, markets, portfolios } from '../db/schema.js'
import { accountKey } from './dataset.js'

type Capture = NonNullable<typeof portfolios.$inferSelect.demo>

export async function demoResolutionEvidence(
  tx: Pick<Database, 'select'>, portfolioId: string, capture: Capture,
  accounts: Array<{ account: string; venue: string; externalId: string }>,
): Promise<Evidence[]> {
  const resolved = capture.dataset.markets.filter((row) => row.lifecycle === 'resolved')
  if (!resolved.length) return []
  const namespace = 'simulation:' + (capture.catalogRevision ?? capture.revision) + ':'
  const catalog = await tx.select({ provider: markets.providerCode, market: markets.externalId, token: instruments.externalId, id: instruments.id })
    .from(instruments).innerJoin(markets, and(eq(markets.id, instruments.marketId), inArray(markets.externalId, resolved.map((row) => namespace + row.nativeMarket))))
    .where(inArray(instruments.externalId, resolved.flatMap((row) => row.outcomes.map((leg) => namespace + leg.instrument))))
  const funding = new Map(accounts.filter((row) => row.externalId.startsWith('simulation:')).map((row) =>
    [accountKey({ provider: row.venue, asset: row.externalId.slice('simulation:'.length) }), row.account]))
  const evidence: Evidence[] = []
  for (const market of resolved) {
    const account = funding.get(accountKey(market))
    if (!account) continue
    for (const leg of market.outcomes) {
      const instrument = catalog.find((row) => row.provider === market.provider && row.market === namespace + market.nativeMarket
        && row.token === namespace + leg.instrument)?.id
      if (!instrument) throw new Error('demo_resolution_instrument_missing')
      const id = 'simulation:derived:' + instrument
      const common = { venue: market.provider, account, asset: market.asset, instrument, canonicalInstrumentId: instrument,
        quantity: null, amount: null, fee: null, feeAsset: null }
      if (!market.resolution) {
        evidence.push({ batchId: portfolioId, row: -(evidence.length + 1), acquisition: 'demo',
          observation: { ...common, id, type: 'mark', timestamp: (capture.priorMarkets ?? []).filter((prior) => prior.provider === market.provider
            && prior.nativeMarket === market.nativeMarket && prior.lifecycle === 'resolved')
            .reduce((earliest, prior) => prior.retrievedAt < earliest ? prior.retrievedAt : earliest, market.retrievedAt), sequence: 1, price: null,
            simulatedResolution: { effect: 'unverified_resolution', timing: 'at_resolution_evidence' } } })
        continue
      }
      const { knownAt, winningInstrument, simulatedPayoutAt } = market.resolution
      evidence.push({ batchId: portfolioId, row: -(evidence.length + 1), acquisition: 'demo',
        observation: { ...common, id, type: 'settlement', timestamp: knownAt, sequence: 1, price: leg.instrument === winningInstrument ? '1' : '0',
          simulatedResolution: { effect: 'entitlement', timing: 'at_resolution_evidence' } } })
      evidence.push({ batchId: portfolioId, row: -(evidence.length + 1), acquisition: 'demo',
        observation: { ...common, id: id + ':payout', entitlementId: id, type: 'redemption', timestamp: simulatedPayoutAt ?? knownAt, sequence: 2, price: null,
          simulatedResolution: { effect: 'payout', timing: simulatedPayoutAt ? 'declared_simulated_time' : 'at_resolution_evidence' } } })
    }
  }
  return evidence
}

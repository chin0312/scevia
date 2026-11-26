import { eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { instruments, marketInstrumentMappings } from '../db/schema.js'

export class IdentityConflict extends Error {}

export async function registerInstrumentMappings(db: Pick<Database, 'select' | 'insert'>, marketId: string,
  asset: string, generation: string, mappings: Array<{ position: string; clobToken: string }>) {
  const legs = await db.select().from(instruments).where(eq(instruments.marketId, marketId))
  const rows = mappings.flatMap((mapping) => {
    const instrument = legs.find((leg) => leg.externalId === mapping.position && leg.settlementAssetCode === asset)
    return instrument ? [{ instrumentId: instrument.id, provider: 'polymarket', asset, generation,
      subscriptionToken: mapping.clobToken, provenance: 'gamma_exact_condition', retrievedAt: new Date() }] : []
  })
  if (!rows.length || rows.length !== mappings.length) throw new IdentityConflict('market_identity_conflict')
  await db.insert(marketInstrumentMappings).values(rows).onConflictDoNothing()
  const existing = await db.select().from(marketInstrumentMappings)
    .where(inArray(marketInstrumentMappings.instrumentId, rows.map((row) => row.instrumentId)))
  if (rows.some((row) => !existing.some((stored) => stored.instrumentId === row.instrumentId
    && stored.asset === row.asset && stored.generation === row.generation && stored.subscriptionToken === row.subscriptionToken))) {
    throw new IdentityConflict('market_identity_conflict')
  }
}

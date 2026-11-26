import { and, asc, inArray, lte } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { marketLifecycleEvidence, type TrackedResolution } from '../db/schema.js'

export function conflictingResolution(
  prior: Pick<TrackedResolution, 'winningInstrument' | 'unitPayout'> | null | undefined,
  incoming: Pick<TrackedResolution, 'winningInstrument' | 'unitPayout'> | null | undefined,
) {
  return Boolean(prior && incoming && (prior.winningInstrument !== incoming.winningInstrument || prior.unitPayout !== incoming.unitPayout))
}

export async function lifecycleAt(db: Pick<Database, 'select'>, marketIds: string[], cutoff: string, maxRows?: number) {
  const result = new Map<string, typeof marketLifecycleEvidence.$inferSelect[]>()
  if (!marketIds.length) return result
  const query = db.select().from(marketLifecycleEvidence)
    .where(and(inArray(marketLifecycleEvidence.marketId, marketIds), lte(marketLifecycleEvidence.retrievedAt, new Date(cutoff))))
    .orderBy(asc(marketLifecycleEvidence.retrievedAt), asc(marketLifecycleEvidence.revision))
  const rows = maxRows === undefined ? await query : await query.limit(maxRows)
  for (const row of rows) {
    const history = result.get(row.marketId) ?? []
    history.push(row)
    result.set(row.marketId, history)
  }
  return result
}

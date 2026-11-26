import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { accountTracking, instruments, markets, marketTracking, marketWatches, portfolios, providerAccounts, sharedMarketObservations } from '../db/schema.js'

const portfolioParam = z.object({ portfolioId: z.uuid() })
const watchBody = z.object({ markets: z.array(z.uuid()).max(20) }).strict()

export function registerTrackingRoutes(app: FastifyInstance, db: Database) {
  const path = '/portfolios/:portfolioId/tracking'
  const owner = (id: string, principal: string) => and(eq(portfolios.id, id), eq(portfolios.ownerId, principal))
  const marketStatus = { marketId: markets.id, provider: markets.providerCode, nativeMarket: markets.externalId,
    lifecycle: marketTracking.lifecycle, checkedAt: marketTracking.lastAttemptAt, refreshedAt: marketTracking.lastSuccessAt,
    nextAttemptAt: marketTracking.nextAttemptAt, failures: marketTracking.failures }
  app.get(path, async (request, reply) => {
    const params = portfolioParam.safeParse(request.params)
    if (!params.success) return reply.code(422).send({ error: { code: 'invalid_tracking_scope' } })
    const { portfolioId } = params.data
    const [portfolio] = await db.select({ id: portfolios.id }).from(portfolios).where(owner(portfolioId, request.principalId!))
    if (!portfolio) return reply.code(404).send({ error: { code: 'not_found' } })
    const marketsStatus = await db.select(marketStatus).from(marketWatches)
      .innerJoin(marketTracking, eq(marketTracking.marketId, marketWatches.marketId))
      .innerJoin(markets, eq(markets.id, marketWatches.marketId))
      .where(eq(marketWatches.portfolioId, portfolioId)).orderBy(asc(markets.id))
    const accounts = await db.select({ accountId: providerAccounts.id, kind: providerAccounts.kind, disabledAt: providerAccounts.disabledAt,
      scope: accountTracking.scope, checkedAt: accountTracking.lastAttemptAt, refreshedAt: accountTracking.lastSuccessAt,
      nextAttemptAt: accountTracking.nextAttemptAt, failures: accountTracking.failures })
      .from(providerAccounts).leftJoin(accountTracking, eq(accountTracking.accountId, providerAccounts.id))
      .where(eq(providerAccounts.portfolioId, portfolioId)).orderBy(asc(providerAccounts.id), asc(accountTracking.scope)).limit(200)
    const observations = await db.selectDistinctOn([instruments.id, sharedMarketObservations.asset], {
      marketId: instruments.marketId, instrumentId: instruments.id, nativeOutcome: instruments.externalId,
      asset: sharedMarketObservations.asset, price: sharedMarketObservations.price, source: sharedMarketObservations.source,
      method: sharedMarketObservations.method, observedAt: sharedMarketObservations.observedAt,
      retrievedAt: sharedMarketObservations.retrievedAt, revision: sharedMarketObservations.revision,
    }).from(sharedMarketObservations)
      .innerJoin(instruments, eq(instruments.id, sharedMarketObservations.instrumentId))
      .innerJoin(marketWatches, and(eq(marketWatches.portfolioId, portfolioId), eq(marketWatches.marketId, instruments.marketId)))
      .orderBy(instruments.id, sharedMarketObservations.asset, desc(sharedMarketObservations.effectiveAt)).limit(100)
    return { portfolioId, markets: marketsStatus, observations, accounts, valuation: { mechanism: 'read_through_accounting' } }
  })
  app.put(path + '/markets', async (request, reply) => {
    const params = portfolioParam.safeParse(request.params)
    const body = watchBody.safeParse(request.body)
    if (!params.success || !body.success) return reply.code(422).send({ error: { code: 'invalid_tracking_scope' } })
    const { portfolioId } = params.data
    const ids = [...new Set(body.data.markets)]
    const result = await db.transaction(async (tx) => {
      const [portfolio] = await tx.select({ id: portfolios.id }).from(portfolios)
        .where(owner(portfolioId, request.principalId!)).for('update')
      if (!portfolio) return 'not_found'
      const catalog = ids.length ? await tx.select().from(markets).where(inArray(markets.id, ids)) : []
      if (catalog.length !== ids.length || catalog.some((market) => !(
        (market.providerCode === 'kalshi' && /^[A-Z0-9][A-Z0-9_.-]{0,127}$/.test(market.externalId) && market.settlementAssetCode === 'USD')
        || (market.providerCode === 'polymarket' && /^0x[0-9a-f]{64}$/i.test(market.externalId)
          && ['USDC', 'PUSD'].includes(market.settlementAssetCode ?? ''))))) return 'market_not_supported'
      await tx.delete(marketWatches).where(eq(marketWatches.portfolioId, portfolioId))
      for (const marketId of [...ids].sort()) {
        await tx.insert(marketTracking).values({ marketId }).onConflictDoNothing()
        await tx.insert(marketWatches).values({ portfolioId, marketId })
      }
      return 'ok'
    })
    if (result !== 'ok') return reply.code(result === 'not_found' ? 404 : 422).send({ error: { code: result } })
    return { portfolioId, markets: ids }
  })
}

export async function initializeTrackedAccounts(db: Database, ownerId: string, ids: string[], polymarket: boolean, kalshiId?: string) {
  if (!ids.length) return []
  const rows = await db.select({ id: providerAccounts.id, provider: providerAccounts.providerCode, kind: providerAccounts.kind })
    .from(providerAccounts).innerJoin(portfolios, eq(portfolios.id, providerAccounts.portfolioId))
    .where(and(eq(portfolios.ownerId, ownerId), isNull(portfolios.demo), isNull(providerAccounts.disabledAt), inArray(providerAccounts.id, ids)))
  const authorized = rows.filter((row) => (row.provider === 'polymarket' && polymarket && row.kind === 'public_wallet')
    || (row.provider === 'kalshi' && row.id === kalshiId && row.kind === 'authenticated_account')).map((row) => row.id)
  if (authorized.length) await db.insert(accountTracking)
    .values(authorized.flatMap((accountId) => ['current', 'history'].map((scope) => ({ accountId, scope })))).onConflictDoNothing()
  return authorized
}

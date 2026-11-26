import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { financialImportBatches, instruments, markets, portfolios, providerAccounts, users } from '../db/schema.js'
import { normalizedRecordSchema } from '../domain/model.js'
import { upsertMarket } from '../ingestion/persistence.js'
import type { FinancialObservation } from '../accounting/model.js'
import { digest } from '../accounting/decisions.js'
import { replayAccounting } from '../accounting/ledger.js'
import { accountKey, availableAt, marketKey, readDemoDataset } from './dataset.js'

export function registerDemoRoutes(app: FastifyInstance, db: Database, settings?: { path: string; cacheMs: number; allowFixture: boolean }) {
  let cache: { value: Promise<Awaited<ReturnType<typeof readDemoDataset>>>; expires: number } | undefined
  const dataset = async () => {
    if (!settings) return null
    if (cache && cache.expires > Date.now()) return cache.value.catch(() => null)
    cache = { value: readDemoDataset(settings.path, settings.allowFixture), expires: Date.now() + settings.cacheMs }
    return cache.value.catch(() => null)
  }
  const payload = (row: { id: string; demo: NonNullable<typeof portfolios.$inferSelect.demo> }) => ({
    status: 'available', portfolioId: row.id, mode: row.demo.dataset.evidenceKind === 'fixture' ? 'fixture' : 'demo',
    revision: row.demo.revision, catalogRevision: row.demo.catalogRevision ?? row.demo.revision, capturedAt: row.demo.dataset.capturedAt,
    marketEvidence: 'captured', transactions: 'hypothetical', markets: row.demo.dataset.markets,
    quotes: row.demo.dataset.quotes.map((quote) => ({ ...quote, effectiveAt: availableAt(quote),
      freshness: Date.now() - Date.parse(quote.retrievedAt) > 86_400_000 ? 'stale_capture' : 'recent_capture' })),
  })
  const unavailable = { status: 'unavailable', reason: 'authorized_demo_dataset_unavailable' }
  const current = async (owner: string) => {
    const [row] = await db.select({ id: portfolios.id, demo: portfolios.demo }).from(portfolios)
      .where(and(eq(portfolios.ownerId, owner), isNotNull(portfolios.demo))).orderBy(desc(portfolios.createdAt), desc(portfolios.id)).limit(1)
    return row?.demo ? { id: row.id, demo: row.demo } : null
  }

  app.get('/demo', async (request) => {
    const existing = await current(request.principalId!)
    return existing ? payload(existing) : await dataset() ? { status: 'initialization_required' } : unavailable
  })
  app.post<{ Body: unknown }>('/demo/refresh', async (request, reply) => {
    const body = z.object({ portfolioId: z.uuid(), revision: z.string().length(64) }).strict().safeParse(request.body)
    if (!body.success) return reply.code(422).send({ error: { code: 'invalid_demo_request' } })
    const capture = await dataset()
    if (!capture) return reply.code(503).send(unavailable)
    const { portfolioId, revision } = body.data
    const result = await db.transaction(async (tx) => {
      const [workspace] = await tx.select({ id: portfolios.id, demo: portfolios.demo }).from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.ownerId, request.principalId!))).for('update')
      if (!workspace?.demo) return { status: 'not_found' as const }
      const demo = workspace.demo
      if (demo.revision !== revision) return { status: 'stale' as const }
      if (demo.dataset.evidenceKind !== capture.manifest.evidenceKind) return { status: 'stale' as const }
      const curated = new Map(demo.dataset.markets.map((row) => [marketKey(row), row]))
      const capturedMarkets = new Map(capture.manifest.markets.map((row) => [marketKey(row), row]))
      const rank = { open: 0, closed: 1, resolved: 2 } as const
      const matches = (original: typeof demo.dataset.markets[number], incoming: typeof demo.dataset.markets[number]) =>
        incoming.asset === original.asset && incoming.nativeEvent === original.nativeEvent
        && original.outcomes.every((leg) => incoming.outcomes.some((item) => item.instrument === leg.instrument && item.name === leg.name))
      const updatedMarkets = demo.dataset.markets.map((original) => {
        const incoming = capturedMarkets.get(marketKey(original))
        if (!incoming || !matches(original, incoming) || incoming.retrievedAt <= original.retrievedAt
          || rank[incoming.lifecycle] < rank[original.lifecycle]) return original
        return { ...incoming, ...(original.resolution ? { resolution: original.resolution } : {}) }
      })
      const marketRevisions = new Map(updatedMarkets.map((row) => [marketKey(row), row]))
      const previousQuoteTimes = new Map<string, string>()
      for (const quote of demo.dataset.quotes) {
        const key = JSON.stringify([marketKey(quote), quote.instrument])
        if (availableAt(quote) > (previousQuoteTimes.get(key) ?? '')) previousQuoteTimes.set(key, availableAt(quote))
      }
      const latest = capture.manifest.quotes.filter((quote) => {
        const original = curated.get(marketKey(quote))
        const incoming = marketRevisions.get(marketKey(quote))
        const observedMarket = capturedMarkets.get(marketKey(quote))
        return original && observedMarket && matches(original, observedMarket) && incoming?.lifecycle === 'open' && original.outcomes.some((leg) => leg.instrument === quote.instrument)
          && quote.method === 'book_midpoint'
          && quote.retrievedAt > (previousQuoteTimes.get(JSON.stringify([marketKey(quote), quote.instrument])) ?? '')
      })
      if (!latest.length && updatedMarkets.every((row, index) => row === demo.dataset.markets[index])) {
        return { status: 'ok' as const, row: { id: portfolioId, demo } }
      }
      if (latest.length + demo.dataset.quotes.length > 2000) return { status: 'limit' as const }

      const catalogRevision = demo.catalogRevision ?? revision
      const capturedAt = capture.manifest.capturedAt > demo.dataset.capturedAt ? capture.manifest.capturedAt : demo.dataset.capturedAt
      const nextDataset = { ...demo.dataset, capturedAt, markets: updatedMarkets, quotes: [...demo.dataset.quotes, ...latest] }
      const history = demo.dataset.markets.filter((row, index) => row !== updatedMarkets[index]
        && (row.lifecycle !== updatedMarkets[index]!.lifecycle || row.title !== updatedMarkets[index]!.title))
      const priorMarkets = [...(demo.priorMarkets ?? []), ...history]
      if (priorMarkets.length > 500) return { status: 'limit' as const }
      const nextDemo = { catalogRevision, dataset: nextDataset, priorMarkets, revision: digest([nextDataset, priorMarkets]) }
      const observations = new Map<string, FinancialObservation[]>()
      const accounts = await tx.select().from(providerAccounts).where(eq(providerAccounts.portfolioId, portfolioId))
      for (const [index, quote] of latest.entries()) {
        const market = curated.get(marketKey(quote))!
        const account = accounts.find((row) => row.providerCode === market.provider && row.externalAccountId === 'simulation:' + market.asset)
        const namespace = 'simulation:' + catalogRevision + ':'
        const [instrument] = await tx.select({ id: instruments.id }).from(instruments).innerJoin(markets, eq(markets.id, instruments.marketId))
          .where(and(eq(markets.providerCode, market.provider), eq(markets.externalId, namespace + market.nativeMarket),
            eq(instruments.externalId, namespace + quote.instrument))).limit(1)
        if (!account || !instrument) return { status: 'stale' as const }
        const rows = observations.get(account.id) ?? []
        rows.push({ venue: market.provider, account: account.id, asset: market.asset,
          id: 'simulation:refresh:' + nextDemo.revision + ':' + index, type: 'mark', timestamp: quote.retrievedAt,
          sequence: null, instrument: instrument.id, canonicalInstrumentId: instrument.id, price: quote.price,
          quantity: null, fee: null, feeAsset: null, amount: null })
        observations.set(account.id, rows)
      }
      for (const [account, rows] of observations) {
        await tx.insert(financialImportBatches).values({ portfolioId, associatedAccountId: account,
          contentHash: 'simulation:' + nextDemo.revision + ':' + account, observations: rows, expiresAt: new Date(), confirmedAt: new Date() })
      }
      await tx.update(portfolios).set({ demo: nextDemo }).where(eq(portfolios.id, portfolioId))
      return { status: 'ok' as const, row: { id: portfolioId, demo: nextDemo } }
    })
    if (result.status === 'not_found') return reply.code(404).send({ error: { code: 'not_found' } })
    if (result.status === 'stale') return reply.code(409).send({ error: { code: 'demo_workspace_changed' } })
    if (result.status === 'limit') return reply.code(422).send({ error: { code: 'demo_quote_limit' } })
    return payload(result.row)
  })
  app.post<{ Body: unknown }>('/demo', async (request, reply) => {
    const body = z.object({ resetFromPortfolioId: z.uuid().optional() }).strict().safeParse(request.body ?? {})
    if (!body.success) return reply.code(422).send({ error: { code: 'invalid_demo_request' } })
    const owner = request.principalId!
    const existing = await current(owner)
    if (existing && !body.data.resetFromPortfolioId) return payload(existing)
    const capture = await dataset()
    if (!capture) return reply.code(503).send(unavailable)
    try {
      const result = await db.transaction(async (tx) => {
        await tx.insert(users).values({ id: owner, authSubject: 'development:' + owner }).onConflictDoNothing()
        await tx.select({ id: users.id }).from(users).where(eq(users.id, owner)).for('update')
        const [prior] = await tx.select({ id: portfolios.id, demo: portfolios.demo }).from(portfolios)
          .where(and(eq(portfolios.ownerId, owner), isNotNull(portfolios.demo))).orderBy(desc(portfolios.createdAt), desc(portfolios.id)).limit(1)
        const reset = body.data.resetFromPortfolioId
        if (reset !== undefined && reset !== prior?.id) return null
        if (!reset && prior?.demo) return { id: prior.id, demo: prior.demo }

        const { manifest, revision } = capture
        const demo = { revision, dataset: manifest }
        const [portfolio] = await tx.insert(portfolios).values({ ownerId: owner, name: 'Demo Portfolio', demo }).returning({ id: portfolios.id })
        const portfolioId = portfolio!.id
        const accountRows = await tx.insert(providerAccounts).values(manifest.capital.map((row) => ({ portfolioId, providerCode: row.provider,
          externalAccountId: 'simulation:' + row.asset, label: row.provider + ' simulated ' + row.asset, kind: 'file_import' as const,
          disabledAt: new Date() }))).returning()
        const accounts = new Map(accountRows.map((row) => [row.providerCode + ':' + row.externalAccountId.slice('simulation:'.length), row.id]))
        const observations = new Map<string, FinancialObservation[]>()
        function record(scope: { provider: string; asset: string }, value: Pick<FinancialObservation, 'id' | 'type' | 'timestamp'> & Partial<FinancialObservation>) {
          const account = accounts.get(accountKey(scope))!
          const list = observations.get(account) ?? []
          list.push({ venue: scope.provider, asset: scope.asset, account, sequence: null, instrument: null,
            price: null, quantity: null, amount: null, fee: null, feeAsset: null, ...value })
          observations.set(account, list)
        }
        for (const row of manifest.capital) {
          record(row, { id: 'simulation:opening_cash', type: 'opening_cash', timestamp: row.openedAt, amount: row.amount })
          record(row, { id: 'simulation:opening_inventory', type: 'opening_inventory', timestamp: row.openedAt })
          record(row, { id: 'simulation:coverage', type: 'history_complete', timestamp: row.openedAt, coveredThrough: manifest.capturedAt })
        }
        const catalog = new Map<string, { market: typeof manifest.markets[number]; instruments: Map<string, string> }>()
        for (const market of manifest.markets) {
          // Separate catalog rows keep capture revisions from rewriting another portfolio's metadata.
          const namespace = 'simulation:' + revision + ':'
          const externalMarketId = namespace + market.nativeMarket
          const normalized = normalizedRecordSchema.parse({
            kind: 'market', externalEventId: namespace + market.nativeEvent, externalMarketId, eventIdentityKind: 'provider_native',
            eventName: market.eventTitle, eventDescription: null, resolutionRules: null, eventLifecycle: market.lifecycle,
            eventResolvesAt: market.resolvesAt, marketTitle: market.title, marketLifecycle: market.lifecycle,
            settlementRules: null, settlementAssetCode: market.asset, eventSourceUpdatedAt: market.retrievedAt,
            sourceUpdatedAt: market.retrievedAt,
            outcomes: market.outcomes.map((row) => ({ externalId: namespace + row.instrument, name: row.name,
              outcomeType: row.name.toLowerCase(), payoutAmount: null, settlementAssetCode: market.asset })),
            rawPayload: market,
          })
          if (normalized.kind !== 'market') throw new Error('invalid_demo_market')
          await upsertMarket(tx, market.provider, normalized)
          const legs = await tx.select({ id: instruments.id, native: instruments.externalId }).from(instruments)
            .innerJoin(markets, eq(instruments.marketId, markets.id)).where(and(eq(markets.providerCode, market.provider), eq(markets.externalId, externalMarketId)))
          catalog.set(marketKey(market), { market, instruments: new Map(legs.map((row) => [row.native.slice(namespace.length), row.id])) })
        }
        for (const [index, quote] of manifest.quotes.entries()) {
          const entry = catalog.get(marketKey(quote))!
          const instrument = entry.instruments.get(quote.instrument)!
          record(entry.market, { id: 'simulation:mark:' + index, type: 'mark', timestamp: availableAt(quote), instrument,
            canonicalInstrumentId: instrument, price: quote.price })
        }
        for (const [sequence, trade] of manifest.trades.entries()) {
          const quote = manifest.quotes[trade.quoteIndex]!
          const entry = catalog.get(marketKey(quote))!
          const instrument = entry.instruments.get(quote.instrument)!
          record(entry.market, { id: 'simulation:trade:' + trade.id, type: trade.direction, sequence: sequence + 1, timestamp: availableAt(quote),
            instrument, canonicalInstrumentId: instrument, quantity: trade.quantity, price: quote.price, fee: trade.assumedFee })
        }
        const replay = (list: FinancialObservation[], asOf: string) => replayAccounting(
          list.map((observation, row) => ({ observation, batchId: portfolioId, row })), asOf)
        for (const [account, list] of observations) {
          if (replay(list, manifest.capturedAt).discrepancies.length) throw new Error('demo_dataset_replay_invalid')
          await tx.insert(financialImportBatches).values({ portfolioId, contentHash: 'simulation:' + revision + ':' + account,
            associatedAccountId: account, observations: list, expiresAt: new Date(), confirmedAt: new Date() })
        }
        return { id: portfolioId, demo }
      })
      return result ? payload(result) : reply.code(409).send({ error: { code: 'demo_workspace_changed' } })
    } catch {
      return reply.code(422).send({ error: { code: 'demo_dataset_replay_invalid' } })
    }
  })
}

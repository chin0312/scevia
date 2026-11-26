import { proposeReceiptLinks } from '../src/providers/polymarket/receipt-review.js'
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { fills, instruments, portfolios, polymarketReceiptReviews, providerAccounts, providerActivityFacts, sourceRecords } from '../src/db/schema.js'
import { PolymarketCollateralReader } from '../src/providers/polymarket/collateral.js'

const [, , accountId, from, through] = process.argv
const scope = z.tuple([z.uuid(), z.iso.datetime({ offset: true }), z.iso.datetime({ offset: true })]).parse([accountId, from, through])
const start = new Date(scope[1])
const end = new Date(scope[2])
if (end <= start || end.getTime() - start.getTime() > 7 * 86_400_000) throw new Error('Select an approved window of up to seven days')
const config = loadConfig()
if (!config.polymarketPolygonRpc || process.env.POLYMARKET_RECEIPT_DISCOVERY_AUTHORIZED !== 'YES') {
  throw new Error('Confirm separate permission to inspect receipts discovered from the selected owned account')
}
const { database, pool } = createDatabase(config)
try {
  const [account] = await database.select({ wallet: providerAccounts.externalAccountId }).from(providerAccounts)
    .innerJoin(portfolios, eq(portfolios.id, providerAccounts.portfolioId))
    .where(and(eq(providerAccounts.id, scope[0]), eq(portfolios.ownerId, config.devPrincipalId),
      eq(providerAccounts.providerCode, 'polymarket'), eq(providerAccounts.kind, 'public_wallet'), isNull(providerAccounts.disabledAt), isNull(portfolios.demo)))
    .limit(1)
  if (!account) throw new Error('Select an enabled, owned Polymarket wallet')
  const hash = sql<string | null>`lower(${sourceRecords.payload}->>'transaction_hash')`
  const trades = await database.select({ hash, id: fills.sourceRecordId, instrument: instruments.externalId, side: fills.direction,
    quantity: fills.quantity, price: fills.price, asset: fills.settlementAssetCode }).from(fills)
    .innerJoin(instruments, eq(instruments.id, fills.instrumentId))
    .innerJoin(sourceRecords, eq(sourceRecords.id, fills.sourceRecordId))
    .where(and(eq(fills.providerAccountId, scope[0]), gte(fills.occurredAt, start), lte(fills.occurredAt, end)))
    .orderBy(asc(fills.occurredAt), asc(fills.id)).limit(501)
  const activities = await database.select({ hash: providerActivityFacts.transactionHash, id: providerActivityFacts.sourceRecordId,
    instrument: providerActivityFacts.externalInstrumentId, side: providerActivityFacts.side,
    quantity: providerActivityFacts.quantity, price: providerActivityFacts.price, asset: providerActivityFacts.assetCode })
    .from(providerActivityFacts).where(and(eq(providerActivityFacts.providerAccountId, scope[0]),
      gte(providerActivityFacts.occurredAt, start), lte(providerActivityFacts.occurredAt, end)))
    .orderBy(asc(providerActivityFacts.occurredAt), asc(providerActivityFacts.id)).limit(501)
  const candidates = new Map<string, Set<string>>()
  for (const row of [...trades, ...activities]) {
    const key = row.hash?.toLowerCase()
    if (!key || !/^0x[0-9a-f]{64}$/.test(key)) continue
    const ids = candidates.get(key) ?? new Set<string>()
    ids.add(row.id)
    candidates.set(key, ids)
  }
  const known = candidates.size ? await database.select().from(polymarketReceiptReviews).where(and(
    eq(polymarketReceiptReviews.accountId, scope[0]), inArray(polymarketReceiptReviews.transactionHash, [...candidates.keys()]))) : []
  const previous = new Map(known.map((row) => [row.transactionHash, row.evidence]))
  const pending = [...candidates.keys()].filter((transaction) => !previous.has(transaction))
  const reader = new PolymarketCollateralReader(config.polymarketPolygonRpc)
  const receipts = []
  for (const transactionHash of pending.slice(0, 12)) {
    const [enabled] = await database.select({ id: providerAccounts.id }).from(providerAccounts)
      .where(and(eq(providerAccounts.id, scope[0]), isNull(providerAccounts.disabledAt))).limit(1)
    if (!enabled) break
    const sources = candidates.get(transactionHash)!
    try {
      const evidence = await reader.transferEvidence(account.wallet, transactionHash, AbortSignal.timeout(15_000))
      await database.insert(polymarketReceiptReviews).values({ accountId: scope[0], transactionHash, evidence }).onConflictDoNothing()
      previous.set(transactionHash, evidence)
    } catch {
      receipts.push({ transactionHash, sourceCandidates: [...sources], status: 'receipt_unavailable' })
    }
  }
  for (const [transactionHash, evidence] of previous) {
    const sourceRows = [...trades, ...activities].filter((row) => row.hash?.toLowerCase() === transactionHash)
    receipts.push({ transactionHash, sourceCandidates: [...candidates.get(transactionHash)!], status: 'review_required',
      evidence, proposals: proposeReceiptLinks(evidence, sourceRows) })
  }
  process.stdout.write(JSON.stringify({ scope: 'authorized_local_review', truncated: pending.length > 12
    || trades.length === 501 || activities.length === 501, receipts }, null, 2) + '\n')
} finally {
  await pool.end()
}

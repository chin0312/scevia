import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { fills, portfolios, providerAccounts, providerActivityFacts, sourceRecords } from '../src/db/schema.js'
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
  const trades = await database.select({ hash, id: fills.sourceRecordId }).from(fills)
    .innerJoin(sourceRecords, eq(sourceRecords.id, fills.sourceRecordId))
    .where(and(eq(fills.providerAccountId, scope[0]), gte(fills.occurredAt, start), lte(fills.occurredAt, end)))
    .orderBy(asc(fills.occurredAt), asc(fills.id)).limit(501)
  const activities = await database.select({ hash: providerActivityFacts.transactionHash, id: providerActivityFacts.sourceRecordId })
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
  const reader = new PolymarketCollateralReader(config.polymarketPolygonRpc)
  const receipts = []
  for (const [transactionHash, sources] of [...candidates].slice(0, 12)) {
    try {
      const evidence = await reader.transferEvidence(account.wallet, transactionHash, AbortSignal.timeout(15_000))
      receipts.push({ transactionHash, sourceCandidates: [...sources], status: 'review_required', evidence })
    } catch {
      receipts.push({ transactionHash, sourceCandidates: [...sources], status: 'receipt_unavailable' })
    }
  }
  process.stdout.write(JSON.stringify({ scope: 'authorized_local_review', truncated: candidates.size > 12
    || trades.length === 501 || activities.length === 501, receipts }, null, 2) + '\n')
} finally {
  await pool.end()
}

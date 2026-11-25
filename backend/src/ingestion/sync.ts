import { randomUUID } from 'node:crypto'
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { portfolios, providerAccounts, syncCheckpoints, syncRuns } from '../db/schema.js'
import type { CoverageEntity, CoverageState, NormalizedRecord } from '../domain/model.js'
import { ProviderAdapterError, type ProviderAdapter, type ProviderPage } from '../providers/adapter.js'
import { ProviderRegistry } from '../providers/registry.js'
import { IngestionError, SyncAlreadyRunningError } from './errors.js'
import { persistPage, writeCoverage, type CoverageWriteInput } from './persistence.js'

const SYNC_NAME = 'portfolio-history'
const MAX_RETRY_ATTEMPTS = 2
const MAX_PAGE_COUNT = 100
const PAGE_TIMEOUT_MS = 10_000

export interface SyncAccount {
  id: string
  providerCode: string
  externalAccountId: string
}

export interface SyncResult {
  runId: string
  providerAccountId: string
  status: 'complete' | 'partial' | 'failed'
  pagesRead: number
  recordsSeen: number
  errorCode: string | null
  startedAt: string
  finishedAt: string
}

export class IngestionService {
  constructor(
    private readonly database: Database,
    private readonly registry: ProviderRegistry,
  ) {}

  async syncProviderAccount(account: SyncAccount): Promise<SyncResult> {
    const adapter = this.registry.get(account.providerCode)
    const checkpointId = await this.getOrCreateCheckpoint(account.id)
    const leaseToken = randomUUID()
    const leasedCheckpoint = await this.tryAcquireLease(checkpointId, leaseToken)
    if (!leasedCheckpoint) throw new SyncAlreadyRunningError()

    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    const cursorAtStart = leasedCheckpoint.cursor
    let pagesRead = 0
    let recordsSeen = 0
    let cursor = cursorAtStart
    let sourceAsOf: string | null = null
    let historyStart: string | null = null
    let historyEnd: string | null = null
    const coverage: Partial<Record<CoverageEntity, CoverageState>> = {}

    try {
      await this.startRun({
        accountId: account.id,
        checkpointId,
        leaseToken,
        runId,
        cursorAtStart,
        startedAt,
      })

      while (true) {
        await this.renewLease(checkpointId, leaseToken)
        const page = await this.fetchWithRetry(adapter, account.externalAccountId, cursor)
        const retrievedAt = new Date().toISOString()
        const records = adapter.normalizePage(page)
        const pageResult = await persistPage({
          database: this.database,
          providerAccountId: account.id,
          providerCode: account.providerCode,
          checkpointId,
          runId,
          leaseToken,
          nextCursor: page.nextCursor,
          retrievedAt,
          records,
        })
        pagesRead += 1
        recordsSeen += pageResult.recordsSeen
        this.mergeCoverage(coverage, page.coverage)
        sourceAsOf = this.latestTimestamp(sourceAsOf, page.sourceAsOf)
        for (const record of records) {
          const occurredAt = this.recordTimestamp(record)
          historyStart = this.earliestTimestamp(historyStart, occurredAt)
          historyEnd = this.latestTimestamp(historyEnd, occurredAt)
        }

        if (page.nextCursor === null) break
        if (page.nextCursor === cursor) throw new IngestionError('provider_cursor_did_not_advance')
        if (pagesRead >= MAX_PAGE_COUNT) throw new IngestionError('provider_page_limit_reached')
        cursor = page.nextCursor
      }

      const status = this.coverageIsComplete(adapter, coverage) ? 'complete' : 'partial'
      const finishedAt = new Date().toISOString()
      await this.finishRun({
        checkpointId,
        leaseToken,
        runId,
        status,
        finishedAt,
        errorCode: null,
        coverage: this.coverageInput(account.id, adapter, coverage, sourceAsOf, historyStart, historyEnd, finishedAt, status, pagesRead > 0),
      })
      return {
        runId,
        providerAccountId: account.id,
        status,
        pagesRead,
        recordsSeen,
        errorCode: null,
        startedAt,
        finishedAt,
      }
    } catch (error) {
      const status = pagesRead > 0 ? 'partial' : 'failed'
      const finishedAt = new Date().toISOString()
      const errorCode = this.safeErrorCode(error)
      await this.finishRun({
        checkpointId,
        leaseToken,
        runId,
        status,
        finishedAt,
        errorCode,
        coverage: this.coverageInput(account.id, adapter, coverage, sourceAsOf, historyStart, historyEnd, finishedAt, status, pagesRead > 0),
      }).catch(() => undefined)
      await this.releaseLease(checkpointId, leaseToken, status, errorCode)
      return {
        runId,
        providerAccountId: account.id,
        status,
        pagesRead,
        recordsSeen,
        errorCode,
        startedAt,
        finishedAt,
      }
    }
  }

  private async getOrCreateCheckpoint(providerAccountId: string): Promise<string> {
    await this.database.insert(syncCheckpoints).values({
      providerAccountId,
      syncName: SYNC_NAME,
      status: 'idle',
    }).onConflictDoNothing()
    const [checkpoint] = await this.database.select({ id: syncCheckpoints.id })
      .from(syncCheckpoints)
      .where(and(
        eq(syncCheckpoints.providerAccountId, providerAccountId),
        eq(syncCheckpoints.syncName, SYNC_NAME),
      ))
      .limit(1)
    if (!checkpoint) throw new IngestionError('sync_checkpoint_unavailable')
    return checkpoint.id
  }

  private async tryAcquireLease(checkpointId: string, leaseToken: string) {
    const [checkpoint] = await this.database.update(syncCheckpoints).set({
      status: 'running',
      leaseToken,
      leaseExpiresAt: sql`now() + interval '2 minutes'`,
      lastStartedAt: new Date(),
      lastErrorCode: null,
      updatedAt: new Date(),
    }).where(and(
      eq(syncCheckpoints.id, checkpointId),
      or(isNull(syncCheckpoints.leaseExpiresAt), lt(syncCheckpoints.leaseExpiresAt, sql`now()`)),
    )).returning()
    return checkpoint
  }

  private async startRun(input: {
    accountId: string
    checkpointId: string
    leaseToken: string
    runId: string
    cursorAtStart: string | null
    startedAt: string
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.update(syncRuns).set({
        status: 'failed',
        finishedAt: new Date(input.startedAt),
        errorCode: 'interrupted',
      }).where(and(
        eq(syncRuns.providerAccountId, input.accountId),
        eq(syncRuns.syncName, SYNC_NAME),
        eq(syncRuns.status, 'running'),
        ne(syncRuns.id, input.runId),
      ))
      await tx.insert(syncRuns).values({
        id: input.runId,
        providerAccountId: input.accountId,
        syncName: SYNC_NAME,
        status: 'running',
        cursorAtStart: input.cursorAtStart,
        startedAt: new Date(input.startedAt),
      })
      const [checkpoint] = await tx.update(syncCheckpoints).set({
        lastRunId: input.runId,
        lastStartedAt: new Date(input.startedAt),
        status: 'running',
      }).where(and(
        eq(syncCheckpoints.id, input.checkpointId),
        eq(syncCheckpoints.leaseToken, input.leaseToken),
      )).returning({ id: syncCheckpoints.id })
      if (!checkpoint) throw new IngestionError('sync_lease_lost')
    })
  }

  private async renewLease(checkpointId: string, leaseToken: string): Promise<void> {
    const [checkpoint] = await this.database.update(syncCheckpoints).set({
      leaseExpiresAt: sql`now() + interval '2 minutes'`,
      updatedAt: new Date(),
    }).where(and(
      eq(syncCheckpoints.id, checkpointId),
      eq(syncCheckpoints.leaseToken, leaseToken),
    )).returning({ id: syncCheckpoints.id })
    if (!checkpoint) throw new IngestionError('sync_lease_lost')
  }

  private async finishRun(input: {
    checkpointId: string
    leaseToken: string
    runId: string
    status: 'complete' | 'partial' | 'failed'
    finishedAt: string
    errorCode: string | null
    coverage: CoverageWriteInput
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [checkpoint] = await tx.update(syncCheckpoints).set({
        status: input.status,
        leaseToken: null,
        leaseExpiresAt: null,
        lastCompletedAt: new Date(input.finishedAt),
        lastErrorCode: input.errorCode,
        updatedAt: new Date(input.finishedAt),
      }).where(and(
        eq(syncCheckpoints.id, input.checkpointId),
        eq(syncCheckpoints.leaseToken, input.leaseToken),
      )).returning({ id: syncCheckpoints.id })
      if (!checkpoint) throw new IngestionError('sync_lease_lost')
      await tx.update(syncRuns).set({
        status: input.status,
        finishedAt: new Date(input.finishedAt),
        errorCode: input.errorCode,
      }).where(eq(syncRuns.id, input.runId))
      await writeCoverage(tx, input.coverage)
    })
  }

  private async releaseLease(
    checkpointId: string,
    leaseToken: string,
    status: 'complete' | 'partial' | 'failed',
    errorCode: string,
  ): Promise<void> {
    await this.database.update(syncCheckpoints).set({
      status,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: errorCode,
      updatedAt: new Date(),
    }).where(and(
      eq(syncCheckpoints.id, checkpointId),
      eq(syncCheckpoints.leaseToken, leaseToken),
    )).catch(() => undefined)
  }

  private coverageInput(
    providerAccountId: string,
    adapter: ProviderAdapter,
    coverage: Partial<Record<CoverageEntity, CoverageState>>,
    sourceAsOf: string | null,
    historyStart: string | null,
    historyEnd: string | null,
    retrievedAt: string,
    syncStatus: 'complete' | 'partial' | 'failed',
    pagesPersisted: boolean,
  ): CoverageWriteInput {
    return {
      providerAccountId,
      capabilities: adapter.capabilities,
      coverage,
      sourceAsOf,
      historyStart,
      historyEnd,
      retrievedAt,
      syncStatus,
      pagesPersisted,
    }
  }

  private async fetchWithRetry(
    adapter: ProviderAdapter,
    externalAccountId: string,
    cursor: string | null,
  ): Promise<ProviderPage> {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await adapter.fetchPage({
          externalAccountId,
          cursor,
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        })
      } catch (error) {
        const retryable = error instanceof ProviderAdapterError
          ? error.retryable
          : error instanceof Error && error.name === 'TimeoutError'
        if (!retryable || attempt === MAX_RETRY_ATTEMPTS) throw error
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
      }
    }
    throw new IngestionError('provider_retry_limit_reached')
  }

  private mergeCoverage(
    result: Partial<Record<CoverageEntity, CoverageState>>,
    pageCoverage: Partial<Record<CoverageEntity, CoverageState>>,
  ): void {
    for (const [entity, next] of Object.entries(pageCoverage) as Array<[CoverageEntity, CoverageState]>) {
      const previous = result[entity]
      result[entity] = previous === undefined
        ? next
        : previous === 'unavailable' || next === 'unavailable'
          ? 'unavailable'
          : previous === 'partial' || next === 'partial'
            ? 'partial'
            : 'complete'
    }
  }

  private coverageIsComplete(
    adapter: ProviderAdapter,
    coverage: Partial<Record<CoverageEntity, CoverageState>>,
  ): boolean {
    return Object.entries(adapter.capabilities.operations).every(([entity, capability]) =>
      capability === 'unsupported' || coverage[entity as CoverageEntity] === 'complete',
    )
  }

  private recordTimestamp(record: NormalizedRecord): string | null {
    if (record.kind === 'market') return record.sourceUpdatedAt ?? record.eventResolvesAt
    if (record.kind === 'fill' || record.kind === 'cash_movement') return record.occurredAt
    if (record.kind === 'settlement') return record.settledAt
    return record.observedAt
  }

  private earliestTimestamp(current: string | null, next: string | null): string | null {
    if (next === null) return current
    return current === null || next < current ? next : current
  }

  private latestTimestamp(current: string | null, next: string | null): string | null {
    if (next === null) return current
    return current === null || next > current ? next : current
  }

  private safeErrorCode(error: unknown): string {
    const rawCode = error instanceof ProviderAdapterError || error instanceof IngestionError
      ? error.code
      : error instanceof Error && error.name === 'TimeoutError'
        ? 'provider_timeout'
        : 'sync_failed'
    return /^[a-z0-9_]{1,64}$/.test(rawCode) ? rawCode : 'sync_failed'
  }
}

export async function getSyncAccount(database: Database, accountId: string, ownerId: string) {
  const [row] = await database.select({
    id: providerAccounts.id,
    providerCode: providerAccounts.providerCode,
    externalAccountId: providerAccounts.externalAccountId,
  }).from(providerAccounts)
    .innerJoin(portfolios, eq(providerAccounts.portfolioId, portfolios.id))
    .where(and(eq(providerAccounts.id, accountId), eq(portfolios.ownerId, ownerId)))
    .limit(1)
  return row
}

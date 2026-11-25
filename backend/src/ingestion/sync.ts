import { randomUUID } from 'node:crypto'
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { providerAccounts, syncCheckpoints, syncRuns } from '../db/schema.js'
import type { CoverageEntity, EntityCoverageReport, ProviderSyncStream } from '../domain/model.js'
import { ProviderAdapterError, type ProviderAdapter, type ProviderPage } from '../providers/adapter.js'
import { ProviderRegistry } from '../providers/registry.js'
import { IngestionError, SyncAlreadyRunningError } from './errors.js'
import { finalizeSnapshots, initializeCoverage, persistPage, writeStreamCoverage } from './persistence.js'
import { MAX_RECORDS_PER_STREAM, MAX_SYNC_DURATION_MS, validateNormalizedRecords, validateProviderPage } from './validation.js'

const ACCOUNT_LOCK_NAME = 'portfolio-history'
const MAX_RETRY_ATTEMPTS = 2
const MAX_PAGE_COUNT = 100
const PAGE_TIMEOUT_MS = 10_000
const LEASE_DURATION = sql`now() + interval '2 minutes'`

type SyncStatus = 'complete' | 'partial' | 'failed'

export interface StreamSyncResult {
  streamName: string
  status: SyncStatus
  pagesRead: number
  recordsSeen: number
  errorCode: string | null
  runId: string
}

export interface SyncResult {
  providerAccountId: string
  status: SyncStatus
  streams: StreamSyncResult[]
  startedAt: string
  finishedAt: string
}

interface StoredSyncAccount {
  id: string
  providerCode: string
  externalAccountId: string
}

export class IngestionService {
  constructor(
    private readonly database: Database,
    private readonly registry: ProviderRegistry,
  ) {}

  async syncProviderAccount(account: string | { id: string }): Promise<SyncResult> {
    const accountId = typeof account === 'string' ? account : account.id
    const storedAccount = await this.loadSyncAccount(accountId)
    const adapter = this.registry.get(storedAccount.providerCode)
    this.validateStreams(adapter)
    const startedAt = new Date().toISOString()
    const deadline = Date.now() + MAX_SYNC_DURATION_MS

    const accountCheckpointId = await this.getOrCreateCheckpoint(accountId, ACCOUNT_LOCK_NAME)
    const leaseToken = randomUUID()
    if (!await this.tryAcquireLease(accountCheckpointId, leaseToken)) throw new SyncAlreadyRunningError()

    const results: StreamSyncResult[] = []
    try {
      await this.database.transaction((tx) => initializeCoverage(tx, accountId, adapter.capabilities, new Date()))
      for (const stream of adapter.capabilities.streams) {
        results.push(await this.syncStream({
          account: storedAccount,
          adapter,
          stream,
          accountCheckpointId,
          leaseToken,
          deadline,
        }))
      }
    } finally {
      const status = this.aggregateStatus(results)
      await this.releaseAccountLease(accountCheckpointId, leaseToken, status)
    }

    const finishedAt = new Date().toISOString()
    return {
      providerAccountId: storedAccount.id,
      status: this.aggregateStatus(results),
      streams: results,
      startedAt,
      finishedAt,
    }
  }

  private async loadSyncAccount(accountId: string): Promise<StoredSyncAccount> {
    const [account] = await this.database.select({
      id: providerAccounts.id,
      providerCode: providerAccounts.providerCode,
      externalAccountId: providerAccounts.externalAccountId,
      disabledAt: providerAccounts.disabledAt,
    }).from(providerAccounts).where(eq(providerAccounts.id, accountId)).limit(1)
    if (!account) throw new IngestionError('provider_account_not_found')
    if (account.disabledAt) throw new IngestionError('provider_account_disabled')
    return { id: account.id, providerCode: account.providerCode, externalAccountId: account.externalAccountId }
  }

  private validateStreams(adapter: ProviderAdapter): void {
    const names = new Set<string>()
    const configuredEntities = new Set<CoverageEntity>()
    for (const stream of adapter.capabilities.streams) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(stream.name) || names.has(stream.name) || stream.entities.length === 0) {
        throw new IngestionError('invalid_provider_stream_configuration')
      }
      names.add(stream.name)
      if (new Set(stream.entities).size !== stream.entities.length) throw new IngestionError('invalid_provider_stream_configuration')
      for (const entity of stream.entities) {
        if (adapter.capabilities.operations[entity] !== 'supported') throw new IngestionError('invalid_provider_stream_configuration')
        if (configuredEntities.has(entity)) throw new IngestionError('provider_entity_configured_in_multiple_streams')
        configuredEntities.add(entity)
      }
      for (const entity of Object.keys(stream.snapshotSemantics) as Array<'positions' | 'cash_balances'>) {
        if (!stream.entities.includes(entity)) throw new IngestionError('invalid_provider_stream_configuration')
      }
    }
    if (names.size === 0) throw new IngestionError('invalid_provider_stream_configuration')
    for (const [entity, capability] of Object.entries(adapter.capabilities.operations) as Array<[CoverageEntity, 'supported' | 'unsupported']>) {
      if (capability === 'supported' && !configuredEntities.has(entity)) throw new IngestionError('invalid_provider_stream_configuration')
    }
  }

  private async syncStream(input: {
    account: StoredSyncAccount
    adapter: ProviderAdapter
    stream: ProviderSyncStream
    accountCheckpointId: string
    leaseToken: string
    deadline: number
  }): Promise<StreamSyncResult> {
    const { account, adapter, stream, accountCheckpointId, leaseToken, deadline } = input
    const streamCheckpointId = await this.getOrCreateCheckpoint(account.id, `stream:${stream.name}`)
    const [checkpoint] = await this.database.select({
      id: syncCheckpoints.id,
      cursor: syncCheckpoints.cursor,
      durableCheckpoint: syncCheckpoints.durableCheckpoint,
      status: syncCheckpoints.status,
    }).from(syncCheckpoints).where(eq(syncCheckpoints.id, streamCheckpointId)).limit(1)
    if (!checkpoint) throw new IngestionError('sync_checkpoint_unavailable')

    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    const cursorAtStart = checkpoint.cursor
    const checkpointAtStart = stream.strategy === 'provider_checkpoint' ? checkpoint.durableCheckpoint : null
    let cursor = cursorAtStart
    let durableCheckpoint = checkpoint.durableCheckpoint
    let pagesRead = 0
    let recordsSeen = 0
    let status: SyncStatus = 'failed'
    let errorCode: string | null = null
    const seenCursors = new Set<string>()
    if (cursor !== null) seenCursors.add(cursor)
    const reports: Partial<Record<CoverageEntity, EntityCoverageReport>> = {}

    await this.startRun({
      accountId: account.id,
      accountCheckpointId,
      streamCheckpointId,
      leaseToken,
      runId,
      streamName: stream.name,
      cursorAtStart,
      checkpointAtStart,
      startedAt,
    })

    try {
      while (true) {
        if (Date.now() >= deadline) throw new IngestionError('sync_deadline_exceeded')
        if (pagesRead >= MAX_PAGE_COUNT) throw new IngestionError('provider_page_limit_reached')
        await this.renewAccountLease(accountCheckpointId, leaseToken)
        const page = await this.fetchWithRetry({
          adapter,
          externalAccountId: account.externalAccountId,
          stream,
          cursor,
          checkpoint: stream.strategy === 'provider_checkpoint' ? durableCheckpoint : null,
          deadline,
        })
        const validatedPage = validateProviderPage(page, stream)
        const normalized = adapter.normalizePage(validatedPage, stream.name)
        const records = validateNormalizedRecords(normalized, stream)
        if (recordsSeen + records.length > MAX_RECORDS_PER_STREAM) throw new IngestionError('provider_stream_record_limit_reached')
        if (validatedPage.nextCursor !== null && seenCursors.has(validatedPage.nextCursor)) {
          throw new IngestionError('provider_cursor_did_not_advance')
        }

        const nextDurableCheckpoint = stream.strategy === 'provider_checkpoint' && validatedPage.checkpoint !== null
          ? validatedPage.checkpoint
          : durableCheckpoint
        const retrievedAt = new Date().toISOString()
        await persistPage({
          database: this.database,
          providerAccountId: account.id,
          providerCode: account.providerCode,
          accountCheckpointId,
          streamCheckpointId,
          runId,
          leaseToken,
          nextCursor: validatedPage.nextCursor,
          durableCheckpoint: nextDurableCheckpoint,
          retrievedAt,
          records,
          snapshotSemantics: stream.snapshotSemantics,
        })
        pagesRead += 1
        recordsSeen += records.length
        this.mergeReports(reports, validatedPage.coverage)
        cursor = validatedPage.nextCursor
        durableCheckpoint = nextDurableCheckpoint
        if (cursor === null) break
        seenCursors.add(cursor)
        if (pagesRead >= MAX_PAGE_COUNT) throw new IngestionError('provider_page_limit_reached')
      }
      status = 'complete'
    } catch (error) {
      status = pagesRead > 0 ? 'partial' : 'failed'
      errorCode = this.safeErrorCode(error)
    }

    const finishedAt = new Date().toISOString()
    await this.finishStream({
      providerAccountId: account.id,
      accountCheckpointId,
      streamCheckpointId,
      leaseToken,
      runId,
      stream,
      status,
      errorCode,
      cursor,
      durableCheckpoint,
      reports,
      pagesRead,
      recordsSeen,
      finishedAt,
    }).catch((error: unknown) => {
      if (error instanceof IngestionError && error.code === 'sync_lease_lost') errorCode = error.code
      else if (errorCode === null) errorCode = 'sync_finish_failed'
      status = pagesRead > 0 ? 'partial' : 'failed'
    })

    return { streamName: stream.name, status, pagesRead, recordsSeen, errorCode, runId }
  }

  private async getOrCreateCheckpoint(providerAccountId: string, syncName: string): Promise<string> {
    await this.database.insert(syncCheckpoints).values({ providerAccountId, syncName, status: 'idle' }).onConflictDoNothing()
    const [checkpoint] = await this.database.select({ id: syncCheckpoints.id }).from(syncCheckpoints).where(and(
      eq(syncCheckpoints.providerAccountId, providerAccountId),
      eq(syncCheckpoints.syncName, syncName),
    )).limit(1)
    if (!checkpoint) throw new IngestionError('sync_checkpoint_unavailable')
    return checkpoint.id
  }

  private async tryAcquireLease(checkpointId: string, leaseToken: string): Promise<boolean> {
    const [checkpoint] = await this.database.update(syncCheckpoints).set({
      status: 'running',
      leaseToken,
      leaseExpiresAt: LEASE_DURATION,
      lastStartedAt: new Date(),
      lastErrorCode: null,
      updatedAt: new Date(),
    }).where(and(
      eq(syncCheckpoints.id, checkpointId),
      or(isNull(syncCheckpoints.leaseExpiresAt), lt(syncCheckpoints.leaseExpiresAt, sql`now()`)),
    )).returning({ id: syncCheckpoints.id })
    return checkpoint !== undefined
  }

  private async startRun(input: {
    accountId: string
    accountCheckpointId: string
    streamCheckpointId: string
    leaseToken: string
    runId: string
    streamName: string
    cursorAtStart: string | null
    checkpointAtStart: string | null
    startedAt: string
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [lease] = await tx.update(syncCheckpoints).set({ leaseExpiresAt: LEASE_DURATION, updatedAt: new Date(input.startedAt) }).where(and(
        eq(syncCheckpoints.id, input.accountCheckpointId),
        eq(syncCheckpoints.leaseToken, input.leaseToken),
      )).returning({ id: syncCheckpoints.id })
      if (!lease) throw new IngestionError('sync_lease_lost')
      await tx.update(syncRuns).set({
        status: 'failed',
        finishedAt: new Date(input.startedAt),
        errorCode: 'interrupted',
      }).where(and(
        eq(syncRuns.providerAccountId, input.accountId),
        eq(syncRuns.syncName, input.streamName),
        eq(syncRuns.status, 'running'),
        ne(syncRuns.id, input.runId),
      ))
      await tx.insert(syncRuns).values({
        id: input.runId,
        providerAccountId: input.accountId,
        syncName: input.streamName,
        status: 'running',
        cursorAtStart: input.cursorAtStart,
        checkpointAtStart: input.checkpointAtStart,
        startedAt: new Date(input.startedAt),
      })
      await tx.update(syncCheckpoints).set({
        lastRunId: input.runId,
        lastStartedAt: new Date(input.startedAt),
        status: 'running',
        updatedAt: new Date(input.startedAt),
      }).where(eq(syncCheckpoints.id, input.streamCheckpointId))
    })
  }

  private async renewAccountLease(checkpointId: string, leaseToken: string): Promise<void> {
    const [checkpoint] = await this.database.update(syncCheckpoints).set({ leaseExpiresAt: LEASE_DURATION, updatedAt: new Date() }).where(and(
      eq(syncCheckpoints.id, checkpointId),
      eq(syncCheckpoints.leaseToken, leaseToken),
    )).returning({ id: syncCheckpoints.id })
    if (!checkpoint) throw new IngestionError('sync_lease_lost')
  }

  private async fetchWithRetry(input: {
    adapter: ProviderAdapter
    externalAccountId: string
    stream: ProviderSyncStream
    cursor: string | null
    checkpoint: string | null
    deadline: number
  }): Promise<ProviderPage> {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      const remaining = input.deadline - Date.now()
      if (remaining <= 0) throw new IngestionError('sync_deadline_exceeded')
      const timeoutMs = Math.min(PAGE_TIMEOUT_MS, remaining)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new ProviderAdapterError('provider_page_timeout', true)), timeoutMs)
        })
        const response = await Promise.race([
          input.adapter.fetchPage({
            externalAccountId: input.externalAccountId,
            streamName: input.stream.name,
            cursor: input.cursor,
            checkpoint: input.checkpoint,
            signal: AbortSignal.timeout(timeoutMs),
          }),
          timeoutPromise,
        ])
        return validateProviderPage(response, input.stream)
      } catch (error) {
        const retryable = error instanceof ProviderAdapterError
          ? error.retryable
          : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        if (!retryable || attempt === MAX_RETRY_ATTEMPTS || Date.now() >= input.deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, Math.min(100 * attempt, Math.max(0, input.deadline - Date.now()))))
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }
    throw new IngestionError('provider_page_unavailable')
  }

  private async finishStream(input: {
    providerAccountId: string
    accountCheckpointId: string
    streamCheckpointId: string
    leaseToken: string
    runId: string
    stream: ProviderSyncStream
    status: SyncStatus
    errorCode: string | null
    cursor: string | null
    durableCheckpoint: string | null
    reports: Partial<Record<CoverageEntity, EntityCoverageReport>>
    pagesRead: number
    recordsSeen: number
    finishedAt: string
  }): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [lease] = await tx.update(syncCheckpoints).set({ leaseExpiresAt: LEASE_DURATION, updatedAt: new Date(input.finishedAt) }).where(and(
        eq(syncCheckpoints.id, input.accountCheckpointId),
        eq(syncCheckpoints.leaseToken, input.leaseToken),
      )).returning({ id: syncCheckpoints.id })
      if (!lease) throw new IngestionError('sync_lease_lost')
      await tx.update(syncCheckpoints).set({
        status: input.status,
        cursor: input.status === 'complete' ? null : input.cursor,
        durableCheckpoint: input.durableCheckpoint,
        lastCompletedAt: new Date(input.finishedAt),
        lastErrorCode: input.errorCode,
        updatedAt: new Date(input.finishedAt),
      }).where(eq(syncCheckpoints.id, input.streamCheckpointId))

      let snapshots = { positionSnapshotComplete: false, cashBalanceSnapshotComplete: false }
      if (input.status === 'complete') {
        snapshots = await finalizeSnapshots({
          tx,
          providerAccountId: input.providerAccountId,
          runId: input.runId,
          stream: input.stream,
          reports: input.reports,
          finishedAt: new Date(input.finishedAt),
        })
      }
      await tx.update(syncRuns).set({
        status: input.status,
        finishedAt: new Date(input.finishedAt),
        cursorAtEnd: input.status === 'complete' ? null : input.cursor,
        checkpointAtEnd: input.durableCheckpoint,
        pagesRead: input.pagesRead,
        recordsSeen: input.recordsSeen,
        errorCode: input.errorCode,
        ...snapshots,
      }).where(eq(syncRuns.id, input.runId))
      await writeStreamCoverage(tx, {
        providerAccountId: input.providerAccountId,
        stream: input.stream,
        reports: input.reports,
        retrievedAt: input.finishedAt,
        syncStatus: input.status,
        errorCode: input.errorCode,
        pagesPersisted: input.pagesRead > 0,
      })
    })
  }

  private async releaseAccountLease(checkpointId: string, leaseToken: string, status: SyncStatus): Promise<void> {
    await this.database.update(syncCheckpoints).set({
      status,
      leaseToken: null,
      leaseExpiresAt: null,
      lastCompletedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(syncCheckpoints.id, checkpointId), eq(syncCheckpoints.leaseToken, leaseToken)))
  }

  private mergeReports(
    target: Partial<Record<CoverageEntity, EntityCoverageReport>>,
    pageCoverage: Partial<Record<CoverageEntity, EntityCoverageReport>>,
  ): void {
    const rank = { complete: 0, partial: 1, unavailable: 2, unknown: 3 } as const
    for (const [entity, next] of Object.entries(pageCoverage) as Array<[CoverageEntity, EntityCoverageReport]>) {
      const prior = target[entity]
      if (!prior) {
        target[entity] = next
        continue
      }
      const status = rank[prior.status] >= rank[next.status] ? prior.status : next.status
      const starts = [prior.coverageStart, next.coverageStart].filter((value): value is string => value !== null && value !== undefined)
      const ends = [prior.coverageEnd, next.coverageEnd].filter((value): value is string => value !== null && value !== undefined)
      const asOfs = [prior.sourceAsOf, next.sourceAsOf].filter((value): value is string => value !== null && value !== undefined)
      target[entity] = {
        status,
        coverageStart: starts.length ? starts.reduce((a, b) => new Date(a) <= new Date(b) ? a : b) : null,
        coverageEnd: ends.length ? ends.reduce((a, b) => new Date(a) >= new Date(b) ? a : b) : null,
        sourceAsOf: asOfs.length ? asOfs.reduce((a, b) => new Date(a) >= new Date(b) ? a : b) : null,
        reasonCode: next.reasonCode ?? prior.reasonCode ?? null,
      }
    }
  }

  private aggregateStatus(results: StreamSyncResult[]): SyncStatus {
    if (results.length > 0 && results.every((result) => result.status === 'complete')) return 'complete'
    if (results.length > 0 && results.every((result) => result.status === 'failed')) return 'failed'
    return 'partial'
  }

  private safeErrorCode(error: unknown): string {
    if (error instanceof IngestionError || error instanceof ProviderAdapterError) return error.code
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'provider_page_timeout'
    return 'provider_sync_failed'
  }
}

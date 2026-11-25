import { z } from 'zod'
import { normalizedRecordSchema, type EntityCoverageReport, type NormalizedRecord, type ProviderCapabilities } from '../../domain/model.js'
import { ProviderAdapterError, type ProviderAdapter, type ProviderPage } from '../adapter.js'
import { SNAPSHOT_ACCOUNT_ID, snapshotPage } from './data.js'

const contractSchema = z.object({
  caseId: z.string(),
  caseName: z.string(),
  resolution: z.string(),
  caseStatus: z.string(),
  marketRef: z.string(),
  question: z.string(),
  contractStatus: z.string(),
  collateral: z.string(),
  outcomes: z.array(z.object({
    legRef: z.string(),
    label: z.string(),
    kind: z.string(),
    payoutUnits: z.string().nullable(),
  }).strict()).min(2),
}).strict()

const executionSchema = z.object({
  fillRef: z.string(),
  contractRef: z.string(),
  legRef: z.string(),
  verb: z.enum(['buy', 'sell']),
  filledAt: z.string().datetime({ offset: true }),
  lots: z.string(),
  unitPrice: z.string(),
  fee: z.object({ status: z.enum(['reported', 'estimated', 'unavailable']), value: z.string().nullable() }).strict(),
  collateral: z.string(),
  transactionState: z.string(),
}).strict()

const accountChangeSchema = z.object({
  changeRef: z.string(),
  type: z.enum(['deposit', 'withdrawal', 'transfer', 'adjustment']),
  effectiveAt: z.string().datetime({ offset: true }),
  delta: z.string(),
  collateral: z.string(),
  charge: z.string().nullable(),
  chargeState: z.enum(['reported', 'estimated', 'unavailable']),
}).strict()

const holdingSchema = z.object({
  holdingRef: z.string(),
  contractRef: z.string(),
  legRef: z.string(),
  snapshotAt: z.string().datetime({ offset: true }),
  contractsHeld: z.string(),
  averageEntry: z.string().nullable(),
  currentMark: z.string().nullable(),
  collateral: z.string().nullable(),
  reportedByProvider: z.boolean(),
}).strict()

const snapshotSchema = z.object({
  contracts: z.array(contractSchema),
  executions: z.array(executionSchema),
  accountChanges: z.array(accountChangeSchema),
  holdings: z.array(holdingSchema),
  accountBalance: z.null(),
}).strict()

const completeReport = (coverageStart: string | null = null, coverageEnd: string | null = null): EntityCoverageReport => ({
  status: 'complete', coverageStart, coverageEnd, sourceAsOf: '2026-11-24T04:00:00Z', reasonCode: null,
})

const emptySnapshotPayload = () => ({
  contracts: [], executions: [], accountChanges: [], holdings: [], accountBalance: null,
})

export class SnapshotFixtureAdapter implements ProviderAdapter {
  readonly capabilities: ProviderCapabilities = {
    providerCode: 'fixture-account-snapshot',
    displayName: 'Fixture Account Snapshot Provider',
    adapterKind: 'fixture',
    accountKinds: ['fixture'],
    operations: {
      markets: 'supported',
      fills: 'supported',
      activity: 'unsupported',
      cash_movements: 'supported',
      settlements: 'unsupported',
      positions: 'supported',
      cash_balances: 'unsupported',
      prices: 'unsupported',
    },
    streams: [
      {
        name: 'activity',
        entities: ['markets', 'fills', 'cash_movements'],
        strategy: 'full_refresh',
        snapshotSemantics: {},
      },
      {
        name: 'positions',
        entities: ['positions'],
        strategy: 'full_refresh',
        snapshotSemantics: { positions: 'complete' },
      },
    ],
    pagination: 'unsupported',
    incrementalSync: 'unsupported',
  }

  async fetchPage({ externalAccountId, streamName, cursor, checkpoint, signal }: Parameters<ProviderAdapter['fetchPage']>[0]): Promise<ProviderPage> {
    if (signal.aborted) throw new ProviderAdapterError('request_aborted', true)
    if (externalAccountId !== SNAPSHOT_ACCOUNT_ID) throw new ProviderAdapterError('fixture_account_not_found', false)
    if (cursor !== null || checkpoint !== null) throw new ProviderAdapterError('fixture_pagination_unsupported', false)
    if (streamName !== 'activity' && streamName !== 'positions') throw new ProviderAdapterError('unknown_fixture_stream', false)
    const full = snapshotPage as Record<string, unknown[]>
    const activityPayload = {
      ...emptySnapshotPayload(),
      contracts: full.contracts,
      executions: full.executions,
      accountChanges: full.accountChanges,
    }
    const positionPayload = { ...emptySnapshotPayload(), holdings: full.holdings }
    const activity = streamName === 'activity'
    return {
      payload: activity ? activityPayload : positionPayload,
      nextCursor: null,
      checkpoint: null,
      coverage: activity
        ? {
          markets: completeReport(),
          fills: completeReport('2026-11-19T06:00:00Z', '2026-11-19T06:00:00Z'),
          cash_movements: completeReport('2026-11-17T02:00:00Z', '2026-11-17T02:00:00Z'),
        }
        : { positions: completeReport('2026-11-24T04:00:00Z', '2026-11-24T04:00:00Z') },
    }
  }

  normalizePage(page: ProviderPage, streamName: string): NormalizedRecord[] {
    const parsedPage = snapshotSchema.safeParse(page.payload)
    if (!parsedPage.success) throw new ProviderAdapterError('invalid_provider_payload', false)
    const isActivity = streamName === 'activity'
    const isPositions = streamName === 'positions'
    if (!isActivity && !isPositions) throw new ProviderAdapterError('unknown_fixture_stream', false)
    const contracts = isActivity ? parsedPage.data.contracts : []
    const executions = isActivity ? parsedPage.data.executions : []
    const accountChanges = isActivity ? parsedPage.data.accountChanges : []
    const holdings = isPositions ? parsedPage.data.holdings : []
    const records: unknown[] = [
      ...contracts.map((contract) => ({
        kind: 'market',
        externalEventId: contract.caseId,
        eventName: contract.caseName,
        eventDescription: null,
        resolutionRules: contract.resolution,
        eventLifecycle: contract.caseStatus,
        eventResolvesAt: null,
        externalMarketId: contract.marketRef,
        marketTitle: contract.question,
        marketLifecycle: contract.contractStatus,
        settlementRules: contract.resolution,
        settlementAssetCode: contract.collateral,
        eventSourceUpdatedAt: null,
        sourceUpdatedAt: null,
        outcomes: contract.outcomes.map((outcome) => ({
          externalId: outcome.legRef,
          name: outcome.label,
          outcomeType: outcome.kind,
          payoutAmount: outcome.payoutUnits,
          settlementAssetCode: contract.collateral,
        })),
        rawPayload: contract,
      })),
      ...executions.map((execution) => ({
        kind: 'fill',
        externalId: execution.fillRef,
        externalMarketId: execution.contractRef,
        externalInstrumentId: execution.legRef,
        direction: execution.verb,
        occurredAt: execution.filledAt,
        quantity: execution.lots,
        price: execution.unitPrice,
        feeAmount: execution.fee.value,
        feeStatus: execution.fee.status,
        settlementAssetCode: execution.collateral,
        finality: execution.transactionState,
        rawPayload: execution,
      })),
      ...accountChanges.map((change) => ({
        kind: 'cash_movement',
        externalId: change.changeRef,
        movementKind: change.type,
        occurredAt: change.effectiveAt,
        signedAmount: change.type === 'withdrawal' ? `-${change.delta}` : change.delta,
        assetCode: change.collateral,
        feeAmount: change.charge,
        feeStatus: change.chargeState,
        rawPayload: change,
      })),
      ...holdings.map((holding) => ({
        kind: 'position',
        externalId: holding.holdingRef,
        externalMarketId: holding.contractRef,
        externalInstrumentId: holding.legRef,
        observedAt: holding.snapshotAt,
        quantity: holding.contractsHeld,
        averageCostPrice: holding.averageEntry,
        markPrice: holding.currentMark,
        markAt: null,
        settlementAssetCode: holding.collateral,
        origin: holding.reportedByProvider ? 'provider_reported' : 'reconstructed',
        reconciliationStatus: 'not_started',
        rawPayload: holding,
      })),
    ]
    return records.map((record) => normalizedRecordSchema.parse(record))
  }
}

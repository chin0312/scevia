type Mode = 'connectivity' | 'populated' | 'repeat' | 'market-services'

interface StreamResult {
  streamName: string
  status: string
  pagesRead: number
  recordsSeen: number
  rowsReceived: number
  sourceRowsRetained: number
  invalidRecords: number
  recordsPersisted: number
  exactDuplicates: number
  unresolvedRecords: number
  overlapCandidates: number
  excludedRecords: number
  errorCode: string | null
  runId: string
}

interface SyncResult {
  providerAccountId: string
  status: string
  streams: StreamResult[]
  startedAt: string
  finishedAt: string
}

const apiBase = new URL(process.env.SCEVIA_API_URL ?? 'http://127.0.0.1:3001')
const mode = parseMode(process.argv.slice(2), process.env.POLYMARKET_VERIFY_MODE)
const walletAddress = process.env.POLYMARKET_WALLET_ADDRESS
const portfolioId = process.env.SCEVIA_PORTFOLIO_ID
const token = process.env.DEV_AUTH_TOKEN

if (!['127.0.0.1', 'localhost', '[::1]'].includes(apiBase.hostname) || apiBase.protocol !== 'http:' || apiBase.port !== '3001') {
  throw new Error('Live verification is restricted to the local development API at http://127.0.0.1:3001.')
}

if (process.env.POLYMARKET_LIVE_DATA_AUTHORIZED !== 'YES') {
  throw new Error('Set POLYMARKET_LIVE_DATA_AUTHORIZED=YES only after confirming the selected Polymarket data use is permitted.')
}

if (mode === 'market-services') {
  const query = process.env.POLYMARKET_SEARCH_QUERY ?? 'polymarket'
  const marketUrl = process.env.POLYMARKET_MARKET_URL
  const search = await request<{ items: unknown[]; pagination: Record<string, unknown>; enrichment: Record<string, unknown> }>(
    `/v1/market-data/search?q=${encodeURIComponent(query)}&limit=5&page=1`,
  )
  const resolution = marketUrl
    ? await request<Record<string, unknown>>('/v1/market-data/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: marketUrl }),
    })
    : null
  const summary = {
    mode,
    providerCode: 'polymarket',
    publicMarketSearch: {
      result: search.items.length > 0 ? 'populated' : 'empty',
      firstPageCount: search.items.length,
      pagination: search.pagination,
      enrichment: search.enrichment,
    },
    urlResolution: resolution === null ? 'not_requested' : 'resolved',
    completeCriteriaMet: search.enrichment.status === 'complete'
      && (search.pagination.providerHasMore !== true || search.pagination.continuationAvailable === true)
      && (marketUrl === undefined || resolution !== null),
  }
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.completeCriteriaMet) process.exitCode = 2
} else {
  if (!walletAddress || !portfolioId || !token) {
    throw new Error('Set POLYMARKET_WALLET_ADDRESS, SCEVIA_PORTFOLIO_ID, and DEV_AUTH_TOKEN before wallet verification.')
  }

  const authHeaders = { authorization: `Bearer ${token}` }
  const registration = await request<{ id: string; alreadyRegistered: boolean }>(
    `/v1/portfolios/${encodeURIComponent(portfolioId)}/sources/polymarket`,
    { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ walletAddress }) },
  )
  const firstSync = await sync(registration.id, authHeaders)
  const sourceQuery = `providerAccountId=${encodeURIComponent(registration.id)}&limit=100&offset=0`
  const readFills = () => request<{ items: Array<{ id: string; providerAccountId: string; identityKind?: string }> }>(
    `/v1/portfolios/${encodeURIComponent(portfolioId)}/fills?${sourceQuery}`, { headers: authHeaders },
  )
  const [positions, fills, cashMovements, activityFacts, coverage] = await Promise.all([
    request<{ items: Array<{ providerAccountId: string }> }>(`/v1/portfolios/${encodeURIComponent(portfolioId)}/positions?${sourceQuery}`, { headers: authHeaders }),
    readFills(),
    request<{ items: Array<{ providerAccountId: string }> }>(`/v1/portfolios/${encodeURIComponent(portfolioId)}/cash-movements?${sourceQuery}`, { headers: authHeaders }),
    request<{ items: Array<{ providerAccountId: string; classification?: string }> }>(`/v1/portfolios/${encodeURIComponent(portfolioId)}/activity-facts?${sourceQuery}`, { headers: authHeaders }),
    request<{ items: Array<{ providerAccountId: string; entityType: string; status: string; reasonCode: string | null }> }>(
      `/v1/portfolios/${encodeURIComponent(portfolioId)}/coverage?providerAccountId=${encodeURIComponent(registration.id)}&limit=100&offset=0`,
      { headers: authHeaders },
    ),
  ])

  const secondSync = mode === 'repeat' ? await sync(registration.id, authHeaders) : null
  const repeatedFills = secondSync === null ? null : await readFills()
  const sourceRows = [
    ...positions.items,
    ...fills.items,
    ...cashMovements.items,
    ...activityFacts.items,
  ]
  const allRowsBelongToSelectedSource = sourceRows.every((row) => row.providerAccountId === registration.id)
  const firstPageCounts = {
    positions: positions.items.length,
    fills: fills.items.length,
    cashMovements: cashMovements.items.length,
    unresolvedAndOverlapActivityFacts: activityFacts.items.length,
  }
  const retainedApiRows = Object.values(firstPageCounts).reduce((sum, value) => sum + value, 0)
  const firstRunTotals = addStreamCounters(firstSync.streams)
  const allStreamsComplete = firstSync.streams.every((stream) => stream.status === 'complete')
  const incompleteFirstSyncStreams = firstSync.streams.filter((stream) => stream.status !== 'complete').map((stream) => stream.streamName)
  const hasProviderEvidence = firstRunTotals.rowsReceived > 0
  const hasRetainedFinancialFacts = !registration.alreadyRegistered
    && (positions.items.length > 0 || fills.items.length > 0 || cashMovements.items.length > 0)
  const hasApiReadback = retainedApiRows > 0 && allRowsBelongToSelectedSource
  const secondRunTotals = secondSync === null ? null : addStreamCounters(secondSync.streams)
  const repeatedSyncEvidence = secondSync === null ? null : {
    status: secondSync.status,
    exactDuplicates: secondRunTotals?.exactDuplicates ?? 0,
    retainedRows: secondRunTotals?.sourceRowsRetained ?? 0,
    deduplicationObserved: fills.items.length > 0 && fills.items.length < 100
      && (secondRunTotals?.exactDuplicates ?? 0) > 0
      && JSON.stringify(fills.items.map((row) => row.id).sort())
        === JSON.stringify(repeatedFills?.items.map((row) => row.id).sort()),
  }

  const secondSyncComplete = secondSync === null || secondSync.streams.every((stream) => stream.status === 'complete')
  const completeCriteriaMet = mode === 'connectivity'
    ? allStreamsComplete
    : mode === 'populated'
      ? allStreamsComplete && hasProviderEvidence && hasRetainedFinancialFacts && hasApiReadback
      : allStreamsComplete && secondSyncComplete && hasProviderEvidence && hasRetainedFinancialFacts && hasApiReadback
        && repeatedSyncEvidence?.deduplicationObserved === true

  console.log(JSON.stringify({
    mode,
    providerCode: 'polymarket',
    sourceRegistration: registration.alreadyRegistered ? 'already_registered' : 'created',
    selectedProviderAccountId: registration.id,
    providerConnectivity: allStreamsComplete ? 'reachable' : 'reached_but_sync_incomplete',
    providerData: hasProviderEvidence ? 'populated_response' : 'empty_response',
    syncCompleteness: {
      firstSync: allStreamsComplete ? 'complete' : 'incomplete',
      incompleteStreamNames: incompleteFirstSyncStreams,
      secondSync: secondSync === null ? 'not_run' : secondSyncComplete ? 'complete' : 'incomplete',
    },
    normalization: {
      rowsReceived: firstRunTotals.rowsReceived,
      sourceRowsRetained: firstRunTotals.sourceRowsRetained,
      recordsPersisted: firstRunTotals.recordsPersisted,
      exactDuplicates: firstRunTotals.exactDuplicates,
      unresolvedRecords: firstRunTotals.unresolvedRecords,
      invalidRecords: firstRunTotals.invalidRecords,
      excludedRecords: firstRunTotals.excludedRecords,
    },
    firstSync: { status: firstSync.status, streams: firstSync.streams },
    secondSync: secondSync === null ? null : { status: secondSync.status, streams: secondSync.streams },
    repeatedSyncEvidence,
    authorizedApiReadback: {
      firstPageCounts,
      limitPerEndpoint: 100,
      selectedSourceOnly: allRowsBelongToSelectedSource,
      populated: hasApiReadback,
    },
    coverage: coverage.items.map(({ entityType, status, reasonCode }) => ({ entityType, status, reasonCode })),
    completeCriteriaMet,
    evidenceClass: 'live_provider_and_database_backed',
  }, null, 2))

  if (firstSync.status !== 'complete' || secondSync !== null && secondSync.status !== 'complete' || !completeCriteriaMet) process.exitCode = 2
}

async function sync(providerAccountId: string, headers: Record<string, string>): Promise<SyncResult> {
  return request<SyncResult>(`/v1/provider-accounts/${encodeURIComponent(providerAccountId)}/sync`, {
    method: 'POST',
    headers,
  })
}

function addStreamCounters(streams: StreamResult[]) {
  return streams.reduce((totals, stream) => ({
    rowsReceived: totals.rowsReceived + stream.rowsReceived,
    sourceRowsRetained: totals.sourceRowsRetained + stream.sourceRowsRetained,
    recordsPersisted: totals.recordsPersisted + stream.recordsPersisted,
    exactDuplicates: totals.exactDuplicates + stream.exactDuplicates,
    unresolvedRecords: totals.unresolvedRecords + stream.unresolvedRecords,
    invalidRecords: totals.invalidRecords + stream.invalidRecords,
    excludedRecords: totals.excludedRecords + stream.excludedRecords,
  }), {
    rowsReceived: 0,
    sourceRowsRetained: 0,
    recordsPersisted: 0,
    exactDuplicates: 0,
    unresolvedRecords: 0,
    invalidRecords: 0,
    excludedRecords: 0,
  })
}

function parseMode(arguments_: string[], environmentMode: string | undefined): Mode {
  const modeArgument = arguments_.find((argument) => argument.startsWith('--mode='))?.slice('--mode='.length)
  const candidate = modeArgument ?? environmentMode ?? 'connectivity'
  if (candidate === 'connectivity' || candidate === 'populated' || candidate === 'repeat' || candidate === 'market-services') return candidate
  throw new Error('Verification mode must be connectivity, populated, repeat, or market-services.')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, apiBase), { ...init, redirect: 'error' })
  const body = await response.json() as unknown
  if (!response.ok) {
    const code = typeof body === 'object' && body !== null
      && typeof (body as { error?: { code?: unknown } }).error?.code === 'string'
      ? (body as { error: { code: string } }).error.code
      : 'unexpected_api_error'
    throw new Error(`Local Scevia API returned ${response.status} (${code}).`)
  }
  return body as T
}

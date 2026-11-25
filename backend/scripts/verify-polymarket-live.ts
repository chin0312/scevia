const apiBase = new URL(process.env.SCEVIA_API_URL ?? 'http://127.0.0.1:3001')
const walletAddress = process.env.POLYMARKET_WALLET_ADDRESS
const portfolioId = process.env.SCEVIA_PORTFOLIO_ID
const token = process.env.DEV_AUTH_TOKEN

if (!['127.0.0.1', 'localhost', '[::1]'].includes(apiBase.hostname) || apiBase.protocol !== 'http:' || apiBase.port !== '3001') {
  throw new Error('Live verification is restricted to the local development API at http://127.0.0.1:3001.')
}
if (!walletAddress || !portfolioId || !token) {
  throw new Error('Set POLYMARKET_WALLET_ADDRESS, SCEVIA_PORTFOLIO_ID, and DEV_AUTH_TOKEN before running live verification.')
}

const authHeaders = { authorization: `Bearer ${token}` }
const registration = await request<{ id: string; alreadyRegistered: boolean }>(
  `/v1/portfolios/${encodeURIComponent(portfolioId)}/sources/polymarket`,
  { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ walletAddress }) },
)
const sync = await request<{
  status: string
  streams: Array<{ streamName: string; status: string; pagesRead: number; recordsSeen: number; errorCode: string | null }>
}>(`/v1/provider-accounts/${encodeURIComponent(registration.id)}/sync`, { method: 'POST', headers: authHeaders })

const [positions, fills, cashMovements, activityFacts, coverage] = await Promise.all([
  request<{ items: unknown[] }>(`/v1/portfolios/${encodeURIComponent(portfolioId)}/positions?limit=100`, { headers: authHeaders }),
  request<{ items: unknown[] }>(`/v1/portfolios/${encodeURIComponent(portfolioId)}/fills?limit=100`, { headers: authHeaders }),
  request<{ items: unknown[] }>(`/v1/portfolios/${encodeURIComponent(portfolioId)}/cash-movements?limit=100`, { headers: authHeaders }),
  request<{ items: unknown[] }>(`/v1/portfolios/${encodeURIComponent(portfolioId)}/activity-facts?limit=100`, { headers: authHeaders }),
  request<{ items: Array<{ providerCode: string; entityType: string; status: string; reasonCode: string | null }> }>(
    `/v1/portfolios/${encodeURIComponent(portfolioId)}/coverage?limit=100`,
    { headers: authHeaders },
  ),
])

const sourceCoverage = coverage.items.filter((item) => item.providerCode === 'polymarket')
console.log(JSON.stringify({
  providerCode: 'polymarket',
  sourceRegistration: registration.alreadyRegistered ? 'already_registered' : 'created',
  syncStatus: sync.status,
  streams: sync.streams,
  storedPageCounts: {
    positions: positions.items.length,
    fills: fills.items.length,
    cashMovements: cashMovements.items.length,
    unreconciledActivityFacts: activityFacts.items.length,
  },
  coverage: sourceCoverage.map(({ entityType, status, reasonCode }) => ({ entityType, status, reasonCode })),
  countsAreLimitedToFirst100Rows: true,
}, null, 2))

if (sync.status === 'failed') process.exitCode = 1

async function request<T>(path: string, init: RequestInit): Promise<T> {
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

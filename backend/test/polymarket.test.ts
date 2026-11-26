import { PolymarketCollateralReader, polygonPusd } from '../src/providers/polymarket/collateral.js'
import { describe, expect, it } from 'vitest'
import { PolymarketAdapter } from '../src/providers/polymarket/adapter.js'
import { decimalString, PolymarketHttpClient, parseProviderJson } from '../src/providers/polymarket/http.js'
import { PolymarketMarketDataService, supportedPolymarketUrl } from '../src/providers/polymarket/market-data.js'
import type { FetchPageRequest } from '../src/providers/adapter.js'

const WALLET = '0x1234567890abcdef1234567890abcdef12345678'
const NO_ABORT = new AbortController().signal

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function textResponse(value: string): Response {
  return new Response(value, { status: 200, headers: { 'content-type': 'application/json' } })
}

function request(streamName: FetchPageRequest['streamName'], extra: Partial<FetchPageRequest> = {}): FetchPageRequest {
  return {
    externalAccountId: WALLET,
    streamName,
    cursor: null,
    checkpoint: null,
    signal: NO_ABORT,
    ...extra,
  }
}

describe('Polymarket provider adapter', () => {
  it('identifies receipt transfers by canonical chain and log without assuming contribution', async () => {
    const hash = '0x' + 'b'.repeat(64)
    const transaction = '0x' + 'a'.repeat(64)
    const from = '0x' + '1'.repeat(40)
    const topic = (value: string) => '0x' + value.slice(2).padStart(64, '0')
    const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const filled = '0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee'
    const exchange = '0xe111180000d2663c0091e4f400237545b87b996b'
    const fillData = '0x' + [0, 42, 400000, 1000000, 10000, 0, 0].map((n) => n.toString(16).padStart(64, '0')).join('')
    const reader = new PolymarketCollateralReader(new URL('https://rpc.example'), async (_url, options) => {
      const request = JSON.parse(String(options?.body))
      const block = { hash, number: '0x200', timestamp: '0x6553f100' }
      const responses: Record<string, unknown> = {
        eth_chainId: '0x89', eth_getBlockByNumber: block, eth_call: '0x' + '6'.padStart(64, '0'),
        eth_getTransactionReceipt: { transactionHash: transaction, blockHash: hash, blockNumber: '0x200', status: '0x1',
          logs: [{ address: polygonPusd, topics: [transfer, topic(from), topic(WALLET)], data: '0x' + (2500000).toString(16).padStart(64, '0'),
            logIndex: '0x7' }, { address: exchange, topics: [filled, '0x' + 'c'.repeat(64), topic(WALLET), topic(from)],
            data: fillData, logIndex: '0x8' }] },
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: responses[request.method] })
    })
    expect(await reader.transferEvidence(WALLET, transaction, NO_ABORT)).toMatchObject({ chainId: 137, blockHash: hash,
      items: [{ id: [137, polygonPusd, transaction, 7].join(':'), amount: '2.500000', asset: 'PUSD', classification: 'unresolved_transfer' }], fills: [{ side: 'buy', instrument: '42', grossCollateral: '0.400000', quantity: '1.000000', fee: '0.010000' }] })
  })

  it('reads exact native pUSD at a pinned finalized Polygon block', async () => {
    const hash = '0x' + 'a'.repeat(64)
    const hex = (value: bigint) => '0x' + value.toString(16).padStart(64, '0')
    let chainId = '0x89'
    const reader = new PolymarketCollateralReader(new URL('https://rpc.example'), async (_url, options) => {
      const query = JSON.parse(String(options?.body))
      let result: unknown = chainId
      if (query.method === 'eth_getBlockByNumber') {
        expect(query.params).toEqual(['finalized', false])
        result = { hash, number: '0x123', timestamp: '0x6553f100' }
      }
      if (query.method === 'eth_call') {
        expect(query.params[0].to).toBe(polygonPusd)
        expect(query.params[1]).toEqual({ blockHash: hash, requireCanonical: true })
        result = query.params[0].data === '0x313ce567' ? hex(6n) : hex(14_523_011n)
      }
      expect(options?.redirect).toBe('error')
      return jsonResponse({ jsonrpc: '2.0', id: 1, result })
    })
    const adapter = new PolymarketAdapter(undefined, reader)
    const request = { externalAccountId: WALLET, streamName: 'polygon_pusd_balance', signal: NO_ABORT, cursor: null, checkpoint: null }
    const page = await adapter.fetchPage(request)
    expect(adapter.normalizePage(page, request.streamName)).toMatchObject([{ kind: 'cash_balance', assetCode: 'PUSD',
      balance: '14.523011', rawPayload: { blockHash: hash, chainId: 137, finality: 'finalized' } }])
    chainId = '0x1'
    await expect(adapter.fetchPage(request)).rejects.toThrow('polymarket_polygon_chain_mismatch')
  })

  it('preserves JSON number lexemes for canonical decimal validation', () => {
    const parsed = parseProviderJson('{"size":0.123456789012345678,"price":1.2300e-2}') as Record<string, unknown>
    expect(parsed.size).toBe('0.123456789012345678')
    expect(parsed.price).toBe('1.2300e-2')
    expect(decimalString('1e999')).toBeNull()
    expect(decimalString('1e-99')).toBeNull()
    expect(decimalString('1.1234567890123456789')).toBeNull()
    expect(decimalString('0.000000000000000001')).toBe('0.000000000000000001')
  })

  it('requests open archived positions and preserves provider state without claiming a complete snapshot', async () => {
    const calls: URL[] = []
    const client = new PolymarketHttpClient(async (input) => {
      const url = new URL(String(input))
      calls.push(url)
      return textResponse('{"data":[{"proxy_wallet":"' + WALLET + '","condition_id":"condition-a","token_id":"101","opposite_token_id":"102","title":"Will it happen?","outcome":"Yes","opposite_outcome":"No","current_size":1.234567890123456789,"avg_price":0.25,"current_price":0.4,"current_value":0.493827156049382716,"realized_pnl":0,"unrealized_pnl":0.18518518318518518,"total_pnl":0.18518518318518518,"entry_cost_usdc":0.3086419725,"entry_fees_usdc":0,"total_cost_usdc":0.3086419725,"total_size":1.234567890123456789,"percent_pnl":60,"status":"REDEEMABLE","redeemable":true,"mergeable":false,"archived":true,"timestamp":1795564800}],"pagination":{"next_cursor":null}}')
    })
    const adapter = new PolymarketAdapter(client)
    const page = await adapter.fetchPage(request('positions'))
    const records = adapter.normalizePage(page, 'positions')
    const position = records.find((record) => record.kind === 'position')

    expect(calls[0]?.pathname).toBe('/v2/positions')
    expect(calls[0]?.searchParams.get('status')).toBe('OPEN')
    expect(calls[0]?.searchParams.get('include_archived')).toBe('true')
    expect(calls[0]?.searchParams.get('filter_amount')).toBe('0')
    expect(position?.kind).toBe('position')
    if (position?.kind !== 'position') throw new Error('position record missing')
    expect(position.quantity).toBe('1.234567890123456789')
    expect(position.providerStatus).toBe('REDEEMABLE')
    expect(position.redeemable).toBe(true)
    expect(position.archived).toBe(true)
    expect(position.providerReported?.currentValue).toBe('0.493827156049382716')
    expect(position.markAt).toBeNull()
    expect(page.coverage.positions?.status).toBe('partial')
  })

  it('refreshes OPEN independently and retains CLOSED as historical evidence', async () => {
    const calls: URL[] = []
    const client = new PolymarketHttpClient(async (input) => {
      const url = new URL(String(input))
      calls.push(url)
      return url.searchParams.get('status') === 'OPEN'
        ? jsonResponse({ data: [], pagination: { next_cursor: null } })
        : jsonResponse({ data: [{ proxy_wallet: WALLET, condition_id: 'condition-a', token_id: '101', current_size: null, status: 'CLOSED' }], pagination: { next_cursor: null } })
    })
    const adapter = new PolymarketAdapter(client)
    const openPage = await adapter.fetchPage(request('positions'))
    expect(openPage.nextCursor).toBeNull()
    const closedPage = await adapter.fetchPage(request('closed_positions'))
    const history = adapter.normalizePage(closedPage, 'closed_positions')
    expect(calls.map((url) => url.searchParams.get('status'))).toEqual(['OPEN', 'CLOSED'])
    expect(history).toMatchObject([{ kind: 'activity_fact', activityType: 'POSITION_CLOSURE' }])
  })

  it('retains invalid position and trade values as unresolved facts instead of publishing them as holdings or fills', async () => {
    const adapter = new PolymarketAdapter(new PolymarketHttpClient(async () => jsonResponse({ data: [] })))
    const positionPage = await adapter.fetchPage(request('positions'))
    positionPage.payload = {
      stream: 'positions',
      positionStatus: 'OPEN',
      rows: [{
        proxy_wallet: WALLET,
        condition_id: 'condition-a',
        token_id: '101',
        current_size: '-2',
        avg_price: '1.2',
        current_price: '0.4',
      }],
      tokenRows: [],
      retrievedAt: '2026-11-25T10:00:00Z',
    }
    const unresolvedPosition = adapter.normalizePage(positionPage, 'positions').find((record) => record.kind === 'activity_fact')
    expect(unresolvedPosition).toMatchObject({
      kind: 'activity_fact', classification: 'unresolved', resolutionReason: 'position_fields_invalid',
      quantity: '-2', sourceEndpoint: 'positions',
    })
    if (unresolvedPosition?.kind === 'activity_fact') {
      expect(unresolvedPosition.rawPayload.avg_price).toBe('1.2')
    }

    const tradePage = {
      payload: {
        stream: 'trades',
        rows: [{ id: 'invalid-price', transaction_hash: '0xinvalid-price', condition_id: 'condition-a', token_id: '101', side: 'BUY', size: '2', price: '1.2', timestamp: 1795564800 }],
        tokenRows: [
          { token_id: '101', opposite_token_id: '102', condition_id: 'condition-a', title: 'Market A', outcome: 'Yes', outcome_index: 0 },
          { token_id: '102', opposite_token_id: '101', condition_id: 'condition-a', title: 'Market A', outcome: 'No', outcome_index: 1 },
        ],
        retrievedAt: '2026-11-25T10:00:00Z',
      },
      nextCursor: null,
      checkpoint: null,
      coverage: { fills: { status: 'partial' as const, coverageStart: null, coverageEnd: null, sourceAsOf: null, reasonCode: 'provider_trade_id_not_exposed' }, markets: { status: 'partial' as const, coverageStart: null, coverageEnd: null, sourceAsOf: null, reasonCode: 'wallet_scoped_market_metadata' } },
      diagnostics: { upstreamRowsReceived: 1 },
    }
    const unresolvedTrade = adapter.normalizePage(tradePage, 'trades').find((record) => record.kind === 'activity_fact')
    expect(unresolvedTrade).toMatchObject({
      kind: 'activity_fact', classification: 'unresolved', resolutionReason: 'trade_fields_invalid',
      activityType: 'TRADE_UNRESOLVED', price: '1.2', sourceEndpoint: 'trades',
    })
    expect(adapter.normalizePage(tradePage, 'trades').some((record) => record.kind === 'fill')).toBe(false)
  })

  it('excludes mismatched account rows, accepts user-scoped rows without an echoed wallet, and retains counters', async () => {
    const client = new PolymarketHttpClient(async () => jsonResponse({
      data: [
        { proxy_wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', condition_id: 'wrong', token_id: '1', current_size: '2' },
        { proxy_wallet: 'malformed', condition_id: 'invalid', token_id: '2', current_size: '2' },
        { proxy_wallet: 123, condition_id: 'non-string-account', token_id: '3', current_size: '2' },
        { condition_id: 'condition-a', token_id: '101', opposite_token_id: '102', title: 'Market A', current_size: '3' },
      ],
      pagination: { next_cursor: null },
    }))
    const adapter = new PolymarketAdapter(client)
    const page = await adapter.fetchPage(request('positions'))
    const records = adapter.normalizePage(page, 'positions')
    expect(records.filter((record) => record.kind === 'position')).toHaveLength(1)
    expect(page.diagnostics).toMatchObject({ upstreamRowsReceived: 4, excludedRecords: 3, sourceRowsRetained: 1, invalidRecords: 0 })
    expect(page.coverage.positions?.reasonCode).toBe('account_identity_mismatch')
  })

  it('pages initial and resumed trade history and creates stable native fill identities', async () => {
    const calls: URL[] = []
    const tokens = [
      { token_id: '101', opposite_token_id: '102', condition_id: 'condition-a', title: 'Market A', outcome: 'Yes', outcome_index: 0, module: 'v1' },
      { token_id: '102', opposite_token_id: '101', condition_id: 'condition-a', title: 'Market A', outcome: 'No', outcome_index: 1, module: 'v1' },
    ]
    const client = new PolymarketHttpClient(async (input) => {
      const url = new URL(String(input))
      calls.push(url)
      if (url.pathname.endsWith('/v2/trades')) {
        return textResponse('{"data":[{"proxy_wallet":"' + WALLET + '","id":"native-fill","transaction_hash":"0xabc","condition_id":"condition-a","token_id":"101","side":"BUY","size":0.123456789012345678,"price":0.4,"timestamp":1795564800,"title":"Market A"}],"pagination":{"next_cursor":null}}')
      }
      const ids = new Set((url.searchParams.get('token_id') ?? '').split(','))
      return jsonResponse({ data: tokens.filter((token) => ids.has(token.token_id)) })
    })
    const adapter = new PolymarketAdapter(client)
    const firstPage = await adapter.fetchPage(request('trades'))
    const records = adapter.normalizePage(firstPage, 'trades')
    const fill = records.find((record) => record.kind === 'fill')
    const repeated = adapter.normalizePage(firstPage, 'trades').find((record) => record.kind === 'fill')
    const resumePage = await adapter.fetchPage(request('trades', {
      cursor: 'cursor-2',
      checkpoint: JSON.stringify({ start: 1, end: 1_795_564_800 }),
    }))

    expect(calls[0]?.searchParams.get('start')).toBe('1')
    expect(calls[0]?.searchParams.get('taker_only')).toBe('false')
    expect(fill?.kind).toBe('fill')
    if (fill?.kind !== 'fill') throw new Error('fill record missing')
    expect(fill.quantity).toBe('0.123456789012345678')
    expect(fill.feeAmount).toBeNull()
    expect(fill.feeStatus).toBe('unavailable')
    expect(fill.externalId).toBe(repeated?.kind === 'fill' ? repeated.externalId : null)
    const resumedTradesCall = calls.find((url) => url.pathname.endsWith('/v2/trades') && url.searchParams.has('cursor'))
    expect(resumedTradesCall?.searchParams.get('cursor')).toBe('cursor-2')
    expect(resumedTradesCall?.searchParams.get('start')).toBe('1')
    expect(resumePage.nextCursor).toBeNull()
    expect(firstPage.coverage.fills?.reasonCode).toBe('provider_trade_id_not_exposed')
  })

  it('retains trade observations when token metadata is missing and groups indistinguishable same-transaction observations', async () => {
    const tradeRow = { transaction_hash: '0xabc', condition_id: 'condition-a', token_id: '999', side: 'BUY', size: '2', price: '0.25', timestamp: 1795564800 }
    const client = new PolymarketHttpClient(async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/v2/trades')) return jsonResponse({ data: [tradeRow, tradeRow], pagination: { next_cursor: null } })
      return jsonResponse({ data: [] })
    })
    const adapter = new PolymarketAdapter(client)
    const page = await adapter.fetchPage(request('trades'))
    const facts = adapter.normalizePage(page, 'trades').filter((record) => record.kind === 'activity_fact')
    expect(facts).toHaveLength(2)
    expect(facts.map((fact) => fact.kind === 'activity_fact' ? fact.resolutionReason : null)).toEqual([
      'token_metadata_missing', 'token_metadata_missing',
    ])
    expect(facts.map((fact) => fact.kind === 'activity_fact' ? fact.quantity : null)).toEqual(['2', '2'])
    expect(facts[0]?.kind === 'activity_fact' && facts[1]?.kind === 'activity_fact'
      ? facts[0].externalId === facts[1].externalId
      : false).toBe(true)
  })

  it('maps deposits and withdrawals as signed cash flows while keeping other account events unreconciled', async () => {
    const client = new PolymarketHttpClient(async () => jsonResponse({
      data: [
        { id: 'deposit-confirmed', type: 'DEPOSIT', transaction_hash: '0x01', proxy_wallet: WALLET, timestamp: 1795564800, usdc_size: '10.25' },
        { id: 'withdrawal-confirmed', type: 'WITHDRAWAL', transaction_hash: '0x02', proxy_wallet: WALLET, timestamp: 1795564801, usdc_size: '3' },
        { type: 'WITHDRAWAL', transaction_hash: '0x07', proxy_wallet: WALLET, timestamp: 1795564801, usdc_size: '5' },
        { type: 'WITHDRAWAL', transaction_hash: '0x07', proxy_wallet: WALLET, timestamp: 1795564801, usdc_size: '6' },
        { type: 'REDEEM', transaction_hash: '0x03', proxy_wallet: WALLET, timestamp: 1795564802, condition_id: 'condition-a', token_id: '101', size: '4', usdc_size: '4' },
        { type: 'MERGE', transaction_hash: '0x04', proxy_wallet: WALLET, timestamp: 1795564803, size: '2' },
        { type: 'TRADE', transaction_hash: '0x05', proxy_wallet: WALLET, timestamp: 1795564804, size: '1', is_combo: false },
        { type: 'TRADE', transaction_hash: '0x06', proxy_wallet: WALLET, timestamp: 1795564805, size: '1', is_combo: true },
      ],
      pagination: { next_cursor: null },
    }))
    const adapter = new PolymarketAdapter(client)
    const page = await adapter.fetchPage(request('activity'))
    const records = adapter.normalizePage(page, 'activity')
    const cash = records.filter((record) => record.kind === 'cash_movement')
    const facts = records.filter((record) => record.kind === 'activity_fact')

    expect(cash).toHaveLength(2)
    expect(cash.map((record) => record.kind === 'cash_movement' ? record.signedAmount : null)).toEqual(['10.25', '-3'])
    expect(facts.map((record) => record.kind === 'activity_fact' ? record.activityType : null)).toEqual(['WITHDRAWAL', 'WITHDRAWAL', 'REDEEM', 'MERGE', 'TRADE', 'TRADE'])
    expect(facts.slice(0, 2)).toMatchObject([
      { amount: '-5', resolutionReason: 'cash_movement_identity_ambiguous' },
      { amount: '-6', resolutionReason: 'cash_movement_identity_ambiguous' },
    ])
    expect(facts.filter((record) => record.kind === 'activity_fact' && record.classification === 'overlap_candidate')).toHaveLength(2)
    expect(page.coverage.activity?.status).toBe('partial')
    expect(page.coverage.cash_movements?.status).toBe('partial')
  })

  it('rejects invalid wallet identifiers and surfaces Retry-After without exposing response bodies', async () => {
    const adapter = new PolymarketAdapter(new PolymarketHttpClient(async () => new Response('provider internals', {
      status: 429,
      headers: { 'retry-after': '2' },
    })))
    await expect(adapter.fetchPage(request('positions', { externalAccountId: 'not-an-address' }))).rejects.toMatchObject({ code: 'invalid_polymarket_wallet_address' })
    await expect(adapter.fetchPage(request('positions'))).rejects.toMatchObject({ code: 'polymarket_rate_limited', retryAfterMs: 2_000 })
  })
})

describe('Polymarket public market data', () => {
  it('searches events, preserves multi-outcome identities and distinguishes missing batch prices', async () => {
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = []
    const marketRows = Array.from({ length: 50 }, (_, marketIndex) => ({
      id: `market-${marketIndex}`,
      version: 'v1',
      slug: `market-${marketIndex}`,
      conditionId: `condition-${marketIndex}`,
      question: `Question ${marketIndex}`,
      outcomes: JSON.stringify(Array.from({ length: 11 }, (_, i) => `Outcome ${i}`)),
      clobTokenIds: JSON.stringify(Array.from({ length: 11 }, (_, i) => `${marketIndex * 11 + i + 1}`)),
      closed: false,
      active: true,
      negRisk: marketIndex === 0,
      description: 'Provider market description',
      feesEnabled: marketIndex === 0 || marketIndex === 2,
      feeSchedule: marketIndex === 0
        ? { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 }
        : marketIndex === 2 ? { rate: -0.05, exponent: -1, takerOnly: true, rebateRate: 1.5 } : null,
    }))
    const client = new PolymarketHttpClient(async (input, init) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      if (url.pathname.endsWith('/public-search')) {
        return jsonResponse({ events: [{ id: 'event-1', slug: 'event-one', title: 'Event One' }], profiles: [{ id: 'profile-1' }], pagination: { hasMore: false, totalResults: 1 } })
      }
      if (url.pathname.endsWith('/events/slug/event-one')) {
        return jsonResponse({ id: 'event-1', slug: 'event-one', title: 'Event One', active: true, markets: marketRows })
      }
      const body = JSON.parse(String(init?.body)) as Array<{ token_id: string }>
      expect(body).toHaveLength(500)
      return jsonResponse(Object.fromEntries(body.map(({ token_id }) => [token_id, '0.4200'])))
    })
    const service = new PolymarketMarketDataService(client)
    const result = await service.search('event one', 5, 2)
    const resultItems = result.items as Array<Record<string, unknown>>
    const firstEvent = resultItems[0]!
    const markets = firstEvent.markets as Array<Record<string, unknown>>
    const outcomes = markets[0]!.outcomes as Array<Record<string, unknown>>
    const lastOutcomes = markets[49]!.outcomes as Array<Record<string, unknown>>

    expect(calls.map(({ url }) => url.hostname)).toEqual(['gamma-api.polymarket.com', 'gamma-api.polymarket.com', 'clob.polymarket.com'])
    expect(markets).toHaveLength(50)
    expect(markets[0]?.negativeRisk).toBe(true)
    expect(markets[0]?.feeMetadata).toMatchObject({ status: 'known', rate: '0.05', exponent: 1, takerOnly: true, amountUnit: 'USDC' })
    expect(markets[1]?.feeMetadata).toMatchObject({ status: 'fee_free', enabled: false })
    expect(markets[2]?.feeMetadata).toMatchObject({ status: 'incomplete', rate: null, exponent: null, rebateRate: null })
    expect(outcomes).toHaveLength(11)
    expect(outcomes[0]?.assetId).toBe('1')
    expect(outcomes[0]?.assetIdType).toBe('clob_token_id')
    expect(outcomes[0]?.referencePrice).toMatchObject({ value: '0.42', sourceTimestamp: null })
    expect(lastOutcomes[10]?.referencePrice).toMatchObject({ value: null, freshness: 'not_requested_due_to_batch_limit' })
    expect(calls[0]?.url.searchParams.get('page')).toBe('2')
    expect(result.pagination).toMatchObject({ page: 2, pageSize: 5, hasMore: false, continuationAvailable: false })
  })

  it('resolves supported event links with all candidate markets and rejects SSRF-style inputs before fetching', async () => {
    let requestCount = 0
    const service = new PolymarketMarketDataService(new PolymarketHttpClient(async (input) => {
      requestCount += 1
      const url = new URL(String(input))
      if (url.pathname.endsWith('/events/slug/event-one')) {
        return jsonResponse({
          id: 'event-1', slug: 'event-one', title: 'Event One', active: true,
          markets: [
            { id: 'm1', slug: 'market-one', conditionId: 'c1', question: 'First?', outcomes: '["A","B"]', clobTokenIds: '["11","12"]', active: true },
            { id: 'm2', slug: 'market-two', conditionId: 'c2', question: 'Second?', outcomes: '["C","D"]', clobTokenIds: '["21","22"]', active: true },
          ],
        })
      }
      return jsonResponse({ '11': '0.5', '12': '0.5', '21': '0.3', '22': '0.7' })
    }))
    const resolved = await service.resolve('https://www.polymarket.com/event/event-one?utm_source=share&ref=invite')
    const item = resolved.item as Record<string, unknown>
    expect(resolved.resolvedAs).toBe('event')
    expect((item.markets as unknown[])).toHaveLength(2)
    expect(supportedPolymarketUrl('https://polymarket.com/market/market-one').kind).toBe('market')

    for (const unsafe of [
      'http://polymarket.com/event/event-one',
      'https://polymarket.com.evil.test/event/event-one',
      'https://user@polymarket.com/event/event-one',
      'https://polymarket.com:8443/event/event-one',
      'https://polymarket.com/event/event-one?redirect=http://127.0.0.1',
      'https://127.0.0.1/event/event-one',
    ]) {
      expect(() => supportedPolymarketUrl(unsafe)).toThrow()
    }
    await expect(service.resolve('https://polymarket.com@127.0.0.1/event/evil')).rejects.toMatchObject({ httpStatus: 400 })
    expect(resolved.sourceUrl).toBe('https://polymarket.com/event/event-one')
    expect(requestCount).toBe(1)
  })

  it('returns historical source timestamps and refuses automatic redirects', async () => {
    const urls: URL[] = []
    const service = new PolymarketMarketDataService(new PolymarketHttpClient(async (input) => {
      const url = new URL(String(input))
      urls.push(url)
      return textResponse('{"data":[{"timestamp":1795564800,"price":0.123456789012345678,"resolution_seconds":3600},{"timestamp":1795564801,"price":2,"resolution_seconds":3600}],"pagination":{"next_cursor":"next"}}')
    }))
    const result = await service.priceHistory({ tokenId: '123', interval: '1w', bucketSeconds: 3600 })
    const items = result.items as Array<Record<string, unknown>>
    expect(urls[0]?.pathname).toBe('/v2/prices-history')
    expect(urls[0]?.searchParams.get('bucket_seconds')).toBe('3600')
    expect(items[0]).toMatchObject({ price: '0.123456789012345678', timestampBasis: 'provider_observation', resolutionSeconds: 3600 })
    expect(result.nextCursor).toBe('next')
    expect(result).toMatchObject({ invalidPointCount: 1, complete: false })

    const redirectingClient = new PolymarketHttpClient(async (_input, init) => {
      expect(init?.redirect).toBe('error')
      throw new TypeError('redirect rejected')
    })
    await expect(redirectingClient.getData('positions', new URLSearchParams())).rejects.toMatchObject({ code: 'polymarket_upstream_unavailable' })
  })
})

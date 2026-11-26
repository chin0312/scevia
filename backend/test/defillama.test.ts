import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../src/db/client.js'
import { archiveDefillama, refreshDefillama, sampleDefillama } from '../src/fx/defillama.js'
import { defillamaContracts, defillamaSource, referenceInput, selectRate } from '../src/fx/reference.js'

const pUSD = 'polygon:' + defillamaContracts.PUSD
const USDC = 'polygon:' + defillamaContracts.USDC
const bridged = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const timestamp = 1793059200
const point = { timestamp, decimals: 6, confidence: 0.99, price: 0.999 }
const response = (coins: object) => new Response(JSON.stringify({ coins }))

function database() {
  const values = vi.fn(() => ({ onConflictDoNothing: vi.fn() }))
  const db = { insert: vi.fn(() => ({ values })) } as unknown as Pick<Database, 'insert'>
  return { db, values }
}

describe('DefiLlama FX acquisition', () => {
  it('binds observations to exact contract keys and keeps original clocks', async () => {
    const { db, values } = database()
    const transport = vi.fn(async () => response({
      [pUSD]: { ...point, symbol: 'irrelevant' },
      [USDC]: point,
      ['polygon:' + bridged]: point,
    }))
    const result = await refreshDefillama(db, new AbortController().signal, transport)
    expect(result.processed).toBe(2)
    for (const asset of ['USDC', 'PUSD'] as const) {
      expect(values).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({
        base: asset, source: defillamaSource[asset], quote: 'USD', rate: '0.999',
        observedAt: new Date(timestamp * 1000), retrievedAt: expect.any(Date),
        tokenIdentity: { chain: 'polygon-pos', contract: defillamaContracts[asset], quoteBasis: 'vendor_aggregated_fiat_usd' },
      })]))
    }
  })

  it('reports omitted or unsupported assets and skips low confidence or future-at-cutoff prices', async () => {
    const { db, values } = database()
    const signal = new AbortController().signal
    const empty = await sampleDefillama(db, signal, timestamp, async () => response({
      ['polygon:' + bridged]: point, [pUSD]: { ...point, decimals: 18 },
    }))
    expect(empty.coverage.map(({ status }) => status)).toEqual(['missing', 'unsupported'])
    const ineligible = await sampleDefillama(db, signal, timestamp, async () => response({
      [USDC]: { ...point, timestamp: timestamp + 1 }, [pUSD]: { ...point, confidence: 0.94 },
    }))
    expect(ineligible.coverage.map(({ status }) => status)).toEqual(['ineligible', 'ineligible'])
    expect(values).not.toHaveBeenCalled()
  })

  it('splits annual chart requests at the service limit and surfaces rate limiting without retrying', async () => {
    const { db, values } = database()
    const signal = new AbortController().signal
    const transport = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const query = new URL(String(input)).searchParams
      const at = Number(query.get('end'))
      return response({ [pUSD]: { decimals: 6, confidence: 0.99, prices: [
        { timestamp: at, price: 1 }, { timestamp: at, price: 1 }, { timestamp: timestamp + 1, price: 1 },
      ] } })
    })
    const result = await archiveDefillama(db, signal, 365, transport, timestamp)
    expect(result.windows.map(({ span }) => span)).toEqual([250, 115])
    expect(result.processed).toBe(2)
    expect(values).toHaveBeenCalledTimes(2)
    const limit = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '10' } }))
    await expect(refreshDefillama(db, signal, limit)).rejects.toMatchObject({ message: 'defillama_rate_limit', retryAfter: '10' })
    expect(limit).toHaveBeenCalledTimes(1)
  })

  it('rejects incorrect token identities at ingest and selection and falls back to eligible evidence', () => {
    const observedAt = '2026-11-24T12:00:00.000Z'
    const retrievedAt = '2026-11-25T12:00:00.000Z'
    const rate = { base: 'USDC', quote: 'USD', source: defillamaSource.USDC, methodology: 'stablecoin_market_reference',
      rate: '0.99', observedAt, retrievedAt, tokenIdentity: { chain: 'polygon-pos',
        contract: defillamaContracts.USDC, quoteBasis: 'vendor_aggregated_fiat_usd' } }
    const invalid = { ...rate, tokenIdentity: { ...rate.tokenIdentity, contract: bridged } }
    expect(referenceInput.safeParse(rate).success).toBe(true)
    for (const input of [invalid, { ...rate, tokenIdentity: undefined }, { ...rate, base: 'PUSD' }]) {
      expect(referenceInput.safeParse(input).success).toBe(false)
    }
    const row = { ...rate, revision: 'defi', observedAt: new Date(observedAt), retrievedAt: new Date(retrievedAt) }
    expect(selectRate([{ ...row, tokenIdentity: invalid.tokenIdentity }], 'USDC', 'USD', retrievedAt).rate).toBeNull()
    expect(selectRate([row], 'USDC', 'USD', '2026-11-24T17:00:00Z').rate).toBeNull()
    expect(selectRate([row], 'USDC', 'USD', '2026-11-24T17:00:00Z', { mode: 'retrospective' }).rate).toBe('0.99')
    const staleAt = '2026-11-25T14:01:00Z'
    expect(selectRate([row], 'USDC', 'USD', staleAt)).toMatchObject({ rate: null, availability: 'stale' })
    const kraken = { ...row, source: 'kraken_usdc_usd_ohlc', tokenIdentity: null, revision: 'kraken',
      rate: '1.001', observedAt: new Date(retrievedAt) }
    expect(selectRate([row, kraken], 'USDC', 'USD', staleAt)).toMatchObject({ rate: '1.001', legs: [{ revision: 'kraken' }] })
    expect(selectRate([row], 'USDC', 'USD', retrievedAt, { stablecoinSource: kraken.source }).fallback).toBe(true)
  })
})

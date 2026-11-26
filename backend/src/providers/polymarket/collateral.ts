import { z } from 'zod'
import { ProviderAdapterError } from '../adapter.js'
import { normalizedRecordSchema } from '../../domain/model.js'

export const polygonPusd = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb'
const word = z.string().regex(/^0x[0-9a-f]{64}$/i)
const quantity = z.string().regex(/^0x[0-9a-f]{1,16}$/i)
const address = /^0x[0-9a-f]{40}$/i

export class PolymarketCollateralReader {
  constructor(private readonly endpoint: URL, private readonly transport: typeof fetch = fetch) {}

  private async read(method: 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_call', params: unknown[], signal: AbortSignal) {
    let response: Response
    try {
      response = await this.transport(this.endpoint, { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    } catch {
      throw new ProviderAdapterError('polymarket_polygon_transport_failed', true)
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {})
      throw new ProviderAdapterError('polymarket_polygon_response_unavailable', response.status === 429 || response.status >= 500)
    }
    const reader = response.body.getReader()
    try {
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 64_000) throw new Error('response size')
        chunks.push(value)
      }
      return z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown(), error: z.never().optional() })
        .parse(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))).result
    } catch {
      throw new ProviderAdapterError('polymarket_polygon_invalid_response', false)
    } finally {
      void reader.cancel().catch(() => {})
    }
  }

  async balance(wallet: string, signal: AbortSignal) {
    if (!address.test(wallet)) throw new ProviderAdapterError('invalid_polymarket_wallet_address', false)
    const chain = quantity.safeParse(await this.read('eth_chainId', [], signal))
    if (!chain.success || BigInt(chain.data) !== 137n) throw new ProviderAdapterError('polymarket_polygon_chain_mismatch', false)
    const block = z.object({ hash: word, number: quantity, timestamp: quantity }).parse(
      await this.read('eth_getBlockByNumber', ['finalized', false], signal))
    const blockReference = { blockHash: block.hash, requireCanonical: true }
    const call = (data: string) => this.read('eth_call', [{ to: polygonPusd, data }, blockReference], signal)
    const [decimals, amount] = await Promise.all([call('0x313ce567'), call('0x70a08231' + wallet.slice(2).toLowerCase().padStart(64, '0'))])
    if (BigInt(word.parse(decimals)) !== 6n) throw new ProviderAdapterError('polymarket_pusd_decimals_mismatch', false)
    const units = BigInt(word.parse(amount))
    const value = (units / 1_000_000n).toString() + '.' + (units % 1_000_000n).toString().padStart(6, '0')
    const seconds = BigInt(block.timestamp)
    if (seconds <= 0n || seconds > BigInt(Math.floor(Date.now() / 1000))) {
      throw new ProviderAdapterError('polymarket_polygon_block_time_invalid', false)
    }
    const observedAt = new Date(Number(seconds) * 1000).toISOString()
    return normalizedRecordSchema.parse({ kind: 'cash_balance', externalId: 'polygon:' + polygonPusd, observedAt,
      balance: value, assetCode: 'PUSD', rawPayload: { chainId: 137, contract: polygonPusd, blockHash: block.hash,
        blockNumber: block.number, wallet: wallet.toLowerCase(), units: units.toString(), finality: 'finalized' } })
  }
}

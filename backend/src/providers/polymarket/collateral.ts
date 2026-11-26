import { z } from 'zod'
import { ProviderAdapterError } from '../adapter.js'
import { normalizedRecordSchema } from '../../domain/model.js'

export const polygonPusd = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb'
// CTF Exchange V2 deployments documented by Polymarket. Other exchange generations use different events.
export const polygonCtfV2 = new Set(['0xe111180000d2663c0091e4f400237545b87b996b', '0xe2222d279d744050d28e00520010520000310f59'])
const orderFilled = '0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee'
const indexedAddress = /^0x0{24}[0-9a-f]{40}$/i
const word = z.string().regex(/^0x[0-9a-f]{64}$/i)
const quantity = z.string().regex(/^0x[0-9a-f]{1,16}$/i)
const address = /^0x[0-9a-f]{40}$/i

export class PolymarketCollateralReader {
  constructor(private readonly endpoint: URL, private readonly transport: typeof fetch = fetch) {}

  private async read(method: 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getTransactionReceipt' | 'eth_call', params: unknown[], signal: AbortSignal) {
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

  async transferEvidence(wallet: string, transaction: string, signal: AbortSignal) {
    if (!address.test(wallet) || !word.safeParse(transaction).success) {
      throw new ProviderAdapterError('polymarket_polygon_invalid_evidence_scope', false)
    }
    const blockSchema = z.object({ hash: word, number: quantity, timestamp: quantity })
    const chain = quantity.safeParse(await this.read('eth_chainId', [], signal))
    if (!chain.success || BigInt(chain.data) !== 137n) throw new ProviderAdapterError('polymarket_polygon_chain_mismatch', false)
    const finalized = blockSchema.parse(await this.read('eth_getBlockByNumber', ['finalized', false], signal))
    const receipt = z.object({ transactionHash: word, blockNumber: quantity, blockHash: word, status: quantity,
      logs: z.array(z.object({ address: z.string(), topics: z.array(word).max(4), data: z.string(),
        logIndex: quantity, removed: z.boolean().optional() })).max(400),
    }).parse(await this.read('eth_getTransactionReceipt', [transaction], signal))
    if (receipt.transactionHash.toLowerCase() !== transaction.toLowerCase() || BigInt(receipt.blockNumber) > BigInt(finalized.number)
      || BigInt(receipt.status) !== 1n) throw new ProviderAdapterError('polymarket_polygon_receipt_unverified', false)
    const canonical = blockSchema.parse(await this.read('eth_getBlockByNumber', [receipt.blockNumber, false], signal))
    if (canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() || BigInt(canonical.number) !== BigInt(receipt.blockNumber)) {
      throw new ProviderAdapterError('polymarket_polygon_receipt_unverified', false)
    }
    const blockReference = { blockHash: canonical.hash, requireCanonical: true }
    const decimals = word.parse(await this.read('eth_call', [{ to: polygonPusd, data: '0x313ce567' }, blockReference], signal))
    if (BigInt(decimals) !== 6n) throw new ProviderAdapterError('polymarket_pusd_decimals_mismatch', false)
    const normalizedWallet = wallet.toLowerCase()
    const transferEvent = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const observedAt = blockTime(canonical.timestamp)
    const items = receipt.logs.flatMap((log) => {
      if (log.removed || log.address.toLowerCase() !== polygonPusd || log.topics.length !== 3
        || log.topics[0]?.toLowerCase() !== transferEvent || !word.safeParse(log.data).success) return []
      if (!indexedAddress.test(log.topics[1]!) || !indexedAddress.test(log.topics[2]!)) return []
      const from = '0x' + log.topics[1]!.slice(-40).toLowerCase()
      const to = '0x' + log.topics[2]!.slice(-40).toLowerCase()
      if (from !== normalizedWallet && to !== normalizedWallet) return []
      const logIndex = BigInt(log.logIndex).toString()
      return [{ id: ['137', polygonPusd, receipt.transactionHash.toLowerCase(), logIndex].join(':'),
        logIndex, from, to, amount: pusdAmount(BigInt(log.data)), asset: 'PUSD' as const, classification: 'unresolved_transfer' as const }]
    })
    const fills = receipt.logs.flatMap((log) => {
      const exchange = log.address.toLowerCase()
      if (log.removed || !polygonCtfV2.has(exchange) || log.topics.length !== 4 || log.topics[0]?.toLowerCase() !== orderFilled
        || !indexedAddress.test(log.topics[2]!) || '0x' + log.topics[2]!.slice(-40).toLowerCase() !== normalizedWallet
        || !/^0x[0-9a-f]{448}$/i.test(log.data)) return []
      const words = log.data.slice(2).match(/.{64}/g)!.map((value) => BigInt('0x' + value))
      const [side, token, makerAmount, takerAmount, fee] = words as [bigint, bigint, bigint, bigint, bigint]
      if ((side !== 0n && side !== 1n) || token === 0n || makerAmount === 0n || takerAmount === 0n) return []
      const buy = side === 0n
      const gross = buy ? makerAmount : takerAmount
      if (!buy && fee > gross) return []
      const logIndex = BigInt(log.logIndex).toString()
      return [{ id: ['137', exchange, receipt.transactionHash.toLowerCase(), logIndex].join(':'),
        exchange, logIndex, orderHash: log.topics[1]!, instrument: token.toString(), side: buy ? 'buy' as const : 'sell' as const,
        grossCollateral: pusdAmount(gross), quantity: pusdAmount(buy ? takerAmount : makerAmount),
        fee: pusdAmount(fee), asset: 'PUSD' as const, classification: 'ctf_v2_order_fill' as const }]
    })
    const ids = [...items, ...fills].map((item) => item.id)
    if (new Set(ids).size !== ids.length) {
      throw new ProviderAdapterError('polymarket_polygon_duplicate_log', false)
    }
    return { chainId: 137, wallet: normalizedWallet, contract: polygonPusd,
      transactionHash: receipt.transactionHash, blockHash: canonical.hash, blockNumber: canonical.number, observedAt, items, fills }
  }

  async standardCtfResolution(condition: string, positions: readonly string[], signal: AbortSignal) {
    if (!word.safeParse(condition).success || positions.length !== 2 || new Set(positions).size !== 2
      || positions.some((token) => !/^\d{1,78}$/.test(token))) return null
    const chain = quantity.parse(await this.read('eth_chainId', [], signal))
    if (BigInt(chain) !== 137n) throw new ProviderAdapterError('polymarket_polygon_chain_mismatch', false)
    const block = z.object({ hash: word, number: quantity, timestamp: quantity })
      .parse(await this.read('eth_getBlockByNumber', ['finalized', false], signal))
    const ctf = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'
    const legacyCollateral = '2791bca1f2de4661ed88a30c99a7a9449aa84174'
    const arg = condition.slice(2)
    const uint = (value: number) => value.toString(16).padStart(64, '0')
    const call = async (data: string) => word.parse(await this.read('eth_call',
      [{ to: ctf, data: '0x' + data }, { blockHash: block.hash, requireCanonical: true }], signal))
    const [slots, denominator] = await Promise.all([call('d42dc0c2' + arg), call('dd34de67' + arg)])
    if (BigInt(slots) !== 2n || BigInt(denominator) <= 0n) return null
    const [first, second] = await Promise.all([call('0504c814' + arg + uint(0)), call('0504c814' + arg + uint(1))])
    const payout = BigInt(denominator)
    const winningIndex = BigInt(first) === payout && BigInt(second) === 0n ? 0 : BigInt(first) === 0n && BigInt(second) === payout ? 1 : -1
    if (winningIndex < 0) return null
    const ids = await Promise.all([1, 2].map(async (indexSet) => {
      const collection = await call('856296f7' + uint(0) + arg + uint(indexSet))
      return BigInt(await call('39dd7530' + legacyCollateral.padStart(64, '0') + collection.slice(2))).toString()
    }))
    if (ids.some((id, index) => id !== positions[index])) return null
    return { knownAt: new Date().toISOString(), winningInstrument: ids[winningIndex]!, unitPayout: '1' as const,
      source: 'polygon_ctf' as const, finalizedBlockHash: block.hash, finalizedBlockAt: blockTime(block.timestamp), settlementTime: null }
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
    const value = pusdAmount(units)
    const observedAt = blockTime(block.timestamp)
    return normalizedRecordSchema.parse({ kind: 'cash_balance', externalId: 'polygon:' + polygonPusd, observedAt,
      balance: value, assetCode: 'PUSD', rawPayload: { chainId: 137, contract: polygonPusd, blockHash: block.hash,
        blockNumber: block.number, wallet: wallet.toLowerCase(), units: units.toString(), finality: 'finalized' } })
  }
}

function pusdAmount(units: bigint) {
  return (units / 1_000_000n).toString() + '.' + (units % 1_000_000n).toString().padStart(6, '0')
}

function blockTime(value: string) {
  const seconds = BigInt(value)
  if (seconds <= 0n || seconds > BigInt(Math.floor(Date.now() / 1000))) {
    throw new ProviderAdapterError('polymarket_polygon_block_time_invalid', false)
  }
  return new Date(Number(seconds) * 1000).toISOString()
}

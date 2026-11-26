import { strict as assert } from 'node:assert'
import { z } from 'zod'
import { polygonPusd } from '../src/providers/polymarket/collateral.js'

if (process.argv.length !== 3 || process.argv[2] !== '--confirm-public-rpc-evaluation') {
  throw new Error('Pass --confirm-public-rpc-evaluation for the bounded public Polygon deployment and receipt checks')
}

const manager = '0x006f54f7f9a22e0000cc2ab60031000000ae9fef'
const implementation = '0xcc5de1e9d14a7ab75e872e23fc9d605518bac2d0'
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const pusdPool = '0xef2406f844d59ec4a0fc55357ad4318729ea0567'
const bridgedUsdc = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const usdcPool = '0xb6e57ed85c4c9dbfef2a68711e9d6f36c56e0fcb'
const swapTransaction = '0xb19e424a37e773de61d5d13482fb1afa653e97ba3b8aee5ef0583feb880b4556'
const swapTopic = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const hex = z.string().regex(/^0x[0-9a-f]+$/i)
const block = z.object({ number: hex, hash: hex, timestamp: hex })
type Method = 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getCode' | 'eth_getStorageAt' | 'eth_call' | 'eth_getTransactionReceipt'

async function rpc(method: Method, params: unknown[] = []) {
  const response = await fetch('https://polygon-bor-rpc.publicnode.com', { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  assert.equal(response.status, 200, method)
  const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown() }).parse(await response.json())
  assert(envelope.result !== undefined && envelope.result !== null, method + ' returned no result')
  return envelope.result
}

assert.equal(await rpc('eth_chainId'), '0x89')
const finalized = block.parse(await rpc('eth_getBlockByNumber', ['finalized', false]))
const proxySlot = hex.parse(await rpc('eth_getStorageAt', [manager, implementationSlot, finalized.number]))
assert.equal('0x' + proxySlot.slice(-40).toLowerCase(), implementation)
const code = hex.parse(await rpc('eth_getCode', [implementation, finalized.number]))
const view = async (to: string, data: string) => hex.parse(await rpc('eth_call', [{ to, data }, finalized.number]))
const decimals = Number(BigInt(await view(polygonPusd, '0x313ce567')))
assert.equal(decimals, 6)
const token0 = '0x' + (await view(pusdPool, '0x0dfe1681')).slice(-40).toLowerCase()
const token1 = '0x' + (await view(pusdPool, '0xd21220a7')).slice(-40).toLowerCase()
assert.deepEqual([token0, token1], [bridgedUsdc, polygonPusd])

const receipt = z.object({ transactionHash: hex, blockNumber: hex, blockHash: hex, status: z.literal('0x1'),
  logs: z.array(z.object({ address: hex, topics: z.array(hex), logIndex: hex })) })
  .parse(await rpc('eth_getTransactionReceipt', [swapTransaction]))
const receiptBlock = block.parse(await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]))
assert.equal(receipt.transactionHash, swapTransaction)
assert.equal(receipt.blockHash, receiptBlock.hash)
assert(BigInt(receipt.blockNumber) <= BigInt(finalized.number))
const swap = receipt.logs.find((log) => log.address === usdcPool && log.topics[0] === swapTopic)
assert(swap, 'Expected a Uniswap swap in the finalized public reference receipt')
process.stdout.write(JSON.stringify({ chainId: 137, finalized, manager, implementation, implementationBytes: (code.length - 2) / 2,
  pusd: { contract: polygonPusd, decimals, pool: pusdPool, token0, token1 },
  publicSwapReceipt: { transaction: swapTransaction, block: receipt.blockNumber, logIndex: swap.logIndex },
}, null, 2) + '\n')

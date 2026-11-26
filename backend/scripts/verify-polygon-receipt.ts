import { loadConfig } from '../src/config.js'
import { PolymarketCollateralReader } from '../src/providers/polymarket/collateral.js'

const [, , wallet, transaction] = process.argv
const config = loadConfig()
if (!config.polymarketPolygonRpc || !wallet || !transaction) {
  throw new Error('Enable authorized Polygon access and supply an approved wallet and transaction hash')
}
const reader = new PolymarketCollateralReader(config.polymarketPolygonRpc)
const evidence = await reader.transferEvidence(wallet, transaction, AbortSignal.timeout(15000))
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')

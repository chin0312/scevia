import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { archivePusd } from '../src/fx/coingecko.js'
import { archiveDefillama, refreshDefillama } from '../src/fx/defillama.js'
import { refreshEcb, refreshEcbAnnual } from '../src/fx/ecb.js'
import { refreshUsdc } from '../src/fx/kraken.js'

const [, , source, argument] = process.argv
if (process.argv.length > (source === 'defillama' ? 4 : 3)) throw new Error('Unexpected archive arguments')
const config = loadConfig()
const defillamaAuthorized = config.nodeEnv === 'development' && ['127.0.0.1', '::1'].includes(config.host)
  && process.env.DEFILLAMA_FX_ACQUISITION_AUTHORIZED === 'YES'
const pusdKey = config.coingeckoPusdKey
const fetchArchive = source === 'ecb' && config.ecbReferenceAuthorized ? refreshEcb
  : source === 'ecb-annual' && config.ecbReferenceAuthorized ? refreshEcbAnnual
  : source === 'defillama-current' && defillamaAuthorized ? refreshDefillama
  : source === 'defillama' && defillamaAuthorized ? (db: Parameters<typeof archiveDefillama>[0], signal: AbortSignal) =>
    archiveDefillama(db, signal, argument === undefined ? 90 : Number(argument))
  : source === 'kraken' && config.krakenFxAuthorized ? refreshUsdc
  : source === 'coingecko-pusd' && pusdKey ? (db: Parameters<typeof archivePusd>[0], signal: AbortSignal) => archivePusd(db, pusdKey, signal)
  : null
if (!fetchArchive || process.env.FX_ARCHIVE_AUTHORIZED !== 'YES') throw new Error('Select and explicitly authorize the FX archive source')
const { database, pool } = createDatabase(config)
try {
  const result = await fetchArchive(database, AbortSignal.timeout(20_000), fetch, true)
  process.stdout.write(JSON.stringify({ source, status: 'completed', ...(source?.startsWith('defillama') ? { result } : {}) }) + '\n')
} finally { await pool.end() }

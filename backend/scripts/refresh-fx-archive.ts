import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { archivePusd } from '../src/fx/coingecko.js'
import { refreshEcb } from '../src/fx/ecb.js'
import { refreshUsdc } from '../src/fx/kraken.js'

const source = process.argv[2]
const config = loadConfig()
const pusdKey = config.coingeckoPusdKey
const fetchArchive = source === 'ecb' && config.ecbReferenceAuthorized ? refreshEcb
  : source === 'kraken' && config.krakenFxAuthorized ? refreshUsdc
  : source === 'coingecko-pusd' && pusdKey ? (db: Parameters<typeof archivePusd>[0], signal: AbortSignal) => archivePusd(db, pusdKey, signal)
  : null
if (!fetchArchive || process.env.FX_ARCHIVE_AUTHORIZED !== 'YES') throw new Error('Select and explicitly authorize the FX archive source')
const { database, pool } = createDatabase(config)
try {
  await fetchArchive(database, AbortSignal.timeout(12_000), fetch, true)
  process.stdout.write(JSON.stringify({ source, status: 'stored' }) + '\n')
} finally { await pool.end() }

import { open } from 'node:fs/promises'
import { createDatabase } from '../src/db/client.js'
import { loadDatabaseConfig } from '../src/config.js'
import { storeReferences } from '../src/fx/reference.js'

const file = process.argv[2]
if (!file || process.env.FX_CAPTURE_IMPORT_AUTHORIZED !== 'YES') throw new Error('Supply a permitted FX evidence export')
const handle = await open(file, 'r')
try {
  const info = await handle.stat()
  if (!info.isFile() || info.size > 256_000) throw new Error('fx_import_size')
  const input = JSON.parse(await handle.readFile('utf8')) as unknown
  if (!Array.isArray(input)) throw new Error('fx_import_shape')
  const { database, pool } = createDatabase(loadDatabaseConfig())
  try {
    await storeReferences(database, input)
    process.stdout.write(JSON.stringify({ processed: input.length }) + '\n')
  } finally { await pool.end() }
} finally { await handle.close() }

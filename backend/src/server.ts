import { loadConfig } from './config.js'
import { createDatabase } from './db/client.js'
import { buildApp } from './http/app.js'

async function start(): Promise<void> {
  const config = loadConfig()
  const { database, pool } = createDatabase(config)
  const app = await buildApp({ config, database })
  let stopping = false

  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await app.close()
    await pool.end()
  }

  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })

  try {
    const address = await app.listen({ host: config.host, port: config.port })
    app.log.info({ address }, 'Scevia API listening')
  } catch (error) {
    app.log.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'API startup failed')
    await shutdown()
    process.exitCode = 1
  }
}

await start()

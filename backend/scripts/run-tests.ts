import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

const externalTestUrl = process.env.TEST_DATABASE_URL
if (externalTestUrl) {
  process.exitCode = await runVitest(externalTestUrl)
} else {
  const embeddedDatabase = new PGlite()
  const socketServer = new PGLiteSocketServer({
    db: embeddedDatabase,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 8,
  })
  let port = 0
  socketServer.addEventListener('listening', (event) => {
    port = (event as CustomEvent<{ port: number }>).detail.port
  }, { once: true })

  try {
    await socketServer.start()
    if (port === 0) throw new Error('Embedded PostgreSQL did not report its listening port')
    const testUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`
    process.exitCode = await runVitest(testUrl)
  } finally {
    await socketServer.stop()
    await embeddedDatabase.close()
  }
}

async function runVitest(testDatabaseUrl: string): Promise<number> {
  const cliPath = resolve('node_modules/vitest/vitest.mjs')
  const child = spawn(process.execPath, [cliPath, 'run'], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DATABASE_URL: testDatabaseUrl, NODE_ENV: 'test' },
    stdio: 'inherit',
  })
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Vitest exited on ${signal}`))
      else resolveExit(code ?? 1)
    })
  })
}

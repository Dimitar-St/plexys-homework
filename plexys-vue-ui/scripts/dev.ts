import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'
import type { Server } from 'node:http'
import { createApp } from '../server/app.ts'
import { readConfig } from '../server/config.ts'
import { createMockCorteza } from './mock-corteza.ts'

try { process.loadEnvFile('.env') }
catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }

const demo = process.argv.includes('--demo')
const env = demo ? {
  ...process.env, DEMO_MODE: 'true', APP_ORIGIN: 'http://localhost:5173', CORTEZA_URL: 'http://localhost:18081',
  CORTEZA_CLIENT_ID: 'demo-client', CORTEZA_CLIENT_SECRET: 'demo-secret',
  CORTEZA_NAMESPACE_ID: '100', CORTEZA_TICKET_MODULE_ID: '200', CORTEZA_CUSTOMER_MODULE_ID: '300',
} : { ...process.env, DEMO_MODE: 'false' }

const config = readConfig(env)
if (config.appOrigin !== 'http://localhost:5173') throw new Error('For local development set APP_ORIGIN=http://localhost:5173.')

const listen = (server: Server, port: number): Promise<void> => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
let mock: ReturnType<typeof createMockCorteza> | undefined

let api: Server | undefined
let vite: ViteDevServer | undefined
let closing = false

async function shutdown(code = 0): Promise<void> {
  if (closing) return
  closing = true
  if (vite) await vite.close()
  for (const server of [api, mock?.server]) if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  process.exit(code)
}
try {
  if (demo) { mock = createMockCorteza(); await listen(mock.server, 18081) }
  api = createApp(config)
  await listen(api, 3001)
  process.env.LOCAL_NODE_SERVER = 'true'
  vite = await createViteServer()
  await vite.listen()
  console.log(demo ? '\nDEMO MODE: local fixture data only; no live Corteza requests.\n' : '\nUsing the configured Corteza instance.\n')
  if (!config.ready) console.log('Fill .env with your Corteza client and module IDs, then restart.\n')
  console.log('Open http://localhost:5173\n')
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); await shutdown(1) }

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown())

import { createApp } from './app.ts'
import { readConfig } from './config.ts'

const config = readConfig()
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const server = createApp(config)

server.listen(port, host, () => {
  console.log(`Plexys auth/API server listening on http://${host}:${port}`)
  if (!config.ready) console.log('Connection pending: fill in the Corteza client and module IDs in .env.')
})

server.on('error', error => { console.error(error.message); process.exitCode = 1 })

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))

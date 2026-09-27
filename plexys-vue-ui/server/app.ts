import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from './config.ts'
import { handleAPI } from './api.ts'
import { MemorySessions } from './sessions.ts'

const fail = (status: number, message: string) => Object.assign(new Error(message), { status })

export function createApp(config: AppConfig, options: { fetcher?: typeof fetch; dist?: string } = {}) {
  const sessions = new MemorySessions(options.fetcher)
  const dist = options.dist || resolve(dirname(fileURLToPath(import.meta.url)), '../dist/client')
  const cleanup = setInterval(() => sessions.cleanup(), 60_000)
  cleanup.unref()
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    try {
      const url = new URL(req.url || '/', config.appOrigin)
      const { pathname } = url
      if (/^\/(auth|app|api)(\/|$)/.test(pathname)) {
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item)
          else if (value !== undefined) headers.set(name, value)
        }
        const init: RequestInit & { duplex?: string } = { method: req.method, headers }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
          init.duplex = 'half'
        }
        const response = await handleAPI(new Request(url, init), config, sessions, options.fetcher)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed.')
      const requested = decodeURIComponent(pathname)
      const filePath = resolve(dist, `.${requested === '/' ? '/index.html' : requested}`)
      if (!filePath.startsWith(`${dist}${sep}`) || requested.split('/').some(segment => segment.startsWith('.'))) {
        throw fail(404, 'File not found.')
      }
      const bytes = await readFile(filePath).catch(() => { throw fail(404, 'Frontend not found. Run npm run build, or use npm run dev.') })
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
      res.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream', 'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch (cause) {
      const error = cause instanceof Error && 'status' in cause && typeof cause.status === 'number' ? cause : undefined
      res.writeHead(error?.status as number || 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ error: { message: error?.message || 'The request could not be completed.' } }))
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.on('close', () => clearInterval(cleanup))
  return server
}

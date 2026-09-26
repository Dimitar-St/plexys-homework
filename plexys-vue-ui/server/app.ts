import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from './config.ts'
import type { RecordValue } from '../src/domain/tickets.ts'

interface TokenSet {
  access_token: string
  refresh_token?: string
  expiresAt: number
  sub: string
  name: string
  handle: string
  email: string
}
interface PendingSession {
  kind: 'pending'
  state: string
  csrf: string
  expiresAt: number
}
interface AuthenticatedSession {
  kind: 'authenticated'
  tokens: TokenSet
  csrf: string
  expiresAt: number
  user: { id: string; name: string; email: string }
  refreshing?: Promise<void>
}
type Session = PendingSession | AuthenticatedSession
type SessionLookup = { id: string; session: Session } | { id: undefined; session: undefined }
interface AppOptions { fetcher?: typeof fetch; dist?: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isRecordValue = (value: unknown): value is RecordValue => isObject(value)
  && typeof value.name === 'string' && typeof value.value === 'string'
  && (value.place === undefined || (typeof value.place === 'number' && Number.isInteger(value.place) && value.place >= 0))
const stringValue = (value: unknown): string => typeof value === 'string' ? value : ''

const SESSION_COOKIE = 'plexys_session'
const random = () => randomBytes(32).toString('base64url')
const equal = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const fail = (status: number, message: string) => Object.assign(new Error(message), { status })
const json = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}
const redirect = (res: ServerResponse, target: string): void => { res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' }); res.end() }

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw fail(415, 'Use application/json.')
  let size = 0
  const parts: Buffer[] = []
  for await (const part of req) {
    size += part.length
    if (size > 65_536) throw fail(413, 'The ticket is too large. Keep the request below 64 KB.')
    parts.push(part)
  }
  try { return JSON.parse(Buffer.concat(parts).toString()) }
  catch { throw fail(400, 'Invalid JSON request.') }
}

export function createApp(config: AppConfig, options: AppOptions = {}) {
  const fetcher = options.fetcher || fetch
  const sessions = new Map<string, Session>()
  const dist = options.dist || resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(id)
  }, 60_000)
  cleanup.unref()

  function cookie(res: ServerResponse, id: string, ttl = 28_800): void {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ttl}${config.secureCookie ? '; Secure' : ''}`)
  }
  function getSession(req: IncomingMessage): SessionLookup {
    const id = String(req.headers.cookie || '').split(';').map(value => value.trim())
      .find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
    const session = id ? sessions.get(id) : undefined
    if (id && session && session.expiresAt > Date.now()) return { id, session }
    if (id) sessions.delete(id)
    return { id: undefined, session: undefined }
  }
  function checkCsrf(req: IncomingMessage, session: AuthenticatedSession): void {
    if (req.headers.origin !== config.appOrigin || !equal(req.headers['x-csrf-token'], session.csrf)) {
      throw fail(403, 'The request could not be verified. Reload the page and try again.')
    }
  }
  async function exchangeToken(parameters: Record<string, string>): Promise<TokenSet> {
    const upstream = await fetcher(`${config.cortezaURL}/auth/oauth2/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientID}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      },
      body: new URLSearchParams(parameters).toString(),
    })
    const data: unknown = await upstream.json().catch(() => null)
    if (!upstream.ok || !isObject(data) || typeof data.access_token !== 'string' || !data.access_token) {
      throw fail(401, 'Corteza could not renew this session. Sign in again.')
    }
    const lifetime = Number(data.expires_in)
    if (!Number.isFinite(lifetime) || lifetime <= 0) throw fail(502, 'Corteza returned an invalid token lifetime.')
    return {
      access_token: data.access_token, refresh_token: stringValue(data.refresh_token) || undefined,
      expiresAt: Date.now() + lifetime * 1000,
      sub: typeof data.sub === 'string' || typeof data.sub === 'number' ? String(data.sub) : '',
      name: stringValue(data.name), handle: stringValue(data.handle), email: stringValue(data.email),
    }
  }
  async function accessToken(session: AuthenticatedSession): Promise<string> {
    if (session.tokens.expiresAt > Date.now() + 30_000) return session.tokens.access_token
    if (!session.tokens.refresh_token) throw fail(401, 'Your session has expired. Sign in again.')
    if (!session.refreshing) {
      session.refreshing = exchangeToken({ grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token })
        .then(tokens => { session.tokens = { ...tokens, refresh_token: tokens.refresh_token || session.tokens.refresh_token } })
        .finally(() => { session.refreshing = undefined })
    }
    await session.refreshing
    return session.tokens.access_token
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    const current = getSession(req)
    try {
      const url = new URL(req.url || '/', config.appOrigin)
      const { pathname } = url
      if (pathname === '/app/session' && req.method === 'GET') {
        const session = current.session
        const authenticated = session?.kind === 'authenticated'
        return json(res, 200, {
          response: {
            authenticated,
            ...(authenticated ? { csrfToken: session.csrf, user: session.user } : {}),
            config: {
              namespaceID: config.namespaceID, ticketModuleID: config.ticketModuleID,
              customerModuleID: config.customerModuleID, cortezaURL: config.cortezaURL, demo: config.demo, ready: config.ready,
            },
          }
        })
      }

      if (pathname === '/auth/login' && req.method === 'GET') {
        if (!config.ready) throw fail(503, 'Complete the Corteza configuration in the server environment.')
        if (sessions.size >= 1000) throw fail(503, 'Too many active sessions. Please try again later.')
        if (current.id) sessions.delete(current.id)
        const id = random()
        const state = random()
        sessions.set(id, { kind: 'pending', state, csrf: random(), expiresAt: Date.now() + 10 * 60_000 })
        cookie(res, id, 600)
        const target = new URL(`${config.cortezaURL}/auth/oauth2/authorize`)
        target.search = new URLSearchParams({
          client_id: config.clientID, redirect_uri: config.callbackURL,
          response_type: 'code', scope: 'profile api', state,
        }).toString()
        return redirect(res, target.href)
      }

      if (pathname === '/auth/callback' && req.method === 'GET') {
        const { id, session } = current
        const code = url.searchParams.get('code')
        if (!id || session?.kind !== 'pending' || !equal(session.state, url.searchParams.get('state')) || !code || code.length > 2048 || url.searchParams.has('error')) {
          return redirect(res, `${config.appOrigin}/?auth_error=invalid_state`)
        }
        // Consume state before exchanging the code, then rotate the session ID.
        sessions.delete(id)
        try {
          const tokens = await exchangeToken({ grant_type: 'authorization_code', code, redirect_uri: config.callbackURL })
          const nextID = random()
          sessions.set(nextID, {
            kind: 'authenticated', tokens, csrf: random(), expiresAt: Date.now() + 8 * 60 * 60_000,
            user: { id: String(tokens.sub || ''), name: tokens.name || tokens.handle || '', email: tokens.email || '' },
          })
          cookie(res, nextID)
          return redirect(res, `${config.appOrigin}/`)
        } catch {
          cookie(res, '', 0)
          return redirect(res, `${config.appOrigin}/?auth_error=exchange_failed`)
        }
      }

      if (pathname === '/auth/logout' && req.method === 'POST') {
        if (!current.id || current.session.kind !== 'authenticated') throw fail(401, 'Sign in to continue.')
        checkCsrf(req, current.session)
        sessions.delete(current.id)
        cookie(res, '', 0)
        return json(res, 200, { response: true })
      }

      if (pathname.startsWith('/api/')) {
        if (!current.id || current.session.kind !== 'authenticated') throw fail(401, 'Sign in to continue.')
        const match = pathname.match(/^\/api\/compose\/namespace\/(\d+)\/module\/(\d+)\/record\/(\d+)?$/)
        if (!match || match[1] !== config.namespaceID
          || ![config.ticketModuleID, config.customerModuleID].filter(Boolean).includes(match[2])) {
          throw fail(404, 'This API resource is not available through the workspace.')
        }
        if ((req.method !== 'GET' && req.method !== 'POST') || (req.method === 'POST' && match[2] !== config.ticketModuleID)) {
          throw fail(405, 'This operation is not available through the workspace.')
        }
        let body: string | undefined
        if (req.method === 'POST') {
          checkCsrf(req, current.session)
          const input = await readBody(req)
          if (!isObject(input) || !Array.isArray(input.values) || input.values.length > 100
            || !input.values.every(isRecordValue)) {
            throw fail(400, 'Invalid Corteza record values.')
          }
          if (input.updatedAt && (typeof input.updatedAt !== 'string' || Number.isNaN(Date.parse(input.updatedAt)))) {
            throw fail(400, 'Invalid record revision timestamp.')
          }
          // Created/owner/system fields are never written by the proxy.
          body = JSON.stringify({ values: input.values, ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}) })
        }
        const token = await accessToken(current.session)
        const target = new URL(`${config.cortezaURL}${pathname}`)
        if (req.method === 'GET' && !match[3]) {
          target.searchParams.set('limit', '100')
          target.searchParams.set('sort', 'createdAt DESC')
          const cursor = url.searchParams.get('pageCursor')
          if (cursor) {
            if (cursor.length > 4096) throw fail(400, 'Invalid pagination cursor.')
            target.searchParams.set('pageCursor', cursor)
          }
        }
        const upstream = await fetcher(target, {
          method: req.method, redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body } : {}),
        })
        if (upstream.status === 401) {
          sessions.delete(current.id)
          cookie(res, '', 0)
          throw fail(401, 'Your session has expired. Sign in again.')
        }
        const result: unknown = await upstream.json().catch(() => null)
        if (!result) throw fail(502, 'Corteza returned an unreadable response.')
        return json(res, upstream.status, result)
      }

      if (pathname.startsWith('/auth/') || pathname.startsWith('/app/')) throw fail(404, 'Route not found.')
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
      const error = cause instanceof Error && 'status' in cause && typeof cause.status === 'number'
        ? { status: cause.status, message: cause.message } : undefined
      if (error?.status === 401 && current.id) { sessions.delete(current.id); cookie(res, '', 0) }
      if (res.headersSent) { res.end(); return }
      json(res, error?.status || 502, { error: { message: error ? error.message : 'Corteza could not be reached. Check the server URL and try again.' } })
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.on('close', () => clearInterval(cleanup))
  return server
}

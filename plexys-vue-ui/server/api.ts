import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { AppConfig } from './config.ts'
import type { RecordValue } from '../src/domain/tickets.ts'

export interface TokenSet {
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
}
export type Session = PendingSession | AuthenticatedSession
export interface SessionStore {
  get(id: string): Promise<Session | undefined>
  set(id: string, session: Session): Promise<void>
  delete(id: string): Promise<void>
  consume(id: string): Promise<Session | undefined>
  refresh(id: string, config: AppConfig): Promise<TokenSet>
}

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
export const json = (status: number, payload: unknown): Response => Response.json(payload, {
  status, headers: { 'Cache-Control': 'no-store' },
})
const redirect = (target: string): Response => new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } })

async function readBody(req: Request): Promise<unknown> {
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw fail(415, 'Use application/json.')
  const reader = req.body?.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  if (reader) while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 65_536) { await reader.cancel(); throw fail(413, 'The ticket is too large. Keep the request below 64 KB.') }
    parts.push(value)
  }
  try { return JSON.parse(Buffer.concat(parts).toString()) }
  catch { throw fail(400, 'Invalid JSON request.') }
}

export async function handleAPI(req: Request, config: AppConfig, sessions: SessionStore, fetcher: typeof fetch = fetch): Promise<Response> {
  let setCookie: string | undefined
  const cookie = (id: string, ttl = 28_800) => {
    setCookie = `${SESSION_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${ttl}${config.secureCookie ? '; Secure' : ''}`
  }
  const id = req.headers.get('cookie')?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
  const current: { id?: string; session?: Session } = {}
  const finish = (response: Response) => {
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('X-Frame-Options', 'DENY')
    if (setCookie !== undefined) response.headers.set('Set-Cookie', setCookie)
    return response
  }
  function checkCsrf(req: Request, session: AuthenticatedSession): void {
    if (req.headers.get('origin') !== config.appOrigin || !equal(req.headers.get('x-csrf-token'), session.csrf)) {
      throw fail(403, 'The request could not be verified. Reload the page and try again.')
    }
  }
  const run = async (): Promise<Response> => {
    try {
      if (id && /^[A-Za-z0-9_-]{43}$/.test(id)) {
        const session = await sessions.get(id)
        if (session && session.expiresAt > Date.now()) { current.id = id; current.session = session }
        else if (session) await sessions.delete(id)
      }
      const url = new URL(req.url)
      const { pathname } = url
      if (pathname === '/app/session' && req.method === 'GET') {
        const session = current.session
        const authenticated = session?.kind === 'authenticated'
        return json(200, {
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
        if (current.id) await sessions.delete(current.id)
        const id = random()
        const state = random()
        await sessions.set(id, { kind: 'pending', state, csrf: random(), expiresAt: Date.now() + 10 * 60_000 })
        cookie(id, 600)
        const target = new URL(`${config.cortezaURL}/auth/oauth2/authorize`)
        target.search = new URLSearchParams({
          client_id: config.clientID, redirect_uri: config.callbackURL,
          response_type: 'code', scope: 'profile api', state,
        }).toString()
        return redirect(target.href)
      }

      if (pathname === '/auth/callback' && req.method === 'GET') {
        const { id } = current
        const session = current.session
        const code = url.searchParams.get('code')
        if (!id || session?.kind !== 'pending' || !equal(session.state, url.searchParams.get('state')) || !code || code.length > 2048 || url.searchParams.has('error')) {
          return redirect(`${config.appOrigin}/?auth_error=invalid_state`)
        }
        // Atomically consume state before exchanging the code, then rotate the session ID.
        const consumed = await sessions.consume(id)
        if (consumed?.kind !== 'pending' || !equal(consumed.state, session.state)) return redirect(`${config.appOrigin}/?auth_error=invalid_state`)
        try {
          const tokens = await exchangeToken(config, { grant_type: 'authorization_code', code, redirect_uri: config.callbackURL }, fetcher)
          const nextID = random()
          await sessions.set(nextID, {
            kind: 'authenticated', tokens, csrf: random(), expiresAt: Date.now() + 8 * 60 * 60_000,
            user: { id: String(tokens.sub || ''), name: tokens.name || tokens.handle || '', email: tokens.email || '' },
          })
          cookie(nextID)
          return redirect(`${config.appOrigin}/`)
        } catch {
          cookie('', 0)
          return redirect(`${config.appOrigin}/?auth_error=exchange_failed`)
        }
      }

      if (pathname === '/auth/logout' && req.method === 'POST') {
        if (!current.id || current.session?.kind !== 'authenticated') throw fail(401, 'Sign in to continue.')
        checkCsrf(req, current.session)
        await sessions.delete(current.id)
        cookie('', 0)
        return json(200, { response: true })
      }

      if (pathname.startsWith('/api/')) {
        if (!current.id || current.session?.kind !== 'authenticated') throw fail(401, 'Sign in to continue.')
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
        const token = current.session.tokens.expiresAt > Date.now() + 30_000
          ? current.session.tokens.access_token : (await sessions.refresh(current.id, config)).access_token
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
          method: req.method, redirect: 'manual', signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body } : {}),
        })
        if (upstream.status >= 300 && upstream.status < 400) throw fail(502, 'Corteza returned an unexpected redirect. Check CORTEZA_URL.')
        if (upstream.status === 401) {
          await sessions.delete(current.id)
          cookie('', 0)
          throw fail(401, 'Your session has expired. Sign in again.')
        }
        const result: unknown = await upstream.json().catch(() => null)
        if (!result) throw fail(502, 'Corteza returned an unreadable response.')
        return json(upstream.status, result)
      }

      throw fail(404, 'Route not found.')
    } catch (cause) {
      const error = cause instanceof Error && 'status' in cause && typeof cause.status === 'number'
        ? { status: cause.status, message: cause.message } : undefined
      if (error?.status === 401 && current.id) { await sessions.delete(current.id); cookie('', 0) }
      return json(error?.status || 502, { error: { message: error ? error.message : 'Corteza could not be reached. Check the server URL and try again.' } })
    }
  }
  return finish(await run())
}

export async function exchangeToken(config: AppConfig, parameters: Record<string, string>, fetcher: typeof fetch = fetch): Promise<TokenSet> {
  const upstream = await fetcher(`${config.cortezaURL}/auth/oauth2/token`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
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

export async function refreshSession(config: AppConfig, session: Session | undefined, fetcher: typeof fetch = fetch): Promise<TokenSet> {
  if (session?.kind !== 'authenticated' || session.expiresAt <= Date.now()) throw fail(401, 'Your session has expired. Sign in again.')
  if (session.tokens.expiresAt > Date.now() + 30_000) return session.tokens
  if (!session.tokens.refresh_token) throw fail(401, 'Your session has expired. Sign in again.')
  const tokens = await exchangeToken(config, { grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token }, fetcher)
  return { ...tokens, refresh_token: tokens.refresh_token || session.tokens.refresh_token }
}

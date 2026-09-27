import { DurableObject } from 'cloudflare:workers'
import { readConfig } from '../server/config.ts'
import type { AppConfig } from '../server/config.ts'
import { handleAPI, json, refreshSession } from '../server/api.ts'
import type { Session, SessionStore, TokenSet } from '../server/api.ts'

interface Env {
  ASSETS: Fetcher
  SESSIONS: DurableObjectNamespace<CortezaSession>
  APP_ORIGIN?: string
  CORTEZA_URL?: string
  CORTEZA_CLIENT_ID?: string
  CORTEZA_CLIENT_SECRET?: string
  CORTEZA_NAMESPACE_ID?: string
  CORTEZA_TICKET_MODULE_ID?: string
  CORTEZA_CUSTOMER_MODULE_ID?: string
}

function configFromEnv(env: Env): AppConfig {
  return readConfig({
    APP_ORIGIN: env.APP_ORIGIN, CORTEZA_URL: env.CORTEZA_URL,
    CORTEZA_CLIENT_ID: env.CORTEZA_CLIENT_ID, CORTEZA_CLIENT_SECRET: env.CORTEZA_CLIENT_SECRET,
    CORTEZA_NAMESPACE_ID: env.CORTEZA_NAMESPACE_ID, CORTEZA_TICKET_MODULE_ID: env.CORTEZA_TICKET_MODULE_ID,
    CORTEZA_CUSTOMER_MODULE_ID: env.CORTEZA_CUSTOMER_MODULE_ID, NODE_ENV: 'production',
  })
}

// Each opaque session ID gets its own object. Tokens never leave server-side storage.
export class CortezaSession extends DurableObject<Env> {
  private refreshing?: Promise<TokenSet>
  async getSession(): Promise<Session | undefined> {
    const session = await this.ctx.storage.get<Session>('session')
    if (session && session.expiresAt <= Date.now()) { await this.ctx.storage.deleteAll(); return undefined }
    return session
  }
  async saveSession(session: Session): Promise<void> {
    await this.ctx.storage.put('session', session)
    await this.ctx.storage.setAlarm(session.expiresAt)
  }
  async deleteSession(): Promise<void> { await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm() }
  async consumeSession(): Promise<Session | undefined> {
    return this.ctx.storage.transaction(async tx => {
      const session = await tx.get<Session>('session')
      await tx.delete('session')
      return session
    })
  }
  async refreshTokens(): Promise<TokenSet> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const session = await this.getSession()
      const tokens = await refreshSession(configFromEnv(this.env), session)
      // A logout while the upstream refresh is running must not resurrect the session.
      return this.ctx.storage.transaction(async tx => {
        const latest = await tx.get<Session>('session')
        if (latest?.kind !== 'authenticated' || latest.expiresAt <= Date.now()) throw new Error('Session expired during refresh.')
        await tx.put('session', { ...latest, tokens })
        return tokens
      })
    })()
    try { return await this.refreshing } finally { this.refreshing = undefined }
  }
  async alarm(): Promise<void> { await this.ctx.storage.deleteAll() }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (/^\/(auth|app|api)(\/|$)/.test(path)) {
      if (!env.APP_ORIGIN || !env.CORTEZA_URL) return json(503, { error: { message: 'Configure APP_ORIGIN and CORTEZA_URL in the Worker settings.' } })
      const object = (id: string) => env.SESSIONS.get(env.SESSIONS.idFromName(id))
      const store: SessionStore = {
        get: id => object(id).getSession(),
        set: (id, session) => object(id).saveSession(session),
        delete: id => object(id).deleteSession(),
        consume: id => object(id).consumeSession(),
        refresh: async id => {
          try { return await object(id).refreshTokens() }
          catch { throw Object.assign(new Error('Your session has expired. Sign in again.'), { status: 401 }) }
        },
      }
      try { return await handleAPI(request, configFromEnv(env), store) }
      catch { return json(503, { error: { message: 'Check the Worker environment configuration and session binding.' } }) }
    }
    const asset = await env.ASSETS.fetch(request)
    const response = new Response(asset.body, asset)
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    return response
  },
} satisfies ExportedHandler<Env>

import type { AppConfig } from './config.ts'
import { refreshSession } from './api.ts'
import type { Session, SessionStore, TokenSet } from './api.ts'

export class MemorySessions implements SessionStore {
  private sessions = new Map<string, Session>()
  private refreshing = new Map<string, Promise<TokenSet>>()
  private fetcher: typeof fetch
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher }
  async get(id: string) { return this.sessions.get(id) }
  async set(id: string, session: Session) { this.sessions.set(id, session) }
  async delete(id: string) { this.sessions.delete(id) }
  async consume(id: string) {
    const session = this.sessions.get(id)
    this.sessions.delete(id)
    return session
  }
  cleanup() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= Date.now()) this.sessions.delete(id)
  }
  async refresh(id: string, config: AppConfig): Promise<TokenSet> {
    const active = this.refreshing.get(id)
    if (active) return active
    const pending = (async () => {
      const session = this.sessions.get(id)
      const tokens = await refreshSession(config, session, this.fetcher)
      if (session?.kind !== 'authenticated' || this.sessions.get(id) !== session) throw Object.assign(new Error('Your session has expired.'), { status: 401 })
      session.tokens = tokens
      return tokens
    })()
    this.refreshing.set(id, pending)
    try { return await pending } finally { this.refreshing.delete(id) }
  }
}

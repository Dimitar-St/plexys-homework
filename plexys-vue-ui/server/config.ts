export interface AppConfig {
  appOrigin: string
  cortezaURL: string
  callbackURL: string
  secureCookie: boolean
  namespaceID: string
  ticketModuleID: string
  customerModuleID: string
  clientID: string
  clientSecret: string
  ready: boolean
  demo: boolean
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const app = new URL(env.APP_ORIGIN || 'http://localhost:5173')
  const corteza = new URL(env.CORTEZA_URL || 'http://localhost:18080')
  for (const url of [app, corteza]) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('APP_ORIGIN and CORTEZA_URL must be HTTP(S) URLs without credentials, queries, or fragments.')
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Use HTTPS for non-local APP_ORIGIN and CORTEZA_URL values.')
    }
  }
  if (app.pathname !== '/') throw new Error('APP_ORIGIN must be an origin without a path.')
  const namespaceID = env.CORTEZA_NAMESPACE_ID || ''
  const ticketModuleID = env.CORTEZA_TICKET_MODULE_ID || ''
  const customerModuleID = env.CORTEZA_CUSTOMER_MODULE_ID || ''
  const clientID = env.CORTEZA_CLIENT_ID || ''
  const clientSecret = env.CORTEZA_CLIENT_SECRET || ''
  const demo = env.DEMO_MODE === 'true'
  if (demo && env.NODE_ENV === 'production') throw new Error('Demo mode is not permitted in production.')
  const ready = Boolean(clientID && clientSecret && /^\d+$/.test(namespaceID)
    && /^\d+$/.test(ticketModuleID) && (!customerModuleID || /^\d+$/.test(customerModuleID)))
  return {
    appOrigin: app.origin, cortezaURL: corteza.href.replace(/\/$/, ''),
    callbackURL: `${app.origin}/auth/callback`, secureCookie: app.protocol === 'https:',
    namespaceID, ticketModuleID, customerModuleID, clientID, clientSecret, ready, demo,
  }
}

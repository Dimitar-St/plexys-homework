import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../server/app.ts'
import { readConfig } from '../server/config.ts'
import { createMockCorteza } from '../scripts/mock-corteza.ts'

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
async function fixture(t, options = {}) {
  const mock = createMockCorteza(options)
  const upstreamURL = await listen(mock.server)
  const config = readConfig({
    APP_ORIGIN: 'http://127.0.0.1:5173', CORTEZA_URL: upstreamURL,
    CORTEZA_CLIENT_ID: 'demo-client', CORTEZA_CLIENT_SECRET: 'demo-secret',
    CORTEZA_NAMESPACE_ID: '100', CORTEZA_TICKET_MODULE_ID: '200', CORTEZA_CUSTOMER_MODULE_ID: '300',
  })
  const app = createApp(config)
  const base = await listen(app)
  config.appOrigin = base
  config.callbackURL = `${base}/auth/callback`
  t.after(async () => {
    for (const server of [app, mock.server]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })
  async function login() {
    const start = await fetch(`${base}/auth/login`, { redirect: 'manual' })
    const pendingCookie = start.headers.get('set-cookie').split(';')[0]
    const authorization = new URL(start.headers.get('location'))
    assert.equal(authorization.searchParams.get('response_type'), 'code')
    assert.equal(authorization.searchParams.get('scope'), 'profile api')
    const granted = await fetch(authorization, { redirect: 'manual' })
    const callback = await fetch(granted.headers.get('location'), { redirect: 'manual', headers: { Cookie: pendingCookie } })
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get('location'), `${base}/`)
    const cookie = callback.headers.get('set-cookie').split(';')[0]
    assert.notEqual(cookie, pendingCookie)
    assert.match(callback.headers.get('set-cookie'), /HttpOnly/)
    const response = await fetch(`${base}/app/session`, { headers: { Cookie: cookie } })
    const session = (await response.json()).response
    assert.equal(session.authenticated, true)
    assert.ok(!JSON.stringify(session).includes('demo-access-token'))
    assert.ok(!JSON.stringify(session).includes('demo-secret'))
    return { cookie, csrf: session.csrfToken }
  }
  return { base, mock, login }
}
const recordPath = '/api/compose/namespace/100/module/200/record/'
const draft = { values: [{ name: 'Subject', value: 'Created via Vue' }, { name: 'Status', value: 'New' }, { name: 'Priority', value: 'High' }] }

test('requires authentication and rejects a forged OAuth callback', async t => {
  const { base } = await fixture(t)
  assert.equal((await fetch(base + recordPath)).status, 401)
  const response = await fetch(`${base}/auth/callback?code=forged&state=forged`, { redirect: 'manual' })
  assert.match(response.headers.get('location'), /auth_error=invalid_state/)
  assert.equal((await (await fetch(`${base}/app/session`)).json()).response.authenticated, false)
})

test('uses OAuth code exchange, bearer authentication, and Corteza cursor pagination', async t => {
  const { base, mock, login } = await fixture(t, { pageSize: 2 })
  const { cookie } = await login()
  const page1 = (await (await fetch(base + recordPath, { headers: { Cookie: cookie } })).json()).response
  assert.equal(page1.set.length, 2)
  assert.equal(page1.filter.nextPage, '2')
  const page2 = (await (await fetch(`${base}${recordPath}?pageCursor=${page1.filter.nextPage}`, { headers: { Cookie: cookie } })).json()).response
  assert.notEqual(page1.set[0].recordID, page2.set[0].recordID)
  assert.equal(mock.requests.at(-1).authorization, 'Bearer demo-access-token')
  assert.match(mock.requests.at(-1).query, /pageCursor=2/)
})

test('rejects missing CSRF, foreign origins, unrelated modules, and customer writes', async t => {
  const { base, login } = await fixture(t)
  const { cookie, csrf } = await login()
  const options = { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }
  assert.equal((await fetch(base + recordPath, options)).status, 403)
  assert.equal((await fetch(base + recordPath, { ...options, headers: { ...options.headers, 'X-CSRF-Token': csrf, Origin: 'https://other.example' } })).status, 403)
  assert.equal((await fetch(base + recordPath.replace('/200/', '/999/'), { headers: { Cookie: cookie } })).status, 404)
  assert.equal((await fetch(base + recordPath.replace('/200/', '/300/'), { ...options, headers: { ...options.headers, 'X-CSRF-Token': csrf } })).status, 405)
})

test('creates and updates records while keeping system metadata server-owned', async t => {
  const { base, mock, login } = await fixture(t)
  const { cookie, csrf } = await login()
  const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
  const created = (await (await fetch(base + recordPath, { method: 'POST', headers, body: JSON.stringify({ ...draft, ownedBy: '123', createdAt: '1999-01-01' }) })).json()).response
  assert.equal(created.ownedBy, '900000000000000001')
  assert.ok(!Object.hasOwn(JSON.parse(mock.requests.at(-1).body), 'ownedBy'))
  const updatedDraft = { values: draft.values.map(value => value.name === 'Status' ? { ...value, value: 'Resolved' } : value) }
  const updated = (await (await fetch(base + recordPath + created.recordID, { method: 'POST', headers, body: JSON.stringify(updatedDraft) })).json()).response
  assert.equal(updated.recordID, created.recordID)
  assert.equal(updated.values.find(value => value.name === 'Status').value, 'Resolved')
  assert.equal(updated.createdAt, created.createdAt)
  assert.ok(updated.updatedAt)
  const stale = await (await fetch(base + recordPath + created.recordID, { method: 'POST', headers, body: JSON.stringify(updatedDraft) })).json()
  assert.ok(stale.error.message.includes('changed'))
})

test('refreshes expired access tokens and invalidates the local session on logout', async t => {
  const { base, mock, login } = await fixture(t, { tokenLifetime: 1 })
  const { cookie, csrf } = await login()
  await fetch(base + recordPath, { headers: { Cookie: cookie } })
  assert.ok(mock.requests.some(request => request.path === '/auth/oauth2/token' && request.body.includes('grant_type=refresh_token')))
  const response = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf } })
  assert.equal(response.status, 200)
  assert.equal((await fetch(base + recordPath, { headers: { Cookie: cookie } })).status, 401)
})

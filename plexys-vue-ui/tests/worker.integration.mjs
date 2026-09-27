import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createMockCorteza } from '../scripts/mock-corteza.ts'

const origin = 'https://localhost:5173'
const recordPath = '/api/compose/namespace/100/module/200/record/'

test('Worker serves assets and persists OAuth sessions across restarts, with CSRF and logout', async t => {
  const mock = createMockCorteza({ tokenLifetime: 1 })
  await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
  const storage = await mkdtemp(join(tmpdir(), 'plexys-worker-'))
  let runtime
  t.after(async () => {
    await runtime?.dispose()
    mock.server.closeAllConnections()
    await new Promise(resolve => mock.server.close(resolve))
    await rm(storage, { recursive: true, force: true })
  })
  const options = convertV4MiniflareOptions({
    name: 'plexys-test', modules: true, scriptPath: resolve('dist/plexys_vue_corteza_ui/index.js'),
    compatibilityDate: '2026-09-25', compatibilityFlags: ['nodejs_compat'],
    bindings: {
      APP_ORIGIN: origin, CORTEZA_URL: `http://127.0.0.1:${mock.server.address().port}`,
      CORTEZA_CLIENT_ID: 'demo-client', CORTEZA_CLIENT_SECRET: 'demo-secret',
      CORTEZA_NAMESPACE_ID: '100', CORTEZA_TICKET_MODULE_ID: '200', CORTEZA_CUSTOMER_MODULE_ID: '300',
    },
    durableObjects: { SESSIONS: { className: 'CortezaSession', useSQLite: true } },
    assets: { routerConfig: { has_user_worker: true }, directory: resolve('dist/client'), binding: 'ASSETS', run_worker_first: true },
  })
  options.resourcePersistencePath = storage
  runtime = new Miniflare(options)
  const request = (path, options = {}) => runtime.dispatchFetch(origin + path, { redirect: 'manual', ...options })
  assert.match(await (await request('/')).text(), /<div id="app">/)
  assert.equal((await request(recordPath)).status, 401)
  const start = await request('/auth/login', { headers: { 'Sec-Fetch-Mode': 'navigate' } })
  assert.equal(start.status, 302)
  const pendingCookie = start.headers.get('set-cookie').split(';')[0]
  const granted = await fetch(start.headers.get('location'), { redirect: 'manual' })
  const callbackURL = new URL(granted.headers.get('location'))
  const callback = await request(callbackURL.pathname + callbackURL.search, { headers: { Cookie: pendingCookie } })
  assert.equal(callback.headers.get('location'), `${origin}/`)
  assert.match(callback.headers.get('set-cookie'), /Secure/)
  const cookie = callback.headers.get('set-cookie').split(';')[0]
  assert.notEqual(cookie, pendingCookie)
  const replay = await request(callbackURL.pathname + callbackURL.search, { headers: { Cookie: pendingCookie } })
  assert.match(replay.headers.get('location'), /invalid_state/)
  await runtime.dispose()
  runtime = new Miniflare(options)
  const sessionResponse = await request('/app/session', { headers: { Cookie: cookie } })
  const session = (await sessionResponse.json()).response
  assert.equal(session.authenticated, true)
  assert.ok(!JSON.stringify(session).includes('demo-access-token'))
  assert.ok(!JSON.stringify(session).includes('demo-secret'))
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }
  const body = JSON.stringify({ values: [{ name: 'Subject', value: 'Worker ticket' }, { name: 'Status', value: 'New' }, { name: 'Priority', value: 'Medium' }], ownedBy: '123' })
  assert.equal((await request(recordPath, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body })).status, 403)
  const createdResponse = await request(recordPath, { method: 'POST', headers, body })
  const result = await createdResponse.json()
  assert.ok(result.response?.recordID, JSON.stringify(result))
  assert.equal(result.response.ownedBy, '900000000000000001')
  const listed = await (await request(recordPath, { headers })).json()
  assert.ok(listed.response.set.some(record => record.recordID === result.response.recordID))
  assert.ok(mock.requests.some(request => request.body.includes('grant_type=refresh_token')))
  assert.equal((await request('/auth/logout', { method: 'POST', headers })).status, 200)
  assert.equal((await request(recordPath, { headers })).status, 401)
  await runtime.dispose()
  runtime = new Miniflare(options)
  assert.equal((await (await request('/app/session', { headers })).json()).response.authenticated, false)
})

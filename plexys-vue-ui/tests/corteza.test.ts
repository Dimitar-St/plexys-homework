import test from 'node:test'
import assert from 'node:assert/strict'
import { listCustomers, listTickets, readTicket, saveTicket } from '../src/api/corteza.ts'
import { blankDraft } from '../src/domain/tickets.ts'

const config = {
  namespaceID: '100', ticketModuleID: '200', customerModuleID: '300',
  cortezaURL: 'http://localhost:18080', demo: false, ready: true,
}
const record = {
  recordID: '18446744073709551615', createdAt: '2026-09-01T10:00:00Z',
  values: [{ name: 'Subject', value: 'New ticket' }],
}
const base = '/api/compose/namespace/100/module/'

test('creates at the record collection URL without supplying an ID', async t => {
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    assert.equal(path, `${base}200/record/`)
    assert.equal(options.method, 'POST')
    const body = JSON.parse(options.body as string)
    assert.deepEqual(Object.keys(body), ['values'])
    assert.ok(body.values.some((value: { name: string; value: string }) => value.name === 'Subject' && value.value === 'New ticket'))
    return Response.json({ response: record })
  })
  const saved = await saveTicket(config, { ...blankDraft(), subject: 'New ticket' })
  assert.equal(saved.id, record.recordID)
})

test('lists tickets and customers at their record collection URLs', async t => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    paths.push(path)
    return Response.json({ response: { set: [record] } })
  })
  assert.equal((await listTickets(config))[0]?.id, record.recordID)
  assert.equal((await listCustomers(config))[0]?.id, record.recordID)
  assert.deepEqual(paths.map(path => path.split('?')[0]), [`${base}200/record/`, `${base}300/record/`])
})

test('reads and updates using the existing backend ID and revision', async t => {
  const original = { ...record, updatedAt: '2026-09-02T10:00:00Z' }
  const methods: string[] = []
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    assert.equal(path, `${base}200/record/${record.recordID}`)
    methods.push(options.method ?? 'GET')
    if (options.method === 'POST') {
      assert.equal(JSON.parse(options.body as string).updatedAt, original.updatedAt)
    }
    return Response.json({ response: original })
  })
  await readTicket(config, record.recordID)
  await saveTicket(config, { ...blankDraft(), subject: 'Updated ticket' }, original)
  assert.deepEqual(methods, ['GET', 'POST'])
})

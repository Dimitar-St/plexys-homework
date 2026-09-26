import test from 'node:test'
import assert from 'node:assert/strict'
import { blankDraft, fromRecord, localDateInput, toRecordValues, validateDraft } from '../src/domain/tickets.ts'
import type { CortezaRecord } from '../src/domain/tickets.ts'

test('round-trips all ticket fields using capitalized Corteza names', () => {
  const draft = {
    subject: 'Test', description: 'Details', status: 'New', priority: 'Medium',
    dueDate: '2026-09-25T12:18:00.000Z', customer: '515381907068616705',
  }
  const values = toRecordValues(draft, undefined, true)
  assert.deepEqual(values.map(value => value.name), ['Subject', 'Description', 'Status', 'Priority', 'DueDate', 'Customer'])
  const { id, source, ...loaded } = fromRecord({ recordID: '123', createdAt: '2026-09-01T10:00:00Z', values })
  assert.deepEqual(loaded, draft)
})

test('keeps 64-bit record IDs as strings and reads Corteza value arrays', () => {
  const ticket = fromRecord({ recordID: '18446744073709551615', values: [{ name: 'Subject', value: 'A real request' }], createdAt: '2026-09-01T10:00:00Z' })
  assert.equal(ticket.id, '18446744073709551615')
  assert.equal(ticket.subject, 'A real request')
  assert.equal(ticket.description, '')
})

test('clears optional values, preserves additional fields, and does not synthesize system metadata', () => {
  const original: CortezaRecord = {
    recordID: '9223372036854775808', createdAt: '2026-09-01T10:00:00Z', ownedBy: '900000000000000001',
    values: [
      { name: 'Subject', value: 'Old' }, { name: 'Description', value: 'Old detail' },
      { name: 'DueDate', value: '2026-09-27T10:00:00Z' }, { name: 'Customer', value: '201' },
      { name: 'externalReference', value: 'ABC-123', place: 0 },
    ],
  }
  const values = toRecordValues({ ...blankDraft(), subject: ' Updated ' }, original, true)
  assert.equal(values.find(value => value.name === 'Subject')?.value, 'Updated')
  for (const name of ['Description', 'DueDate', 'Customer', 'createdAt', 'updatedAt', 'ownedBy']) {
    assert.equal(values.some(value => value.name === name), false)
  }
  assert.deepEqual(values.find(value => value.name === 'externalReference'), { name: 'externalReference', value: 'ABC-123', place: 0 })
  assert.equal(toRecordValues({ ...blankDraft(), subject: 'Updated' }, original, false).find(value => value.name === 'Customer')?.value, '201')
})

test('rejects missing subject, invalid enum values, and invalid dates', () => {
  const errors = validateDraft({ ...blankDraft(), subject: '   ', status: 'Anything', priority: '', dueDate: 'invalid' })
  assert.deepEqual(Object.keys(errors).sort(), ['dueDate', 'priority', 'status', 'subject'])
})

test('converts date input to UTC while preserving its local display time', () => {
  const local = '2026-09-27T17:30'
  const result = toRecordValues({ ...blankDraft(), subject: 'Test', dueDate: local })
  const iso = result.find(value => value.name === 'DueDate')?.value
  assert.ok(iso?.endsWith('Z'))
  assert.equal(localDateInput(iso!), local)
})

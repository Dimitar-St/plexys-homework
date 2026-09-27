import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { CortezaRecord, RecordValue } from '../src/domain/tickets.ts'

export interface MockOptions { tokenLifetime?: number; pageSize?: number }
interface CapturedRequest {
  path: string
  query: string
  method: string | undefined
  authorization: string | undefined
  body: string
}
type SeedTicket = [subject: string, status: string, priority: string, customer: string, description: string, due: number | null]

// Explicit demo/test fixture. It never starts during npm run dev or npm start.
export function createMockCorteza(options: MockOptions = {}) {
  const requests: CapturedRequest[] = []
  const codes = new Set<string>()
  const records = new Map<string, CortezaRecord>()
  const now = Date.now()
  const date = (days: number): string => new Date(now + days * 86_400_000).toISOString()
  let sequence = 300000000000000100n
  const values = (object: Record<string, string>): RecordValue[] => Object.entries(object).filter(([, value]) => value !== '').map(([name, value]) => ({ name, value }))
  const subjects: SeedTicket[] = [
    ['Unable to sign in to the customer portal', 'New', 'High', '201', 'The sign-in screen returns an error after submitting valid credentials.', 1],
    ['Invoice download returns an empty file', 'In Progress', 'Medium', '202', 'The PDF download finishes, but the file is empty.\nReported on Chrome and Safari.', 3],
    ['Payment confirmation has not arrived', 'New', 'Urgent', '203', 'Payment was completed this morning. Please check the confirmation email.', 0],
    ['Update the contact email on our account', 'Resolved', 'Low', '201', 'The new email address has been verified and updated.', -1],
    ['Service report is missing attachments', 'In Progress', 'High', '202', 'Two photos are missing from the latest service report.', 2],
    ['Question about the service schedule', 'Closed', 'Low', '', 'The customer received the requested schedule.', null],
  ]
  subjects.forEach(([subject, status, priority, customer, description, due], index) => {
    const id = String(++sequence)
    records.set(id, {
      recordID: id, createdAt: date(-7 + index), updatedAt: index ? date(-1) : null,
      ownedBy: '900000000000000001', createdBy: '900000000000000001', canUpdateRecord: true,
      values: values({ Subject: subject, Status: status, Priority: priority, Customer: customer, Description: description, DueDate: due === null ? '' : date(due) }),
    })
  })
  const customers = [
    { recordID: '201', values: values({ name: 'Alex Morgan', email: 'alex@example.com', company: 'Northstar Studio' }) },
    { recordID: '202', values: values({ name: 'Maya Chen', email: 'maya@example.com', company: 'Forma Workshop' }) },
    { recordID: '203', values: values({ name: 'Oliver Reed', email: 'oliver@example.com', company: 'Good Company' }) },
  ]
  const reply = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString()
      requests.push({ path: url.pathname, query: url.search, method: req.method, authorization: req.headers.authorization, body: raw })
      if (url.pathname === '/auth/oauth2/authorize') {
        const target = new URL(url.searchParams.get('redirect_uri') || '')
        if (!['localhost', '127.0.0.1'].includes(target.hostname)) return reply(res, 400, { error: 'Local demo callbacks only.' })
        const code = randomBytes(16).toString('hex')
        codes.add(code)
        target.searchParams.set('code', code)
        target.searchParams.set('state', url.searchParams.get('state') || '')
        res.writeHead(302, { Location: target.href }); return res.end()
      }
      if (url.pathname === '/auth/oauth2/token' && req.method === 'POST') {
        const input = new URLSearchParams(raw)
        if (req.headers.authorization !== `Basic ${Buffer.from('demo-client:demo-secret').toString('base64')}`) {
          return reply(res, 401, { error: 'invalid_client' })
        }
        if (input.get('grant_type') === 'authorization_code') {
          if (!codes.delete(input.get('code') || '')) return reply(res, 400, { error: 'invalid_grant' })
        } else if (input.get('grant_type') !== 'refresh_token' || input.get('refresh_token') !== 'demo-refresh-token') {
          return reply(res, 400, { error: 'invalid_grant' })
        }
        return reply(res, 200, {
          access_token: 'demo-access-token', refresh_token: 'demo-refresh-token', token_type: 'Bearer',
          expires_in: options.tokenLifetime ?? 7200, sub: '900000000000000001', name: 'Morgan Lee', email: 'morgan@example.com',
        })
      }
      if (req.headers.authorization !== 'Bearer demo-access-token') return reply(res, 401, { error: { message: 'Unauthorized' } })
      const match = url.pathname.match(/^\/api\/compose\/namespace\/100\/module\/(200|300)\/record\/(\d+)?$/)
      if (!match) return reply(res, 404, { error: { message: 'Not found' } })
      const [, moduleID, id] = match
      if (req.method === 'GET' && !id) {
        const all = moduleID === '300' ? customers : [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        const offset = Number(url.searchParams.get('pageCursor') || 0)
        const size = options.pageSize ?? 100
        return reply(res, 200, { response: { set: all.slice(offset, offset + size), filter: { nextPage: offset + size < all.length ? String(offset + size) : '' } } })
      }
      if (req.method === 'GET' && id) {
        const record = records.get(id)
        return record ? reply(res, 200, { response: record }) : reply(res, 404, { error: { message: 'Ticket not found.' } })
      }
      if (req.method === 'POST' && moduleID === '200') {
        const body = JSON.parse(raw) as { values: RecordValue[]; updatedAt?: string }
        const get = (name: string): string => body.values.find(value => value.name === name)?.value || ''
        if (!get('Subject').trim() || !['New', 'In Progress', 'Resolved', 'Closed'].includes(get('Status'))
          || !['Low', 'Medium', 'High', 'Urgent'].includes(get('Priority'))) {
          return reply(res, 200, { error: { message: 'Subject, status, and priority are required.' } })
        }
        const previous = id ? records.get(id) : undefined
        if (id && !previous) return reply(res, 404, { error: { message: 'Ticket not found.' } })
        if (previous?.updatedAt && body.updatedAt !== previous.updatedAt) return reply(res, 200, { error: { message: 'This record changed. Close and reopen the ticket before saving.' } })
        const record: CortezaRecord = {
          recordID: id || String(++sequence), createdAt: previous?.createdAt || new Date().toISOString(),
          updatedAt: id ? new Date().toISOString() : null, ownedBy: previous?.ownedBy || '900000000000000001',
          createdBy: previous?.createdBy || '900000000000000001', canUpdateRecord: true, values: body.values,
        }
        records.set(record.recordID, record)
        return reply(res, 200, { response: record })
      }
      return reply(res, 405, { error: { message: 'Method not allowed.' } })
    } catch { return reply(res, 400, { error: { message: 'Invalid demo request.' } }) }
  })
  return { server, requests, records }
}

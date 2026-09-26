import type { CortezaRecord, Customer, TicketDraft } from '../domain/tickets'
import { field, fromRecord, toRecordValues } from '../domain/tickets.ts'

export interface AppConfig {
  namespaceID: string
  ticketModuleID: string
  customerModuleID: string
  cortezaURL: string
  demo: boolean
  ready: boolean
}
export interface Session {
  authenticated: boolean
  csrfToken?: string
  user?: { name: string; email: string; id: string }
  config: AppConfig
}
interface Envelope<T> { response?: T; error?: { message?: string; details?: unknown } | string }
interface RecordPage { set: CortezaRecord[]; filter?: { nextPage?: string } }
let csrfToken = ''

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.method === 'POST' ? { 'X-CSRF-Token': csrfToken } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(25_000),
    })
  } catch {
    throw new ApiError('The server could not be reached. Check your connection and try again.', 0)
  }
  const body = await response.json().catch(() => null) as Envelope<T> | null
  if (!response.ok || body?.error || body?.response === undefined) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message
    if (response.status === 401) window.dispatchEvent(new Event('session-expired'))
    throw new ApiError(message || `Request failed (${response.status}).`, response.status)
  }
  return body.response
}

export async function getSession(): Promise<Session> {
  const session = await request<Session>('/app/session')
  csrfToken = session.csrfToken ?? ''
  return session
}

export async function logout(): Promise<void> {
  await request<boolean>('/auth/logout', { method: 'POST' })
  csrfToken = ''
}

function recordPath(config: AppConfig, moduleID: string, id = ''): string {
  for (const value of [config.namespaceID, moduleID, ...(id ? [id] : [])]) {
    if (!/^\d+$/.test(value)) throw new Error('Configure the numeric namespace and module IDs in .env.')
  }

  return `/api/compose/namespace/${config.namespaceID}/module/${moduleID}/record/${id}`
}

export async function listRecords(config: AppConfig, moduleID: string): Promise<CortezaRecord[]> {
  const records = new Map<string, CortezaRecord>()
  const cursors = new Set<string>()
  let cursor = ''
  // Follow Corteza's cursor pagination instead of assuming the first page is the full dataset.
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({ limit: '100', sort: 'createdAt DESC' })
    if (cursor) params.set('pageCursor', cursor)
    const result = await request<RecordPage>(`${recordPath(config, moduleID)}?${params}`)
    if (!Array.isArray(result.set)) throw new Error('Unexpected record list returned by Corteza.')
    for (const record of result.set) records.set(record.recordID, record)
    cursor = result.filter?.nextPage ?? ''
    if (!cursor) return [...records.values()]
    if (cursors.has(cursor)) throw new Error('Corteza returned a repeated pagination cursor.')
    cursors.add(cursor)
  }
  throw new Error('This workspace exceeds the 10,000-record client-side search limit. Add server-side filtering before using larger datasets.')
}

export async function listTickets(config: AppConfig) {
  return (await listRecords(config, config.ticketModuleID)).map(fromRecord)
}

export async function readTicket(config: AppConfig, id: string) {
  return fromRecord(await request<CortezaRecord>(recordPath(config, config.ticketModuleID, id)))
}

export async function listCustomers(config: AppConfig): Promise<Customer[]> {
  if (!config.customerModuleID) return []
  return (await listRecords(config, config.customerModuleID)).map(record => ({
    id: record.recordID, name: field(record, 'name') || `Customer ${record.recordID}`, email: field(record, 'email'),
  }))
}

export async function saveTicket(config: AppConfig, draft: TicketDraft, original?: CortezaRecord) {
  const body = {
    values: toRecordValues(draft, original, Boolean(config.customerModuleID)),
    // Echo Corteza's revision timestamp; never generate system metadata in the UI.
    ...(original?.updatedAt ? { updatedAt: original.updatedAt } : {}),
  }
  const saved = await request<CortezaRecord>(recordPath(config, config.ticketModuleID, original?.recordID), {
    method: 'POST', body: JSON.stringify(body),
  })
  return fromRecord(saved)
}

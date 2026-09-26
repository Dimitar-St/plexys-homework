export const statuses = ['New', 'In Progress', 'Resolved', 'Closed'] as const
export const priorities = ['Low', 'Medium', 'High', 'Urgent'] as const

export interface RecordValue { name: string; value: string; place?: number }
export interface CortezaRecord {
  recordID: string
  values: RecordValue[]
  createdAt: string
  updatedAt?: string | null
  ownedBy?: string
  createdBy?: string
  updatedBy?: string
  canUpdateRecord?: boolean
}
export interface TicketDraft {
  subject: string
  description: string
  status: string
  priority: string
  dueDate: string
  customer: string
}
export interface Ticket extends TicketDraft {
  id: string
  source: CortezaRecord
}
export interface Customer { id: string; name: string; email: string }

export function field(record: CortezaRecord, name: string): string {
  return record.values?.find(value => value.name === name)?.value ?? ''
}

export function fromRecord(record: CortezaRecord): Ticket {
  if (typeof record.recordID !== 'string') throw new Error('Corteza record IDs must be strings.')
  return {
    id: record.recordID,
    subject: field(record, 'Subject'), description: field(record, 'Description'),
    status: field(record, 'Status'), priority: field(record, 'Priority'),
    dueDate: field(record, 'DueDate'), customer: field(record, 'Customer'),
    source: record,
  }
}

export function blankDraft(): TicketDraft {
  return { subject: '', description: '', status: 'New', priority: 'Medium', dueDate: '', customer: '' }
}

export function localDateInput(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function validateDraft(draft: TicketDraft): Partial<Record<keyof TicketDraft, string>> {
  const errors: Partial<Record<keyof TicketDraft, string>> = {}
  if (!draft.subject.trim()) errors.subject = 'Enter a subject.'
  if (!(statuses as readonly string[]).includes(draft.status)) errors.status = 'Choose a status.'
  if (!(priorities as readonly string[]).includes(draft.priority)) errors.priority = 'Choose a priority.'
  if (draft.dueDate && Number.isNaN(new Date(draft.dueDate).getTime())) errors.dueDate = 'Enter a valid date and time.'
  if (draft.customer && !/^\d+$/.test(draft.customer)) errors.customer = 'Choose a valid customer.'
  return errors
}

export function toRecordValues(draft: TicketDraft, original?: CortezaRecord, includeCustomer = false): RecordValue[] {
  const errors = validateDraft(draft)
  if (Object.keys(errors).length) throw new Error(Object.values(errors).join(' '))
  const editedNames = new Set(['Subject', 'Description', 'Status', 'Priority', 'DueDate'])
  if (includeCustomer) editedNames.add('Customer')
  // Preserve additional fields, including an existing customer when its module is not configured.
  const values = (original?.values ?? []).filter(value => !editedNames.has(value.name))
    .map(({ name, value, place }) => ({ name, value, ...(place !== undefined ? { place } : {}) }))
  const inputs: Record<string, string> = {
    Subject: draft.subject.trim(), Description: draft.description,
    Status: draft.status, Priority: draft.priority,
    DueDate: draft.dueDate ? new Date(draft.dueDate).toISOString() : '',
    ...(includeCustomer ? { Customer: draft.customer } : {}),
  }
  // Corteza receives the full values set. Omitting an optional value clears it on update.
  for (const [name, value] of Object.entries(inputs)) if (value !== '') values.push({ name, value })
  return values
}

export function isOpen(ticket: Ticket): boolean {
  return ticket.status === 'New' || ticket.status === 'In Progress'
}

export function formatDate(iso?: string | null, withTime = false): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }).format(date)
}

export function tone(value: string): string { return value.toLowerCase().replaceAll(' ', '-') }

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getSession, listCustomers, listTickets, logout, readTicket, saveTicket } from './api/corteza'
import type { Session } from './api/corteza'
import { formatDate, isOpen, priorities, statuses, tone } from './domain/tickets'
import type { Customer, Ticket, TicketDraft } from './domain/tickets'
import AppIcon from './components/AppIcon.vue'
import TicketDialog from './components/TicketDialog.vue'

const session = ref<Session>()
const tickets = ref<Ticket[]>([])
const customers = ref<Customer[]>([])
const initializing = ref(true)
const loading = ref(false)
const opening = ref('')
const saving = ref(false)
const error = ref('')
const customerError = ref('')
const saveError = ref('')
const toast = ref('')
const search = ref('')
const statusFilter = ref('')
const priorityFilter = ref('')
const activeView = ref<'all' | 'open'>('all')
const showDialog = ref(false)
const selected = ref<Ticket>()
let toastTimer: ReturnType<typeof setTimeout> | undefined
const customerNames = computed(() => new Map(customers.value.map(customer => [customer.id, customer.name])))
const openCount = computed(() => tickets.value.filter(isOpen).length)
const urgentCount = computed(() => tickets.value.filter(ticket => isOpen(ticket) && ticket.priority === 'Urgent').length)
const resolvedCount = computed(() => tickets.value.filter(ticket => ticket.status === 'Resolved' || ticket.status === 'Closed').length)
const filtered = computed(() => tickets.value.filter(ticket => {
  const term = search.value.trim().toLocaleLowerCase()
  return (activeView.value === 'all' || isOpen(ticket))
    && (!statusFilter.value || ticket.status === statusFilter.value)
    && (!priorityFilter.value || ticket.priority === priorityFilter.value)
    && (!term || [ticket.subject, ticket.description, ticket.id, customerNames.value.get(ticket.customer) ?? ''].join(' ').toLocaleLowerCase().includes(term))
}))
const hasFilters = computed(() => search.value || statusFilter.value || priorityFilter.value || activeView.value !== 'all')
const initials = computed(() => (session.value?.user?.name || session.value?.user?.email || 'U').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase())
const friendly = (cause: unknown) => cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'
const customerLabel = (id: string) => customerNames.value.get(id) || (id ? `Customer ${id.slice(-6)}` : '—')

async function initialize() {
  initializing.value = true
  error.value = ''
  try {
    session.value = await getSession()
    if (new URLSearchParams(location.search).has('auth_error')) {
      error.value = 'Sign-in could not be completed. Try again or check the Corteza auth client configuration.'
      history.replaceState(null, '', location.pathname)
    }
    if (session.value.authenticated) await refresh()
  } catch (cause) { error.value = friendly(cause) }
  finally { initializing.value = false }
}

async function refresh() {
  if (!session.value?.authenticated || loading.value) return
  loading.value = true
  error.value = ''
  customerError.value = ''
  const config = session.value.config
  const results = await Promise.allSettled([listTickets(config), listCustomers(config)])
  // A logout or expired session must not repopulate private data from an in-flight request.
  if (session.value?.authenticated) {
    if (results[0].status === 'fulfilled') tickets.value = results[0].value
    else error.value = friendly(results[0].reason)
    if (results[1].status === 'fulfilled') customers.value = results[1].value
    else customerError.value = 'Customer records could not be loaded. Existing links will be preserved.'
  }
  loading.value = false
}

function createTicket() { selected.value = undefined; saveError.value = ''; showDialog.value = true }
async function openTicket(ticket: Ticket) {
  if (opening.value || !session.value) return
  opening.value = ticket.id
  try {
    const latest = await readTicket(session.value.config, ticket.id)
    if (!session.value?.authenticated) return
    selected.value = latest
    saveError.value = ''
    showDialog.value = true
  } catch (cause) { error.value = friendly(cause) }
  finally { opening.value = '' }
}
async function submit(draft: TicketDraft) {
  if (!session.value || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    const record = await saveTicket(session.value.config, draft, selected.value?.source)
    if (!session.value?.authenticated) return
    const existing = tickets.value.findIndex(ticket => ticket.id === record.id)
    if (existing >= 0) tickets.value.splice(existing, 1, record)
    else tickets.value.unshift(record)
    showDialog.value = false
    toast.value = selected.value ? 'Ticket updated' : 'Ticket created'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast.value = '' }, 4000)
  } catch (cause) { saveError.value = friendly(cause) }
  finally { saving.value = false }
}
function clearFilters() { search.value = ''; statusFilter.value = ''; priorityFilter.value = ''; activeView.value = 'all' }
function clearPrivateState() { tickets.value = []; customers.value = []; showDialog.value = false; selected.value = undefined }
function expired() {
  if (session.value) session.value.authenticated = false
  clearPrivateState()
  error.value = 'Your session has expired. Sign in again to continue.'
}
async function signOut() {
  try {
    await logout()
    if (session.value) session.value.authenticated = false
    clearPrivateState()
    error.value = ''
  } catch (cause) { error.value = friendly(cause) }
}
onMounted(() => { window.addEventListener('session-expired', expired); initialize() })
onUnmounted(() => { window.removeEventListener('session-expired', expired); clearTimeout(toastTimer) })
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="Plexys home"><span class="brand-mark"><i /><i /><i /><i /></span>Plexys<span class="brand-period">.</span></a>
      <div class="workspace-card"><span class="workspace-avatar">P</span><div><strong>Homework</strong><span>Support workspace</span></div><span class="workspace-dot" /></div>
      <p class="nav-label">WORKSPACE</p>
      <nav aria-label="Workspace navigation">
        <button :class="['nav-item', { active: activeView === 'all' }]" @click="activeView = 'all'"><AppIcon name="ticket" /><span>All tickets</span><span v-if="session?.authenticated" class="nav-count">{{ tickets.length }}</span></button>
        <button :class="['nav-item', { active: activeView === 'open' }]" @click="activeView = 'open'"><AppIcon name="inbox" /><span>Open requests</span><span v-if="session?.authenticated" class="nav-count">{{ openCount }}</span></button>
      </nav>
      <div class="sidebar-bottom">
        <div class="support-note"><span class="note-icon"><AppIcon name="check" :size="17" /></span><strong>A little clarity goes a long way.</strong><p>Every request, one place.<br />Make the next step a good one.</p></div>
        <a v-if="session?.config.ready && !session.config.demo" class="corteza-link" :href="session.config.cortezaURL" target="_blank" rel="noopener noreferrer">Open Corteza <AppIcon name="external" :size="14" /></a>
        <p class="sidebar-caption">PLEXYS · SUPPORT OPERATIONS</p>
      </div>
    </aside>

    <div class="main-shell">
      <header class="topbar">
        <span class="breadcrumb">Workspace <span>/</span> <strong>Support tickets</strong></span>
        <div v-if="session?.authenticated" class="profile"><span class="profile-avatar">{{ initials }}</span><span class="profile-name">{{ session.user?.name || session.user?.email || 'Your workspace' }}</span><button class="icon-button" aria-label="Sign out of workspace" title="Sign out of workspace" @click="signOut"><AppIcon name="logout" :size="18" /></button></div>
        <span v-else class="topbar-label">A place for better support</span>
      </header>

      <main>
        <div v-if="session?.config.demo" class="demo-banner"><span class="demo-dot" /> Demo workspace · Sample data only. Changes are temporary.</div>
        <div v-if="initializing" class="initial-state" role="status"><span class="spinner" /> Opening your workspace…</div>
        <section v-else-if="!session?.authenticated" class="welcome">
          <div class="welcome-art" aria-hidden="true"><AppIcon name="ticket" :size="44" /><span class="art-check"><AppIcon name="check" :size="19" /></span></div>
          <p class="eyebrow">WELCOME TO PLEXYS</p>
          <h1>Good support starts<br />with a clear view.</h1>
          <p class="welcome-copy">Track requests, set priorities, and keep your customers moving forward. Your support workspace is ready for you.</p>
          <div v-if="error" class="notice error" role="alert"><AppIcon name="alert" /><span>{{ error }}</span><button v-if="!session" class="text-button" @click="initialize">Retry</button></div>
          <div v-if="session && !session.config.ready" class="notice" role="status">Connection setup is incomplete. Add your Corteza client and module IDs to the server environment, then restart.</div>
          <a v-else-if="session?.config.ready" class="button primary sign-in" href="/auth/login">{{ session.config.demo ? 'Explore the demo' : 'Sign in with Corteza' }}<AppIcon name="arrow" :size="18" /></a>
          <div class="welcome-points"><span><AppIcon name="check" :size="15" /> One shared queue</span><span><AppIcon name="check" :size="15" /> Clear priorities</span><span><AppIcon name="check" :size="15" /> Customer context</span></div>
        </section>

        <template v-else>
          <section class="page-heading"><div><p class="eyebrow">YOUR SUPPORT WORKSPACE</p><h1>Support tickets<span class="title-dot">.</span></h1><p>Every request has a next step. Find yours.</p></div><button class="button primary" @click="createTicket"><AppIcon name="plus" :size="18" />New ticket</button></section>
          <section class="stats" aria-label="Ticket summary">
            <div class="stat-card"><div><span>Open requests</span><strong>{{ openCount }}</strong><small>New &amp; in progress</small></div><span class="stat-icon green"><AppIcon name="inbox" :size="23" /></span></div>
            <div class="stat-card"><div><span>Urgent attention</span><strong>{{ urgentCount }}</strong><small>Open tickets with urgent priority</small></div><span class="stat-icon orange"><AppIcon name="clock" :size="23" /></span></div>
            <div class="stat-card"><div><span>Completed</span><strong>{{ resolvedCount }}</strong><small>Resolved &amp; closed</small></div><span class="stat-icon purple"><AppIcon name="check" :size="23" /></span></div>
          </section>
          <div v-if="error" class="notice error" role="alert"><AppIcon name="alert" /><span>{{ error }}</span><button class="text-button" :disabled="loading" @click="refresh">Retry</button></div>
          <div v-if="customerError" class="notice" role="status"><AppIcon name="alert" /><span>{{ customerError }}</span></div>

          <section class="ticket-panel" aria-labelledby="queue-heading">
            <header class="panel-heading"><div><h2 id="queue-heading">{{ activeView === 'all' ? 'All tickets' : 'Open requests' }}</h2><span class="count-pill">{{ filtered.length }}</span></div><span class="panel-caption">A little progress, every day.</span></header>
            <div class="toolbar">
              <div class="search-field"><AppIcon name="search" :size="18" /><input v-model="search" aria-label="Search tickets" type="search" placeholder="Search tickets or customers…" /></div>
              <select v-model="statusFilter" aria-label="Filter by status"><option value="">All statuses</option><option v-for="status in statuses" :key="status">{{ status }}</option></select>
              <select v-model="priorityFilter" aria-label="Filter by priority"><option value="">All priorities</option><option v-for="priority in priorities" :key="priority">{{ priority }}</option></select>
              <button class="icon-button refresh-button" aria-label="Refresh tickets" :disabled="loading" @click="refresh"><AppIcon name="refresh" :class="{ spinning: loading }" :size="18" /></button>
            </div>

            <div v-if="loading && !tickets.length" class="list-state" role="status"><span class="spinner" />Loading tickets…</div>
            <div v-else-if="!filtered.length" class="empty-state"><span class="empty-icon"><AppIcon :name="hasFilters ? 'search' : 'inbox'" :size="28" /></span><h3>{{ hasFilters ? 'No matching tickets' : error ? 'Tickets are unavailable' : 'A fresh start' }}</h3><p>{{ hasFilters ? 'Try another search or clear your filters.' : error ? 'Check the connection and try loading again.' : 'Create your first ticket and keep everything in one place.' }}</p><button v-if="hasFilters" class="button secondary" @click="clearFilters">Clear filters</button><button v-else-if="!error" class="button secondary" @click="createTicket"><AppIcon name="plus" :size="16" />Create a ticket</button></div>
            <div v-else class="table-scroll">
              <table><thead><tr><th scope="col">Ticket</th><th scope="col">Status</th><th scope="col">Priority</th><th v-if="session.config.customerModuleID" scope="col">Customer</th><th scope="col">Due date</th><th scope="col"><span class="sr-only">Open ticket</span></th></tr></thead>
                <tbody><tr v-for="ticket in filtered" :key="ticket.id">
                  <td class="subject-cell"><button class="ticket-title" :disabled="!!opening" @click="openTicket(ticket)">{{ ticket.subject || 'Untitled ticket' }}</button><span class="ticket-subtitle">#{{ ticket.id.slice(-6) }}<span>·</span>{{ formatDate(ticket.source.createdAt) }}</span></td>
                  <td><span :class="['status-badge', tone(ticket.status)]"><i />{{ ticket.status || 'Not set' }}</span></td>
                  <td><span :class="['priority-label', tone(ticket.priority)]"><i />{{ ticket.priority || 'Not set' }}</span></td>
                  <td v-if="session.config.customerModuleID" class="customer-cell">{{ customerLabel(ticket.customer) }}</td>
                  <td class="date-cell">{{ formatDate(ticket.dueDate) }}</td>
                  <td><button class="icon-button row-arrow" :aria-label="`Open ${ticket.subject}`" :disabled="!!opening" @click="openTicket(ticket)"><span v-if="opening === ticket.id" class="spinner" /><AppIcon v-else name="chevron" :size="17" /></button></td>
                </tr></tbody>
              </table>
            </div>
            <footer class="table-footer"><span>{{ filtered.length }} of {{ tickets.length }} tickets</span><button v-if="hasFilters" class="text-button" @click="clearFilters">Clear filters</button><span v-else class="live-caption"><i />{{ session.config.demo ? 'Demo data' : error ? 'Refresh needed' : loading ? 'Refreshing…' : 'Loaded from Corteza' }}</span></footer>
          </section>
          <p class="page-footnote">Small steps. Better support.</p>
        </template>
      </main>
    </div>
    <TicketDialog v-if="showDialog" :key="selected?.id || 'new'" :ticket="selected" :customers="customers" :has-customer="!!session?.config.customerModuleID" :saving="saving" :error="saveError" @close="showDialog = false" @save="submit" />
    <div v-if="toast" class="toast" role="status"><span><AppIcon name="check" :size="17" /></span>{{ toast }}</div>
  </div>
</template>

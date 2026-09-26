<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { blankDraft, formatDate, localDateInput, priorities, statuses, validateDraft } from '../domain/tickets'
import type { Customer, Ticket, TicketDraft } from '../domain/tickets'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ ticket?: Ticket; customers: Customer[]; hasCustomer: boolean; saving: boolean; error: string }>()
const emit = defineEmits<{ close: []; save: [draft: TicketDraft] }>()
const dialog = ref<HTMLDialogElement>()
const draft = reactive<TicketDraft>(props.ticket ? {
  subject: props.ticket.subject, description: props.ticket.description, status: props.ticket.status,
  priority: props.ticket.priority, dueDate: localDateInput(props.ticket.dueDate), customer: props.ticket.customer,
} : blankDraft())
const errors = ref<Partial<Record<keyof TicketDraft, string>>>({})
const readOnly = computed(() => props.ticket?.source.canUpdateRecord === false)
const missingCustomer = computed(() => draft.customer && !props.customers.some(customer => customer.id === draft.customer))
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
onMounted(() => dialog.value?.showModal())

function submit() {
  errors.value = validateDraft(draft)
  if (Object.keys(errors.value).length || props.saving || readOnly.value) return
  emit('save', { ...draft })
}
function close() { if (!props.saving) emit('close') }
</script>

<template>
  <dialog ref="dialog" class="ticket-dialog" aria-labelledby="ticket-dialog-title" @cancel.prevent="close" @click="event => { if (event.target === dialog) close() }">
    <form @submit.prevent="submit">
      <header class="dialog-header">
        <div>
          <p class="eyebrow">{{ ticket ? `TICKET · ${ticket.id}` : 'SUPPORT WORKSPACE' }}</p>
          <h2 id="ticket-dialog-title">{{ ticket ? 'Ticket details' : 'Create a ticket' }}</h2>
          <p>{{ readOnly ? 'You have view-only access to this ticket.' : 'Keep the details clear. We’ll take it from here.' }}</p>
        </div>
        <button type="button" class="icon-button" aria-label="Close ticket" :disabled="saving" @click="close"><AppIcon name="close" /></button>
      </header>
      <div class="dialog-body">
        <div v-if="error" class="notice error" role="alert"><AppIcon name="alert" /><span>{{ error }}</span></div>
        <fieldset :disabled="saving || readOnly">
          <label for="subject">Subject <span class="required">*</span></label>
          <input id="subject" v-model="draft.subject" required autofocus placeholder="What do you need help with?" :aria-invalid="!!errors.subject" :aria-describedby="errors.subject ? 'subject-error' : undefined" />
          <small v-if="errors.subject" id="subject-error" class="field-error">{{ errors.subject }}</small>

          <label for="description">Description <span class="optional">Optional</span></label>
          <textarea id="description" v-model="draft.description" rows="5" placeholder="Add context, steps to reproduce, or anything that could help…" />

          <div class="form-grid">
            <div>
              <label for="status">Status <span class="required">*</span></label>
              <select id="status" v-model="draft.status" required :aria-invalid="!!errors.status">
                <option value="" disabled>Select status</option>
                <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
              </select>
              <small v-if="errors.status" class="field-error">{{ errors.status }}</small>
            </div>
            <div>
              <label for="priority">Priority <span class="required">*</span></label>
              <select id="priority" v-model="draft.priority" required :aria-invalid="!!errors.priority">
                <option value="" disabled>Select priority</option>
                <option v-for="priority in priorities" :key="priority" :value="priority">{{ priority }}</option>
              </select>
              <small v-if="errors.priority" class="field-error">{{ errors.priority }}</small>
            </div>
          </div>

          <label for="due-date">Due date <span class="optional">Optional</span></label>
          <input id="due-date" v-model="draft.dueDate" type="datetime-local" :aria-invalid="!!errors.dueDate" aria-describedby="date-hint" />
          <small id="date-hint" class="hint">Local time · {{ timezone }}</small>
          <small v-if="errors.dueDate" class="field-error">{{ errors.dueDate }}</small>

          <template v-if="hasCustomer">
            <label for="customer">Customer <span class="optional">Optional</span></label>
            <select id="customer" v-model="draft.customer">
              <option value="">No customer linked</option>
              <option v-if="missingCustomer" :value="draft.customer">Linked customer · {{ draft.customer }}</option>
              <option v-for="customer in customers" :key="customer.id" :value="customer.id">{{ customer.name }}{{ customer.email ? ` · ${customer.email}` : '' }}</option>
            </select>
          </template>
        </fieldset>

        <section v-if="ticket" class="metadata" aria-label="System record information">
          <p class="eyebrow">RECORD INFORMATION</p>
          <dl>
            <div><dt>Created</dt><dd>{{ formatDate(ticket.source.createdAt, true) }}</dd></div>
            <div><dt>Last updated</dt><dd>{{ formatDate(ticket.source.updatedAt, true) }}</dd></div>
            <div><dt>Owner ID</dt><dd>{{ ticket.source.ownedBy && ticket.source.ownedBy !== '0' ? ticket.source.ownedBy : 'Unassigned' }}</dd></div>
          </dl>
        </section>
      </div>
      <footer class="dialog-footer">
        <span>{{ readOnly ? 'View only' : '* Required fields' }}</span>
        <div class="button-group">
          <button type="button" class="button secondary" :disabled="saving" @click="close">{{ readOnly ? 'Close' : 'Cancel' }}</button>
          <button v-if="!readOnly" type="submit" class="button primary" :disabled="saving">
            <span v-if="saving" class="spinner" />
            <AppIcon v-else :name="ticket ? 'check' : 'plus'" :size="17" />
            {{ saving ? 'Saving…' : ticket ? 'Save changes' : 'Create ticket' }}
          </button>
        </div>
      </footer>
    </form>
  </dialog>
</template>

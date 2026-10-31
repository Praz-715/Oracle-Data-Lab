<script setup lang="ts">
import type { ConnectionProfile } from '~~/shared/types/lab'

useHead({ title: 'Connections · OracleDB Data Lab' })
const { profiles, activeId, active, environment, envError, refresh, select, loadEnvironment } = useActiveProfile()
const { push } = useToasts()

const editing = ref<ConnectionProfile | null>(null)
const formOpen = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)

const pool = useLoader<any[]>(() => (activeId.value ? `/api/connections/${activeId.value}/pool` : null))
usePolling(() => pool.load(), 5000)

function openNew() {
  editing.value = null
  formOpen.value = true
}
function openEdit(p: ConnectionProfile) {
  editing.value = p
  formOpen.value = true
}
async function onSaved(p: ConnectionProfile) {
  formOpen.value = false
  await refresh()
  select(p.id)
  await loadEnvironment()
}
async function remove() {
  if (!active.value) return
  deleting.value = true
  try {
    await api(`/api/connections/${active.value.id}`, { method: 'DELETE' })
    push({ tone: 'ok', title: `Deleted “${active.value.name}”` })
    deleteOpen.value = false
    select(null)
    await refresh()
  } catch (err) {
    push({ tone: 'bad', title: 'Delete failed', detail: apiErrorMessage(err) })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Connections</h1>
        <p>Oracle connection profiles. Credentials are encrypted and kept server-side; the browser never connects to Oracle directly.</p>
      </div>
      <button class="btn primary" @click="openNew"><Icon name="lucide:plus" size="15" /> New connection</button>
    </div>

    <div class="grid two">
      <UiCard title="Profiles" icon="lucide:plug" flush>
        <UiDataTable
          :columns="[
            { key: 'name', label: 'Name' },
            { key: 'target', label: 'Target', mono: true, maxWidth: '260px', format: (_, r) => r.method === 'descriptor' ? 'descriptor' : `${r.host}:${r.port}/${r.method === 'sid' ? r.sid : r.serviceName}` },
            { key: 'username', label: 'User', mono: true },
            { key: 'mode', label: 'Mode', tone: (v) => (v === 'lab' ? 'warn' : 'ok') },
          ]"
          :rows="profiles"
          row-key="id"
          :selected-key="activeId"
          clickable
          empty-text="No profiles yet — create one to get started."
          @row-click="(r) => select(r.id)"
        />
      </UiCard>

      <UiCard :title="active ? `Environment · ${active.name}` : 'Environment'" icon="lucide:server">
        <template #actions>
          <template v-if="active">
            <button class="btn sm" @click="loadEnvironment"><Icon name="lucide:refresh-cw" size="13" /> Re-test</button>
            <button class="btn sm" @click="openEdit(active)"><Icon name="lucide:pencil" size="13" /> Edit</button>
            <button class="btn sm ghost" aria-label="Delete profile" @click="deleteOpen = true"><Icon name="lucide:trash-2" size="13" /></button>
          </template>
        </template>
        <div v-if="!active" class="subtle">Select or create a profile.</div>
        <div v-else-if="envError" class="callout bad" role="alert">
          <Icon name="lucide:plug-zap" size="16" />
          <div>{{ envError }}</div>
        </div>
        <div v-else-if="!environment" class="subtle">Connecting…</div>
        <DatabaseEnvironmentSummary v-else :env="environment" />
        <div v-if="active" class="stack" style="margin-top: 14px">
          <div class="row">
            <span class="subtle">Write access:</span>
            <span v-if="active.mode !== 'lab'" class="badge ok">read-only</span>
            <template v-else>
              <span class="badge warn">lab mode</span>
              <span v-for="s in active.allowedSchemas" :key="s" class="badge plain mono">{{ s }}</span>
              <span v-if="!active.allowedSchemas.length" class="subtle">no schemas authorized</span>
            </template>
          </div>
        </div>
      </UiCard>
    </div>

    <UiCard v-if="active" title="Connection pools (this app → Oracle)" icon="lucide:waypoints" style="margin-top: 16px" flush>
      <UiDataTable
        :columns="[
          { key: 'purpose', label: 'Pool' },
          { key: 'status', label: 'Status', format: (v, r) => (r.open ? v : 'not opened'), tone: (_, r) => (r.open ? 'ok' : '') },
          { key: 'connectionsInUse', label: 'In use', num: true },
          { key: 'connectionsOpen', label: 'Open', num: true },
          { key: 'poolMax', label: 'Max', num: true },
          { key: 'queueLength', label: 'Queued', num: true },
          { key: 'totalRequests', label: 'Requests', num: true },
          { key: 'failedRequests', label: 'Failed', num: true },
          { key: 'requestTimeouts', label: 'Timeouts', num: true },
          { key: 'averageTimeInQueueMs', label: 'Avg queue ms', num: true },
        ]"
        :rows="pool.data.value ?? []"
        row-key="purpose"
      />
    </UiCard>

    <UiDialog v-model="formOpen" :title="editing ? `Edit ${editing.name}` : 'New connection'" :width="760">
      <DatabaseConnectionForm :profile="editing" @saved="onSaved" @cancel="formOpen = false" />
    </UiDialog>

    <UiConfirm v-model="deleteOpen" title="Delete connection profile" confirm-label="Delete profile" danger :busy="deleting" @confirm="remove">
      <p>Delete <strong>{{ active?.name }}</strong>? This removes the saved profile and its encrypted password from this app. Nothing in the database is touched.</p>
    </UiConfirm>
  </div>
</template>

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
// Diagnostics Pack license confirmation (per profile, audited server-side).
const licenseOpen = ref(false)
const licenseAck = ref(false)
const licenseBusy = ref(false)
const license = useLoader<{ enabled: boolean; changedAt: string | null; packAccess: string | null }>(
  () => (licenseOpen.value && activeId.value ? `/api/connections/${activeId.value}/diagnostics-pack` : null),
)
function openLicense() {
  licenseAck.value = false
  licenseOpen.value = true
}
async function setLicense(enabled: boolean) {
  if (!active.value) return
  licenseBusy.value = true
  try {
    await api(`/api/connections/${active.value.id}/diagnostics-pack`, { method: 'POST', body: { enabled, confirmLicensed: enabled && licenseAck.value } })
    push({ tone: enabled ? 'warn' : 'ok', title: enabled ? 'Diagnostics Pack confirmed' : 'Diagnostics Pack turned off', detail: enabled ? 'ASH and AWR will be used for this profile. Recorded in the audit log.' : 'Only ASH-lite is used for this profile.' })
    licenseOpen.value = false
    await refresh()
  } catch (err) {
    push({ tone: 'bad', title: 'Could not change the license setting', detail: apiErrorMessage(err) })
  } finally {
    licenseBusy.value = false
  }
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
          <div class="row">
            <span class="subtle">Licensed packs:</span>
            <span v-if="active.diagnosticsPack" class="badge warn"><Icon name="lucide:badge-check" size="12" /> Diagnostics Pack confirmed</span>
            <span v-else class="badge ok">none — ASH-lite only</span>
            <button class="btn sm ghost" @click="openLicense">{{ active.diagnosticsPack ? 'Change…' : 'Confirm Diagnostics Pack license…' }}</button>
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

    <UiDialog v-model="licenseOpen" :title="`Oracle Diagnostics Pack · ${active?.name ?? ''}`" :width="620">
      <div v-if="active" class="stack">
        <div class="callout bad" role="alert">
          <Icon name="lucide:octagon-alert" size="18" />
          <div>
            <strong>Licensing warning — read before enabling.</strong>
            <p class="m">
              ASH (<span class="mono">V$ACTIVE_SESSION_HISTORY</span>) and AWR (<span class="mono">DBMS_WORKLOAD_REPOSITORY</span>, <span class="mono">DBA_HIST_*</span>)
              are part of the separately licensed <strong>Oracle Diagnostics Pack</strong> (Enterprise Edition only). Querying them counts as usage
              and is recorded in <span class="mono">DBA_FEATURE_USAGE_STATISTICS</span>, which Oracle can audit — even if the data is readable.
            </p>
            <p class="m">Only enable this for databases you <strong>know</strong> are licensed. When in doubt, leave it off: ASH-lite gives you the same views from <span class="mono">V$SESSION</span> without a license.</p>
          </div>
        </div>
        <dl class="kv">
          <dt>Database</dt><dd>{{ environment ? `${environment.dbName} · ${environment.edition} · ${environment.serverVersion}` : '—' }}</dd>
          <dt>control_management_pack_access</dt>
          <dd>
            <span class="mono">{{ license.data.value?.packAccess ?? '…' }}</span>
            <span class="subtle"> — the database setting only enables the features; it is <strong>not</strong> proof of a license.</span>
          </dd>
          <dt>Current state</dt><dd>{{ active.diagnosticsPack ? `Confirmed ${fmtDate(license.data.value?.changedAt ?? null)}` : 'Not confirmed (ASH/AWR never queried)' }}</dd>
        </dl>
        <div v-if="environment && !/enterprise/i.test(environment.edition)" class="callout warn"><Icon name="lucide:triangle-alert" size="16" />This is {{ environment.edition }}: the Diagnostics Pack is only available for Enterprise Edition.</div>
        <label v-if="!active.diagnosticsPack" class="check"><input v-model="licenseAck" type="checkbox" > I confirm that <strong>{{ active.name }}</strong> is licensed for Oracle Diagnostics Pack.</label>
      </div>
      <template #footer>
        <button class="btn" @click="licenseOpen = false">Cancel</button>
        <button v-if="active?.diagnosticsPack" class="btn" :disabled="licenseBusy" @click="setLicense(false)">Turn off (ASH-lite only)</button>
        <button v-else class="btn danger" :disabled="!licenseAck || licenseBusy" @click="setLicense(true)">Enable ASH &amp; AWR</button>
      </template>
    </UiDialog>

    <UiConfirm v-model="deleteOpen" title="Delete connection profile" confirm-label="Delete profile" danger :busy="deleting" @confirm="remove">
      <p>Delete <strong>{{ active?.name }}</strong>? This removes the saved profile and its encrypted password from this app. Nothing in the database is touched.</p>
    </UiConfirm>
  </div>
</template>

<style scoped>
.m {
  margin: 6px 0 0;
}
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 12.5px;
}
.kv dt {
  color: var(--text-3);
}
.kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>

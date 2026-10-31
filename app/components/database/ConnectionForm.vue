<script setup lang="ts">
import type { ConnectionInput, ConnectionProfile, DbEnvironment } from '~~/shared/types/lab'

const props = defineProps<{ profile?: ConnectionProfile | null }>()
const emit = defineEmits<{ saved: [p: ConnectionProfile]; cancel: [] }>()
const { push } = useToasts()

const blank = (): ConnectionInput => ({
  name: '', host: 'localhost', port: 1521, method: 'service', serviceName: 'FREEPDB1', sid: '', descriptor: '',
  serverType: 'dedicated', username: '', password: '', privilege: 'none', walletLocation: '', walletPassword: '',
  useTls: false, mode: 'read-only', allowedSchemas: [], notes: '',
})
const form = reactive<ConnectionInput>(blank())
const schemasText = ref('')
watch(
  () => props.profile,
  (p) => {
    Object.assign(form, blank(), p ? { ...p, password: '', walletPassword: '' } : {})
    schemasText.value = (p?.allowedSchemas ?? []).join(', ')
  },
  { immediate: true },
)

const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; elapsedMs: number; environment?: DbEnvironment; error?: { code: string; message: string; hint?: string } } | null>(null)

function payload(): ConnectionInput {
  const p: ConnectionInput = {
    ...form,
    allowedSchemas: schemasText.value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
  }
  if (!p.password) delete p.password
  if (!p.walletPassword) delete p.walletPassword
  return p
}

async function test() {
  testing.value = true
  testResult.value = null
  try {
    // A saved profile with no new password is tested with its stored credentials.
    if (props.profile && !form.password) testResult.value = await api(`/api/connections/${props.profile.id}/test`, { method: 'POST' })
    else testResult.value = await api('/api/connections/test', { method: 'POST', body: payload() })
  } catch (err) {
    testResult.value = { ok: false, elapsedMs: 0, error: { code: 'REQUEST', message: apiErrorMessage(err) } }
  } finally {
    testing.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const saved = props.profile
      ? await api<ConnectionProfile>(`/api/connections/${props.profile.id}`, { method: 'PUT', body: payload() })
      : await api<ConnectionProfile>('/api/connections', { method: 'POST', body: payload() })
    form.password = ''
    form.walletPassword = ''
    push({ tone: 'ok', title: `Saved “${saved.name}”` })
    emit('saved', saved)
  } catch (err) {
    push({ tone: 'bad', title: 'Could not save profile', detail: apiErrorMessage(err) })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="stack" autocomplete="off" @submit.prevent="save">
    <div class="form-grid">
      <label class="field"><span>Profile name</span><input v-model="form.name" class="input" required placeholder="lab-19c" ></label>
      <label class="field">
        <span>Connect using</span>
        <select v-model="form.method" class="input">
          <option value="service">Service name</option>
          <option value="sid">SID</option>
          <option value="descriptor">Full descriptor / TNS alias</option>
        </select>
      </label>
      <template v-if="form.method !== 'descriptor'">
        <label class="field"><span>Host</span><input v-model="form.host" class="input" required ></label>
        <label class="field"><span>Port</span><input v-model.number="form.port" class="input" type="number" min="1" max="65535" ></label>
        <label v-if="form.method === 'service'" class="field"><span>Service name</span><input v-model="form.serviceName" class="input" placeholder="ORCLPDB1" ></label>
        <label v-else class="field"><span>SID</span><input v-model="form.sid" class="input" placeholder="ORCL" ></label>
        <label class="field">
          <span>Server type</span>
          <select v-model="form.serverType" class="input">
            <option value="dedicated">Dedicated</option>
            <option value="shared">Shared</option>
            <option value="pooled">Pooled (DRCP)</option>
            <option value="default">Listener default</option>
          </select>
        </label>
      </template>
      <label v-else class="field" style="grid-column: 1 / -1">
        <span>Connect descriptor or TNS alias</span>
        <textarea v-model="form.descriptor" class="input" rows="3" placeholder="(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCLPDB1)))" />
      </label>
      <label class="field"><span>Username</span><input v-model="form.username" class="input" required autocomplete="off" ></label>
      <label class="field">
        <span>Password</span>
        <input v-model="form.password" class="input" type="password" autocomplete="new-password" :placeholder="profile?.hasPassword ? '•••••• (unchanged)' : ''" >
        <small>Stored encrypted on the server, never shown again.</small>
      </label>
      <label class="field">
        <span>Privilege</span>
        <select v-model="form.privilege" class="input">
          <option value="none">Normal</option>
          <option value="sysdba">SYSDBA</option>
          <option value="sysoper">SYSOPER</option>
          <option value="sysbackup">SYSBACKUP</option>
          <option value="sysdg">SYSDG</option>
        </select>
        <small v-if="form.privilege !== 'none'">Privileged logins use standalone connections (no pool).</small>
      </label>
    </div>

    <details>
      <summary class="muted">TLS / wallet</summary>
      <div class="form-grid" style="margin-top: 10px">
        <label class="check"><input v-model="form.useTls" type="checkbox" > Use TCPS (TLS)</label>
        <label class="field"><span>Wallet location (server path)</span><input v-model="form.walletLocation" class="input" ></label>
        <label class="field"><span>Wallet password</span><input v-model="form.walletPassword" class="input" type="password" autocomplete="new-password" ></label>
      </div>
    </details>

    <div class="card safety">
      <div class="card-body stack">
        <div class="row">
          <Icon name="lucide:shield" size="16" />
          <strong>Safety</strong>
        </div>
        <div class="seg" role="group" aria-label="Access mode">
          <button type="button" :aria-pressed="form.mode === 'read-only'" @click="form.mode = 'read-only'">Read-only (default)</button>
          <button type="button" :aria-pressed="form.mode === 'lab'" @click="form.mode = 'lab'">Lab — allow writes</button>
        </div>
        <label class="field">
          <span>Authorized schemas for writes (DDL, data generation, write benchmarks, cleanup)</span>
          <input v-model="schemasText" class="input mono" placeholder="LAB, PERF_TEST" :disabled="form.mode !== 'lab'" >
          <small>Writes are refused for any schema not listed here. Never point lab mode at production.</small>
        </label>
      </div>
    </div>

    <label class="field"><span>Notes</span><input v-model="form.notes" class="input" placeholder="e.g. 19c EE single instance on lab VM" ></label>

    <AnimatePresence>
      <Motion v-if="testResult" key="r" as="div" :initial="{ opacity: 0, y: -4 }" :animate="{ opacity: 1, y: 0 }" :exit="{ opacity: 0 }">
        <div v-if="testResult.ok && testResult.environment" class="callout ok">
          <Icon name="lucide:circle-check" size="16" />
          <div>
            <strong>Connected in {{ testResult.elapsedMs }} ms.</strong>
            {{ testResult.environment.banner || testResult.environment.serverVersion }} ·
            {{ testResult.environment.databaseRole ?? 'role n/a' }} · {{ testResult.environment.instanceName ?? '' }}
            <span v-if="testResult.environment.containerName"> · container {{ testResult.environment.containerName }}</span>
          </div>
        </div>
        <div v-else class="callout bad" role="alert">
          <Icon name="lucide:plug-zap" size="16" />
          <div>
            <strong class="mono">{{ testResult.error?.code }}</strong> {{ testResult.error?.message }}
            <div v-if="testResult.error?.hint" class="muted">{{ testResult.error.hint }}</div>
          </div>
        </div>
      </Motion>
    </AnimatePresence>

    <div class="row">
      <button type="button" class="btn" :disabled="testing" @click="test">
        <Icon :name="testing ? 'lucide:loader-circle' : 'lucide:plug'" :class="{ spin: testing }" size="15" /> Test connection
      </button>
      <div class="spacer" />
      <button type="button" class="btn ghost" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="btn primary" :disabled="saving">{{ profile ? 'Save changes' : 'Save profile' }}</button>
    </div>
  </form>
</template>

<style scoped>
.safety {
  box-shadow: none;
  background: var(--bg-sunken);
}
details summary {
  cursor: pointer;
  font-size: 13px;
}
</style>

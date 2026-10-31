<script setup lang="ts">
import type { JobRecord, JobSummary } from '~~/shared/types/lab'

useHead({ title: 'Job History · OracleDB Data Lab' })
const route = useRoute()
const { activeId, writable } = useActiveProfile()
const { schema, prefix } = useLabTarget()
const { push } = useToasts()
const tab = ref(route.query.tab === 'cleanup' ? 'cleanup' : 'jobs')
const typeFilter = ref('')
const jobs = useLoader<JobSummary[]>(() => '/api/jobs', { query: () => ({ type: typeFilter.value || undefined, limit: 300 }) })
usePolling(() => jobs.load(), 5000)

const selected = ref<string | null>(typeof route.query.id === 'string' ? route.query.id : null)
const detail = useLoader<JobRecord>(() => (selected.value ? `/api/jobs/${selected.value}` : null))
const typeLabels: Record<string, string> = { 'schema-apply': 'Schema DDL', 'data-generate': 'Data generation', quality: 'Validation', benchmark: 'Benchmark', cleanup: 'Cleanup' }

// Cleanup manager
const mode = ref<'job-rows' | 'bench-rows' | 'drop-objects'>('job-rows')
const targetId = ref('')
const plan = ref<any>(null)
const planning = ref(false)
const confirmOpen = ref(false)
const runningCleanup = ref(false)
const cleanupJob = ref<string | null>(null)
const candidates = computed(() =>
  (jobs.data.value ?? []).filter((j) => j.profileId === activeId.value && (mode.value === 'job-rows' ? j.type === 'data-generate' : j.type === 'benchmark')),
)
async function planCleanup() {
  planning.value = true
  try {
    plan.value = await api('/api/cleanup/plan', { method: 'POST', body: { profileId: activeId.value, schema: schema.value, prefix: prefix.value, mode: mode.value, targetId: targetId.value || undefined } })
  } catch (err) {
    push({ tone: 'bad', title: 'Cleanup plan failed', detail: apiErrorMessage(err) })
  } finally {
    planning.value = false
  }
}
async function runCleanup() {
  runningCleanup.value = true
  try {
    const job = await api<JobRecord>('/api/cleanup/run', {
      method: 'POST',
      body: { profileId: activeId.value, schema: schema.value, prefix: prefix.value, mode: mode.value, targetId: targetId.value || undefined, confirmText: schema.value },
    })
    cleanupJob.value = job.id
    confirmOpen.value = false
    plan.value = null
  } catch (err) {
    push({ tone: 'bad', title: 'Cleanup refused', detail: apiErrorMessage(err) })
  } finally {
    runningCleanup.value = false
  }
}
watch(mode, () => ((plan.value = null), (targetId.value = '')))
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Job History</h1>
        <p>Every long operation runs as a persisted background job: configuration, progress, log, errors and results are kept. Interrupted or failed resumable jobs continue from their last checkpoint.</p>
      </div>
    </div>
    <div class="stack">
      <UiTabs v-model="tab" :tabs="[{ id: 'jobs', label: 'Jobs', count: jobs.data.value?.length ?? null }, { id: 'cleanup', label: 'Dataset cleanup' }]" />

      <div v-if="tab === 'jobs'" class="split">
        <UiCard title="Jobs" icon="lucide:list-checks" flush>
          <template #actions>
            <select v-model="typeFilter" class="input" style="width: 170px; height: 26px">
              <option value="">All types</option>
              <option v-for="(l, k) in typeLabels" :key="k" :value="k">{{ l }}</option>
            </select>
          </template>
          <UiDataTable
            :columns="[
              { key: 'createdAt', label: 'Created', format: (v) => fmtRelative(v) },
              { key: 'type', label: 'Type', format: (v) => typeLabels[v] ?? v },
              { key: 'title', label: 'Job', maxWidth: '320px' },
              { key: 'status', label: 'Status', tone: (v) => jobTone(v) },
            ]"
            :rows="jobs.data.value ?? []"
            row-key="id"
            :selected-key="selected"
            clickable
            max-height="680px"
            empty-text="No jobs yet."
            @row-click="(r) => (selected = r.id)"
          />
        </UiCard>

        <UiCard :title="detail.data.value?.title ?? 'Select a job'" icon="lucide:file-clock">
          <div v-if="!selected" class="subtle">Pick a job to see its details.</div>
          <div v-else-if="detail.error.value" class="callout bad">{{ detail.error.value }}</div>
          <div v-else-if="detail.data.value" class="stack">
            <JobsLive :key="selected" :job-id="selected" @settled="detail.load()" />
            <dl class="kv">
              <dt>Job id</dt><dd class="mono">{{ detail.data.value.id }}</dd>
              <dt>Type</dt><dd>{{ typeLabels[detail.data.value.type] }}</dd>
              <dt>Created</dt><dd>{{ fmtDate(detail.data.value.createdAt) }}</dd>
              <dt>Started</dt><dd>{{ fmtDate(detail.data.value.startedAt) }}</dd>
              <dt>Finished</dt><dd>{{ fmtDate(detail.data.value.finishedAt) }}</dd>
              <dt>Resumable</dt><dd>{{ detail.data.value.resumable ? 'yes' : 'no' }}{{ detail.data.value.checkpoint ? ' · checkpoint saved' : '' }}</dd>
            </dl>
            <NuxtLink v-if="detail.data.value.type === 'benchmark' && detail.data.value.result" :to="`/performance?job=${detail.data.value.id}`" class="btn sm" style="align-self: flex-start">Open benchmark result</NuxtLink>
            <details>
              <summary>Configuration</summary>
              <UiCode :code="JSON.stringify(detail.data.value.config, (k, v) => (k === 'steps' && Array.isArray(v) ? `${v.length} steps` : v), 2)" max-height="300px" />
            </details>
            <details v-if="detail.data.value.result">
              <summary>Result</summary>
              <UiCode :code="JSON.stringify(detail.data.value.result, null, 2)" max-height="400px" />
            </details>
            <details v-if="detail.data.value.checkpoint && detail.data.value.status !== 'succeeded'">
              <summary>Checkpoint</summary>
              <UiCode :code="JSON.stringify(detail.data.value.checkpoint, (k, v) => (k === 'refs' ? '(reference data ids)' : v), 2)" max-height="300px" />
            </details>
          </div>
        </UiCard>
      </div>

      <UiRequireProfile v-else writes>
        <div class="stack">
          <UiCard title="Backup dataset & cleanup manager" icon="lucide:eraser">
            <div class="stack">
              <p class="muted">Removes only what this lab created: rows tagged with a generation job id (DL_JOB_ID), rows a benchmark run wrote (RUN_ID), or objects carrying the lab prefix. It never drops users or schemas and never truncates.</p>
              <div class="form-grid">
                <label class="field"><span>Schema</span><input v-model="schema" class="input mono" ></label>
                <label class="field"><span>Prefix</span><input v-model="prefix" class="input mono" ></label>
                <label class="field">
                  <span>What to clean</span>
                  <select v-model="mode" class="input">
                    <option value="job-rows">Rows of one generation job</option>
                    <option value="bench-rows">Rows written by one benchmark run</option>
                    <option value="drop-objects">Drop all prefixed lab objects</option>
                  </select>
                </label>
                <label v-if="mode !== 'drop-objects'" class="field">
                  <span>{{ mode === 'job-rows' ? 'Generation job' : 'Benchmark run' }}</span>
                  <select v-model="targetId" class="input">
                    <option value="">Select…</option>
                    <option v-for="j in candidates" :key="j.id" :value="j.id">{{ fmtDate(j.createdAt) }} · {{ j.status }} · {{ j.id.slice(0, 8) }}</option>
                  </select>
                </label>
              </div>
              <div class="row">
                <button class="btn" :disabled="planning || (mode !== 'drop-objects' && !targetId)" @click="planCleanup"><Icon name="lucide:list" size="15" /> Review what will be removed</button>
              </div>
            </div>
          </UiCard>
          <UiCard v-if="plan" :title="`${plan.steps.length} step(s) in ${plan.schema}`" icon="lucide:clipboard-list">
            <template #actions>
              <button class="btn sm danger" :disabled="!plan.steps.length || !writable" @click="confirmOpen = true"><Icon name="lucide:trash-2" size="13" /> Run cleanup…</button>
            </template>
            <div v-for="w in plan.warnings" :key="w" class="callout warn" style="margin-bottom: 8px">{{ w }}</div>
            <UiDataTable
              :columns="[
                { key: 'seq', label: '#', num: true },
                { key: 'kind', label: 'Action' },
                { key: 'objectType', label: 'Type' },
                { key: 'objectName', label: 'Object', mono: true },
                { key: 'rows', label: 'Rows', num: true, format: (v) => (v == null ? '' : fmtNum(v)) },
                { key: 'sql', label: 'Statement', mono: true, maxWidth: '420px' },
              ]"
              :rows="plan.steps"
              row-key="seq"
              max-height="420px"
              empty-text="Nothing to clean up."
            />
          </UiCard>
          <UiCard v-if="cleanupJob" title="Cleanup progress" icon="lucide:loader">
            <JobsLive :job-id="cleanupJob" />
          </UiCard>
        </div>
        <UiConfirm v-model="confirmOpen" title="Run cleanup" confirm-label="Delete / drop" danger :type-to-confirm="plan?.schema" :busy="runningCleanup" @confirm="runCleanup">
          <p>
            This will execute <strong>{{ plan?.steps.length }}</strong> step(s) in <strong class="mono">{{ plan?.schema }}</strong>
            ({{ mode === 'drop-objects' ? 'DROP … PURGE — not recoverable from the recycle bin' : 'DELETE in committed batches' }}). Every action is written to the audit log.
          </p>
        </UiConfirm>
      </UiRequireProfile>
    </div>
  </div>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
  gap: 16px;
  align-items: start;
}
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0;
  font-size: 12.5px;
}
dt {
  color: var(--text-3);
}
dd {
  margin: 0;
}
details summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 6px;
}
@media (max-width: 1100px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

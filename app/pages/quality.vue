<script setup lang="ts">
import type { JobRecord, JobSummary, QualityCheckResult } from '~~/shared/types/lab'

useHead({ title: 'Data Quality · OracleDB Data Lab' })
const route = useRoute()
const { activeId } = useActiveProfile()
const { schema, prefix } = useLabTarget()
const { push } = useToasts()
const checks = useLoader<{ id: string; category: string; title: string; description: string }[]>(() => '/api/quality/checks')
const selected = ref<string[]>([])
watch(checks.data, (c) => c && !selected.value.length && (selected.value = c.map((x) => x.id)), { immediate: true })

const genJobs = useLoader<JobSummary[]>(() => (activeId.value ? '/api/jobs' : null), { query: () => ({ type: 'data-generate', profileId: activeId.value, limit: 50 }) })
const jobFilter = ref<string>(typeof route.query.job === 'string' ? route.query.job : '')

const categories = computed(() => {
  const m = new Map<string, typeof checks.data.value>()
  for (const c of checks.data.value ?? []) m.set(c.category, [...(m.get(c.category) ?? []), c])
  return [...m.entries()]
})

const jobId = ref<string | null>(null)
const running = ref(false)
async function run() {
  running.value = true
  results.value = null
  try {
    const job = await api<JobRecord>('/api/quality/run', {
      method: 'POST',
      body: { profileId: activeId.value, schema: schema.value, prefix: prefix.value, checks: selected.value, jobFilter: jobFilter.value || undefined },
    })
    jobId.value = job.id
  } catch (err) {
    push({ tone: 'bad', title: 'Validation could not start', detail: apiErrorMessage(err) })
  } finally {
    running.value = false
  }
}
const results = ref<{ summary: Record<string, number>; results: QualityCheckResult[] } | null>(null)
const openSql = ref<string | null>(null)
function onSettled(j: JobRecord) {
  results.value = j.result as any
  const s = results.value?.summary ?? {}
  if (j.status === 'succeeded') push({ tone: s.fail || s.error ? 'warn' : 'ok', title: s.fail || s.error ? `${s.fail ?? 0} check(s) failed, ${s.error ?? 0} errored` : 'All checks passed' })
}
const tone = (s: string) => (s === 'pass' ? 'ok' : s === 'fail' ? 'bad' : s === 'error' ? 'warn' : '')
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Data Quality Validator</h1>
        <p>Orphan rows, duplicates, missing required values, business-rule and aggregate consistency — each check is one COUNT query you can inspect. Read-only.</p>
      </div>
    </div>
    <UiRequireProfile>
      <div class="stack">
        <UiCard title="Scope" icon="lucide:target">
          <div class="form-grid">
            <label class="field"><span>Schema</span><input v-model="schema" class="input mono" ></label>
            <label class="field"><span>Prefix</span><input v-model="prefix" class="input mono" ></label>
            <label class="field">
              <span>Limit to one generation job</span>
              <select v-model="jobFilter" class="input">
                <option value="">All rows</option>
                <option v-for="j in genJobs.data.value ?? []" :key="j.id" :value="j.id">{{ fmtDate(j.createdAt) }} · {{ j.status }} · {{ j.id.slice(0, 8) }}</option>
              </select>
            </label>
          </div>
          <div class="checks">
            <fieldset v-for="[cat, list] in categories" :key="cat">
              <legend>{{ cat }}</legend>
              <label v-for="c in list" :key="c.id" class="check" :title="c.description">
                <input v-model="selected" type="checkbox" :value="c.id" > {{ c.title }}
              </label>
            </fieldset>
          </div>
          <div class="row">
            <button class="btn primary" :disabled="running || !selected.length || !schema" @click="run"><Icon name="lucide:play" size="15" /> Run {{ selected.length }} checks</button>
            <button class="btn ghost sm" @click="selected = (checks.data.value ?? []).map((c) => c.id)">Select all</button>
            <button class="btn ghost sm" @click="selected = []">None</button>
            <span class="subtle">Full-table checks on tens of millions of rows can take minutes; they run as a cancellable job.</span>
          </div>
        </UiCard>

        <UiCard v-if="jobId" title="Results" icon="lucide:shield-check">
          <JobsLive :job-id="jobId" compact @settled="onSettled" />
          <div v-if="results" class="stack" style="margin-top: 12px">
            <div class="row">
              <span class="badge ok">{{ results.summary.pass ?? 0 }} pass</span>
              <span class="badge bad">{{ results.summary.fail ?? 0 }} fail</span>
              <span class="badge warn">{{ results.summary.error ?? 0 }} error</span>
            </div>
            <UiDataTable
              :columns="[
                { key: 'category', label: 'Category' },
                { key: 'title', label: 'Check' },
                { key: 'status', label: 'Status', tone: (v) => tone(v) },
                { key: 'violations', label: 'Violations', num: true, format: (v) => fmtNum(v) },
                { key: 'elapsedMs', label: 'Time', num: true, format: (v) => fmtMs(v) },
                { key: 'error', label: 'Detail', maxWidth: '340px', format: (v, r) => v ?? r.description },
              ]"
              :rows="results.results"
              row-key="id"
              clickable
              @row-click="(r) => (openSql = openSql === r.id ? null : r.id)"
            />
            <UiCode v-if="openSql" :code="results.results.find((r) => r.id === openSql)?.sql ?? ''" />
            <p class="subtle">Click a row to see the SQL that produced it.</p>
          </div>
        </UiCard>
      </div>
    </UiRequireProfile>
  </div>
</template>

<style scoped>
.checks {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
  margin: 14px 0;
}
fieldset {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
}
legend {
  font-size: 11.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
  padding: 0 4px;
}
</style>

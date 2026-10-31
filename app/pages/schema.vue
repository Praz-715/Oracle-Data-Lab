<script setup lang="ts">
import type { JobRecord, SchemaOptions, SchemaPlan } from '~~/shared/types/lab'

useHead({ title: 'Schema Designer · OracleDB Data Lab' })
const { activeId, environment, writable } = useActiveProfile()
const { schema } = useLabTarget()
const { push } = useToasts()
const blueprint = useLoader<any>(() => '/api/schema/blueprint')

const opts = reactive<SchemaOptions>({
  prefix: 'DL_',
  partitioning: 'interval',
  includeLobs: true,
  includePlsql: true,
  includeMaterializedViews: true,
  includeSynonyms: true,
  compression: false,
  extensionTables: 0,
  tablespace: '',
  historyStart: `${new Date().getFullYear() - 3}-01-01`,
})
watch(environment, (e) => {
  if (e && e.options.Partitioning === false) opts.partitioning = 'none'
})

const plan = ref<SchemaPlan | null>(null)
const planning = ref(false)
const typeFilter = ref('ALL')
const selectedSeq = ref<number | null>(null)
const tab = ref('statements')

async function makePlan() {
  if (!activeId.value) return
  planning.value = true
  try {
    plan.value = await api<SchemaPlan>('/api/schema/plan', { method: 'POST', body: { profileId: activeId.value, schema: schema.value, options: opts } })
    selectedSeq.value = plan.value.statements[0]?.seq ?? null
    typeFilter.value = 'ALL'
    jobId.value = null
  } catch (err) {
    push({ tone: 'bad', title: 'Could not build the plan', detail: apiErrorMessage(err) })
  } finally {
    planning.value = false
  }
}

const typeCounts = computed(() => {
  const m = new Map<string, number>()
  for (const s of plan.value?.statements ?? []) m.set(s.objectType, (m.get(s.objectType) ?? 0) + 1)
  return [...m.entries()]
})
const shown = computed(() => (plan.value?.statements ?? []).filter((s) => typeFilter.value === 'ALL' || s.objectType === typeFilter.value))
const selected = computed(() => plan.value?.statements.find((s) => s.seq === selectedSeq.value) ?? null)
const fullSql = computed(() => (plan.value ? plan.value.statements.map((s) => `-- [${s.seq}] ${s.objectType} ${s.objectName}\n${s.sql};`).join('\n\n') : ''))

const applyOpen = ref(false)
const skipExisting = ref(true)
const applying = ref(false)
const jobId = ref<string | null>(null)
const applyResult = ref<any>(null)

async function apply() {
  if (!plan.value) return
  applying.value = true
  try {
    const job = await api<JobRecord>(`/api/schema/plans/${plan.value.id}/apply`, { method: 'POST', body: { sha256: plan.value.sha256, skipExisting: skipExisting.value, confirm: true } })
    jobId.value = job.id
    applyResult.value = null
    applyOpen.value = false
    tab.value = 'status'
  } catch (err) {
    push({ tone: 'bad', title: 'Apply refused', detail: apiErrorMessage(err) })
  } finally {
    applying.value = false
  }
}
function onSettled(job: JobRecord) {
  applyResult.value = job.result ?? job.checkpoint
  if (job.status === 'succeeded') push({ tone: 'ok', title: 'Schema objects created', detail: `${plan.value?.schema}.${plan.value?.options.prefix}* — see object status.` })
  else push({ tone: 'bad', title: `DDL job ${job.status}`, detail: job.error?.message })
}
const statusTone = (s: string) => (s === 'ok' ? 'ok' : s === 'failed' ? 'bad' : s === 'warning' || s === 'skipped' ? 'warn' : '')
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Schema Designer</h1>
        <p>Generate a related schema — tables, keys, checks, indexes, views, materialized views, sequences, synonyms, PL/SQL, triggers, partitions and LOBs. Every statement is reviewed before it runs.</p>
      </div>
    </div>

    <UiRequireProfile writes>
      <div class="stack">
        <UiCard title="Blueprint options" icon="lucide:sliders-horizontal">
          <div class="form-grid">
            <label class="field"><span>Target schema</span><input v-model="schema" class="input mono" ></label>
            <label class="field"><span>Object prefix</span><input v-model="opts.prefix" class="input mono" maxlength="8" ></label>
            <label class="field">
              <span>ORDERS partitioning</span>
              <select v-model="opts.partitioning" class="input">
                <option value="interval">Interval (monthly)</option>
                <option value="range">Range (monthly, pre-created)</option>
                <option value="list">List (by channel)</option>
                <option value="hash">Hash (16)</option>
                <option value="none">None</option>
              </select>
              <small v-if="environment && environment.options.Partitioning === false" style="color: var(--warn)">Partitioning option not enabled on this database.</small>
            </label>
            <label class="field"><span>History start (range partitions)</span><input v-model="opts.historyStart" type="date" class="input" ></label>
            <label class="field">
              <span>Extension tables</span>
              <input v-model.number="opts.extensionTables" type="number" min="0" :max="blueprint.data.value?.maxExtensionTables ?? 300" class="input" >
              <small>Adds EXT_001…n related tables to reach hundreds of objects.</small>
            </label>
            <label class="field"><span>Tablespace (optional)</span><input v-model="opts.tablespace" class="input mono" placeholder="default" ></label>
          </div>
          <div class="row" style="margin-top: 12px; gap: 18px">
            <label class="check"><input v-model="opts.includeLobs" type="checkbox" > CLOB/BLOB tables</label>
            <label class="check"><input v-model="opts.includePlsql" type="checkbox" > Package, procedure, function, triggers</label>
            <label class="check"><input v-model="opts.includeMaterializedViews" type="checkbox" > Materialized views</label>
            <label class="check"><input v-model="opts.includeSynonyms" type="checkbox" > Synonyms</label>
            <label class="check"><input v-model="opts.compression" type="checkbox" > Basic compression (EE)</label>
          </div>
          <div class="row" style="margin-top: 14px">
            <button class="btn primary" :disabled="planning || !schema" @click="makePlan">
              <Icon :name="planning ? 'lucide:loader-circle' : 'lucide:file-code-2'" :class="{ spin: planning }" size="15" /> Generate DDL plan
            </button>
            <span class="subtle">Nothing is executed until you review and apply.</span>
          </div>
        </UiCard>

        <UiCard v-if="plan" :title="`Plan · ${plan.statements.length} statements for ${plan.schema}.${plan.options.prefix}*`" icon="lucide:list-tree">
          <template #actions>
            <a class="btn sm" :href="`/api/schema/plans/${plan.id}/export`" download><Icon name="lucide:download" size="13" /> Export .sql</a>
            <button class="btn sm primary" :disabled="!writable || !!(jobId && !applyResult)" @click="applyOpen = true">
              <Icon name="lucide:play" size="13" /> Apply…
            </button>
          </template>
          <div class="stack">
            <div v-for="w in plan.warnings" :key="w" class="callout warn"><Icon name="lucide:triangle-alert" size="16" />{{ w }}</div>
            <div class="row subtle">
              <span>Oracle {{ plan.versionMajor || '?' }} · partitioning {{ plan.options.partitioning }}</span>
              <span class="mono">sha256 {{ plan.sha256.slice(0, 16) }}…</span>
            </div>
            <UiTabs
              v-model="tab"
              :tabs="[
                { id: 'statements', label: 'Statements', count: plan.statements.length },
                { id: 'sql', label: 'Full DDL' },
                { id: 'status', label: 'Object creation status', count: applyResult?.results?.length ?? null },
              ]"
            />
            <div v-if="tab === 'statements'" class="split">
              <div>
                <div class="row" style="margin-bottom: 8px">
                  <select v-model="typeFilter" class="input" style="width: 220px">
                    <option value="ALL">All types</option>
                    <option v-for="[t, n] in typeCounts" :key="t" :value="t">{{ t }} ({{ n }})</option>
                  </select>
                </div>
                <UiDataTable
                  :columns="[
                    { key: 'seq', label: '#', num: true, width: '50px' },
                    { key: 'objectType', label: 'Type' },
                    { key: 'objectName', label: 'Object', mono: true },
                    { key: 'note', label: 'Note', format: (v, r) => [r.optional ? 'optional' : '', v].filter(Boolean).join(' · ') || '' },
                  ]"
                  :rows="shown"
                  row-key="seq"
                  :selected-key="selectedSeq != null ? String(selectedSeq) : null"
                  clickable
                  max-height="460px"
                  @row-click="(r) => (selectedSeq = r.seq)"
                />
              </div>
              <div>
                <div v-if="selected" class="subtle" style="margin-bottom: 6px">[{{ selected.seq }}] {{ selected.objectType }} {{ selected.objectName }}</div>
                <UiCode v-if="selected" :code="selected.sql" max-height="460px" />
              </div>
            </div>
            <UiCode v-else-if="tab === 'sql'" :code="fullSql" max-height="560px" />
            <div v-else class="stack">
              <JobsLive v-if="jobId" :job-id="jobId" @settled="onSettled" />
              <div v-else class="subtle">Not applied yet.</div>
              <UiDataTable
                v-if="applyResult?.results"
                :columns="[
                  { key: 'seq', label: '#', num: true, width: '50px' },
                  { key: 'objectType', label: 'Type' },
                  { key: 'objectName', label: 'Object', mono: true },
                  { key: 'status', label: 'Status', tone: statusTone },
                  { key: 'elapsedMs', label: 'ms', num: true },
                  { key: 'message', label: 'Message', maxWidth: '420px' },
                ]"
                :rows="applyResult.results"
                row-key="seq"
                max-height="460px"
              />
            </div>
          </div>
        </UiCard>

        <UiCard v-if="blueprint.data.value" :title="`Blueprint: ${blueprint.data.value.name}`" icon="lucide:book-open" flush>
          <UiDataTable
            :columns="[
              { key: 'key', label: 'Table', mono: true, format: (v) => opts.prefix + v },
              { key: 'kind', label: 'Kind' },
              { key: 'columns', label: 'Cols', num: true, format: (v) => String(v.length) },
              { key: 'pk', label: 'Primary key', mono: true, format: (v) => v.join(', ') },
              { key: 'fks', label: 'References', format: (v) => v.map((f: any) => opts.prefix + f.ref).join(', ') || '—' },
              { key: 'checks', label: 'Checks', num: true, format: (v) => String(v.length) },
              { key: 'comment', label: 'Purpose', maxWidth: '380px' },
            ]"
            :rows="blueprint.data.value.tables.filter((t: any) => opts.includeLobs || !t.lobTable)"
            row-key="key"
          />
        </UiCard>
      </div>

      <UiConfirm
        v-model="applyOpen"
        title="Apply DDL plan"
        confirm-label="Create objects"
        :type-to-confirm="plan?.schema"
        :busy="applying"
        @confirm="apply"
      >
        <p>
          This runs <strong>{{ plan?.statements.length }}</strong> DDL statements in <strong class="mono">{{ plan?.schema }}</strong> as a
          background job. DDL auto-commits; the job can be resumed from the failed statement.
        </p>
        <label class="check"><input v-model="skipExisting" type="checkbox" > Skip objects that already exist (ORA-00955 and similar)</label>
      </UiConfirm>
    </UiRequireProfile>
  </div>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 14px;
}
@media (max-width: 1100px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

<script setup lang="ts">
import type { JobRecord, JobSummary, StorageEstimate } from '~~/shared/types/lab'

useHead({ title: 'Data Generator · OracleDB Data Lab' })
const { activeId, writable } = useActiveProfile()
const { schema, prefix } = useLabTarget()
const { push } = useToasts()
const presets = useLoader<any>(() => '/api/generator/presets')

const today = new Date().toISOString().slice(0, 10)
const cfg = reactive({
  preset: 'small' as 'small' | 'medium' | 'large' | 'xl' | 'custom',
  orders: 17_000,
  seed: 20260101,
  batchSize: 2000,
  commitEvery: 10_000,
  includeLobs: true,
  historyStart: `${new Date().getFullYear() - 3}-01-01`,
  historyEnd: today,
  extensionRowsPerTable: 10_000,
})
watch(
  () => cfg.preset,
  (p) => {
    if (p !== 'custom' && presets.data.value) cfg.orders = presets.data.value.presets[p].orders
  },
)

const pf = ref<any>(null)
const estimate = ref<{ estimate: StorageEstimate; counts: any } | null>(null)
let estTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => [cfg.orders, cfg.includeLobs, cfg.extensionRowsPerTable, pf.value?.extTables],
  () => {
    if (estTimer) clearTimeout(estTimer)
    estTimer = setTimeout(async () => {
      try {
        estimate.value = await api('/api/generator/estimate', {
          method: 'POST',
          body: { orders: cfg.orders, includeLobs: cfg.includeLobs, extensionTables: pf.value?.extTables ?? 0, extensionRowsPerTable: cfg.extensionRowsPerTable },
        })
      } catch {
        estimate.value = null
      }
    }, 250)
  },
  { immediate: true },
)

const body = () => ({ profileId: activeId.value, schema: schema.value, prefix: prefix.value, ...cfg })
const checking = ref(false)
async function preflight() {
  checking.value = true
  try {
    pf.value = await api('/api/generator/preflight', { method: 'POST', body: body() })
  } catch (err) {
    pf.value = null
    push({ tone: 'bad', title: 'Preflight failed', detail: apiErrorMessage(err) })
  } finally {
    checking.value = false
  }
}

const jobId = ref<string | null>(null)
const starting = ref(false)
const confirmOpen = ref(false)
async function start() {
  starting.value = true
  try {
    const job = await api<JobRecord>('/api/generator/start', { method: 'POST', body: body() })
    jobId.value = job.id
    confirmOpen.value = false
    await history.load()
  } catch (err) {
    push({ tone: 'bad', title: 'Generation refused', detail: apiErrorMessage(err) })
  } finally {
    starting.value = false
  }
}
const result = ref<any>(null)
function onSettled(j: JobRecord) {
  result.value = j.result
  void history.load()
  if (j.status === 'succeeded') push({ tone: 'ok', title: 'Dataset generated', detail: `${fmtNum((j.result as any)?.rowsInserted)} rows committed. Validate it in Data Quality.` })
}

const history = useLoader<JobSummary[]>(() => (activeId.value ? '/api/jobs' : null), { query: () => ({ type: 'data-generate', profileId: activeId.value, limit: 20 }) })
const presetOrder = ['small', 'medium', 'large', 'xl', 'custom'] as const
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Synthetic Data Generator</h1>
        <p>
          Realistic, fully synthetic business data with consistent relations: seasonality, repeat buyers, skewed product popularity,
          status lifecycles and reconciled totals. Deterministic by seed, batched with array binding, resumable after interruption.
        </p>
      </div>
    </div>

    <UiRequireProfile writes>
      <div class="stack">
        <div class="grid two">
          <UiCard title="Dataset" icon="lucide:factory">
            <div class="stack">
              <div class="form-grid">
                <label class="field"><span>Schema</span><input v-model="schema" class="input mono" ></label>
                <label class="field"><span>Prefix</span><input v-model="prefix" class="input mono" maxlength="8" ></label>
              </div>
              <div class="field">
                <span>Size preset</span>
                <div class="seg" role="group" aria-label="Size preset">
                  <button v-for="p in presetOrder" :key="p" type="button" :aria-pressed="cfg.preset === p" @click="cfg.preset = p">
                    {{ p === 'custom' ? 'Custom' : presets.data.value?.presets[p]?.label ?? p }}
                    <span v-if="p !== 'custom' && presets.data.value" class="subtle">~{{ fmtCompact(presets.data.value.presets[p].targetRows) }}</span>
                  </button>
                </div>
              </div>
              <div class="form-grid">
                <label class="field">
                  <span>Orders (drives all volumes)</span>
                  <input v-model.number="cfg.orders" type="number" min="100" class="input" :disabled="cfg.preset !== 'custom'" >
                </label>
                <label class="field"><span>Random seed</span><input v-model.number="cfg.seed" type="number" class="input mono" ><small>Same seed → identical data.</small></label>
                <label class="field"><span>History start</span><input v-model="cfg.historyStart" type="date" class="input" ></label>
                <label class="field"><span>History end</span><input v-model="cfg.historyEnd" type="date" class="input" ></label>
                <label class="field"><span>Batch size (rows per array bind)</span><input v-model.number="cfg.batchSize" type="number" min="50" :max="presets.data.value?.limits.maxBatchSize" class="input" ></label>
                <label class="field"><span>Commit every (orders)</span><input v-model.number="cfg.commitEvery" type="number" min="50" class="input" ></label>
                <label class="field"><span>Rows per extension table</span><input v-model.number="cfg.extensionRowsPerTable" type="number" min="0" class="input" ></label>
              </div>
              <label class="check"><input v-model="cfg.includeLobs" type="checkbox" > Generate CLOB reviews and BLOB images (if those tables exist)</label>
              <div class="row">
                <button class="btn" :disabled="checking || !schema" @click="preflight">
                  <Icon :name="checking ? 'lucide:loader-circle' : 'lucide:clipboard-check'" :class="{ spin: checking }" size="15" /> Preflight check
                </button>
                <button class="btn primary" :disabled="!pf || pf.errors.length > 0 || !writable || starting" @click="confirmOpen = true">
                  <Icon name="lucide:play" size="15" /> Generate…
                </button>
              </div>
              <template v-if="pf">
                <div v-for="e in pf.errors" :key="e" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ e }}</div>
                <div v-for="w in pf.warnings" :key="w" class="callout warn"><Icon name="lucide:triangle-alert" size="16" />{{ w }}</div>
                <div v-if="!pf.errors.length" class="callout ok">
                  <Icon name="lucide:circle-check" size="16" />
                  <div>Schema ready: {{ pf.extTables }} extension table(s){{ pf.includeLobs ? ', LOB tables present' : '' }}{{ pf.freeBytes != null ? ` · ~${fmtBytes(pf.freeBytes)} free in default tablespace` : '' }}.</div>
                </div>
              </template>
            </div>
          </UiCard>

          <UiCard title="Storage estimate" icon="lucide:calculator">
            <div v-if="!estimate" class="subtle">Calculating…</div>
            <div v-else class="stack">
              <div class="grid kpis">
                <UiKpi label="Total rows" :value="fmtCompact(estimate.estimate.totalRows)" :sub="`${fmtNum(estimate.counts.orders)} orders`" />
                <UiKpi label="Estimated size" :value="fmtBytes(estimate.estimate.totalBytes)" :sub="`tables ${fmtBytes(estimate.estimate.tableBytes)} · idx ${fmtBytes(estimate.estimate.indexBytes)}`" />
              </div>
              <ChartsBars
                :items="[...estimate.estimate.tables].sort((a, b) => b.rows - a.rows).slice(0, 12).map((t) => ({ label: prefix + t.table, value: t.rows, sub: fmtBytes(t.bytes) }))"
                :format="(v) => fmtCompact(v)"
                aria-label="Estimated rows per table"
              />
              <p class="subtle">{{ estimate.estimate.note }}</p>
            </div>
          </UiCard>
        </div>

        <UiCard v-if="jobId" title="Generation progress" icon="lucide:loader">
          <JobsLive :job-id="jobId" @settled="onSettled" />
          <div v-if="result" style="margin-top: 12px" class="stack">
            <div class="row subtle">
              <span>{{ fmtNum(result.rowsInserted) }} rows in {{ fmtDuration(result.elapsedSec) }}</span>
              <span>{{ fmtNum(result.rowsPerSec) }} rows/s</span>
              <span>seed {{ result.seed }}</span>
            </div>
            <ChartsBars
              :items="Object.entries(result.tables as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: result.prefix + k, value: v }))"
              aria-label="Rows inserted per table"
            />
            <div class="row">
              <NuxtLink :to="`/quality?job=${jobId}`" class="btn sm"><Icon name="lucide:shield-check" size="13" /> Validate this dataset</NuxtLink>
              <NuxtLink :to="`/explorer?owner=${result.schema}`" class="btn sm ghost">Explore tables</NuxtLink>
            </div>
          </div>
        </UiCard>

        <UiCard title="Recent generation jobs" icon="lucide:history" flush>
          <UiDataTable
            :columns="[
              { key: 'createdAt', label: 'Started', format: (v) => fmtDate(v) },
              { key: 'title', label: 'Job', maxWidth: '520px' },
              { key: 'status', label: 'Status', tone: (v) => jobTone(v) },
              { key: 'progress', label: 'Rows', num: true, format: (v) => fmtNum(v.done) },
              { key: 'id', label: 'Job id (DL_JOB_ID)', mono: true },
            ]"
            :rows="history.data.value ?? []"
            row-key="id"
            clickable
            empty-text="No generation jobs for this connection yet."
            @row-click="(r) => (jobId = r.id)"
          />
        </UiCard>
      </div>

      <UiConfirm v-model="confirmOpen" title="Generate synthetic data" confirm-label="Start generation" :busy="starting" @confirm="start">
        <p>
          Insert about <strong>{{ fmtNum(estimate?.estimate.totalRows) }}</strong> rows (~{{ fmtBytes(estimate?.estimate.totalBytes) }}) into
          <strong class="mono">{{ schema }}.{{ prefix }}*</strong>. Rows are tagged with the job id so they can be cleaned up precisely.
        </p>
      </UiConfirm>
    </UiRequireProfile>
  </div>
</template>

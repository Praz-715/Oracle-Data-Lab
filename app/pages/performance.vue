<script setup lang="ts">
import type { BenchmarkResult, BenchmarkScenarioInfo, JobRecord } from '~~/shared/types/lab'

useHead({ title: 'Performance Lab · OracleDB Data Lab' })
const route = useRoute()
const { activeId, writable } = useActiveProfile()
const { schema, prefix } = useLabTarget()
const { push } = useToasts()

const meta = useLoader<{ scenarios: BenchmarkScenarioInfo[]; limits: any }>(() => '/api/benchmarks/scenarios')
const scenarioId = ref('select-pk')
const scenario = computed(() => meta.data.value?.scenarios.find((s) => s.id === scenarioId.value) ?? null)
const cfg = reactive({ concurrency: 4, warmupSeconds: 10, durationSeconds: 60, thinkTimeMs: 0, batchSize: 100, readRatio: 0.8, label: '', capturePlan: true, cleanupAfter: true })
watch(scenario, (s) => s && (cfg.concurrency = s.defaultConcurrency))

const heavy = computed(() => !!scenario.value && (scenario.value.writes || scenario.value.category === 'analytic' || cfg.concurrency > (meta.data.value?.limits.heavyConcurrencyThreshold ?? 8)))
const confirmOpen = ref(false)
const starting = ref(false)
const jobId = ref<string | null>(typeof route.query.job === 'string' ? route.query.job : null)
const tab = ref('run')

function requestRun() {
  if (heavy.value) confirmOpen.value = true
  else void run()
}
async function run() {
  starting.value = true
  try {
    const job = await api<JobRecord>('/api/benchmarks/run', {
      method: 'POST',
      body: { profileId: activeId.value, schema: schema.value, prefix: prefix.value, scenarioId: scenarioId.value, ...cfg, confirmHeavy: heavy.value },
    })
    jobId.value = job.id
    liveOps.value = []
    confirmOpen.value = false
  } catch (err) {
    push({ tone: 'bad', title: 'Benchmark refused', detail: apiErrorMessage(err) })
  } finally {
    starting.value = false
  }
}

// Live ops/s while the run is measuring (from job progress events).
const job = useJob(jobId)
const liveOps = ref<{ x: number; y: number }[]>([])
watch(
  () => job.summary.value?.progress,
  (p) => {
    if (p?.phase === 'measuring' && p.ratePerSec != null) {
      const x = p.done
      if (!liveOps.value.length || liveOps.value[liveOps.value.length - 1]!.x !== x) liveOps.value = [...liveOps.value, { x, y: p.ratePerSec }]
    }
  },
)
const result = computed(() => (job.full.value?.type === 'benchmark' ? (job.full.value.result as BenchmarkResult | null) : null))
watch(result, (r) => r && history.load())

// History & comparison
const history = useLoader<any[]>(() => '/api/benchmarks/history', { query: () => ({ profileId: activeId.value }) })
const compare = ref<string[]>([])
const compared = computed(() => (history.data.value ?? []).filter((h) => compare.value.includes(h.id)))
const byCategory = computed(() => {
  const m = new Map<string, BenchmarkScenarioInfo[]>()
  for (const s of meta.data.value?.scenarios ?? []) m.set(s.category, [...(m.get(s.category) ?? []), s])
  return [...m.entries()]
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Performance & SQL Benchmark Lab</h1>
        <p>Repeatable workloads with warm-up, fixed duration and concurrency. Latency percentiles, throughput, errors and the full run context are stored for comparison.</p>
      </div>
    </div>

    <UiRequireProfile>
      <div class="stack">
        <UiTabs v-model="tab" :tabs="[{ id: 'run', label: 'Run' }, { id: 'history', label: 'History & compare', count: history.data.value?.length ?? null }]" />

        <template v-if="tab === 'run'">
          <div class="grid two">
            <UiCard title="Scenario" icon="lucide:list-checks">
              <div class="scenarios">
                <div v-for="[cat, list] in byCategory" :key="cat">
                  <div class="cat">{{ cat }}</div>
                  <button
                    v-for="s in list"
                    :key="s.id"
                    class="scn"
                    :class="{ on: s.id === scenarioId }"
                    :aria-pressed="s.id === scenarioId"
                    @click="scenarioId = s.id"
                  >
                    <span class="no num">{{ s.no }}</span>
                    <span class="nm">{{ s.name }}</span>
                    <span v-if="s.writes" class="badge warn plain">writes</span>
                  </button>
                </div>
              </div>
            </UiCard>

            <UiCard :title="scenario ? `#${scenario.no} ${scenario.name}` : 'Configuration'" icon="lucide:sliders-horizontal">
              <div class="stack">
                <p v-if="scenario" class="muted">{{ scenario.description }}</p>
                <div class="form-grid">
                  <label class="field"><span>Schema</span><input v-model="schema" class="input mono" ></label>
                  <label class="field"><span>Prefix</span><input v-model="prefix" class="input mono" ></label>
                  <label class="field"><span>Concurrent sessions</span><input v-model.number="cfg.concurrency" type="number" min="1" :max="meta.data.value?.limits.maxConcurrency" class="input" ><small>Limit {{ meta.data.value?.limits.maxConcurrency }}</small></label>
                  <label class="field"><span>Warm-up (s)</span><input v-model.number="cfg.warmupSeconds" type="number" min="0" class="input" ></label>
                  <label class="field"><span>Measured duration (s)</span><input v-model.number="cfg.durationSeconds" type="number" min="5" class="input" ></label>
                  <label class="field"><span>Think time (ms)</span><input v-model.number="cfg.thinkTimeMs" type="number" min="0" class="input" ></label>
                  <label class="field"><span>Batch size / commit interval</span><input v-model.number="cfg.batchSize" type="number" min="1" class="input" ></label>
                  <label v-if="scenarioId === 'mixed'" class="field"><span>Read ratio</span><input v-model.number="cfg.readRatio" type="number" min="0" max="1" step="0.05" class="input" ></label>
                  <label class="field"><span>Label</span><input v-model="cfg.label" class="input" placeholder="e.g. after index rebuild" ></label>
                </div>
                <div class="row" style="gap: 18px">
                  <label class="check"><input v-model="cfg.capturePlan" type="checkbox" > Capture execution plan</label>
                  <label v-if="scenario?.writes" class="check"><input v-model="cfg.cleanupAfter" type="checkbox" > Delete rows written by this run</label>
                </div>
                <div v-if="scenario?.writes && !writable" class="callout warn"><Icon name="lucide:shield-alert" size="16" />Write scenarios need a lab-mode profile with this schema authorized.</div>
                <div class="row">
                  <button class="btn primary" :disabled="!!(starting || !schema || (scenario?.writes && !writable) || (job.summary.value && !job.settled.value))" @click="requestRun">
                    <Icon name="lucide:play" size="15" /> Run benchmark
                  </button>
                  <span v-if="heavy" class="badge warn">needs confirmation</span>
                </div>
              </div>
            </UiCard>
          </div>

          <UiCard v-if="jobId" title="Run" icon="lucide:gauge">
            <div class="stack">
              <JobsLive :job-id="jobId" compact />
              <ChartsLine
                v-if="!result && liveOps.length"
                :series="[{ name: 'ops/s (live)', points: liveOps }]"
                :x-format="(v) => `${v}s`"
                :y-format="(v) => fmtCompact(v)"
                :height="160"
                area
              />
              <BenchmarkResultView v-if="result" :result="result" :job-id="jobId" />
            </div>
          </UiCard>
        </template>

        <template v-else>
          <UiCard title="Benchmark history" icon="lucide:history" flush>
            <UiDataTable
              :columns="[
                { key: 'pick', label: 'Compare', sortable: false, width: '70px' },
                { key: 'createdAt', label: 'When', format: (v) => fmtDate(v) },
                { key: 'scenarioId', label: 'Scenario', mono: true },
                { key: 'label', label: 'Label' },
                { key: 'concurrency', label: 'Sessions', num: true },
                { key: 'opsPerSec', label: 'ops/s', num: true, format: (v) => fmtNum(v, 1) },
                { key: 'p95Ms', label: 'p95', num: true, format: (v) => fmtMs(v) },
                { key: 'p99Ms', label: 'p99', num: true, format: (v) => fmtMs(v) },
                { key: 'errors', label: 'Errors', num: true },
                { key: 'oracleVersion', label: 'Oracle', mono: true },
                { key: 'status', label: 'Status', tone: (v) => jobTone(v) },
              ]"
              :rows="history.data.value ?? []"
              row-key="id"
              max-height="420px"
              empty-text="No benchmark runs yet."
            >
              <template #cell-pick="{ row }">
                <input v-model="compare" type="checkbox" :value="row.id" :disabled="row.opsPerSec == null" :aria-label="`Compare run ${row.id}`" >
              </template>
              <template #cell-scenarioId="{ row }">
                <a href="#" class="mono" @click.prevent="(jobId = row.id), (tab = 'run')">{{ row.scenarioId }}</a>
              </template>
            </UiDataTable>
          </UiCard>
          <div v-if="compared.length >= 2" class="grid two">
            <UiCard title="Throughput (ops/s)" icon="lucide:bar-chart-3">
              <ChartsBars :items="compared.map((c) => ({ label: `${c.scenarioId} · ${c.label || fmtDate(c.createdAt)} · ${c.concurrency}s`, value: c.opsPerSec }))" :format="(v) => fmtNum(v, 1)" />
            </UiCard>
            <UiCard title="p95 latency" icon="lucide:timer">
              <ChartsBars :hue="1" :items="compared.map((c) => ({ label: `${c.scenarioId} · ${c.label || fmtDate(c.createdAt)} · ${c.concurrency}s`, value: c.p95Ms }))" :format="(v) => fmtMs(v)" />
            </UiCard>
          </div>
          <p v-else class="subtle">Tick two or more completed runs to compare them. Comparisons are only meaningful for the same scenario, data size and environment — check the run details.</p>
        </template>
      </div>

      <UiConfirm v-model="confirmOpen" title="Confirm heavy workload" confirm-label="Run benchmark" :busy="starting" @confirm="run">
        <p>
          <strong>#{{ scenario?.no }} {{ scenario?.name }}</strong> with <strong>{{ cfg.concurrency }}</strong> session(s) for
          {{ cfg.warmupSeconds }} s warm-up + {{ cfg.durationSeconds }} s.
        </p>
        <p v-if="scenario?.writes">It <strong>writes</strong> to <span class="mono">{{ schema }}.{{ prefix }}BENCH_EVENTS</span> (rows tagged with the run id{{ cfg.cleanupAfter ? ', deleted afterwards' : '' }}).</p>
        <p v-else>It can put significant load on the database (full scans / aggregation or high concurrency).</p>
        <p class="subtle">Only run this against a lab or test database.</p>
      </UiConfirm>
    </UiRequireProfile>
  </div>
</template>

<style scoped>
.scenarios {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}
.cat {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-3);
  margin-bottom: 4px;
}
.scn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: none;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  font: 13px var(--font-sans);
  color: var(--text);
  cursor: pointer;
}
.scn:hover {
  background: var(--bg-hover);
}
.scn.on {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}
.no {
  width: 22px;
  color: var(--text-3);
  font-size: 12px;
}
.nm {
  flex: 1;
}
</style>

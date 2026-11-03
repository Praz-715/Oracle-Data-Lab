<script setup lang="ts">
import type { AdvisorIndex, AdvisorResult, IndexCandidate, IndexTestResult, PlaygroundRun, SavedQuery } from '~~/shared/types/lab'
import { bindNames } from '~~/shared/utils/sql'

useHead({ title: 'SQL Playground · OracleDB Data Lab' })
const route = useRoute()
const { active, activeId, writable } = useActiveProfile()
const { push } = useToasts()

const SNIPPETS: { name: string; sql: string; binds?: Record<string, string> }[] = [
  {
    name: 'Olist · revenue by category for a month',
    sql: `SELECT NVL(t.PRODUCT_CATEGORY_NAME_ENGLISH, p.PRODUCT_CATEGORY_NAME) AS category,
       COUNT(DISTINCT o.ORDER_ID) AS orders, SUM(i.PRICE) AS revenue
  FROM OL_ORDERS o
  JOIN OL_ORDER_ITEMS i ON i.ORDER_ID = o.ORDER_ID
  JOIN OL_PRODUCTS p ON p.PRODUCT_ID = i.PRODUCT_ID
  LEFT JOIN OL_CATEGORY_TRANSLATION t ON t.PRODUCT_CATEGORY_NAME = p.PRODUCT_CATEGORY_NAME
 WHERE o.ORDER_PURCHASE_TIMESTAMP >= TO_DATE(:d1, 'YYYY-MM-DD')
   AND o.ORDER_PURCHASE_TIMESTAMP <  TO_DATE(:d2, 'YYYY-MM-DD')
 GROUP BY NVL(t.PRODUCT_CATEGORY_NAME_ENGLISH, p.PRODUCT_CATEGORY_NAME)
 ORDER BY revenue DESC`,
    binds: { d1: '2017-11-01', d2: '2017-12-01' },
  },
  {
    name: 'Olist · zip points by city (try the Index Advisor)',
    sql: `SELECT GEOLOCATION_ZIP_CODE_PREFIX AS zip, COUNT(*) AS points,
       ROUND(AVG(GEOLOCATION_LAT), 5) AS lat, ROUND(AVG(GEOLOCATION_LNG), 5) AS lng
  FROM OL_GEOLOCATION
 WHERE GEOLOCATION_CITY = :city AND GEOLOCATION_STATE = :state
 GROUP BY GEOLOCATION_ZIP_CODE_PREFIX
 ORDER BY points DESC`,
    binds: { city: 'campinas', state: 'SP' },
  },
  {
    name: 'Olist · late deliveries by state (TRUNC anti-pattern)',
    sql: `SELECT c.CUSTOMER_STATE, COUNT(*) AS late
  FROM OL_ORDERS o JOIN OL_CUSTOMERS c ON c.CUSTOMER_ID = o.CUSTOMER_ID
 WHERE TRUNC(o.ORDER_PURCHASE_TIMESTAMP) = DATE '2018-01-15'
   AND o.ORDER_DELIVERED_CUSTOMER_DATE > o.ORDER_ESTIMATED_DELIVERY_DATE
 GROUP BY c.CUSTOMER_STATE`,
  },
  {
    name: 'Olist · same query, sargable date range',
    sql: `SELECT c.CUSTOMER_STATE, COUNT(*) AS late
  FROM OL_ORDERS o JOIN OL_CUSTOMERS c ON c.CUSTOMER_ID = o.CUSTOMER_ID
 WHERE o.ORDER_PURCHASE_TIMESTAMP >= DATE '2018-01-15'
   AND o.ORDER_PURCHASE_TIMESTAMP <  DATE '2018-01-16'
   AND o.ORDER_DELIVERED_CUSTOMER_DATE > o.ORDER_ESTIMATED_DELIVERY_DATE
 GROUP BY c.CUSTOMER_STATE`,
  },
  {
    name: 'Olist · top sellers with average review score',
    sql: `SELECT * FROM (
  SELECT i.SELLER_ID, s.SELLER_CITY, COUNT(DISTINCT i.ORDER_ID) AS orders, SUM(i.PRICE) AS revenue,
         ROUND(AVG(r.REVIEW_SCORE), 2) AS avg_score
    FROM OL_ORDER_ITEMS i
    JOIN OL_SELLERS s ON s.SELLER_ID = i.SELLER_ID
    LEFT JOIN OL_ORDER_REVIEWS r ON r.ORDER_ID = i.ORDER_ID
   GROUP BY i.SELLER_ID, s.SELLER_CITY
   ORDER BY revenue DESC)
 WHERE ROWNUM <= 20`,
  },
  {
    name: 'Retail blueprint · orders of a customer',
    sql: `SELECT o.ORDER_ID, o.ORDER_DATE, o.STATUS, o.ORDER_TOTAL
  FROM DL_ORDERS o
 WHERE o.CUSTOMER_ID = :customer_id
 ORDER BY o.ORDER_DATE DESC`,
    binds: { customer_id: '1000' },
  },
]

// ---------------- editor ----------------
const sql = ref(SNIPPETS[0]!.sql)
const binds = reactive<Record<string, string>>({ ...SNIPPETS[0]!.binds })
const names = computed(() => bindNames(sql.value))
const schema = ref('')
watch(
  active,
  (p) => {
    if (!schema.value) schema.value = p?.allowedSchemas[0] ?? ''
  },
  { immediate: true },
)
const maxRows = ref(200)
const actualPlan = ref(true)
const snippet = ref('')
function loadSnippet(name: string) {
  const s = SNIPPETS.find((x) => x.name === name)
  if (!s) return
  sql.value = s.sql
  Object.assign(binds, s.binds ?? {})
  snippet.value = ''
}

// Open a SQL_ID from SQL Tuning / Top SQL.
watch(
  [activeId, () => route.query.sqlId],
  async ([id, sqlId]) => {
    if (!id || typeof sqlId !== 'string') return
    try {
      const d = await api<any>(`/api/connections/${id}/sql/${sqlId}`)
      if (d.text?.status === 'ok' && d.text.data) sql.value = String(d.text.data)
      else push({ tone: 'warn', title: `SQL_ID ${sqlId} not in the shared pool` })
    } catch (err) {
      push({ tone: 'bad', title: 'Could not load the SQL', detail: apiErrorMessage(err) })
    }
  },
  { immediate: true },
)

// ---------------- runs ----------------
type RunEntry = PlaygroundRun & { n: number; sql: string; schema: string }
const runs = ref<RunEntry[]>([])
const current = computed(() => runs.value[0] ?? null)
const pinned = ref<RunEntry | null>(null)
const running = ref(false)
const tab = ref('results')
let counter = 0
async function run() {
  if (!activeId.value || running.value) return
  running.value = true
  try {
    const body = { profileId: activeId.value, sql: sql.value, schema: schema.value || null, binds: Object.fromEntries(names.value.map((n) => [n, binds[n] ?? ''])), maxRows: maxRows.value, actualPlan: actualPlan.value }
    const r = await api<PlaygroundRun>('/api/playground/run', { method: 'POST', body })
    runs.value = [{ ...r, n: ++counter, sql: sql.value, schema: schema.value }, ...runs.value].slice(0, 20)
    if (tab.value === 'advisor') tab.value = 'results'
  } catch (err) {
    push({ tone: 'bad', title: 'Query failed', detail: apiErrorMessage(err) })
  } finally {
    running.value = false
  }
}
function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    void run()
  }
}

const resultColumns = computed(() =>
  (current.value?.columns ?? []).map((c, i) => ({ key: String(i), label: c.name, num: /NUMBER|FLOAT|DOUBLE|INTEGER/.test(c.type), mono: !/NUMBER|FLOAT|DOUBLE|INTEGER/.test(c.type), maxWidth: '320px' })),
)
const resultRows = computed(() => (current.value?.rows ?? []).map((r, i) => ({ _i: i, ...Object.fromEntries(r.map((v, j) => [String(j), v])) })))

const STAT_LABELS: Record<string, string> = {
  'session logical reads': 'Logical reads (buffer gets)',
  'consistent gets': 'Consistent gets',
  'db block gets': 'DB block gets',
  'physical reads': 'Physical reads',
  'CPU used by this session': 'CPU (ms)',
  'sorts (memory)': 'Sorts in memory',
  'sorts (disk)': 'Sorts to disk',
  'redo size': 'Redo (bytes)',
  'parse count (hard)': 'Hard parses',
  'bytes sent via SQL*Net to client': 'Bytes sent to client',
  'SQL*Net roundtrips to/from client': 'Round trips',
}
const statValue = (k: string, v: number) => (k === 'CPU used by this session' ? v * 10 : v)
const statRows = computed(() =>
  Object.entries(current.value?.stats ?? {}).map(([k, v]) => ({ stat: STAT_LABELS[k] ?? k, key: k, value: statValue(k, v), a: pinned.value?.stats ? statValue(k, pinned.value.stats[k] ?? 0) : null })),
)

// ---------------- compare ----------------
function metrics(r: RunEntry | null) {
  if (!r) return null
  const s = r.stats ?? {}
  return { elapsed: r.elapsedMs, gets: s['session logical reads'] ?? null, phys: s['physical reads'] ?? null, cpu: s['CPU used by this session'] != null ? s['CPU used by this session']! * 10 : null, rows: r.rowCount, hash: r.planHash }
}
const compareRows = computed(() => {
  const a = metrics(pinned.value)
  const b = metrics(current.value && current.value !== pinned.value ? current.value : null)
  if (!a || !b) return []
  const d = (x: number | null, y: number | null) => (x && y != null ? Math.round(((y - x) / x) * 100) : null)
  return [
    { metric: 'Elapsed (ms)', a: a.elapsed, b: b.elapsed, delta: d(a.elapsed, b.elapsed) },
    { metric: 'Logical reads', a: a.gets, b: b.gets, delta: d(a.gets, b.gets) },
    { metric: 'Physical reads', a: a.phys, b: b.phys, delta: d(a.phys, b.phys) },
    { metric: 'CPU (ms)', a: a.cpu, b: b.cpu, delta: d(a.cpu, b.cpu) },
    { metric: 'Rows returned', a: a.rows, b: b.rows, delta: null },
  ]
})
const samePlan = computed(() => pinned.value && current.value && pinned.value.planHash != null && pinned.value.planHash === current.value.planHash)

// ---------------- saved queries ----------------
const saved = useLoader<SavedQuery[]>(() => '/api/playground/saved')
const saveOpen = ref(false)
const saveName = ref('')
async function save() {
  try {
    await api('/api/playground/saved', { method: 'POST', body: { name: saveName.value, sql: sql.value, schema: schema.value || null, binds: Object.fromEntries(names.value.map((n) => [n, binds[n] ?? ''])) } })
    saveOpen.value = false
    push({ tone: 'ok', title: 'Query saved', detail: saveName.value })
    await saved.load()
  } catch (err) {
    push({ tone: 'bad', title: 'Save failed', detail: apiErrorMessage(err) })
  }
}
function openSaved(q: SavedQuery) {
  sql.value = q.sql
  if (q.schema) schema.value = q.schema
  Object.assign(binds, q.binds)
}
async function deleteSaved(q: SavedQuery) {
  await api(`/api/playground/saved/${q.id}`, { method: 'DELETE' }).catch(() => {})
  await saved.load()
}

// ---------------- index advisor ----------------
const advice = ref<AdvisorResult | null>(null)
const analyzing = ref(false)
const testing = ref<string | null>(null)
const testResult = ref<IndexTestResult | null>(null)
const advIndexes = useLoader<(AdvisorIndex & { exists: boolean })[]>(() => (activeId.value ? `/api/advisor/indexes?profileId=${activeId.value}` : null))
async function analyze() {
  if (!activeId.value) return
  analyzing.value = true
  tab.value = 'advisor'
  try {
    advice.value = await api<AdvisorResult>('/api/advisor/analyze', { method: 'POST', body: { profileId: activeId.value, sql: sql.value, schema: schema.value || null } })
  } catch (err) {
    push({ tone: 'bad', title: 'Analysis failed', detail: apiErrorMessage(err) })
  } finally {
    analyzing.value = false
  }
}
const canTest = (c: IndexCandidate) => writable.value && !!active.value?.allowedSchemas.includes(c.owner)
async function test(c: IndexCandidate) {
  if (!activeId.value) return
  testing.value = c.id
  testResult.value = null
  try {
    testResult.value = await api<IndexTestResult>('/api/advisor/test', {
      method: 'POST',
      body: { profileId: activeId.value, sql: sql.value, schema: schema.value || null, binds: Object.fromEntries(names.value.map((n) => [n, binds[n] ?? ''])), owner: c.owner, table: c.table, columns: c.columns, runs: 3 },
    })
    await advIndexes.load()
  } catch (err) {
    push({ tone: 'bad', title: 'Index test failed', detail: apiErrorMessage(err) })
  } finally {
    testing.value = null
  }
}
async function indexAction(ix: { owner: string; name: string }, action: 'keep' | 'hide' | 'drop') {
  try {
    await api('/api/advisor/indexes/action', { method: 'POST', body: { profileId: activeId.value, owner: ix.owner, name: ix.name, action } })
    push({ tone: 'ok', title: action === 'drop' ? `Dropped ${ix.name}` : action === 'keep' ? `${ix.name} is now visible to all sessions` : `${ix.name} is invisible again` })
    if (action === 'drop' && testResult.value?.index.name === ix.name) testResult.value = null
    await advIndexes.load()
  } catch (err) {
    push({ tone: 'bad', title: 'Index action failed', detail: apiErrorMessage(err) })
  }
}
const pctChange = (a: number | null, b: number | null) => (a && b != null ? Math.round(((b - a) / a) * 100) : null)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>SQL Playground</h1>
        <p>
          Run read-only queries with bind variables, see the <strong>actual</strong> plan (real rows and buffers per step) and autotrace-style session
          statistics, compare two versions side by side, and let the Index Advisor propose and test indexes — invisible first, kept only if they help.
        </p>
      </div>
    </div>

    <UiRequireProfile>
      <div class="stack">
        <UiCard title="Query" icon="lucide:square-terminal">
          <template #actions>
            <select v-model="snippet" class="input sel" aria-label="Examples" @change="loadSnippet(snippet)">
              <option value="">Examples…</option>
              <option v-for="s in SNIPPETS" :key="s.name" :value="s.name">{{ s.name }}</option>
            </select>
            <select class="input sel" aria-label="Saved queries" :value="''" @change="openSaved((saved.data.value ?? []).find((q) => q.id === ($event.target as HTMLSelectElement).value)!); ($event.target as HTMLSelectElement).value = ''">
              <option value="">Saved ({{ saved.data.value?.length ?? 0 }})…</option>
              <option v-for="q in saved.data.value ?? []" :key="q.id" :value="q.id">{{ q.name }}</option>
            </select>
            <button class="btn sm" @click="(saveName = ''), (saveOpen = true)"><Icon name="lucide:bookmark-plus" size="13" /> Save</button>
          </template>
          <div class="stack-sm">
            <div class="row opts">
              <label class="field schema">
                <span>Schema context</span>
                <input v-model="schema" class="input mono" list="pg-schemas" placeholder="(your own)" @change="schema = schema.toUpperCase()" >
                <datalist id="pg-schemas"><option v-for="s in active?.allowedSchemas ?? []" :key="s" :value="s" /></datalist>
              </label>
              <label class="field">
                <span>Max rows</span>
                <select v-model.number="maxRows" class="input"><option v-for="n in [50, 200, 1000, 5000]" :key="n" :value="n">{{ n }}</option></select>
              </label>
              <label class="check"><input v-model="actualPlan" type="checkbox" > Actual plan statistics</label>
              <span class="subtle push">Read-only: SELECT / WITH only, inside a READ ONLY transaction · Ctrl+Enter runs</span>
            </div>
            <textarea v-model="sql" class="input editor" spellcheck="false" aria-label="SQL" @keydown="onKey" />
            <div v-if="names.length" class="row binds">
              <span class="subtle">Binds</span>
              <label v-for="n in names" :key="n" class="bind">
                <span class="mono">:{{ n }}</span>
                <input v-model="binds[n]" class="input mono" placeholder="NULL" >
              </label>
            </div>
            <div class="row">
              <button class="btn primary" :disabled="running || !sql.trim()" @click="run">
                <Icon :name="running ? 'lucide:loader-circle' : 'lucide:play'" :class="{ spin: running }" size="15" /> Run
              </button>
              <button class="btn" :disabled="analyzing || !sql.trim()" @click="analyze">
                <Icon :name="analyzing ? 'lucide:loader-circle' : 'lucide:wand-sparkles'" :class="{ spin: analyzing }" size="15" /> Index Advisor
              </button>
              <button class="btn" :disabled="!current" @click="(pinned = current), (tab = 'compare')"><Icon name="lucide:pin" size="15" /> Pin as baseline (A)</button>
              <span v-if="current" class="subtle">
                Run #{{ current.n }}: {{ fmtNum(current.rowCount) }}{{ current.truncated ? '+' : '' }} rows · {{ fmtMs(current.elapsedMs) }}
                <template v-if="current.stats"> · {{ fmtNum(current.stats['session logical reads']) }} logical reads</template>
                <template v-if="current.sqlId"> · <NuxtLink :to="{ path: '/tuning', query: { sql: current.sqlId } }" class="mono">{{ current.sqlId }}</NuxtLink></template>
              </span>
            </div>
          </div>
        </UiCard>

        <UiTabs
          v-model="tab"
          :tabs="[
            { id: 'results', label: 'Results', count: current ? current.rowCount : null },
            { id: 'plan', label: 'Plan' },
            { id: 'stats', label: 'Statistics' },
            { id: 'compare', label: 'Compare A / B', count: runs.length || null },
            { id: 'advisor', label: 'Index Advisor', count: advice ? advice.candidates.length : null },
          ]"
        />

        <!-- Results -->
        <UiCard v-if="tab === 'results'" :title="current ? `Results · run #${current.n}` : 'Results'" icon="lucide:table" flush>
          <p v-if="!current" class="subtle pad">Run a query to see rows here.</p>
          <template v-else>
            <p v-if="current.truncated" class="subtle pad">Showing the first {{ fmtNum(current.rowCount) }} rows (max rows {{ maxRows }}).</p>
            <UiDataTable :columns="resultColumns" :rows="resultRows" row-key="_i" max-height="520px" empty-text="No rows." />
          </template>
        </UiCard>

        <!-- Plan -->
        <UiCard v-else-if="tab === 'plan'" :title="current?.planKind === 'actual' ? 'Actual execution plan (ALLSTATS LAST)' : 'Execution plan'" icon="lucide:route">
          <p v-if="!current" class="subtle">Run a query first.</p>
          <template v-else>
            <p class="subtle m0">
              <template v-if="current.planKind === 'actual'">Starts / A-Rows / Buffers are measured for this execution; compare E-Rows (estimate) with A-Rows to spot bad cardinality estimates.</template>
              <template v-else>Estimated plan — actual statistics were not available (needs access to V$SQL_PLAN_STATISTICS_ALL).</template>
              {{ current.statsNote ?? '' }}
            </p>
            <UiCode :code="current.plan ?? 'Plan not available.'" max-height="560px" />
          </template>
        </UiCard>

        <!-- Statistics -->
        <UiCard v-else-if="tab === 'stats'" title="Session statistics for this execution" icon="lucide:gauge">
          <p v-if="!current" class="subtle">Run a query first.</p>
          <template v-else>
            <div class="grid kpis">
              <UiKpi label="Elapsed" :value="fmtMs(current.elapsedMs)" sub="client-observed, incl. fetch" />
              <UiKpi label="Logical reads" :value="fmtNum(current.stats?.['session logical reads'])" sub="buffer gets" tone="info" />
              <UiKpi label="Physical reads" :value="fmtNum(current.stats?.['physical reads'])" sub="blocks read from disk" />
              <UiKpi label="CPU" :value="current.stats ? fmtMs((current.stats['CPU used by this session'] ?? 0) * 10) : null" sub="10 ms resolution" />
            </div>
            <p v-if="current.statsNote" class="subtle">{{ current.statsNote }}</p>
            <UiDataTable
              v-if="current.stats"
              :columns="[
                { key: 'stat', label: 'Statistic' },
                { key: 'value', label: `Run #${current.n}`, num: true, format: (v) => fmtNum(v) },
                { key: 'a', label: pinned ? `Baseline #${pinned.n}` : 'Baseline (pin a run)', num: true, format: (v) => (v == null ? '—' : fmtNum(v)) },
              ]"
              :rows="statRows"
              row-key="key"
            />
          </template>
        </UiCard>

        <!-- Compare -->
        <template v-else-if="tab === 'compare'">
          <UiCard title="Baseline (A) vs latest run (B)" icon="lucide:git-compare">
            <p v-if="!pinned" class="subtle">Pin a run as the baseline, change the query (or add an index), run again — the difference shows here.</p>
            <template v-else-if="current === pinned">
              <p class="subtle">Run #{{ pinned.n }} is the baseline. Edit the query and run it again to compare.</p>
            </template>
            <template v-else-if="current">
              <div class="row">
                <span class="badge" :class="samePlan ? '' : 'info'">{{ samePlan ? 'same plan' : 'different plan' }}</span>
                <span class="subtle">A = run #{{ pinned.n }} (hash {{ pinned.planHash ?? '—' }}) · B = run #{{ current.n }} (hash {{ current.planHash ?? '—' }})</span>
              </div>
              <UiDataTable
                :columns="[
                  { key: 'metric', label: 'Metric' },
                  { key: 'a', label: 'A', num: true, format: (v) => (v == null ? '—' : fmtNum(v, 2)) },
                  { key: 'b', label: 'B', num: true, format: (v) => (v == null ? '—' : fmtNum(v, 2)) },
                  { key: 'delta', label: 'B vs A', num: true, tone: (v) => (v == null ? '' : v < -10 ? 'ok' : v > 10 ? 'bad' : ''), format: (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`) },
                ]"
                :rows="compareRows"
                row-key="metric"
                style="margin-top: 10px"
              />
              <div class="grid two" style="margin-top: 14px">
                <div><h4>A · run #{{ pinned.n }}</h4><UiCode :code="pinned.plan ?? ''" max-height="420px" /></div>
                <div><h4>B · run #{{ current.n }}</h4><UiCode :code="current.plan ?? ''" max-height="420px" /></div>
              </div>
            </template>
          </UiCard>
          <UiCard title="Recent runs (this session)" icon="lucide:history" flush>
            <UiDataTable
              :columns="[
                { key: 'n', label: '#', num: true },
                { key: 'sql', label: 'SQL', mono: true, maxWidth: '520px', format: (v) => v.replace(/\s+/g, ' ') },
                { key: 'elapsedMs', label: 'Elapsed', num: true, format: (v) => fmtMs(v) },
                { key: 'stats', label: 'Logical reads', num: true, format: (v) => (v ? fmtNum(v['session logical reads']) : '—') },
                { key: 'planHash', label: 'Plan hash', mono: true, format: (v) => v ?? '—' },
                { key: 'pin', label: '', sortable: false },
              ]"
              :rows="runs"
              row-key="n"
              empty-text="No runs yet."
            >
              <template #cell-pin="{ row }">
                <button class="btn sm ghost" :disabled="pinned === row" @click="pinned = row">{{ pinned === row ? 'baseline' : 'Pin as A' }}</button>
              </template>
            </UiDataTable>
          </UiCard>
        </template>

        <!-- Index advisor -->
        <template v-else>
          <UiCard title="Index Advisor" icon="lucide:wand-sparkles">
            <template #actions>
              <button class="btn sm" :disabled="analyzing" @click="analyze"><Icon name="lucide:refresh-cw" size="13" /> Analyze current query</button>
            </template>
            <p v-if="!advice && !analyzing" class="subtle">
              Explains the query, reads the predicates per table and the column statistics, and proposes B-tree indexes only where they can pay off. Test creates
              the index <strong>INVISIBLE</strong> (only the test session uses it), measures before vs after, and you decide to keep or drop it.
            </p>
            <div v-if="analyzing" class="subtle">Analyzing…</div>
            <div v-else-if="advice" class="stack-sm">
              <div class="row">
                <span class="subtle">Plan cost {{ fmtNum(advice.totalCost) }} · {{ advice.fullScans.length }} full table scan(s)</span>
                <span v-for="f in advice.fullScans" :key="f.table" class="badge plain mono">{{ f.table }} {{ f.tableRows != null ? fmtCompact(f.tableRows) : '?' }} rows</span>
              </div>
              <div v-for="(n, i) in advice.notes" :key="i" class="callout" :class="n.severity === 'warning' ? 'warn' : 'info'">
                <Icon :name="n.severity === 'warning' ? 'lucide:triangle-alert' : 'lucide:info'" size="16" />
                <div>{{ n.text }}</div>
              </div>
              <p v-if="!advice.candidates.length" class="subtle">No index candidates — the plan's access paths look appropriate for these predicates.</p>
              <div v-for="c in advice.candidates" :key="c.id" class="cand">
                <div class="row between">
                  <div class="row">
                    <span class="badge" :class="c.coveredBy ? '' : 'info'">{{ c.kind === 'join' ? 'join' : 'filter' }}</span>
                    <strong class="mono">{{ c.table }} ({{ c.columns.join(', ') }})</strong>
                    <span v-if="c.selectivity != null" class="subtle">~{{ c.selectivity < 0.0001 ? "<0.01%" : fmtPct(c.selectivity * 100, c.selectivity < 0.01 ? 2 : 1) }} of {{ fmtCompact(c.tableRows) }} rows</span>
                  </div>
                  <button
                    class="btn sm primary"
                    :disabled="!!testing || !!c.coveredBy || !canTest(c)"
                    :title="canTest(c) ? '' : `Needs a lab-mode profile with ${c.owner} authorized`"
                    @click="test(c)"
                  >
                    <Icon :name="testing === c.id ? 'lucide:loader-circle' : 'lucide:flask-conical'" :class="{ spin: testing === c.id }" size="13" />
                    {{ testing === c.id ? 'Building & measuring…' : 'Test (invisible index)' }}
                  </button>
                </div>
                <p class="m0">{{ c.rationale }}</p>
                <UiCode :code="c.ddl + ';'" />
              </div>
            </div>
          </UiCard>

          <UiCard v-if="testResult" :title="`Test result · ${testResult.index.name}`" icon="lucide:flask-conical">
            <div class="callout" :class="testResult.used ? 'ok' : 'warn'"><Icon :name="testResult.used ? 'lucide:circle-check' : 'lucide:triangle-alert'" size="16" />{{ testResult.verdict }}</div>
            <UiDataTable
              style="margin-top: 10px"
              :columns="[
                { key: 'metric', label: 'Median of 3 runs' },
                { key: 'before', label: 'Without index', num: true },
                { key: 'after', label: 'With index (invisible)', num: true },
                { key: 'delta', label: 'Change', num: true, tone: (v) => (v == null ? '' : v < -10 ? 'ok' : v > 10 ? 'bad' : '') , format: (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`) },
              ]"
              :rows="[
                { metric: 'Optimizer cost', before: fmtNum(testResult.before.cost), after: fmtNum(testResult.after.cost), delta: pctChange(testResult.before.cost, testResult.after.cost) },
                { metric: 'Elapsed (ms)', before: fmtNum(testResult.before.medianMs, 2), after: fmtNum(testResult.after.medianMs, 2), delta: pctChange(testResult.before.medianMs, testResult.after.medianMs) },
                { metric: 'Logical reads / exec', before: fmtNum(testResult.before.gets), after: fmtNum(testResult.after.gets), delta: pctChange(testResult.before.gets, testResult.after.gets) },
                { metric: 'Physical reads / exec', before: fmtNum(testResult.before.physicalReads), after: fmtNum(testResult.after.physicalReads), delta: pctChange(testResult.before.physicalReads, testResult.after.physicalReads) },
              ]"
              row-key="metric"
            />
            <p class="subtle">Index size {{ fmtBytes(testResult.index.sizeBytes) }} · built in {{ testResult.index.seconds }} s · plan hash {{ testResult.before.planHash }} → {{ testResult.after.planHash }}</p>
            <div class="row">
              <button class="btn primary" @click="indexAction(testResult.index, 'keep')"><Icon name="lucide:eye" size="14" /> Keep (make visible)</button>
              <button class="btn danger" @click="indexAction(testResult.index, 'drop')"><Icon name="lucide:trash-2" size="14" /> Drop</button>
            </div>
            <div class="grid two" style="margin-top: 14px">
              <div><h4>Plan without the index</h4><UiCode :code="testResult.before.plan" max-height="360px" /></div>
              <div><h4>Plan with the index</h4><UiCode :code="testResult.after.plan" max-height="360px" /></div>
            </div>
          </UiCard>

          <UiCard title="Indexes created by the advisor" icon="lucide:list-tree" flush>
            <UiDataTable
              :columns="[
                { key: 'name', label: 'Index', mono: true },
                { key: 'table', label: 'Table', mono: true, format: (v, r) => `${r.owner}.${v}` },
                { key: 'columns', label: 'Columns', mono: true, format: (v) => v.join(', ') },
                { key: 'visible', label: 'State', tone: (v, r) => (!r.exists ? 'bad' : v ? 'ok' : ''), format: (v, r) => (!r.exists ? 'dropped outside the app' : v ? 'visible (kept)' : 'invisible (test)') },
                { key: 'createdAt', label: 'Created', format: (v) => fmtRelative(v) },
                { key: 'act', label: '', sortable: false },
              ]"
              :rows="advIndexes.data.value ?? []"
              :row-key="(r) => `${r.owner}.${r.name}`"
              empty-text="None. Indexes the advisor creates are listed here until you drop them."
            >
              <template #cell-act="{ row }">
                <div v-if="row.exists" class="row tight">
                  <button v-if="!row.visible" class="btn sm ghost" @click="indexAction(row, 'keep')">Keep</button>
                  <button v-else class="btn sm ghost" @click="indexAction(row, 'hide')">Make invisible</button>
                  <button class="btn sm ghost" @click="indexAction(row, 'drop')">Drop</button>
                </div>
              </template>
            </UiDataTable>
          </UiCard>
        </template>
      </div>
    </UiRequireProfile>

    <UiDialog v-model="saveOpen" title="Save query" :width="440">
      <label class="field"><span>Name</span><input v-model="saveName" class="input" maxlength="120" @keydown.enter="saveName.trim() && save()" ></label>
      <div v-if="saved.data.value?.length" class="saved">
        <div class="subtle">Saved queries</div>
        <div v-for="q in saved.data.value" :key="q.id" class="row between saved-row">
          <span class="ellipsis">{{ q.name }}</span>
          <button class="btn sm ghost" :aria-label="`Delete ${q.name}`" @click="deleteSaved(q)"><Icon name="lucide:trash-2" size="13" /></button>
        </div>
      </div>
      <template #footer>
        <button class="btn" @click="saveOpen = false">Cancel</button>
        <button class="btn primary" :disabled="!saveName.trim()" @click="save">Save</button>
      </template>
    </UiDialog>
  </div>
</template>

<style scoped>
.stack-sm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.opts {
  gap: 14px;
  align-items: flex-end;
}
.schema {
  width: 200px;
}
.push {
  margin-left: auto;
}
.sel {
  height: 26px;
  font-size: 12px;
  max-width: 230px;
}
.editor {
  min-height: 220px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  tab-size: 2;
  white-space: pre;
}
.binds {
  gap: 10px;
}
.bind {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.bind .input {
  width: 160px;
  height: 28px;
}
.pad {
  margin: 0;
  padding: 10px 14px;
}
.m0 {
  margin: 0;
}
h4 {
  margin: 0 0 6px;
  font-size: 12.5px;
  color: var(--text-2);
}
.cand {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.tight {
  gap: 4px;
  flex-wrap: nowrap;
}
.saved {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.saved-row {
  flex-wrap: nowrap;
  font-size: 13px;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

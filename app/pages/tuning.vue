<script setup lang="ts">
import type { Panel, SqlIndexReport } from '~~/shared/types/lab'

useHead({ title: 'SQL Tuning · OracleDB Data Lab' })
const route = useRoute()
const { activeId } = useActiveProfile()
const { push } = useToasts()
const tab = ref(typeof route.query.sql === 'string' ? 'inspect' : 'top')
const by = ref<'elapsed' | 'cpu' | 'gets' | 'reads' | 'execs'>('elapsed')

const top = useLoader<Panel<any[]>>(() => (activeId.value && tab.value === 'top' ? `/api/connections/${activeId.value}/monitor/topsql` : null), { query: () => ({ by: by.value }) })
const literals = useLoader<Panel<any[]>>(() => (activeId.value && tab.value === 'literals' ? `/api/connections/${activeId.value}/monitor/literals` : null))

const sqlId = ref(typeof route.query.sql === 'string' ? route.query.sql : '')
const sqlInput = ref(sqlId.value)
const detail = useLoader<any>(() => (activeId.value && sqlId.value && tab.value === 'inspect' ? `/api/connections/${activeId.value}/sql/${sqlId.value}` : null))
function inspect(id: string) {
  sqlId.value = id
  sqlInput.value = id
  tab.value = 'inspect'
}

// Ad-hoc workbench
const adhoc = ref('SELECT o.order_id, o.order_total\n  FROM DL_ORDERS o\n WHERE o.customer_id = 1001\n ORDER BY o.order_date DESC')
const label = ref('before')
const explained = ref<any>(null)
const explaining = ref(false)
const measuring = ref(false)
const runs = ref(5)
const measurements = ref<any[]>([])
async function explain() {
  explaining.value = true
  try {
    explained.value = await api(`/api/connections/${activeId.value}/tuning/explain`, { method: 'POST', body: { sql: adhoc.value } })
  } catch (err) {
    push({ tone: 'bad', title: 'EXPLAIN PLAN failed', detail: apiErrorMessage(err) })
  } finally {
    explaining.value = false
  }
}
async function measure() {
  measuring.value = true
  try {
    const m = await api<any>(`/api/connections/${activeId.value}/tuning/measure`, { method: 'POST', body: { sql: adhoc.value, runs: runs.value, label: label.value } })
    measurements.value = [...measurements.value, { ...m, id: measurements.value.length + 1 }]
  } catch (err) {
    push({ tone: 'bad', title: 'Measurement failed', detail: apiErrorMessage(err) })
  } finally {
    measuring.value = false
  }
}
const fullScanLines = (lines: any[]) => lines.filter((l) => l.operation === 'TABLE ACCESS' && /FULL/.test(l.options ?? ''))

// Index recommendations from the real cursor plans of the top SQL (advice only; test in the Playground).
const adviceTop = ref(30)
const advice = useLoader<SqlIndexReport>(() => (activeId.value && tab.value === 'indexes' ? `/api/connections/${activeId.value}/tuning/index-advice` : null), { query: () => ({ top: adviceTop.value }) })
const adviceOpen = ref<Set<string>>(new Set())
function toggleAdvice(id: string) {
  const s = new Set(adviceOpen.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  adviceOpen.value = s
}
const ddlFor = (c: { ddl: string }) => `${c.ddl};\n-- Test first: SQL Playground → Index Advisor creates it INVISIBLE and measures before/after.`
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>SQL Tuning Workbench</h1>
        <p>Top SQL from the shared pool, cursor/plan/bind inspection by SQL_ID, literal-SQL detection, EXPLAIN PLAN and timed before/after comparisons. Works without the Tuning or Diagnostics packs.</p>
      </div>
    </div>
    <UiRequireProfile>
      <div class="stack">
        <UiTabs
          v-model="tab"
          :tabs="[
            { id: 'top', label: 'Top SQL' },
            { id: 'indexes', label: 'Index recommendations' },
            { id: 'inspect', label: 'Inspect SQL_ID' },
            { id: 'literals', label: 'Bind-variable analysis' },
            { id: 'workbench', label: 'Explain & compare' },
          ]"
        />

        <UiCard v-if="tab === 'top'" title="Top SQL (V$SQLSTATS)" icon="lucide:list-ordered">
          <template #actions>
            <div class="seg" role="group" aria-label="Order by">
              <button v-for="o in ['elapsed', 'cpu', 'gets', 'reads', 'execs'] as const" :key="o" :aria-pressed="by === o" @click="by = o">{{ { elapsed: 'Elapsed', cpu: 'CPU', gets: 'Buffer gets', reads: 'Disk reads', execs: 'Executions' }[o] }}</button>
            </div>
          </template>
          <UiPanelView :panel="top.data.value" :loading="top.loading.value" :error="top.error.value">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'sqlId', label: 'SQL_ID', mono: true },
                  { key: 'executions', label: 'Execs', num: true, format: (v) => fmtCompact(v) },
                  { key: 'elapsedMs', label: 'Elapsed', num: true, format: (v) => fmtMs(v) },
                  { key: 'cpuMs', label: 'CPU', num: true, format: (v) => fmtMs(v) },
                  { key: 'msPerExec', label: 'ms/exec', num: true, format: (v) => fmtMs(v) },
                  { key: 'bufferGets', label: 'Buffer gets', num: true, format: (v) => fmtCompact(v) },
                  { key: 'getsPerExec', label: 'Gets/exec', num: true, format: (v) => fmtCompact(v) },
                  { key: 'diskReads', label: 'Disk reads', num: true, format: (v) => fmtCompact(v) },
                  { key: 'rowsProcessed', label: 'Rows', num: true, format: (v) => fmtCompact(v) },
                  { key: 'sqlText', label: 'SQL text', mono: true, maxWidth: '420px' },
                ]"
                :rows="data"
                row-key="sqlId"
                clickable
                max-height="600px"
                @row-click="(r) => inspect(r.sqlId)"
              />
            </template>
          </UiPanelView>
        </UiCard>

        <div v-else-if="tab === 'inspect'" class="stack">
          <div class="row">
            <input v-model="sqlInput" class="input mono" placeholder="SQL_ID (13 chars)" style="width: 220px" @keydown.enter="sqlId = sqlInput.trim()" >
            <button class="btn primary" @click="sqlId = sqlInput.trim()">Inspect</button>
          </div>
          <div v-if="detail.error.value" class="callout bad">{{ detail.error.value }}</div>
          <template v-else-if="detail.data.value">
            <UiCard title="Execution statistics" icon="lucide:bar-chart-3">
              <UiPanelView :panel="detail.data.value.stats" empty-text="SQL_ID not in the shared pool (aged out or never executed).">
                <template #default="{ data }">
                  <div class="grid kpis">
                    <UiKpi label="Executions" :value="fmtNum(data[0].executions)" />
                    <UiKpi label="Elapsed / exec" :value="fmtMs(data[0].elapsedMs / Math.max(1, data[0].executions))" :sub="`total ${fmtMs(data[0].elapsedMs)}`" />
                    <UiKpi label="CPU / exec" :value="fmtMs(data[0].cpuMs / Math.max(1, data[0].executions))" />
                    <UiKpi label="Buffer gets / exec" :value="fmtCompact(data[0].bufferGets / Math.max(1, data[0].executions))" />
                    <UiKpi label="Rows / exec" :value="fmtNum(data[0].rowsProcessed / Math.max(1, data[0].executions), 1)" />
                    <UiKpi label="Waits" :value="fmtMs(data[0].userIoMs + data[0].concurrencyMs + data[0].clusterMs)" :sub="`I/O ${fmtMs(data[0].userIoMs)} · conc ${fmtMs(data[0].concurrencyMs)}`" />
                  </div>
                </template>
              </UiPanelView>
            </UiCard>
            <UiCard title="SQL text" icon="lucide:code">
              <template #actions>
                <NuxtLink class="btn sm" :to="{ path: '/playground', query: { sqlId } }"><Icon name="lucide:square-terminal" size="13" /> Open in Playground</NuxtLink>
              </template>
              <UiPanelView :panel="detail.data.value.text"><template #default="{ data }"><UiCode :code="data ?? ''" max-height="240px" /></template></UiPanelView>
            </UiCard>
            <UiCard title="Execution plan (DBMS_XPLAN.DISPLAY_CURSOR)" icon="lucide:route">
              <UiPanelView :panel="detail.data.value.plan"><template #default="{ data }"><UiCode :code="data" max-height="480px" /></template></UiPanelView>
            </UiCard>
            <div class="grid two">
              <UiCard title="Plan lines: cost & cardinality" icon="lucide:git-branch" flush>
                <div style="padding: 12px">
                  <UiPanelView :panel="detail.data.value.planLines">
                    <template #default="{ data }">
                      <div v-if="fullScanLines(data).length" class="callout warn" style="margin-bottom: 8px">
                        <Icon name="lucide:lightbulb" size="16" />
                        <div>Full scan on {{ fullScanLines(data).map((l: any) => l.object).join(', ') }}. If its filter is selective, an index on the filtered columns may help — try it in <a href="#" @click.prevent="tab = 'workbench'">Explain & compare</a>.</div>
                      </div>
                      <UiDataTable
                        :columns="[
                          { key: 'id', label: 'Id', num: true },
                          { key: 'operation', label: 'Operation', format: (v, r) => `${v} ${r.options ?? ''}` },
                          { key: 'object', label: 'Object', mono: true },
                          { key: 'cost', label: 'Cost', num: true },
                          { key: 'cardinality', label: 'Card.', num: true, format: (v) => fmtCompact(v) },
                          { key: 'filter', label: 'Filter', mono: true, maxWidth: '220px' },
                        ]"
                        :rows="data"
                        row-key="id"
                      />
                    </template>
                  </UiPanelView>
                </div>
              </UiCard>
              <UiCard title="Child cursors & binds" icon="lucide:git-fork" flush>
                <div style="padding: 12px" class="stack">
                  <UiPanelView :panel="detail.data.value.cursors">
                    <template #default="{ data }">
                      <UiDataTable
                        :columns="[
                          { key: 'child', label: 'Child', num: true },
                          { key: 'planHash', label: 'Plan hash', mono: true },
                          { key: 'executions', label: 'Execs', num: true },
                          { key: 'cost', label: 'Cost', num: true },
                          { key: 'bindSensitive', label: 'Bind sens.' },
                          { key: 'bindAware', label: 'Bind aware' },
                          { key: 'schema', label: 'Schema' },
                        ]"
                        :rows="data"
                        row-key="child"
                      />
                    </template>
                  </UiPanelView>
                  <UiPanelView :panel="detail.data.value.binds" empty-text="No captured bind values.">
                    <template #default="{ data }">
                      <UiDataTable
                        :columns="[{ key: 'child', label: 'Child', num: true }, { key: 'name', label: 'Bind', mono: true }, { key: 'datatype', label: 'Type' }, { key: 'value', label: 'Captured value', mono: true }, { key: 'lastCaptured', label: 'Captured', format: (v) => fmtDate(v) }]"
                        :rows="data"
                        :row-key="(r) => `${r.child}:${r.position}`"
                      />
                    </template>
                  </UiPanelView>
                </div>
              </UiCard>
            </div>
          </template>
          <div v-else-if="!sqlId" class="subtle">Enter a SQL_ID or pick one from Top SQL / Monitoring.</div>
          <div v-else class="subtle">Loading…</div>
        </div>

        <div v-else-if="tab === 'indexes'" class="stack">
          <div class="callout info">
            <Icon name="lucide:shield-check" size="16" />
            <span><strong>Recommendations only.</strong> The top application SQL of the shared pool is analyzed on its real execution plans (V$SQL_PLAN with predicates) and column statistics. Nothing is created here — test a candidate in the SQL Playground (INVISIBLE index, before/after) and create it yourself.</span>
          </div>
          <UiCard title="Indexes that would help the slowest SQL" icon="lucide:lightbulb" flush>
            <template #actions>
              <select v-model.number="adviceTop" class="input" style="width: 150px" aria-label="Statements to analyze">
                <option :value="20">Top 20 SQL</option>
                <option :value="30">Top 30 SQL</option>
                <option :value="50">Top 50 SQL</option>
                <option :value="100">Top 100 SQL</option>
              </select>
              <button class="btn sm" :disabled="advice.loading.value" @click="advice.load()"><Icon name="lucide:refresh-cw" size="13" /> Re-analyze</button>
            </template>
            <p v-if="advice.loading.value && !advice.data.value" class="subtle pad"><span class="spin" aria-hidden="true" /> Reading plans of the top SQL…</p>
            <div v-else-if="advice.error.value" class="callout bad pad-m"><Icon name="lucide:circle-x" size="16" />{{ advice.error.value }}</div>
            <template v-else-if="advice.data.value">
              <p class="subtle pad">{{ advice.data.value.analyzedSql }} statement(s) analyzed{{ advice.data.value.skipped.length ? `, ${advice.data.value.skipped.length} skipped (plan aged out)` : '' }}. {{ advice.data.value.windowNote }}</p>
              <p v-if="!advice.data.value.advice.length" class="subtle pad">No index candidates: the top statements already use indexes, filter too much of their tables, or read small tables.</p>
              <ul class="adv-list">
                <li v-for="a in advice.data.value.advice" :key="a.candidate.id">
                  <button class="adv-row" :aria-expanded="adviceOpen.has(a.candidate.id)" @click="toggleAdvice(a.candidate.id)">
                    <Icon :name="adviceOpen.has(a.candidate.id) ? 'lucide:chevron-down' : 'lucide:chevron-right'" size="14" />
                    <span v-if="a.candidate.coveredBy" class="badge"><Icon name="lucide:circle-help" size="12" />Index exists</span>
                    <span v-else class="badge info"><Icon name="lucide:plus" size="12" />New index</span>
                    <strong class="mono">{{ a.candidate.owner }}.{{ a.candidate.table }} ({{ a.candidate.columns.join(', ') }})</strong>
                    <span class="adv-meta subtle">
                      <span>{{ fmtPct(a.impactPct) }} of SQL time</span>
                      <span>{{ a.sql.length }} statement(s)</span>
                      <span v-if="a.candidate.selectivity != null">keeps {{ fmtPct(a.candidate.selectivity * 100, 2) }} of {{ fmtCompact(a.candidate.tableRows) }} rows</span>
                    </span>
                  </button>
                  <div v-if="adviceOpen.has(a.candidate.id)" class="adv-body stack">
                    <p class="rationale">{{ a.candidate.rationale }}</p>
                    <UiCode v-if="!a.candidate.coveredBy" :code="ddlFor(a.candidate)" />
                    <UiDataTable
                      :columns="[
                        { key: 'sqlId', label: 'SQL_ID', mono: true },
                        { key: 'schema', label: 'Schema' },
                        { key: 'executions', label: 'Execs', num: true, format: (v) => fmtCompact(v) },
                        { key: 'elapsedMsPerExec', label: 'ms/exec', num: true, format: (v) => fmtMs(v) },
                        { key: 'bufferGetsPerExec', label: 'Gets/exec', num: true, format: (v) => fmtCompact(v) },
                        { key: 'dbTimePct', label: '% SQL time', num: true, format: (v) => fmtPct(v) },
                        { key: 'text', label: 'SQL text', mono: true, maxWidth: '420px' },
                      ]"
                      :rows="a.sql"
                      row-key="sqlId"
                    />
                    <div class="row">
                      <NuxtLink v-for="s in a.sql.slice(0, 3)" :key="s.sqlId" class="btn sm" :to="{ path: '/playground', query: { sqlId: s.sqlId, schema: s.schema } }">
                        <Icon name="lucide:square-terminal" size="13" /> Test {{ s.sqlId }} in Playground
                      </NuxtLink>
                      <button v-for="s in a.sql.slice(0, 1)" :key="`i${s.sqlId}`" class="btn sm ghost" @click="inspect(s.sqlId)"><Icon name="lucide:search" size="13" /> Inspect plan</button>
                    </div>
                  </div>
                </li>
              </ul>
              <div v-if="advice.data.value.notes.length" class="pad">
                <h3 class="notes-title">Predicates that stop an index from being used</h3>
                <ul class="adv-notes">
                  <li v-for="n in advice.data.value.notes" :key="n.sqlId + n.text" :class="n.severity">
                    <Icon :name="n.severity === 'warning' ? 'lucide:triangle-alert' : 'lucide:info'" size="13" />
                    <span>{{ n.text }} <button class="link mono" @click="inspect(n.sqlId)">{{ n.sqlId }}</button></span>
                  </li>
                </ul>
              </div>
            </template>
          </UiCard>
        </div>

        <UiCard v-else-if="tab === 'literals'" title="Statements differing only by literals (FORCE_MATCHING_SIGNATURE)" icon="lucide:brackets">
          <UiPanelView :panel="literals.data.value" :loading="literals.loading.value" :error="literals.error.value" empty-text="No literal-only duplicates (≥ 10 cursors) found — good bind variable usage.">
            <template #default="{ data }">
              <UiDataTable
                :columns="[{ key: 'cursors', label: 'Cursors', num: true }, { key: 'executions', label: 'Execs', num: true, format: (v) => fmtCompact(v) }, { key: 'exampleSqlId', label: 'Example SQL_ID', mono: true }, { key: 'example', label: 'Example text', mono: true, maxWidth: '640px' }]"
                :rows="data"
                row-key="signature"
                clickable
                @row-click="(r) => inspect(r.exampleSqlId)"
              />
              <p class="subtle">Many cursors with one signature means hard parsing and shared-pool pressure. Compare scenarios #3 and #12 in the Performance Lab.</p>
            </template>
          </UiPanelView>
        </UiCard>

        <div v-else class="stack">
          <UiCard title="Query" icon="lucide:code">
            <div class="stack">
              <textarea v-model="adhoc" class="input" rows="7" spellcheck="false" aria-label="SQL query" />
              <div class="row">
                <button class="btn" :disabled="explaining" @click="explain"><Icon name="lucide:route" size="15" /> Explain plan</button>
                <input v-model="label" class="input" style="width: 140px" aria-label="Measurement label" placeholder="label" >
                <label class="row subtle">runs <input v-model.number="runs" type="number" min="1" max="20" class="input" style="width: 70px" ></label>
                <button class="btn primary" :disabled="measuring" @click="measure"><Icon :name="measuring ? 'lucide:loader-circle' : 'lucide:timer'" :class="{ spin: measuring }" size="15" /> Measure</button>
                <span class="subtle">Single SELECT/WITH only, executed in a READ ONLY transaction (max 5000 rows fetched).</span>
              </div>
            </div>
          </UiCard>
          <UiCard v-if="explained" title="Estimated plan" icon="lucide:route">
            <div class="stack">
              <div v-for="s in explained.suggestions" :key="s.ddl" class="callout info">
                <Icon name="lucide:lightbulb" size="16" />
                <div>
                  <strong>Index candidate on {{ s.table }}</strong> — {{ s.reason }}
                  <UiCode :code="s.ddl" style="margin-top: 6px" />
                  <div class="subtle">Heuristic only. Create it in a lab schema, then Measure again to compare.</div>
                </div>
              </div>
              <UiCode :code="explained.text" max-height="420px" />
            </div>
          </UiCard>
          <UiCard v-if="measurements.length" title="Before / after comparison" icon="lucide:git-compare">
            <ChartsBars :items="measurements.map((m) => ({ label: `#${m.id} ${m.label || ''}`, value: m.medianMs, sub: `${m.rowsFetched} rows` }))" :format="(v) => fmtMs(v)" :hue="1" aria-label="Median elapsed per measurement" />
            <UiDataTable
              style="margin-top: 12px"
              :columns="[
                { key: 'id', label: '#', num: true },
                { key: 'label', label: 'Label' },
                { key: 'medianMs', label: 'Median', num: true, format: (v) => fmtMs(v) },
                { key: 'minMs', label: 'Min', num: true, format: (v) => fmtMs(v) },
                { key: 'maxMs', label: 'Max', num: true, format: (v) => fmtMs(v) },
                { key: 'rowsFetched', label: 'Rows', num: true },
                { key: 'measuredAt', label: 'When', format: (v) => fmtDate(v) },
                { key: 'sql', label: 'SQL', mono: true, maxWidth: '360px' },
              ]"
              :rows="measurements"
              row-key="id"
            />
            <p class="subtle">{{ measurements[0]?.note }}</p>
          </UiCard>
        </div>
      </div>
    </UiRequireProfile>
  </div>
</template>

<style scoped>
.pad {
  padding: 12px 14px;
  margin: 0;
}
.pad-m {
  margin: 12px 14px;
}
.adv-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.adv-list > li {
  border-top: 1px solid var(--border);
}
.adv-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  width: 100%;
  padding: 10px 14px;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.adv-row:hover {
  background: var(--bg-sunken);
}
.adv-row .badge::before {
  display: none;
}
.adv-row strong {
  overflow-wrap: anywhere;
}
.adv-meta {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-left: auto;
}
.adv-body {
  padding: 4px 14px 16px 38px;
  gap: 10px;
}
.rationale {
  margin: 0;
}
.notes-title {
  margin: 0 0 6px;
  font-size: 13px;
}
.adv-notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}
.adv-notes li {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.adv-notes li.warning :deep(svg) {
  color: var(--warn);
}
.link {
  background: none;
  border: 0;
  padding: 0;
  color: var(--accent, var(--info));
  cursor: pointer;
  font-size: 12px;
}
@media (max-width: 600px) {
  .adv-body {
    padding-left: 14px;
  }
}
</style>

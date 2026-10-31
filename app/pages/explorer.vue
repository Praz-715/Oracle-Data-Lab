<script setup lang="ts">
useHead({ title: 'Table Explorer · OracleDB Data Lab' })
const route = useRoute()
const { activeId, labSchema } = useActiveProfile()
const { push } = useToasts()

const owner = ref(typeof route.query.owner === 'string' ? route.query.owner.toUpperCase() : '')
watch(labSchema, (s) => !owner.value && s && (owner.value = s), { immediate: true })
const tab = ref('tables')
const filter = ref('')
const erdPrefix = ref('')

const base = (a: string) => (activeId.value && owner.value ? `/api/connections/${activeId.value}/explorer/${a}` : null)
const schemas = useLoader<any[]>(() => (activeId.value ? `/api/connections/${activeId.value}/explorer/schemas` : null))
const tables = useLoader<any[]>(() => base('tables'), { query: () => ({ owner: owner.value }) })
const inventory = useLoader<any>(() => (tab.value === 'inventory' ? base('inventory') : null), { query: () => ({ owner: owner.value }) })
const deps = useLoader<any[]>(() => (tab.value === 'dependencies' ? base('dependencies') : null), { query: () => ({ owner: owner.value }) })
const erd = useLoader<any>(() => (tab.value === 'erd' ? base('erd') : null), { query: () => ({ owner: owner.value, prefix: erdPrefix.value || undefined }) })

const table = ref<string | null>(null)
const detailTab = ref('columns')
const detail = useLoader<any>(() => (table.value ? base('table') : null), { query: () => ({ owner: owner.value, table: table.value }) })
const page = ref(1)
const rows = useLoader<any>(() => (table.value && detailTab.value === 'rows' ? base('rows') : null), { query: () => ({ owner: owner.value, table: table.value, page: page.value, pageSize: 50 }) })
const ddl = useLoader<{ ddl: string }>(() => (table.value && detailTab.value === 'ddl' ? base('ddl') : null), { query: () => ({ owner: owner.value, name: table.value, type: 'TABLE' }) })
watch(table, () => (page.value = 1))

const counting = ref(false)
const exact = ref<{ count: number; elapsedMs: number } | null>(null)
watch(table, () => (exact.value = null))
async function count() {
  counting.value = true
  try {
    exact.value = await api(base('count')!, { query: { owner: owner.value, table: table.value } })
  } catch (err) {
    push({ tone: 'bad', title: 'Count failed', detail: apiErrorMessage(err) })
  } finally {
    counting.value = false
  }
}

const objDdl = ref<{ name: string; ddl: string } | null>(null)
async function showObjectDdl(r: any) {
  try {
    const d = await api<{ ddl: string }>(base('ddl')!, { query: { owner: owner.value, name: r.name, type: r.type } })
    objDdl.value = { name: `${r.type} ${r.name}`, ddl: d.ddl }
  } catch (err) {
    push({ tone: 'bad', title: 'DDL unavailable', detail: apiErrorMessage(err) })
  }
}

const filteredTables = computed(() => (tables.data.value ?? []).filter((t) => !filter.value || t.table.includes(filter.value.toUpperCase())))
const rowColumns = computed(() =>
  (rows.data.value?.columns ?? []).map((c: any) => ({
    key: c.name,
    label: c.name,
    num: c.type === 'NUMBER',
    maxWidth: '260px',
    format: (v: any) => (v == null ? 'NULL' : typeof v === 'string' && /T\d\d:/.test(v) ? fmtDate(v) : String(v)),
  })),
)
const conType: Record<string, string> = { P: 'Primary key', U: 'Unique', R: 'Foreign key', C: 'Check' }
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Table & Schema Explorer</h1>
        <p>Everything the connected user can see through ALL_* views: tables, columns, constraints, indexes, partitions, objects, dependencies and an ERD.</p>
      </div>
      <label class="field" style="min-width: 220px">
        <span>Owner</span>
        <select v-model="owner" class="input mono">
          <option v-if="owner && !(schemas.data.value ?? []).some((s) => s.owner === owner)" :value="owner">{{ owner }}</option>
          <option v-for="s in schemas.data.value ?? []" :key="s.owner" :value="s.owner">{{ s.owner }} ({{ s.tables }} tables)</option>
        </select>
      </label>
    </div>

    <UiRequireProfile>
      <div class="stack">
        <UiTabs
          v-model="tab"
          :tabs="[
            { id: 'tables', label: 'Tables', count: tables.data.value?.length ?? null },
            { id: 'inventory', label: 'Object inventory' },
            { id: 'erd', label: 'ERD' },
            { id: 'dependencies', label: 'Dependencies' },
          ]"
        />

        <div v-if="tab === 'tables'" class="split">
          <UiCard title="Tables" icon="lucide:table-2" flush>
            <template #actions><input v-model="filter" class="input" placeholder="Filter…" style="width: 160px; height: 26px" ></template>
            <div v-if="tables.error.value" class="callout bad" style="margin: 12px">{{ tables.error.value }}</div>
            <UiDataTable
              :columns="[
                { key: 'table', label: 'Table', mono: true },
                { key: 'numRows', label: 'Rows (stats)', num: true, format: (v) => fmtCompact(v) },
                { key: 'partitioned', label: 'Part.', format: (v) => (v === 'YES' ? 'yes' : '') },
                { key: 'lastAnalyzed', label: 'Analyzed', format: (v) => fmtRelative(v) },
              ]"
              :rows="filteredTables"
              row-key="table"
              :selected-key="table"
              clickable
              max-height="640px"
              :empty-text="tables.loading.value ? 'Loading…' : 'No tables visible for this owner.'"
              @row-click="(r) => (table = r.table)"
            />
          </UiCard>

          <UiCard :title="table ? `${owner}.${table}` : 'Select a table'" icon="lucide:file-spreadsheet">
            <template v-if="table" #actions>
              <span v-if="exact" class="subtle num">{{ fmtNum(exact.count) }} rows · {{ fmtMs(exact.elapsedMs) }}</span>
              <button class="btn sm" :disabled="counting" @click="count"><Icon name="lucide:sigma" size="13" /> Exact count</button>
            </template>
            <div v-if="!table" class="subtle">Pick a table on the left.</div>
            <div v-else-if="detail.error.value" class="callout bad">{{ detail.error.value }}</div>
            <div v-else-if="detail.data.value" class="stack">
              <div class="row subtle">
                <span>{{ fmtNum(detail.data.value.numRows) }} rows (stats)</span>
                <span>{{ fmtNum(detail.data.value.blocks) }} blocks</span>
                <span>avg row {{ fmtNum(detail.data.value.avgRowLen) }} B</span>
                <span>tablespace {{ detail.data.value.tablespace ?? '—' }}</span>
                <span v-if="detail.data.value.partitioning">{{ detail.data.value.partitioning.type }} partitioned · {{ detail.data.value.partitioning.count }} partitions</span>
                <span>compression {{ detail.data.value.compression ?? '—' }}</span>
              </div>
              <UiTabs
                v-model="detailTab"
                :tabs="[
                  { id: 'columns', label: 'Columns', count: detail.data.value.columns.length },
                  { id: 'constraints', label: 'Constraints', count: detail.data.value.constraints.length },
                  { id: 'indexes', label: 'Indexes', count: detail.data.value.indexes.length },
                  { id: 'partitions', label: 'Partitions', count: detail.data.value.partitions.length },
                  { id: 'rows', label: 'Sample rows' },
                  { id: 'ddl', label: 'DDL' },
                ]"
              />
              <UiDataTable
                v-if="detailTab === 'columns'"
                :columns="[
                  { key: 'id', label: '#', num: true, width: '40px' },
                  { key: 'name', label: 'Column', mono: true },
                  { key: 'dataType', label: 'Type', mono: true, format: (v, r) => v + (r.precision != null ? `(${r.precision}${r.scale ? ',' + r.scale : ''})` : ['VARCHAR2', 'CHAR', 'NVARCHAR2', 'RAW'].includes(v) ? `(${r.charLength || r.length})` : '') },
                  { key: 'nullable', label: 'Null', format: (v) => (v === 'Y' ? 'yes' : 'NOT NULL') },
                  { key: 'distinct', label: 'Distinct', num: true, format: (v) => fmtCompact(v) },
                  { key: 'nulls', label: 'Nulls', num: true, format: (v) => fmtCompact(v) },
                  { key: 'comment', label: 'Comment', maxWidth: '240px' },
                ]"
                :rows="detail.data.value.columns"
                row-key="name"
                max-height="520px"
              />
              <UiDataTable
                v-else-if="detailTab === 'constraints'"
                :columns="[
                  { key: 'name', label: 'Constraint', mono: true },
                  { key: 'type', label: 'Type', format: (v) => conType[v] ?? v },
                  { key: 'columns', label: 'Columns', mono: true },
                  { key: 'refTable', label: 'References', mono: true },
                  { key: 'condition', label: 'Condition', mono: true, maxWidth: '300px' },
                  { key: 'status', label: 'Status', tone: (v) => (v === 'ENABLED' ? 'ok' : 'warn') },
                  { key: 'validated', label: 'Validated' },
                ]"
                :rows="detail.data.value.constraints"
                row-key="name"
                max-height="520px"
              />
              <UiDataTable
                v-else-if="detailTab === 'indexes'"
                :columns="[
                  { key: 'name', label: 'Index', mono: true },
                  { key: 'columns', label: 'Columns', mono: true },
                  { key: 'uniqueness', label: 'Unique', format: (v) => (v === 'UNIQUE' ? 'yes' : '') },
                  { key: 'locality', label: 'Partitioning', format: (v, r) => (r.partitioned === 'YES' ? v ?? 'partitioned' : 'global (none)') },
                  { key: 'blevel', label: 'BLevel', num: true },
                  { key: 'leafBlocks', label: 'Leaf blocks', num: true, format: (v) => fmtCompact(v) },
                  { key: 'clusteringFactor', label: 'Clust. factor', num: true, format: (v) => fmtCompact(v) },
                  { key: 'status', label: 'Status', tone: (v) => (v === 'VALID' || v === 'N/A' ? 'ok' : 'bad') },
                ]"
                :rows="detail.data.value.indexes"
                row-key="name"
              />
              <UiDataTable
                v-else-if="detailTab === 'partitions'"
                :columns="[
                  { key: 'position', label: '#', num: true },
                  { key: 'name', label: 'Partition', mono: true },
                  { key: 'highValue', label: 'High value', mono: true, maxWidth: '360px' },
                  { key: 'numRows', label: 'Rows', num: true, format: (v) => fmtCompact(v) },
                  { key: 'tablespace', label: 'Tablespace' },
                ]"
                :rows="detail.data.value.partitions"
                row-key="name"
                max-height="520px"
                empty-text="Not partitioned."
              />
              <div v-else-if="detailTab === 'rows'" class="stack">
                <div v-if="rows.error.value" class="callout bad">{{ rows.error.value }}</div>
                <UiDataTable v-else :columns="rowColumns" :rows="rows.data.value?.rows ?? []" max-height="520px" :empty-text="rows.loading.value ? 'Loading…' : 'No rows.'" />
                <div class="row">
                  <button class="btn sm" :disabled="page <= 1" @click="page--">Previous</button>
                  <span class="subtle">Page {{ page }} · 50 rows · LOBs truncated</span>
                  <button class="btn sm" :disabled="(rows.data.value?.rows.length ?? 0) < 50" @click="page++">Next</button>
                </div>
              </div>
              <div v-else>
                <div v-if="ddl.error.value" class="callout bad">{{ ddl.error.value }}</div>
                <UiCode v-else :code="ddl.data.value?.ddl ?? 'Loading…'" />
              </div>
            </div>
          </UiCard>
        </div>

        <div v-else-if="tab === 'inventory'" class="stack">
          <div v-if="inventory.error.value" class="callout bad">{{ inventory.error.value }}</div>
          <template v-else-if="inventory.data.value">
            <UiCard title="Objects by type and status" icon="lucide:blocks">
              <div class="row">
                <span v-for="b in inventory.data.value.byType" :key="b.type + b.status" class="badge" :class="b.status === 'VALID' ? 'ok' : 'bad'">{{ b.type }} · {{ b.count }}{{ b.status !== 'VALID' ? ' ' + b.status : '' }}</span>
              </div>
            </UiCard>
            <UiCard v-if="inventory.data.value.errors.length" title="Compilation errors (ALL_ERRORS)" icon="lucide:bug" flush>
              <UiDataTable :columns="[{ key: 'name', label: 'Object', mono: true }, { key: 'type', label: 'Type' }, { key: 'line', label: 'Line', num: true }, { key: 'text', label: 'Error', maxWidth: '600px' }]" :rows="inventory.data.value.errors" />
            </UiCard>
            <UiCard title="Objects" icon="lucide:list" flush>
              <UiDataTable
                :columns="[
                  { key: 'name', label: 'Name', mono: true },
                  { key: 'type', label: 'Type' },
                  { key: 'status', label: 'Status', tone: (v) => (v === 'VALID' ? 'ok' : 'bad') },
                  { key: 'created', label: 'Created', format: (v) => fmtDate(v) },
                  { key: 'lastDdl', label: 'Last DDL', format: (v) => fmtDate(v) },
                ]"
                :rows="inventory.data.value.objects"
                :row-key="(r) => `${r.type}:${r.name}`"
                clickable
                max-height="560px"
                @row-click="showObjectDdl"
              />
            </UiCard>
          </template>
          <div v-else class="subtle">Loading…</div>
        </div>

        <UiCard v-else-if="tab === 'erd'" title="Entity relationship diagram" icon="lucide:git-fork">
          <template #actions>
            <input v-model="erdPrefix" class="input mono" placeholder="Prefix filter, e.g. DL_" style="width: 200px; height: 26px" >
          </template>
          <div v-if="erd.error.value" class="callout bad">{{ erd.error.value }}</div>
          <div v-else-if="!erd.data.value" class="subtle">Loading…</div>
          <div v-else class="stack">
            <div v-if="erd.data.value.truncated" class="callout warn">Showing the first 400 tables — use a prefix filter.</div>
            <ChartsErd :tables="erd.data.value.tables" :edges="erd.data.value.edges" />
            <p class="subtle">{{ erd.data.value.tables.length }} tables · {{ erd.data.value.edges.length }} foreign keys. Parents on the left; arrows point child → parent. Hover or focus a table to highlight it.</p>
          </div>
        </UiCard>

        <UiCard v-else title="Dependencies (ALL_DEPENDENCIES)" icon="lucide:share-2" flush>
          <div v-if="deps.error.value" class="callout bad" style="margin: 12px">{{ deps.error.value }}</div>
          <UiDataTable
            :columns="[
              { key: 'name', label: 'Object', mono: true },
              { key: 'type', label: 'Type' },
              { key: 'refName', label: 'Depends on', mono: true, format: (v, r) => (r.refOwner !== owner ? `${r.refOwner}.${v}` : v) },
              { key: 'refType', label: 'Ref. type' },
              { key: 'depType', label: 'Kind' },
            ]"
            :rows="deps.data.value ?? []"
            max-height="640px"
            :empty-text="deps.loading.value ? 'Loading…' : 'No dependencies.'"
          />
        </UiCard>
      </div>
    </UiRequireProfile>

    <UiDialog :model-value="!!objDdl" :title="objDdl?.name ?? ''" :width="900" @update:model-value="(v) => !v && (objDdl = null)">
      <UiCode :code="objDdl?.ddl ?? ''" max-height="70vh" />
    </UiDialog>
  </div>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: minmax(280px, 0.8fr) minmax(0, 2fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1100px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

<script setup lang="ts">
import type { ColumnKind, DataSource, ImportConfig, ImportPlan, ImportResult, JobRecord, JobSummary, SourceProfile } from '~~/shared/types/lab'

useHead({ title: 'Import Manager · OracleDB Data Lab' })
const { active, activeId, writable } = useActiveProfile()
const { push } = useToasts()
const route = useRoute()

const STEPS = ['Source', 'Target', 'Mapping', 'Review & run'] as const
const step = ref(0)

// ---------------- 1. Source ----------------
const sources = useLoader<DataSource[]>(() => '/api/datasets/sources')
const sourceId = ref<string>((route.query.source as string) || '')
const sheet = ref<string | null>((route.query.sheet as string) || null)
const hasHeader = ref(true)
const delimiter = ref('')
const encoding = ref('')
const source = computed(() => sources.data.value?.find((s) => s.id === sourceId.value) ?? null)
const profile = useLoader<SourceProfile>(() => (sourceId.value ? `/api/datasets/sources/${sourceId.value}/profile` : null), {
  query: () => ({ sheet: sheet.value || undefined, hasHeader: String(hasHeader.value), delimiter: delimiter.value || undefined, encoding: encoding.value || undefined }),
})
watch(sourceId, () => {
  sheet.value = null
  delimiter.value = ''
  encoding.value = ''
})
const { upload, progress, uploading } = useUpload()
const fileInput = ref<HTMLInputElement | null>(null)
async function onFile(list: FileList | null) {
  const f = list?.[0]
  if (!f) return
  const s = await upload(f)
  await sources.load()
  if (s) sourceId.value = s.id
}

// ---------------- 2. Target ----------------
const schema = ref('')
watch(
  () => active.value?.allowedSchemas,
  (s) => {
    if (!schema.value || !s?.includes(schema.value)) schema.value = s?.[0] ?? ''
  },
  { immediate: true },
)
const mode = ref<'create' | 'append'>('create')
const table = ref('')
const appendTable = ref('')
function suggestTable(name: string) {
  let n = name.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  if (!/^[A-Z]/.test(n)) n = `T_${n}`
  return n.slice(0, 30).replace(/_+$/, '')
}
watch(source, (s) => {
  if (s) table.value = suggestTable(profile.data.value?.sheet && s.format === 'xlsx' ? `${s.name}_${profile.data.value.sheet}` : s.name)
})
const tables = useLoader<{ table: string; numRows: number | null; columns: number; tagged: number }[]>(() =>
  mode.value === 'append' && activeId.value && schema.value ? `/api/import/tables?profileId=${activeId.value}&schema=${encodeURIComponent(schema.value)}` : null,
)
const targetCols = useLoader<{ name: string; type: string; nullable: boolean; hasDefault: boolean }[]>(() =>
  mode.value === 'append' && activeId.value && appendTable.value
    ? `/api/import/columns?profileId=${activeId.value}&schema=${encodeURIComponent(schema.value)}&table=${encodeURIComponent(appendTable.value)}`
    : null,
)

// ---------------- 3. Mapping ----------------
interface MapRow {
  key: string
  include: boolean
  source: number | null
  header: string
  kind: ColumnKind | 'constant'
  samples: string[]
  unique: boolean
  target: string
  type: string
  dateMask: string
  decimalComma: boolean
  constant: string
  pk: boolean
}
const mapping = ref<MapRow[]>([])
const trim = ref(true)
const emptyAsNull = ref(true)
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

function buildMapping() {
  const p = profile.data.value
  if (!p) return
  const tcols = targetCols.data.value ?? []
  mapping.value = p.columns.map((c) => {
    const match = mode.value === 'append' ? tcols.find((t) => norm(t.name) === norm(c.name) || norm(t.name) === norm(c.header)) : null
    return {
      key: `s${c.index}`,
      include: mode.value === 'create' ? true : !!match,
      source: c.index,
      header: c.header,
      kind: c.kind,
      samples: c.samples,
      unique: c.unique,
      target: mode.value === 'create' ? c.name : (match?.name ?? ''),
      type: mode.value === 'create' ? c.oracleType : (match?.type ?? ''),
      dateMask: c.dateMask ?? '',
      decimalComma: c.decimalComma,
      constant: '',
      pk: false,
    }
  })
}
watch([() => profile.data.value, mode, () => targetCols.data.value], buildMapping)
function addConstant() {
  mapping.value.push({ key: `k${Date.now()}`, include: true, source: null, header: '(constant)', kind: 'constant', samples: [], unique: false, target: '', type: 'VARCHAR2(100 CHAR)', dateMask: '', decimalComma: false, constant: '', pk: false })
}
function onTargetPick(r: MapRow) {
  const t = targetCols.data.value?.find((c) => c.name === r.target)
  r.type = t?.type ?? ''
  r.include = !!t
}
const isDateType = (t: string) => /^(DATE|TIMESTAMP)/i.test(t)
const isNumberType = (t: string) => /^(NUMBER|INTEGER|FLOAT)/i.test(t)
const TYPE_SUGGESTIONS = ['VARCHAR2(50 CHAR)', 'VARCHAR2(255 CHAR)', 'VARCHAR2(4000 CHAR)', 'NUMBER', 'NUMBER(10)', 'NUMBER(12,2)', 'DATE', 'TIMESTAMP(6)', 'CLOB']
const MASK_SUGGESTIONS = ['YYYY-MM-DD', 'YYYY-MM-DD HH24:MI:SS', 'DD/MM/YYYY', 'DD/MM/YYYY HH24:MI', 'MM/DD/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD"T"HH24:MI:SS', 'YYYY-MM-DD HH24:MI:SS.FF']
const unmappedRequired = computed(() =>
  mode.value === 'append' ? (targetCols.data.value ?? []).filter((c) => !c.nullable && !c.hasDefault && c.name !== 'DL_IMPORT_ID' && !mapping.value.some((r) => r.include && r.target === c.name)) : [],
)

// ---------------- 4. Review & run ----------------
const opts = reactive({ tagRows: true, batchSize: 5000, maxErrors: 1000, gatherStats: true })
const config = computed<ImportConfig | null>(() => {
  if (!activeId.value || !sourceId.value || !profile.data.value) return null
  const cols = mapping.value.filter((r) => r.include)
  return {
    profileId: activeId.value,
    sourceId: sourceId.value,
    sheet: profile.data.value.sheet,
    hasHeader: hasHeader.value,
    delimiter: (delimiter.value || profile.data.value.delimiter) as ImportConfig['delimiter'],
    encoding: encoding.value || profile.data.value.encoding,
    schema: schema.value,
    table: mode.value === 'create' ? table.value : appendTable.value,
    mode: mode.value,
    columns: cols.map((r) => ({
      source: r.source,
      target: r.target,
      type: r.type,
      dateMask: isDateType(r.type) ? r.dateMask || null : null,
      decimalComma: isNumberType(r.type) && r.decimalComma,
      trim: trim.value,
      emptyAsNull: emptyAsNull.value,
      constant: r.source == null ? r.constant : null,
    })),
    primaryKey: mode.value === 'create' ? cols.filter((r) => r.pk).map((r) => r.target) : [],
    tagRows: opts.tagRows,
    batchSize: opts.batchSize,
    maxErrors: opts.maxErrors,
    gatherStats: opts.gatherStats,
  }
})
const plan = ref<ImportPlan | null>(null)
const planning = ref(false)
watch(config, () => (plan.value = null), { deep: true })
async function validate() {
  if (!config.value) return
  planning.value = true
  try {
    plan.value = await api<ImportPlan>('/api/import/plan', { method: 'POST', body: config.value })
  } catch (err) {
    plan.value = null
    push({ tone: 'bad', title: 'Validation failed', detail: apiErrorMessage(err) })
  } finally {
    planning.value = false
  }
}
const jobId = ref<string | null>(null)
const starting = ref(false)
async function start() {
  if (!config.value) return
  starting.value = true
  try {
    const job = await api<{ id: string }>('/api/import/start', { method: 'POST', body: config.value })
    jobId.value = job.id
    push({ tone: 'info', title: 'Import started', detail: `${config.value.schema}.${config.value.table}` })
  } catch (err) {
    push({ tone: 'bad', title: 'Could not start the import', detail: apiErrorMessage(err) })
  } finally {
    starting.value = false
  }
}

const canNext = computed(() => {
  if (step.value === 0) return !!profile.data.value && !profile.loading.value
  if (step.value === 1) return !!schema.value && (mode.value === 'create' ? /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(table.value) : !!appendTable.value && !!targetCols.data.value)
  if (step.value === 2) return mapping.value.some((r) => r.include) && mapping.value.every((r) => !r.include || (r.target && r.type)) && !unmappedRequired.value.length
  return true
})

// ---------------- History & undo ----------------
const imports = useLoader<JobSummary[]>(() => '/api/jobs?type=import&limit=50')
const bundleImports = useLoader<JobSummary[]>(() => '/api/jobs?type=import-bundle&limit=20')
const history = computed(() => [...(imports.data.value ?? []), ...(bundleImports.data.value ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
function reloadHistory() {
  void imports.load()
  void bundleImports.load()
}
const detail = ref<JobRecord | null>(null)
async function openDetail(id: string) {
  try {
    detail.value = await api<JobRecord>(`/api/jobs/${id}`)
  } catch (err) {
    push({ tone: 'bad', title: 'Could not load the job', detail: apiErrorMessage(err) })
  }
}
const undo = reactive<{ job: JobSummary | null; action: 'delete-rows' | 'drop-tables'; confirm: string; busy: boolean; jobId: string | null }>({ job: null, action: 'drop-tables', confirm: '', busy: false, jobId: null })
const undoTarget = computed(() => {
  const j = undo.job
  if (!j) return ''
  const c = j.config as any
  return j.type === 'import-bundle' ? c.prefix : c.table
})
function openUndo(j: JobSummary) {
  undo.job = j
  undo.action = j.type === 'import' && (j.config as any).mode === 'append' ? 'delete-rows' : 'drop-tables'
  undo.confirm = ''
}
async function runUndo() {
  if (!undo.job) return
  undo.busy = true
  try {
    const job = await api<{ id: string }>('/api/import/undo', { method: 'POST', body: { jobId: undo.job.id, action: undo.action, confirm: undo.confirm } })
    undo.jobId = job.id
    undo.job = null
    push({ tone: 'info', title: 'Undo started', detail: 'Follow it below.' })
  } catch (err) {
    push({ tone: 'bad', title: 'Undo refused', detail: apiErrorMessage(err) })
  } finally {
    undo.busy = false
  }
}
const KIND_TONE: Record<string, string> = { integer: 'info', decimal: 'info', date: 'ok', timestamp: 'ok', text: '', empty: 'warn', constant: 'warn' }
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Import Manager</h1>
        <p>
          Load CSV or Excel files into an authorized lab schema: create a new table from the inferred types or append to an existing one, map and
          convert columns, validate the first rows in Oracle, then run as a resumable job. Rejected rows are reported with their ORA error, and every
          row is tagged with the import id so the load can be undone.
        </p>
      </div>
    </div>

    <UiRequireProfile writes>
      <div class="stack">
        <nav class="stepper" aria-label="Import steps">
          <button v-for="(s, i) in STEPS" :key="s" class="step" :class="{ done: i < step, current: i === step }" :disabled="i > step && !(i === step + 1 && canNext)" @click="i <= step || canNext ? (step = i) : null">
            <span class="n">{{ i < step ? '✓' : i + 1 }}</span>{{ s }}
          </button>
        </nav>

        <!-- 1. Source -->
        <UiCard v-if="step === 0" title="1 · Choose a file" icon="lucide:file-spreadsheet">
          <template #actions>
            <NuxtLink to="/datasets" class="btn sm ghost">Manage sources</NuxtLink>
            <button class="btn sm" :disabled="uploading" @click="fileInput?.click()"><Icon name="lucide:upload" size="13" /> Upload</button>
            <input ref="fileInput" type="file" accept=".csv,.tsv,.txt,.xlsx" hidden @change="onFile(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''" >
          </template>
          <div class="stack-sm">
            <UiProgress v-if="uploading" :value="progress" label="Uploading" />
            <div class="row options">
              <label class="field grow">
                <span>File</span>
                <select v-model="sourceId" class="input">
                  <option value="" disabled>Select a file…</option>
                  <optgroup label="Uploaded"><option v-for="s in (sources.data.value ?? []).filter((x) => x.origin === 'upload')" :key="s.id" :value="s.id">{{ s.name }} ({{ fmtBytes(s.sizeBytes) }})</option></optgroup>
                  <optgroup label="datasets/ folder"><option v-for="s in (sources.data.value ?? []).filter((x) => x.origin === 'folder')" :key="s.id" :value="s.id">{{ s.path }} ({{ fmtBytes(s.sizeBytes) }})</option></optgroup>
                </select>
              </label>
              <label v-if="profile.data.value?.sheets.length" class="field">
                <span>Sheet</span>
                <select v-model="sheet" class="input"><option v-for="s in profile.data.value.sheets" :key="s" :value="s">{{ s }}</option></select>
              </label>
              <label v-if="source?.format === 'csv'" class="field">
                <span>Delimiter</span>
                <select v-model="delimiter" class="input">
                  <option value="">auto</option>
                  <option value=",">comma ,</option>
                  <option value=";">semicolon ;</option>
                  <option value="&#9;">tab</option>
                  <option value="|">pipe |</option>
                </select>
              </label>
              <label v-if="source?.format === 'csv'" class="field">
                <span>Encoding</span>
                <select v-model="encoding" class="input">
                  <option value="">auto</option>
                  <option value="utf8">UTF-8</option>
                  <option value="latin1">Latin-1</option>
                </select>
              </label>
              <label class="check"><input v-model="hasHeader" type="checkbox" > Header row</label>
            </div>
            <div v-if="profile.loading.value" class="state"><span class="spinner" aria-hidden="true" /> Profiling the whole file…</div>
            <div v-else-if="profile.error.value" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ profile.error.value }}</div>
            <DatasetProfile v-else-if="profile.data.value" :profile="profile.data.value" :preview-rows="20" />
            <p v-else class="subtle">Pick a file from the datasets folder or upload a CSV/Excel file.</p>
          </div>
        </UiCard>

        <!-- 2. Target -->
        <UiCard v-else-if="step === 1" title="2 · Target table" icon="lucide:table-2">
          <div class="stack-sm">
            <div class="form-grid">
              <label class="field">
                <span>Schema</span>
                <select v-model="schema" class="input mono"><option v-for="s in active?.allowedSchemas ?? []" :key="s" :value="s">{{ s }}</option></select>
                <small>Authorized for writes on “{{ active?.name }}”.</small>
              </label>
              <div class="field">
                <span>Mode</span>
                <div class="seg" role="group" aria-label="Import mode">
                  <button :aria-pressed="mode === 'create'" @click="mode = 'create'">Create new table</button>
                  <button :aria-pressed="mode === 'append'" @click="mode = 'append'">Append to existing</button>
                </div>
              </div>
              <label v-if="mode === 'create'" class="field">
                <span>New table name</span>
                <input v-model="table" class="input mono" maxlength="128" @change="table = table.toUpperCase()" >
                <small>Must not exist yet — imports never overwrite or truncate.</small>
              </label>
              <label v-else class="field">
                <span>Existing table</span>
                <select v-model="appendTable" class="input mono">
                  <option value="" disabled>{{ tables.loading.value ? 'Loading…' : 'Select a table…' }}</option>
                  <option v-for="t in tables.data.value ?? []" :key="t.table" :value="t.table">{{ t.table }} · {{ t.columns }} cols{{ t.numRows != null ? ` · ${fmtCompact(t.numRows)} rows` : '' }}{{ t.tagged ? ' · tagged' : '' }}</option>
                </select>
                <small>Tables with a DL_IMPORT_ID column can be undone row by row.</small>
              </label>
            </div>
            <div v-if="tables.error.value" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ tables.error.value }}</div>
            <div v-if="mode === 'append' && targetCols.data.value" class="subtle">
              {{ targetCols.data.value.length }} columns: <span class="mono">{{ targetCols.data.value.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(' · ') }}</span>
            </div>
          </div>
        </UiCard>

        <!-- 3. Mapping -->
        <UiCard v-else-if="step === 2" title="3 · Map columns" icon="lucide:arrow-left-right" flush>
          <template #actions>
            <label class="check"><input v-model="trim" type="checkbox" > Trim spaces</label>
            <label class="check"><input v-model="emptyAsNull" type="checkbox" > Empty → NULL</label>
            <button class="btn sm" @click="addConstant"><Icon name="lucide:plus" size="13" /> Constant column</button>
            <button class="btn sm ghost" @click="buildMapping"><Icon name="lucide:rotate-ccw" size="13" /> Reset</button>
          </template>
          <div v-if="unmappedRequired.length" class="callout bad pad"><Icon name="lucide:circle-x" size="16" />Required (NOT NULL) target columns not mapped: {{ unmappedRequired.map((c) => c.name).join(', ') }}</div>
          <div class="table-wrap">
            <table class="data map">
              <thead>
                <tr>
                  <th>Load</th>
                  <th>Source column</th>
                  <th>Target column</th>
                  <th>Oracle type</th>
                  <th>Conversion</th>
                  <th v-if="mode === 'create'" title="Primary key (created after the load)">PK</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in mapping" :key="r.key" :class="{ off: !r.include }">
                  <td><input v-model="r.include" type="checkbox" :aria-label="`Load ${r.header}`" ></td>
                  <td class="src">
                    <div class="mono">{{ r.header }}</div>
                    <div class="row tight">
                      <span class="badge plain" :class="KIND_TONE[r.kind]">{{ r.kind }}</span>
                      <span v-if="r.unique" class="badge plain ok">unique</span>
                      <span class="subtle ellipsis samples" :title="r.samples.join(' · ')">{{ r.samples.slice(0, 3).join(' · ') }}</span>
                    </div>
                    <input v-if="r.source == null" v-model="r.constant" class="input sm mono" placeholder="constant value" >
                  </td>
                  <td>
                    <input v-if="mode === 'create'" v-model="r.target" class="input sm mono" :disabled="!r.include" @change="r.target = r.target.toUpperCase()" >
                    <select v-else v-model="r.target" class="input sm mono" @change="onTargetPick(r)">
                      <option value="">— not loaded —</option>
                      <option v-for="c in targetCols.data.value ?? []" :key="c.name" :value="c.name">{{ c.name }}</option>
                    </select>
                  </td>
                  <td>
                    <input v-if="mode === 'create'" v-model="r.type" class="input sm mono" list="odl-types" :disabled="!r.include" >
                    <span v-else class="mono">{{ r.type || '—' }}</span>
                  </td>
                  <td>
                    <input v-if="isDateType(r.type)" v-model="r.dateMask" class="input sm mono" list="odl-masks" placeholder="date mask" :disabled="!r.include" >
                    <label v-else-if="isNumberType(r.type)" class="check sm"><input v-model="r.decimalComma" type="checkbox" :disabled="!r.include" > decimal comma</label>
                    <span v-else class="subtle">as text</span>
                  </td>
                  <td v-if="mode === 'create'"><input v-model="r.pk" type="checkbox" :disabled="!r.include" :aria-label="`Primary key ${r.target}`" ></td>
                </tr>
              </tbody>
            </table>
          </div>
          <datalist id="odl-types"><option v-for="t in TYPE_SUGGESTIONS" :key="t" :value="t" /></datalist>
          <datalist id="odl-masks"><option v-for="m in MASK_SUGGESTIONS" :key="m" :value="m" /></datalist>
        </UiCard>

        <!-- 4. Review -->
        <template v-else>
          <UiCard title="4 · Review & run" icon="lucide:clipboard-check">
            <div class="stack-sm">
              <div class="form-grid">
                <label class="field"><span>Batch size (rows per array bind)</span><input v-model.number="opts.batchSize" type="number" min="100" max="20000" class="input" ></label>
                <label class="field"><span>Stop after rejected rows</span><input v-model.number="opts.maxErrors" type="number" min="0" class="input" ></label>
              </div>
              <label class="check"><input v-model="opts.tagRows" type="checkbox" > Tag rows with DL_IMPORT_ID (enables precise undo)</label>
              <label class="check"><input v-model="opts.gatherStats" type="checkbox" > Gather optimizer statistics afterwards</label>
              <div class="row">
                <button class="btn" :disabled="planning || !config" @click="validate">
                  <Icon :name="planning ? 'lucide:loader-circle' : 'lucide:scan-eye'" :class="{ spin: planning }" size="15" /> Validate in Oracle
                </button>
                <button class="btn primary" :disabled="!plan || plan.errors.length > 0 || starting || !writable" @click="start"><Icon name="lucide:play" size="15" /> Start import</button>
                <span class="subtle">{{ config?.columns.length }} columns → {{ config?.schema }}.{{ config?.table }} ({{ mode === 'create' ? 'new table' : 'append' }})</span>
              </div>
              <template v-if="plan">
                <div v-for="e in plan.errors" :key="e" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ e }}</div>
                <div v-for="w in plan.warnings" :key="w" class="callout warn"><Icon name="lucide:triangle-alert" size="16" />{{ w }}</div>
                <div v-if="!plan.errors.length && !plan.warnings.length" class="callout ok"><Icon name="lucide:circle-check" size="16" />First {{ plan.preview.length }} rows convert cleanly{{ plan.totalRows != null ? ` · ${fmtNum(plan.totalRows)} rows to load` : '' }}.</div>
              </template>
            </div>
          </UiCard>
          <div v-if="plan" class="grid two">
            <UiCard title="SQL that will run" icon="lucide:code">
              <UiCode :code="[...plan.statements.filter((s) => s.kind === 'create').map((s) => s.sql + ';'), '-- per batch (array bind):', plan.insertSql + ';', ...plan.statements.filter((s) => s.kind !== 'create').map((s) => s.sql + (s.kind === 'stats' ? '' : ';'))].join('\n\n')" max-height="420px" />
            </UiCard>
            <UiCard title="Converted preview (validated by Oracle)" icon="lucide:table-properties" flush>
              <div class="table-wrap" style="max-height: 420px">
                <table class="data">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th v-for="c in config?.columns ?? []" :key="c.target" class="mono">{{ c.target }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="r in plan.preview" :key="r.row">
                      <tr :class="{ bad: r.issues.length }">
                        <td class="num">{{ r.row }}</td>
                        <td v-for="(v, i) in r.values" :key="i" class="mono cell">{{ v ?? 'null' }}</td>
                      </tr>
                      <tr v-if="r.issues.length" class="issues">
                        <td :colspan="r.values.length + 1"><Icon name="lucide:circle-x" size="13" /> {{ r.issues.join(' · ') }}</td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
            </UiCard>
          </div>
          <UiCard v-if="jobId" title="Import job" icon="lucide:activity">
            <JobsLive :job-id="jobId" @settled="reloadHistory" />
          </UiCard>
        </template>

        <div class="row between">
          <button class="btn" :disabled="step === 0" @click="step--"><Icon name="lucide:arrow-left" size="14" /> Back</button>
          <button v-if="step < STEPS.length - 1" class="btn primary" :disabled="!canNext" @click="step++">Next <Icon name="lucide:arrow-right" size="14" /></button>
        </div>

        <!-- History -->
        <UiCard title="Import history" icon="lucide:history" flush>
          <template #actions><button class="btn sm ghost" @click="reloadHistory"><Icon name="lucide:refresh-cw" size="13" /></button></template>
          <UiDataTable
            :columns="[
              { key: 'createdAt', label: 'Started', format: (v) => fmtDate(v) },
              { key: 'title', label: 'Import', maxWidth: '520px' },
              { key: 'status', label: 'Status', tone: (v) => jobTone(v) },
              { key: 'progress', label: 'Result', format: (v) => v?.message ?? '—', maxWidth: '260px' },
              { key: 'actions', label: '', sortable: false },
            ]"
            :rows="history"
            row-key="id"
            max-height="420px"
            empty-text="No imports yet."
          >
            <template #cell-actions="{ row }">
              <div class="row tight">
                <button class="btn sm ghost" @click="openDetail(row.id)">Details</button>
                <button v-if="!['queued', 'running'].includes(row.status)" class="btn sm ghost" @click="openUndo(row)"><Icon name="lucide:undo-2" size="13" /> Undo</button>
              </div>
            </template>
          </UiDataTable>
        </UiCard>
        <UiCard v-if="undo.jobId" title="Undo job" icon="lucide:undo-2">
          <JobsLive :job-id="undo.jobId" @settled="reloadHistory" />
        </UiCard>
      </div>
    </UiRequireProfile>

    <UiDialog :model-value="!!detail" :title="detail?.title ?? ''" :width="900" @update:model-value="(v) => !v && (detail = null)">
      <div v-if="detail" class="stack-sm">
        <div class="row">
          <span class="badge" :class="jobTone(detail.status)">{{ detail.status }}</span>
          <span class="subtle">{{ fmtDate(detail.createdAt) }} · job {{ detail.id }}</span>
        </div>
        <div v-if="detail.error" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ (detail.error as any).message ?? detail.error }}</div>
        <template v-if="detail.type === 'import'">
          <div class="grid kpis">
            <UiKpi label="Inserted" :value="fmtNum((detail.result as ImportResult | null)?.inserted ?? (detail.checkpoint as any)?.inserted)" tone="ok" />
            <UiKpi label="Rejected" :value="fmtNum((detail.result as ImportResult | null)?.rejected ?? (detail.checkpoint as any)?.rejected)" :tone="((detail.result as any)?.rejected ?? (detail.checkpoint as any)?.rejected) ? 'warn' : ''" />
            <UiKpi label="Rows read" :value="fmtNum((detail.result as ImportResult | null)?.rowsRead ?? (detail.checkpoint as any)?.rowsRead)" />
            <UiKpi label="Duration" :value="(detail.result as ImportResult | null) ? `${(detail.result as ImportResult).seconds} s` : '—'" />
          </div>
          <UiDataTable
            v-if="(detail.result as ImportResult | null)?.constraints?.length"
            :columns="[{ key: 'sql', label: 'After load', mono: true, maxWidth: '640px' }, { key: 'status', label: 'Status', tone: (v) => (v === 'ok' ? 'ok' : 'bad') }, { key: 'error', label: 'Error', maxWidth: '260px' }]"
            :rows="(detail.result as ImportResult).constraints"
            row-key="sql"
          />
          <h3>Rejected rows (first {{ ((detail.result as any)?.rejectedSamples ?? (detail.checkpoint as any)?.samples ?? []).length }})</h3>
          <UiDataTable
            :columns="[{ key: 'row', label: 'Record', num: true }, { key: 'error', label: 'Error', maxWidth: '420px' }, { key: 'values', label: 'Values', mono: true, maxWidth: '360px', format: (v) => v.map((x: any) => x ?? 'null').join(' | ') }]"
            :rows="(detail.result as any)?.rejectedSamples ?? (detail.checkpoint as any)?.samples ?? []"
            row-key="row"
            max-height="320px"
            empty-text="No rejected rows."
          />
        </template>
        <template v-else-if="detail.result">
          <UiDataTable
            :columns="[{ key: 'table', label: 'Table', mono: true }, { key: 'inserted', label: 'Inserted', num: true, format: (v) => fmtNum(v) }, { key: 'rejected', label: 'Rejected', num: true }]"
            :rows="(detail.result as any).tables"
            row-key="table"
          />
          <UiDataTable
            :columns="[{ key: 'sql', label: 'Constraint / index / statistics', mono: true, maxWidth: '620px' }, { key: 'status', label: 'Status', tone: (v) => (v === 'ok' ? 'ok' : 'bad') }, { key: 'error', label: 'Error', maxWidth: '260px' }]"
            :rows="(detail.result as any).constraints"
            row-key="sql"
            max-height="300px"
          />
        </template>
      </div>
    </UiDialog>

    <UiDialog :model-value="!!undo.job" title="Undo import" :width="560" @update:model-value="(v) => !v && (undo.job = null)">
      <div v-if="undo.job" class="stack-sm">
        <p class="m0">{{ undo.job.title }}</p>
        <div v-if="undo.job.type === 'import'" class="seg" role="group" aria-label="Undo action">
          <button :aria-pressed="undo.action === 'delete-rows'" @click="undo.action = 'delete-rows'">Delete imported rows</button>
          <button :aria-pressed="undo.action === 'drop-tables'" :disabled="(undo.job.config as any).mode === 'append'" @click="undo.action = 'drop-tables'">Drop the created table</button>
        </div>
        <div class="callout warn">
          <Icon name="lucide:triangle-alert" size="16" />
          <div v-if="undo.action === 'delete-rows'">Deletes the rows tagged <span class="mono">DL_IMPORT_ID = {{ undo.job.id }}</span> from <span class="mono">{{ undoTarget }}</span>. Other rows are untouched.</div>
          <div v-else-if="undo.job.type === 'import'">Drops <span class="mono">{{ (undo.job.config as any).schema }}.{{ undoTarget }}</span> (created by this import) with its constraints. This cannot be undone.</div>
          <div v-else>Drops every table this bundle import created (<span class="mono">{{ undoTarget }}*</span>) with their constraints. This cannot be undone.</div>
        </div>
        <label class="field"><span>Type <strong class="mono">{{ undoTarget }}</strong> to confirm</span><input v-model="undo.confirm" class="input mono" autocomplete="off" ></label>
      </div>
      <template #footer>
        <button class="btn" @click="undo.job = null">Cancel</button>
        <button class="btn danger" :disabled="undo.busy || undo.confirm.trim().toUpperCase() !== undoTarget.toUpperCase()" @click="runUndo">Undo import</button>
      </template>
    </UiDialog>
  </div>
</template>

<style scoped>
.stepper {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.step {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-2);
  font: 500 13px var(--font-sans);
  cursor: pointer;
}
.step:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.step .n {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--bg-sunken);
  font-size: 12px;
}
.step.current {
  border-color: var(--accent);
  color: var(--text);
}
.step.current .n,
.step.done .n {
  background: var(--accent);
  color: var(--accent-text);
}
.stack-sm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.options {
  gap: 12px;
  align-items: flex-end;
}
.grow {
  flex: 1 1 320px;
}
.state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 4px;
  color: var(--text-3);
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.map td {
  vertical-align: middle;
}
.map tr.off td {
  opacity: 0.55;
}
.map .src {
  min-width: 220px;
}
.input.sm {
  height: 28px;
  font-size: 12px;
  min-width: 150px;
}
.check.sm {
  font-size: 12px;
}
.tight {
  gap: 4px;
  flex-wrap: nowrap;
}
.samples {
  max-width: 220px;
  display: inline-block;
}
.pad {
  margin: 12px 14px 0;
}
.cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
tr.bad td {
  background: var(--bad-soft);
}
tr.issues td {
  color: var(--bad);
  font-size: 12px;
  background: var(--bad-soft);
}
.m0 {
  margin: 0;
}
h3 {
  margin: 6px 0 0;
  font-size: 13.5px;
}
</style>

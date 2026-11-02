<script setup lang="ts">
import type { DataSource, DatasetBundle, SourceProfile } from '~~/shared/types/lab'

useHead({ title: 'Dataset Sources · OracleDB Data Lab' })
const { active, activeId, writable } = useActiveProfile()
const { push } = useToasts()
const route = useRoute()

const sources = useLoader<DataSource[]>(() => '/api/datasets/sources')
const bundles = useLoader<(DatasetBundle & { defaultPrefix: string })[]>(() => '/api/datasets/bundles')

// ---- upload (button + drag & drop) ----
const { upload, progress, uploading } = useUpload()
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
async function onFiles(list: FileList | null | undefined) {
  if (!list?.length) return
  let last: DataSource | null = null
  for (const f of Array.from(list)) last = (await upload(f)) ?? last
  await sources.load()
  if (last) select(last.id)
}
function onDrop(e: DragEvent) {
  dragging.value = false
  void onFiles(e.dataTransfer?.files)
}

// ---- selected source + profile ----
const selected = ref<string | null>((route.query.source as string) || null)
const sheet = ref<string | null>(null)
const hasHeader = ref(true)
const delimiter = ref<string>('')
const encoding = ref<string>('')
const refreshToken = ref(0)
const current = computed(() => sources.data.value?.find((s) => s.id === selected.value) ?? null)
function select(id: string) {
  selected.value = id
  sheet.value = null
  hasHeader.value = true
  delimiter.value = ''
  encoding.value = ''
  refreshToken.value = 0
}
const profile = useLoader<SourceProfile>(() => (selected.value ? `/api/datasets/sources/${selected.value}/profile` : null), {
  query: () => ({
    sheet: sheet.value || undefined,
    hasHeader: String(hasHeader.value),
    delimiter: delimiter.value || undefined,
    encoding: encoding.value || undefined,
    refresh: refreshToken.value ? '1' : undefined,
    _: refreshToken.value || undefined,
  }),
})
watch(
  () => profile.data.value,
  (p) => {
    if (p && !sheet.value && p.sheet) sheet.value = p.sheet
    if (p) void sources.load()
  },
)

const deleting = ref<DataSource | null>(null)
async function removeUpload() {
  const s = deleting.value
  if (!s) return
  try {
    await api(`/api/datasets/sources/${s.id}`, { method: 'DELETE' })
    push({ tone: 'ok', title: 'Upload deleted', detail: s.name })
    if (selected.value === s.id) selected.value = null
    await sources.load()
  } catch (err) {
    push({ tone: 'bad', title: 'Delete failed', detail: apiErrorMessage(err) })
  } finally {
    deleting.value = null
  }
}

// ---- bundle import ----
const bundleOpen = ref<(DatasetBundle & { defaultPrefix: string }) | null>(null)
const bundleForm = reactive({ schema: '', prefix: '', batchSize: 5000, gatherStats: true })
const preflight = ref<any>(null)
const checking = ref(false)
const bundleJob = ref<string | null>(null)
function openBundle(b: DatasetBundle & { defaultPrefix: string }) {
  bundleOpen.value = b
  bundleForm.schema = active.value?.allowedSchemas[0] ?? ''
  bundleForm.prefix = b.defaultPrefix
  preflight.value = null
  void runPreflight()
}
async function runPreflight() {
  if (!bundleOpen.value || !activeId.value || !bundleForm.schema) return
  checking.value = true
  try {
    preflight.value = await api(`/api/datasets/bundles/${bundleOpen.value.id}/preflight`, { method: 'POST', body: { profileId: activeId.value, ...bundleForm } })
  } catch (err) {
    preflight.value = { errors: [apiErrorMessage(err)], warnings: [], tables: [] }
  } finally {
    checking.value = false
  }
}
async function startBundle() {
  if (!bundleOpen.value || !activeId.value) return
  try {
    const job = await api<{ id: string }>(`/api/datasets/bundles/${bundleOpen.value.id}/import`, { method: 'POST', body: { profileId: activeId.value, ...bundleForm } })
    bundleJob.value = job.id
    bundleOpen.value = null
    push({ tone: 'info', title: 'Bundle import started', detail: 'Progress is shown below and in Job History.' })
  } catch (err) {
    push({ tone: 'bad', title: 'Could not start the import', detail: apiErrorMessage(err) })
  }
}
const bundleBytes = (b: DatasetBundle) => b.tables.reduce((a, t) => a + (t.sizeBytes ?? 0), 0)
</script>

<template>
  <div class="page" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <div class="page-head">
      <div>
        <h1>Dataset Sources</h1>
        <p>
          Real files to load into lab schemas: everything in the <span class="mono">datasets/</span> folder plus CSV/Excel files you upload here.
          Each file is profiled (row count, inferred Oracle types, nulls, distinct values, keys) before it is imported.
        </p>
      </div>
      <div class="row">
        <button class="btn" :disabled="sources.loading.value" @click="sources.load()"><Icon name="lucide:refresh-cw" size="14" /> Rescan</button>
        <button class="btn primary" :disabled="uploading" @click="fileInput?.click()"><Icon name="lucide:upload" size="14" /> Upload CSV / Excel</button>
        <input ref="fileInput" type="file" accept=".csv,.tsv,.txt,.xlsx" multiple hidden @change="onFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''" >
      </div>
    </div>

    <div class="stack">
      <div class="drop" :class="{ active: dragging }" @click="fileInput?.click()">
        <Icon name="lucide:file-up" size="20" />
        <div>
          <strong>Drop CSV, TSV or .xlsx files here</strong>
          <div class="subtle">Stored on the server under .data/uploads (never in the database until you import). Header row, delimiter, encoding and sheets are detected automatically.</div>
        </div>
        <UiProgress v-if="uploading" :value="progress" class="up-bar" label="Uploading" />
      </div>

      <!-- Bundles -->
      <UiCard v-for="b in bundles.data.value ?? []" :key="b.id" :title="b.name" icon="lucide:package">
        <template #actions>
          <span class="badge plain">{{ b.tables.length }} tables · {{ fmtBytes(bundleBytes(b)) }}</span>
          <button class="btn sm primary" :disabled="!activeId || !writable || b.missing.length > 0" @click="openBundle(b)"><Icon name="lucide:database-zap" size="13" /> Import bundle…</button>
        </template>
        <p class="desc">{{ b.description }}</p>
        <p class="subtle">
          <span v-if="b.license">License: {{ b.license }}</span>
          <template v-if="b.url"> · <a :href="b.url" target="_blank" rel="noopener">source</a></template>
          · tables get primary keys, foreign keys and indexes after loading.
        </p>
        <div v-if="b.missing.length" class="callout warn"><Icon name="lucide:triangle-alert" size="16" />Missing file(s): {{ b.missing.join(', ') }}</div>
        <div v-if="!writable && activeId" class="callout info"><Icon name="lucide:shield" size="16" />The selected connection is read-only. Switch it to lab mode in Connections to import.</div>
        <div class="table-chips">
          <span v-for="t in b.tables" :key="t.table" class="chip mono" :title="t.file">
            {{ b.defaultPrefix }}{{ t.table }} <span class="subtle">{{ fmtBytes(t.sizeBytes) }}</span>
            <span v-if="t.primaryKey.length" class="subtle">· PK {{ t.primaryKey.join(', ') }}</span>
          </span>
        </div>
      </UiCard>
      <UiCard v-if="bundleJob" title="Bundle import" icon="lucide:activity">
        <JobsLive :job-id="bundleJob" @settled="sources.load()" />
      </UiCard>

      <!-- Sources -->
      <div class="grid layout">
        <UiCard title="Files" icon="lucide:folder-open" flush>
          <UiPanelView :panel="sources.data.value ? { status: 'ok', data: sources.data.value, collectedAt: '' } : null" :loading="sources.loading.value" :error="sources.error.value" empty-text="No files yet — put CSV/XLSX files in datasets/ or upload one.">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'name', label: 'File', mono: true, maxWidth: '260px' },
                  { key: 'origin', label: 'Origin' },
                  { key: 'sizeBytes', label: 'Size', num: true, format: (v) => fmtBytes(v) },
                  { key: 'rows', label: 'Rows', num: true, format: (v) => (v == null ? '—' : fmtNum(v)) },
                ]"
                :rows="data"
                row-key="id"
                :selected-key="selected"
                clickable
                max-height="560px"
                @row-click="(r) => select(r.id)"
              >
                <template #cell-origin="{ row }">
                  <span class="nowrap">
                    <span class="badge plain" :class="row.origin === 'upload' ? 'info' : ''">{{ row.origin === 'upload' ? 'uploaded' : 'folder' }}</span>
                    <span class="badge plain">{{ row.format }}</span>
                  </span>
                </template>
              </UiDataTable>
            </template>
          </UiPanelView>
        </UiCard>

        <UiCard :title="current ? current.name : 'Profile'" icon="lucide:scan-search">
          <template v-if="current" #actions>
            <NuxtLink class="btn sm primary" :to="{ path: '/import', query: { source: current.id, sheet: sheet || undefined } }"><Icon name="lucide:file-input" size="13" /> Import…</NuxtLink>
            <button v-if="current.origin === 'upload'" class="btn sm ghost" aria-label="Delete upload" @click="deleting = current"><Icon name="lucide:trash-2" size="14" /></button>
          </template>
          <p v-if="!current" class="subtle">Select a file to profile it. Profiles are cached until the file changes.</p>
          <div v-else class="stack-sm">
            <div class="row options">
              <label v-if="profile.data.value?.sheets.length" class="field inline">
                <span>Sheet</span>
                <select v-model="sheet" class="input"><option v-for="s in profile.data.value.sheets" :key="s" :value="s">{{ s }}</option></select>
              </label>
              <label v-if="current.format === 'csv'" class="field inline">
                <span>Delimiter</span>
                <select v-model="delimiter" class="input">
                  <option value="">auto{{ profile.data.value?.delimiter ? ` (${profile.data.value.delimiter === '\t' ? 'tab' : profile.data.value.delimiter})` : '' }}</option>
                  <option value=",">comma ,</option>
                  <option value=";">semicolon ;</option>
                  <option value="&#9;">tab</option>
                  <option value="|">pipe |</option>
                </select>
              </label>
              <label v-if="current.format === 'csv'" class="field inline">
                <span>Encoding</span>
                <select v-model="encoding" class="input">
                  <option value="">auto</option>
                  <option value="utf8">UTF-8</option>
                  <option value="latin1">Latin-1 / Windows-1252</option>
                </select>
              </label>
              <label class="check"><input v-model="hasHeader" type="checkbox" > First row is a header</label>
              <button class="btn sm" :disabled="profile.loading.value" @click="refreshToken++"><Icon name="lucide:refresh-cw" size="13" /> Re-scan</button>
            </div>
            <div class="subtle">{{ current.path }} · {{ fmtBytes(current.sizeBytes) }} · modified {{ fmtDate(current.modifiedAt) }}</div>
            <div v-if="profile.loading.value" class="state"><span class="spinner" aria-hidden="true" /> Scanning the whole file… large files take a few seconds per million rows.</div>
            <div v-else-if="profile.error.value" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ profile.error.value }}</div>
            <DatasetProfile v-else-if="profile.data.value" :profile="profile.data.value" />
          </div>
        </UiCard>
      </div>
    </div>

    <UiDialog :model-value="!!bundleOpen" :title="`Import ${bundleOpen?.name ?? ''}`" :width="720" @update:model-value="(v) => !v && (bundleOpen = null)">
      <div v-if="bundleOpen" class="stack-sm">
        <div class="form-grid">
          <label class="field">
            <span>Target schema</span>
            <select v-model="bundleForm.schema" class="input mono" @change="runPreflight">
              <option v-for="s in active?.allowedSchemas ?? []" :key="s" :value="s">{{ s }}</option>
            </select>
            <small>Only schemas authorized for writes on “{{ active?.name }}”.</small>
          </label>
          <label class="field"><span>Table prefix</span><input v-model="bundleForm.prefix" class="input mono" maxlength="10" @change="bundleForm.prefix = bundleForm.prefix.toUpperCase(); runPreflight()" ></label>
          <label class="field"><span>Batch size</span><input v-model.number="bundleForm.batchSize" type="number" min="100" max="20000" class="input" ></label>
        </div>
        <label class="check"><input v-model="bundleForm.gatherStats" type="checkbox" > Gather optimizer statistics after loading</label>
        <div v-if="checking" class="state"><span class="spinner" aria-hidden="true" /> Checking…</div>
        <template v-else-if="preflight">
          <div v-for="e in preflight.errors" :key="e" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ e }}</div>
          <div v-for="w in preflight.warnings" :key="w" class="callout warn"><Icon name="lucide:triangle-alert" size="16" />{{ w }}</div>
          <UiDataTable
            :columns="[
              { key: 'table', label: 'Table', mono: true },
              { key: 'sizeBytes', label: 'Source', num: true, format: (v) => fmtBytes(v) },
              { key: 'primaryKey', label: 'Primary key', mono: true, format: (v) => (v.length ? v.join(', ') : '—') },
              { key: 'foreignKeys', label: 'FKs', num: true },
              { key: 'indexes', label: 'Indexes', num: true },
              { key: 'exists', label: 'Status', tone: (v) => (v ? 'bad' : 'ok'), format: (v) => (v ? 'exists' : 'new') },
            ]"
            :rows="preflight.tables"
            row-key="table"
            max-height="300px"
          />
        </template>
      </div>
      <template #footer>
        <button class="btn" @click="bundleOpen = null">Cancel</button>
        <button class="btn primary" :disabled="checking || !preflight || preflight.errors.length > 0" @click="startBundle"><Icon name="lucide:play" size="14" /> Start import</button>
      </template>
    </UiDialog>

    <UiConfirm :model-value="!!deleting" title="Delete uploaded file" confirm-label="Delete file" danger @update:model-value="(v) => !v && (deleting = null)" @confirm="removeUpload">
      <p>Delete <strong>{{ deleting?.name }}</strong> from the server? Tables already imported from it are not affected.</p>
    </UiConfirm>
  </div>
</template>

<style scoped>
.drop {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-elev);
  color: var(--text-2);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.drop.active,
.drop:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.up-bar {
  flex-basis: 100%;
}
.desc {
  margin: 0 0 6px;
  color: var(--text-2);
  max-width: 900px;
}
.table-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.chip {
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-sunken);
}
.nowrap {
  display: inline-flex;
  gap: 4px;
  white-space: nowrap;
}
.layout {
  grid-template-columns: minmax(300px, 0.9fr) minmax(0, 2fr);
  align-items: start;
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
.field.inline {
  min-width: 140px;
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
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>

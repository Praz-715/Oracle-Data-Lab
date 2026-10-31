<script setup lang="ts">
import type { Panel } from '~~/shared/types/lab'

useHead({ title: 'Tablespaces & Storage · OracleDB Data Lab' })
const { activeId, labSchema } = useActiveProfile()
const tab = ref('tablespaces')
const owner = ref('')
const prefix = ref('')
watch(labSchema, (s) => !owner.value && s && (owner.value = s), { immediate: true })

const url = (p: string) => (activeId.value ? `/api/connections/${activeId.value}/storage/${p}` : null)
const ts = useLoader<Panel<any[]>>(() => url('tablespaces'))
const files = useLoader<Panel<any[]>>(() => (tab.value === 'datafiles' ? url('datafiles') : null))
const objects = useLoader<Panel<any[]>>(() => (tab.value === 'objects' && owner.value ? url('objects') : null), { query: () => ({ owner: owner.value, prefix: prefix.value || undefined }) })
const segments = useLoader<Panel<any[]>>(() => (tab.value === 'segments' && owner.value ? url('segments') : null), { query: () => ({ owner: owner.value }) })
const temp = useLoader<Panel<any>>(() => (tab.value === 'tempundo' ? url('temp') : null))
const undo = useLoader<Panel<any>>(() => (tab.value === 'tempundo' ? url('undo') : null))
const history = useLoader<Panel<any>>(() => (tab.value === 'growth' ? url('history') : null))
usePolling(() => ts.load(), 60000)

const warnings = computed(() => {
  const p = ts.data.value
  if (!p || p.status !== 'ok') return []
  return p.data.filter((t) => t.usedPct != null && t.usedPct >= 85)
})
const growthSeries = computed(() => {
  const h = history.data.value
  if (!h || h.status !== 'ok') return []
  const snaps = h.data.snapshots as { ts: string; items: { name: string; used: number | null }[] }[]
  const names = [...new Set(snaps.flatMap((s) => s.items.map((i) => i.name)))]
  const latest = snaps[snaps.length - 1]
  const top = names
    .map((n) => ({ n, used: latest?.items.find((i) => i.name === n)?.used ?? 0 }))
    .sort((a, b) => (b.used ?? 0) - (a.used ?? 0))
    .slice(0, 5)
    .map((x) => x.n)
  return top.map((n, i) => ({ name: n, slot: i, points: snaps.map((s) => ({ x: Date.parse(s.ts), y: s.items.find((it) => it.name === n)?.used ?? null })) }))
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Tablespaces & Storage Lab</h1>
        <p>Measured allocation from segments and datafiles, statistics-based estimates labeled as estimates, TEMP/UNDO usage and a growth forecast from this app's own snapshots.</p>
      </div>
    </div>
    <UiRequireProfile>
      <div class="stack">
        <div v-for="w in warnings" :key="w.name" class="callout" :class="w.usedPct >= 95 ? 'bad' : 'warn'">
          <Icon name="lucide:triangle-alert" size="16" />
          <div>Tablespace <strong class="mono">{{ w.name }}</strong> is at <strong>{{ fmtPct(w.usedPct) }}</strong> of its maximum size ({{ fmtBytes(w.usedBytes) }} of {{ fmtBytes(w.maxBytes) }}{{ w.autoextend ? ', autoextend on' : ', autoextend off' }}).</div>
        </div>

        <UiTabs
          v-model="tab"
          :tabs="[
            { id: 'tablespaces', label: 'Tablespaces' },
            { id: 'datafiles', label: 'Datafiles' },
            { id: 'objects', label: 'Table / index / LOB size' },
            { id: 'segments', label: 'Segments & extents' },
            { id: 'tempundo', label: 'TEMP & UNDO' },
            { id: 'growth', label: 'Growth & capacity' },
          ]"
        />

        <UiCard v-if="tab === 'tablespaces'" title="Tablespaces" icon="lucide:hard-drive">
          <UiPanelView :panel="ts.data.value" :loading="ts.loading.value" :error="ts.error.value">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'name', label: 'Tablespace', mono: true },
                  { key: 'contents', label: 'Contents' },
                  { key: 'status', label: 'Status', tone: (v) => (v === 'ONLINE' ? 'ok' : 'warn') },
                  { key: 'usedPct', label: 'Used of max', sortable: true },
                  { key: 'usedBytes', label: 'Used', num: true, format: (v) => fmtBytes(v) },
                  { key: 'allocatedBytes', label: 'Allocated', num: true, format: (v) => fmtBytes(v) },
                  { key: 'maxBytes', label: 'Max (autoextend)', num: true, format: (v) => fmtBytes(v) },
                  { key: 'autoextend', label: 'Autoext.', format: (v) => (v ? 'yes' : 'no') },
                  { key: 'datafiles', label: 'Files', num: true },
                  { key: 'bigfile', label: 'Bigfile' },
                ]"
                :rows="data"
                row-key="name"
              >
                <template #cell-usedPct="{ value }"><UiUsageBar :pct="value" /></template>
              </UiDataTable>
            </template>
          </UiPanelView>
        </UiCard>

        <UiCard v-else-if="tab === 'datafiles'" title="Datafiles & tempfiles" icon="lucide:files">
          <UiPanelView :panel="files.data.value" :loading="files.loading.value" :error="files.error.value">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'kind', label: 'Kind' },
                  { key: 'fileId', label: 'ID', num: true },
                  { key: 'fileName', label: 'File', mono: true, maxWidth: '420px' },
                  { key: 'tablespace', label: 'Tablespace', mono: true },
                  { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) },
                  { key: 'maxBytes', label: 'Max', num: true, format: (v) => fmtBytes(v) },
                  { key: 'autoextend', label: 'Autoext.' },
                  { key: 'status', label: 'Status' },
                ]"
                :rows="data"
                :row-key="(r) => `${r.kind}:${r.fileId}`"
              />
            </template>
          </UiPanelView>
        </UiCard>

        <UiCard v-else-if="tab === 'objects' || tab === 'segments'" :title="tab === 'objects' ? 'Table, index and LOB sizes' : 'Largest segments'" icon="lucide:ruler">
          <template #actions>
            <input v-model="owner" class="input mono" placeholder="Owner" style="width: 140px; height: 26px" @change="owner = owner.toUpperCase()" >
            <input v-if="tab === 'objects'" v-model="prefix" class="input mono" placeholder="Prefix" style="width: 100px; height: 26px" >
          </template>
          <UiPanelView v-if="tab === 'objects'" :panel="objects.data.value" :loading="objects.loading.value" :error="objects.error.value">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'table', label: 'Table', mono: true },
                  { key: 'numRows', label: 'Rows (stats)', num: true, format: (v) => fmtCompact(v) },
                  { key: 'tableBytes', label: 'Table (measured)', num: true, format: (v) => fmtBytes(v) },
                  { key: 'indexBytes', label: 'Indexes', num: true, format: (v) => fmtBytes(v) },
                  { key: 'lobBytes', label: 'LOBs', num: true, format: (v) => fmtBytes(v) },
                  { key: 'total', label: 'Total', num: true, format: (_, r) => fmtBytes(r.tableBytes + r.indexBytes + r.lobBytes) },
                  { key: 'estimatedBytes', label: 'Estimated (stats)', num: true, format: (v) => fmtBytes(v) },
                  { key: 'extents', label: 'Extents', num: true },
                  { key: 'lastAnalyzed', label: 'Analyzed', format: (v) => fmtRelative(v) },
                ]"
                :rows="data"
                row-key="table"
                max-height="560px"
              />
            </template>
          </UiPanelView>
          <UiPanelView v-else :panel="segments.data.value" :loading="segments.loading.value" :error="segments.error.value">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'segment', label: 'Segment', mono: true },
                  { key: 'partition', label: 'Partition', mono: true },
                  { key: 'type', label: 'Type' },
                  { key: 'tablespace', label: 'Tablespace' },
                  { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) },
                  { key: 'blocks', label: 'Blocks', num: true, format: (v) => fmtCompact(v) },
                  { key: 'extents', label: 'Extents', num: true },
                ]"
                :rows="data"
                :row-key="(r) => `${r.segment}:${r.partition}:${r.type}`"
                max-height="560px"
              />
            </template>
          </UiPanelView>
        </UiCard>

        <div v-else-if="tab === 'tempundo'" class="grid two">
          <UiCard title="TEMP" icon="lucide:thermometer">
            <UiPanelView :panel="temp.data.value" :loading="temp.loading.value" :error="temp.error.value">
              <template #default="{ data }">
                <ChartsBars
                  :items="data.space.map((s: any) => ({ label: s.tablespace, value: ((s.allocatedBytes - s.freeBytes) / Math.max(1, s.sizeBytes)) * 100, sub: `${fmtBytes(s.allocatedBytes - s.freeBytes)} in use of ${fmtBytes(s.sizeBytes)}` }))"
                  :format="(v) => fmtPct(v)"
                  :max="100"
                />
                <h3 style="margin: 14px 0 6px">Sessions using TEMP</h3>
                <UiDataTable :columns="[{ key: 'sid', label: 'SID', num: true }, { key: 'username', label: 'User' }, { key: 'sqlId', label: 'SQL_ID', mono: true }, { key: 'segtype', label: 'Type' }, { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) }]" :rows="data.users" empty-text="None." />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="UNDO" icon="lucide:undo-2">
            <UiPanelView :panel="undo.data.value" :loading="undo.loading.value" :error="undo.error.value">
              <template #default="{ data }">
                <ChartsBars :items="data.extents.map((e: any) => ({ label: `${e.tablespace} · ${e.status}`, value: e.bytes }))" :format="(v) => fmtBytes(v)" :hue="2" />
                <h3 style="margin: 14px 0 6px">V$UNDOSTAT (10-minute buckets)</h3>
                <UiDataTable
                  :columns="[
                    { key: 'begin', label: 'From', format: (v) => fmtDate(v) },
                    { key: 'undoBlocks', label: 'Undo blocks', num: true },
                    { key: 'txnCount', label: 'Txns', num: true },
                    { key: 'maxQuerySeconds', label: 'Longest query (s)', num: true },
                    { key: 'tunedRetention', label: 'Tuned retention (s)', num: true },
                    { key: 'snapshotTooOld', label: 'ORA-01555', num: true },
                    { key: 'noSpace', label: 'No space', num: true },
                  ]"
                  :rows="data.stat"
                  row-key="begin"
                  max-height="320px"
                />
              </template>
            </UiPanelView>
          </UiCard>
        </div>

        <div v-else class="stack">
          <UiPanelView :panel="history.data.value" :loading="history.loading.value" :error="history.error.value">
            <template #default="{ data }">
              <UiCard title="Used space over time (top 5 tablespaces)" icon="lucide:trending-up">
                <ChartsLine :series="growthSeries" :y-format="(v) => fmtBytes(v, 0)" :x-format="(v) => fmtDate(new Date(v).toISOString())" :height="220" />
                <p class="subtle">{{ data.snapshots.length }} snapshot(s). Snapshots are recorded at most every 15 minutes while this page or the Overview is open.</p>
              </UiCard>
              <UiCard title="Capacity forecast (linear fit)" icon="lucide:calendar-clock" flush style="margin-top: 16px">
                <UiDataTable
                  :columns="[
                    { key: 'name', label: 'Tablespace', mono: true },
                    { key: 'points', label: 'Samples', num: true },
                    { key: 'bytesPerDay', label: 'Growth / day', num: true, format: (v) => (v == null ? '—' : fmtBytes(v)) },
                    { key: 'daysToFull', label: 'Days to max', num: true, format: (v) => (v == null ? '—' : fmtNum(v, 1)) },
                    { key: 'note', label: 'Note' },
                  ]"
                  :rows="data.forecast"
                  row-key="name"
                />
              </UiCard>
            </template>
          </UiPanelView>
        </div>
      </div>
    </UiRequireProfile>
  </div>
</template>

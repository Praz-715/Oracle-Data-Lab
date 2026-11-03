<script setup lang="ts">
import type { AssessmentDiff, AssessmentSeverity, FindingChange, PanelDiff } from '~~/shared/types/lab'

/** Snapshot A → B comparison: identity, counts, health-check movement and per-area changes. */
const props = defineProps<{ diff: AssessmentDiff }>()

const SEV_TONE: Record<AssessmentSeverity, 'bad' | 'warn' | 'info' | 'ok' | ''> = { critical: 'bad', warning: 'warn', info: 'info', ok: 'ok', na: '' }
const f = computed(() => props.diff.findings)
const groups = computed(() =>
  [
    { id: 'appeared', title: 'New issues', icon: 'lucide:circle-alert', list: f.value.appeared },
    { id: 'worse', title: 'Got worse', icon: 'lucide:trending-down', list: f.value.worse },
    { id: 'resolved', title: 'Resolved', icon: 'lucide:circle-check', list: f.value.resolved },
    { id: 'better', title: 'Improved', icon: 'lucide:trending-up', list: f.value.better },
    { id: 'still', title: 'Still open', icon: 'lucide:clock', list: f.value.stillOpen },
  ].filter((g) => g.list.length),
)
const changed = computed(() => props.diff.panels.filter((p) => p.status !== 'ok' || p.added.length || p.removed.length || p.changed.length || p.numeric.length))
const quiet = computed(() => props.diff.panels.filter((p) => !changed.value.includes(p)))
const showStill = ref(false)

const isBytes = (field: string) => /bytes/i.test(field)
function cell(v: unknown, field = ''): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'number') return isBytes(field) ? fmtBytes(v) : fmtNum(v, 2)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
const signed = (v: number | null, field = '') => (v == null ? '—' : `${v > 0 ? '+' : ''}${isBytes(field) ? fmtBytes(v) : fmtNum(v)}`)
function rowSummary(r: Record<string, unknown>) {
  return Object.entries(r)
    .filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
    .slice(0, 5)
    .map(([k, v]) => `${k}=${cell(v, k)}`)
    .join(' · ')
}
const panelRows = (p: PanelDiff) => [
  ...p.added.map((x) => ({ id: `+${x.key}`, kind: 'added', key: x.key, field: '', a: '—', b: rowSummary(x.row) })),
  ...p.removed.map((x) => ({ id: `-${x.key}`, kind: 'removed', key: x.key, field: '', a: rowSummary(x.row), b: '—' })),
  ...p.changed.flatMap((c) => c.changes.map((ch) => ({ id: `~${c.key}.${ch.field}`, kind: 'changed', key: c.key, field: ch.field, a: cell(ch.a, ch.field), b: cell(ch.b, ch.field) }))),
  ...p.numeric.map((n) => ({ id: `#${n.key}.${n.field}`, kind: 'drift', key: n.key, field: n.field, a: cell(n.a, n.field), b: `${cell(n.b, n.field)} (${signed(n.delta, n.field)})` })),
]
const KIND_TONE: Record<string, 'ok' | 'bad' | 'info' | ''> = { added: 'ok', removed: 'bad', changed: 'info', drift: '' }
const findingRows = (list: FindingChange[]) => list.map((x) => ({ ...x }))
</script>

<template>
  <div class="stack">
    <div class="grid kpis">
      <UiKpi label="New / worse issues" :value="String(f.appeared.length + f.worse.length)" sub="health checks that got worse" :tone="f.appeared.length + f.worse.length ? 'bad' : 'ok'" />
      <UiKpi label="Resolved / improved" :value="String(f.resolved.length + f.better.length)" sub="health checks that got better" tone="ok" />
      <UiKpi label="Still open" :value="String(f.stillOpen.length)" sub="unchanged issues" :tone="f.stillOpen.length ? 'warn' : 'ok'" />
      <UiKpi label="Config changes" :value="String(diff.totals.changed)" :sub="`+${diff.totals.added} added · −${diff.totals.removed} removed`" tone="info" />
    </div>

    <div class="grid two">
      <UiCard title="Identity" icon="lucide:fingerprint" flush>
        <UiDataTable
          :columns="[{ key: 'field', label: 'Field' }, { key: 'a', label: 'A', mono: true, format: (v) => cell(v) }, { key: 'b', label: 'B', mono: true, format: (v) => cell(v) }]"
          :rows="diff.identity"
          row-key="field"
          empty-text="Same database identity (version, log mode, character set, role…)."
        />
      </UiCard>
      <UiCard title="Inventory counts" icon="lucide:sigma" flush>
        <UiDataTable
          :columns="[
            { key: 'key', label: 'Metric', mono: true },
            { key: 'a', label: 'A', num: true, format: (v, r) => cell(v, r.key) },
            { key: 'b', label: 'B', num: true, format: (v, r) => cell(v, r.key) },
            { key: 'delta', label: 'Δ', num: true, format: (v, r) => signed(v, r.key) },
          ]"
          :rows="diff.counts"
          row-key="key"
          max-height="320px"
          empty-text="No count changed."
        />
      </UiCard>
    </div>

    <UiCard title="Health checks" icon="lucide:stethoscope">
      <template #actions>
        <label v-if="f.stillOpen.length" class="check"><input v-model="showStill" type="checkbox" > Show still-open issues</label>
      </template>
      <p v-if="!groups.length" class="subtle m0">No health checks to compare.</p>
      <p v-else-if="!showStill && groups.every((g) => g.id === 'still')" class="subtle m0">
        No health check changed between A and B — {{ f.stillOpen.length }} issue(s) are still open (tick “Show still-open issues”).
      </p>
      <template v-for="g in groups" :key="g.id">
        <div v-if="g.id !== 'still' || showStill" class="group">
          <h4><Icon :name="g.icon" size="14" /> {{ g.title }} · {{ g.list.length }}</h4>
          <UiDataTable
            :columns="[
              { key: 'a', label: 'A', tone: (v) => (v ? SEV_TONE[v as AssessmentSeverity] : ''), format: (v) => v ?? 'not checked' },
              { key: 'b', label: 'B', tone: (v) => (v ? SEV_TONE[v as AssessmentSeverity] : ''), format: (v) => v ?? 'not checked' },
              { key: 'title', label: 'Check' },
              { key: 'category', label: 'Category' },
              { key: 'detailB', label: 'Now', maxWidth: '460px', format: (v, r) => v ?? r.detailA ?? '—' },
            ]"
            :rows="findingRows(g.list)"
            row-key="id"
          />
        </div>
      </template>
    </UiCard>

    <h3 class="sub">Configuration & inventory changes</h3>
    <UiCard v-for="p in changed" :key="`${p.section}.${p.panel}`" :title="p.status === 'ok' ? `${p.title} · +${p.added.length} −${p.removed.length} ~${p.changed.length}${p.numeric.length ? ` · ${p.numeric.length} drift` : ''}` : p.title" icon="lucide:git-compare" flush>
      <p v-if="p.status !== 'ok'" class="subtle pad">Not comparable — {{ p.note }}</p>
      <UiDataTable
        v-else
        :columns="[
          { key: 'kind', label: 'Change', tone: (v) => KIND_TONE[v] ?? '' },
          { key: 'key', label: 'Item', mono: true, maxWidth: '260px' },
          { key: 'field', label: 'Field', mono: true },
          { key: 'a', label: 'A', mono: true, maxWidth: '320px' },
          { key: 'b', label: 'B', mono: true, maxWidth: '360px' },
        ]"
        :rows="panelRows(p)"
        row-key="id"
        max-height="360px"
      />
    </UiCard>
    <p v-if="quiet.length" class="subtle">No differences in: {{ quiet.map((p) => p.title).join(', ') }}.</p>
  </div>
</template>

<style scoped>
.m0 {
  margin: 0;
}
.group + .group {
  margin-top: 14px;
}
h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 13px;
}
.sub {
  margin: 4px 0 -4px;
  font-size: 14px;
}
.pad {
  margin: 0;
  padding: 12px 14px;
}
</style>

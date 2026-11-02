<script setup lang="ts">
import type { ColumnKind, SourceProfile } from '~~/shared/types/lab'

/** Profile of one data source: summary, inferred columns and the first rows. */
const props = defineProps<{ profile: SourceProfile; previewRows?: number }>()
const view = ref<'columns' | 'preview'>('columns')

const KIND: Record<ColumnKind, { label: string; tone: string }> = {
  integer: { label: 'integer', tone: 'info' },
  decimal: { label: 'decimal', tone: 'info' },
  date: { label: 'date', tone: 'ok' },
  timestamp: { label: 'date-time', tone: 'ok' },
  text: { label: 'text', tone: '' },
  empty: { label: 'empty', tone: 'warn' },
}
const rows = computed(() => props.profile.columns)
const preview = computed(() => props.profile.preview.slice(0, props.previewRows ?? 50))
const delim = computed(() => ({ ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' })[props.profile.delimiter ?? ''] ?? null)
</script>

<template>
  <div class="stack-sm">
    <div class="row chips">
      <span class="badge info plain">{{ fmtNum(profile.rows) }} rows</span>
      <span class="badge plain">{{ profile.columns.length }} columns</span>
      <span v-if="profile.sheet" class="badge plain">sheet {{ profile.sheet }}</span>
      <span v-if="delim" class="badge plain">{{ delim }}-separated</span>
      <span class="badge plain">{{ profile.encoding === 'latin1' ? 'Latin-1' : 'UTF-8' }}</span>
      <span class="badge plain">{{ profile.hasHeader ? 'header row' : 'no header' }}</span>
      <span class="subtle">scanned in {{ fmtMs(profile.durationMs) }} · {{ fmtRelative(profile.profiledAt) }}</span>
      <div class="seg push" role="group" aria-label="Profile view">
        <button :aria-pressed="view === 'columns'" @click="view = 'columns'">Columns</button>
        <button :aria-pressed="view === 'preview'" @click="view = 'preview'">Preview</button>
      </div>
    </div>

    <UiDataTable
      v-if="view === 'columns'"
      :columns="[
        { key: 'header', label: 'Source column', mono: true },
        { key: 'kind', label: 'Detected' },
        { key: 'oracleType', label: 'Oracle type', mono: true },
        { key: 'dateMask', label: 'Mask', mono: true, format: (v) => v ?? '—' },
        { key: 'nulls', label: 'Nulls', num: true, format: (v, r) => `${fmtNum(v)} (${fmtPct((v / Math.max(1, r.nulls + r.nonNull)) * 100, 1)})` },
        { key: 'distinct', label: 'Distinct', num: true, format: (v, r) => `${r.distinctCapped ? '≥' : ''}${fmtNum(v)}` },
        { key: 'min', label: 'Min', mono: true, maxWidth: '160px' },
        { key: 'max', label: 'Max', mono: true, maxWidth: '160px' },
        { key: 'samples', label: 'Samples', mono: true, maxWidth: '260px', format: (v) => v.join(' · ') },
      ]"
      :rows="rows"
      row-key="index"
      max-height="460px"
    >
      <template #cell-kind="{ row }">
        <span class="badge plain" :class="KIND[row.kind as ColumnKind].tone">{{ KIND[row.kind as ColumnKind].label }}</span>
        <span v-if="row.unique" class="badge plain ok" title="Every value is distinct and non-null">unique</span>
        <span v-if="row.keepAsText" class="badge plain" title="Looks numeric but has leading zeros or is too long — kept as text">kept as text</span>
        <span v-if="row.decimalComma" class="badge plain" title="Uses a decimal comma (1.234,56)">decimal comma</span>
      </template>
    </UiDataTable>

    <div v-else class="table-wrap preview">
      <table class="data">
        <thead>
          <tr>
            <th class="num">#</th>
            <th v-for="c in profile.columns" :key="c.index" class="mono">{{ c.header }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in preview" :key="i">
            <td class="num subtle">{{ i + 1 }}</td>
            <td v-for="c in profile.columns" :key="c.index" class="mono cell" :title="r[c.index] ?? ''">
              <span v-if="r[c.index] == null" class="subtle">null</span>
              <template v-else>{{ r[c.index] }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.stack-sm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chips {
  gap: 6px;
}
.push {
  margin-left: auto;
}
.preview {
  max-height: 460px;
}
.cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(td .badge) {
  margin-right: 4px;
}
</style>

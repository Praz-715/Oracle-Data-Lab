<script setup lang="ts">
import type { ActivityClass, ActivitySummary } from '~~/shared/types/lab'

/** Activity summary (ASH-lite or ASH): AAS by class over time, top SQL, top events, top sessions. */
const props = defineProps<{
  summary: ActivitySummary
  cpuCount?: number | null
  xFormat?: (t: number) => string
  showSessions?: boolean
  height?: number
}>()

const CLASS_TONE: Record<ActivityClass, 'ok' | 'warn' | 'info' | 'bad' | ''> = { CPU: 'ok', Commit: 'warn', 'User I/O': 'info', Concurrency: 'bad', Application: 'warn', Other: '' }
const top = computed(() => {
  const entries = Object.entries(props.summary.byClass) as [ActivityClass, number][]
  return entries.sort((a, b) => b[1] - a[1])[0]
})
const cpuShare = computed(() => (props.summary.aas ? (props.summary.byClass.CPU / props.summary.aas) * 100 : 0))
</script>

<template>
  <div class="stack-sm">
    <div class="row stats">
      <span>Avg active sessions <strong class="num">{{ fmtNum(summary.aas, 2) }}</strong></span>
      <span>On CPU <strong class="num">{{ fmtPct(cpuShare, 0) }}</strong></span>
      <span v-if="top && top[1] > 0">Top class <strong>{{ top[0] }}</strong></span>
      <span class="subtle">{{ fmtNum(summary.samples) }} samples over {{ fmtNum(summary.ticks) }} × {{ summary.intervalSec }}s · {{ summary.source === 'ash' ? 'Oracle ASH (Diagnostics Pack)' : 'ASH-lite (V$SESSION sampling, no license needed)' }}</span>
    </div>
    <ChartsActivity :series="summary.series" :cpu-line="cpuCount" :x-format="xFormat" :height="height ?? 190" />
    <div class="grid two">
      <div>
        <h4>Top SQL</h4>
        <UiDataTable
          :columns="[
            { key: 'sqlId', label: 'SQL_ID', mono: true },
            { key: 'pct', label: 'DB time', num: true, format: (v) => fmtPct(v, 1) },
            { key: 'topEvent', label: 'Mostly', maxWidth: '150px' },
            { key: 'text', label: 'Text', mono: true, maxWidth: '300px', format: (v) => v ?? '—' },
          ]"
          :rows="summary.topSql"
          row-key="sqlId"
          empty-text="No SQL sampled."
        >
          <template #cell-sqlId="{ value }"><NuxtLink :to="{ path: '/tuning', query: { sql: value } }" class="mono">{{ value }}</NuxtLink></template>
        </UiDataTable>
      </div>
      <div>
        <h4>Top wait events</h4>
        <UiDataTable
          :columns="[
            { key: 'event', label: 'Event', maxWidth: '240px' },
            { key: 'cls', label: 'Class', tone: (v) => CLASS_TONE[v as ActivityClass] ?? '' },
            { key: 'pct', label: 'DB time', num: true, format: (v) => fmtPct(v, 1) },
            { key: 'samples', label: 'Samples', num: true },
          ]"
          :rows="summary.topEvents"
          row-key="event"
          empty-text="No waits sampled."
        />
        <template v-if="showSessions">
          <h4>Top sessions</h4>
          <UiDataTable
            :columns="[
              { key: 'sid', label: 'SID', num: true },
              { key: 'user', label: 'User', mono: true },
              { key: 'module', label: 'Module', maxWidth: '200px' },
              { key: 'pct', label: 'DB time', num: true, format: (v) => fmtPct(v, 1) },
            ]"
            :rows="summary.topSessions"
            row-key="sid"
            empty-text="No sessions sampled."
          />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stack-sm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.stats {
  gap: 18px;
  font-size: 12.5px;
  color: var(--text-2);
}
h4 {
  margin: 0 0 6px;
  font-size: 12.5px;
  color: var(--text-2);
}
h4:not(:first-child) {
  margin-top: 12px;
}
</style>

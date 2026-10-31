<script setup lang="ts">
import type { DbEnvironment } from '~~/shared/types/lab'

const props = defineProps<{ env: DbEnvironment }>()
const items = computed(() => {
  const e = props.env
  return [
    ['Version', e.serverVersion],
    ['Edition', e.edition],
    ['Database', [e.dbName, e.dbUniqueName && e.dbUniqueName !== e.dbName ? `(${e.dbUniqueName})` : ''].filter(Boolean).join(' ')],
    ['Instance', e.instanceName],
    ['Host', e.hostName],
    ['Role', e.databaseRole],
    ['Open mode', e.openMode],
    ['Log mode', e.logMode],
    ['Multitenant', e.isCdb == null ? null : e.isCdb ? `CDB · container ${e.containerName ?? '?'} (CON_ID ${e.conId ?? '?'})` : 'Non-CDB'],
    ['RAC', e.isRac == null ? null : e.isRac ? `Yes · ${e.instanceCount} instances` : 'Single instance'],
    ['Character set', [e.characterSet, e.nationalCharacterSet].filter(Boolean).join(' / ')],
    ['Uptime', e.uptimeSeconds != null ? `${fmtDuration(e.uptimeSeconds)} (since ${fmtDate(e.startupTime)})` : null],
    ['Session', `${e.sessionUser} → schema ${e.currentSchema}${e.serverTypeInUse ? ` · ${e.serverTypeInUse} server` : ''}`],
    ['Driver', `node-oracledb ${e.driver.version} · ${e.driver.mode} mode${e.driver.clientVersion ? ` · client ${e.driver.clientVersion}` : ''}`],
  ] as [string, string | null][]
})
const enabledOptions = computed(() =>
  Object.entries(props.env.options)
    .filter(([k]) => ['Partitioning', 'Real Application Clusters', 'In-Memory Column Store', 'Advanced Compression', 'Oracle Data Guard', 'Flashback Database', 'Parallel execution', 'Online Index Build'].includes(k))
    .sort(),
)
</script>

<template>
  <div class="stack">
    <dl class="kv">
      <template v-for="[k, v] in items" :key="k">
        <dt>{{ k }}</dt>
        <dd :class="{ na: v == null || v === '' }">{{ v || 'unavailable' }}</dd>
      </template>
    </dl>
    <div v-if="enabledOptions.length">
      <div class="subtle" style="margin-bottom: 6px">Options (V$OPTION)</div>
      <div class="row">
        <span v-for="[k, v] in enabledOptions" :key="k" class="badge" :class="v ? 'ok' : ''">{{ k }}</span>
      </div>
    </div>
    <div class="row">
      <span class="badge" :class="env.privileges.vDollar ? 'ok' : 'warn'">V$ views {{ env.privileges.vDollar ? 'visible' : 'not visible' }}</span>
      <span class="badge" :class="env.privileges.dbaViews ? 'ok' : 'warn'">DBA_ views {{ env.privileges.dbaViews ? 'visible' : 'not visible' }}</span>
    </div>
    <details v-if="Object.keys(env.unavailable).length">
      <summary class="subtle">Why some fields are unavailable ({{ Object.keys(env.unavailable).length }})</summary>
      <ul class="why">
        <li v-for="(v, k) in env.unavailable" :key="k"><span class="mono">{{ k }}</span>: {{ v }}</li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
  font-size: 13px;
}
dt {
  color: var(--text-3);
}
dd {
  margin: 0;
  word-break: break-word;
}
dd.na {
  color: var(--na);
  font-style: italic;
}
.why {
  font-size: 12.5px;
  color: var(--text-2);
  padding-left: 18px;
}
details summary {
  cursor: pointer;
}
</style>

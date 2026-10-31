<script setup lang="ts">
import type { AuditEntry, LabSettings } from '~~/shared/types/lab'

useHead({ title: 'Settings · OracleDB Data Lab' })
const settings = useLoader<LabSettings & { driverError?: string }>(() => '/api/settings')
const auditLog = useLoader<AuditEntry[]>(() => '/api/audit', { query: () => ({ limit: 300 }) })
const s = computed(() => settings.data.value)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Settings</h1>
        <p>Server-side configuration (read from environment variables — see <span class="mono">.env.example</span>) and the audit log of every state-changing action.</p>
      </div>
    </div>
    <div class="stack">
      <div v-if="s?.driverError" class="callout bad"><Icon name="lucide:circle-x" size="16" />Driver initialization failed: {{ s.driverError }}</div>
      <div class="grid two">
        <UiCard title="Oracle driver & pools" icon="lucide:cpu">
          <dl v-if="s" class="kv">
            <dt>Driver</dt><dd>node-oracledb {{ s.driverVersion || '—' }} · <strong>{{ s.driverMode }}</strong> mode</dd>
            <dt>Version support</dt><dd>{{ s.driverMode === 'thin' ? 'Oracle 12.1 and later (use thick mode for 11g)' : 'Oracle 11.2 and later via Oracle Client' }}</dd>
            <dt>Pool per profile</dt><dd>min {{ s.pool.poolMin }} · max {{ s.pool.poolMax }} · idle timeout {{ s.pool.poolTimeout }} s</dd>
            <dt>Call timeout</dt><dd>{{ fmtMs(s.pool.callTimeoutMs) }}</dd>
            <dt>Data directory</dt><dd class="mono">{{ s.dataDir }}</dd>
            <dt>Secret key</dt>
            <dd>
              {{ s.secretSource === 'env' ? 'NUXT_LAB_SECRET' : 'generated (.data/lab/secret.key)' }}
              <span v-if="s.secretSource !== 'env'" class="badge warn">set NUXT_LAB_SECRET for production</span>
            </dd>
          </dl>
        </UiCard>
        <UiCard title="Safety limits" icon="lucide:shield">
          <dl v-if="s" class="kv">
            <dt>Max concurrency</dt><dd>{{ s.limits.maxConcurrency }} sessions</dd>
            <dt>Confirmation above</dt><dd>{{ s.limits.heavyConcurrencyThreshold }} sessions (and always for writes / analytic scans)</dd>
            <dt>Max benchmark time</dt><dd>{{ fmtDuration(s.limits.maxBenchmarkSeconds) }}</dd>
            <dt>Max batch size</dt><dd>{{ fmtNum(s.limits.maxBatchSize) }} rows</dd>
            <dt>Max rows per generation</dt><dd>{{ fmtNum(s.limits.maxRows) }}</dd>
            <dt>Concurrent jobs</dt><dd>{{ s.limits.maxConcurrentJobs }}</dd>
            <dt>Extension tables</dt><dd>≤ {{ s.limits.maxExtensionTables }}</dd>
          </dl>
        </UiCard>
      </div>
      <UiCard title="Audit log" icon="lucide:scroll-text" flush>
        <UiDataTable
          :columns="[
            { key: 'ts', label: 'Time', format: (v) => fmtDate(v) },
            { key: 'action', label: 'Action', mono: true },
            { key: 'target', label: 'Target', mono: true },
            { key: 'outcome', label: 'Outcome', tone: (v) => (v === 'ok' ? 'ok' : v === 'failed' ? 'bad' : 'info') },
            { key: 'detail', label: 'Detail', maxWidth: '520px' },
          ]"
          :rows="auditLog.data.value ?? []"
          row-key="id"
          max-height="560px"
          empty-text="No actions recorded yet."
        />
      </UiCard>
    </div>
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
}
</style>

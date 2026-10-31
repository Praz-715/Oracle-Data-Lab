<script setup lang="ts">
import type { BenchmarkResult } from '~~/shared/types/lab'

const props = defineProps<{ result: BenchmarkResult; jobId: string }>()
const r = computed(() => props.result)
const env = computed(() => r.value.environment)
const errRate = computed(() => (r.value.operations + r.value.errors ? (r.value.errors / (r.value.operations + r.value.errors)) * 100 : 0))
</script>

<template>
  <div class="stack">
    <div class="grid kpis">
      <UiKpi label="Throughput" :value="`${fmtNum(r.opsPerSec, 1)} ops/s`" :sub="`${fmtNum(r.operations)} ops in ${fmtNum(r.measuredSeconds, 1)} s`" tone="info" />
      <UiKpi label="Rows / s" :value="fmtNum(r.rowsPerSec, 1)" :sub="`${fmtNum(r.rows)} rows`" />
      <UiKpi label="Latency p50" :value="fmtMs(r.latency.p50Ms)" :sub="`avg ${fmtMs(r.latency.avgMs)}`" />
      <UiKpi label="Latency p95" :value="fmtMs(r.latency.p95Ms)" :sub="`min ${fmtMs(r.latency.minMs)}`" />
      <UiKpi label="Latency p99" :value="fmtMs(r.latency.p99Ms)" :sub="`max ${fmtMs(r.latency.maxMs)}`" />
      <UiKpi label="Errors" :value="fmtNum(r.errors)" :sub="`${fmtPct(errRate, 2)} · ${r.timeouts} timeouts`" :tone="r.errors ? 'bad' : 'ok'" />
    </div>

    <div class="grid two">
      <UiCard title="Throughput per second" icon="lucide:trending-up">
        <ChartsLine :series="[{ name: 'ops/s', points: r.timeline.map((t) => ({ x: t.t, y: t.ops })) }]" :x-format="(v) => `${v}s`" :y-format="(v) => fmtCompact(v)" :height="180" area />
      </UiCard>
      <UiCard title="p95 latency per second" icon="lucide:timer">
        <ChartsLine :series="[{ name: 'p95', slot: 1, points: r.timeline.map((t) => ({ x: t.t, y: t.p95Ms })) }]" :x-format="(v) => `${v}s`" :y-format="(v) => fmtMs(v)" :height="180" />
      </UiCard>
    </div>

    <div class="grid two">
      <UiCard title="Run configuration & environment" icon="lucide:clipboard-list">
        <dl class="kv">
          <dt>Scenario</dt><dd>#{{ r.scenario.no }} {{ r.scenario.name }}</dd>
          <dt>Sessions</dt><dd>{{ r.config.concurrency }} · warm-up {{ r.config.warmupSeconds }} s · duration {{ r.config.durationSeconds }} s · think {{ r.config.thinkTimeMs }} ms</dd>
          <dt>Batch / ratio</dt><dd>batch {{ r.config.batchSize }} · read ratio {{ r.config.readRatio }}</dd>
          <dt>Target</dt><dd class="mono">{{ r.config.schema }}.{{ r.config.prefix }}*</dd>
          <dt>Oracle</dt><dd>{{ env.banner || env.oracleVersion }} · {{ env.edition }}</dd>
          <dt>Instance</dt><dd>{{ env.instanceName ?? '—' }} {{ env.isRac ? '(RAC)' : '' }}</dd>
          <dt>DB host</dt><dd>{{ env.dbCpuCount != null ? `${env.dbCpuCount} CPUs` : 'CPUs n/a' }} · {{ env.dbPhysicalMemoryBytes != null ? fmtBytes(env.dbPhysicalMemoryBytes) : 'memory n/a' }}</dd>
          <dt>App host</dt><dd>{{ env.appHost.cpus }}× {{ env.appHost.cpuModel }} · {{ fmtBytes(env.appHost.totalMemBytes) }} · {{ env.appHost.platform }} · Node {{ env.appHost.node }}</dd>
          <dt>Driver</dt><dd>node-oracledb {{ env.driverMode }} mode</dd>
          <dt>Window</dt><dd>{{ fmtDate(r.startedAt) }} → {{ fmtDate(r.finishedAt) }}</dd>
        </dl>
        <div class="row" style="margin-top: 10px">
          <a class="btn sm" :href="`/api/benchmarks/${jobId}/export?format=json`" download><Icon name="lucide:download" size="13" /> JSON</a>
          <a class="btn sm" :href="`/api/benchmarks/${jobId}/export?format=csv`" download><Icon name="lucide:download" size="13" /> CSV</a>
          <a class="btn sm" :href="`/api/benchmarks/${jobId}/export?format=html`" download><Icon name="lucide:download" size="13" /> HTML report</a>
        </div>
      </UiCard>
      <UiCard title="Data size & indexes at run time" icon="lucide:database" flush>
        <UiDataTable
          :columns="[{ key: 'table', label: 'Table', mono: true }, { key: 'rows', label: 'Rows (stats)', num: true, format: (v) => (v == null ? 'no stats' : fmtNum(v)) }]"
          :rows="env.dataSize"
          row-key="table"
          max-height="200px"
        />
        <UiDataTable
          :columns="[{ key: 'table', label: 'Table', mono: true }, { key: 'index', label: 'Index', mono: true }, { key: 'columns', label: 'Columns', mono: true }]"
          :rows="env.indexes"
          :row-key="(x) => x.index"
          max-height="200px"
        />
      </UiCard>
    </div>

    <UiCard v-if="r.plan" title="Execution plan" icon="lucide:route">
      <UiCode :code="r.plan" max-height="420px" />
    </UiCard>
    <UiCard v-if="r.errorSamples.length" title="Error samples" icon="lucide:bug">
      <ul class="mono errs">
        <li v-for="(e, i) in r.errorSamples" :key="i">{{ e }}</li>
      </ul>
    </UiCard>
  </div>
</template>

<style scoped>
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 5px 14px;
  margin: 0;
  font-size: 12.5px;
}
dt {
  color: var(--text-3);
}
dd {
  margin: 0;
}
.errs {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
}
</style>

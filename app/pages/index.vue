<script setup lang="ts">
useHead({ title: 'Overview · OracleDB Data Lab' })
const { activeId, active, environment, envError } = useActiveProfile()
const live = useLiveMetrics(5000)
const ov = useLoader<any>(() => (activeId.value ? `/api/connections/${activeId.value}/overview` : null))
usePolling(() => ov.load(), 15000)

const tsPanel = computed(() => ov.data.value?.tablespaces ?? null)
const worstTs = computed(() => {
  const p = tsPanel.value
  if (!p || p.status !== 'ok') return null
  return (p.data as any[]).filter((t) => t.usedPct != null).sort((a, b) => b.usedPct - a.usedPct)[0] ?? null
})
const objects = computed(() => ov.data.value?.objects)
const bench = computed(() => ov.data.value?.latestBenchmark ?? null)
const vUnavailable = computed(() => (live.summary.value?.status === 'unavailable' ? live.summary.value.reason : null))
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Overview</h1>
        <p>Live state of the selected Oracle database and this lab's recent work. Every number comes from Oracle or the job store — nothing is simulated.</p>
      </div>
    </div>

    <UiRequireProfile>
      <div class="stack">
        <div class="grid kpis">
          <UiKpi
            label="Database"
            icon="lucide:database"
            :value="envError ? 'Disconnected' : environment ? 'Connected' : null"
            :tone="envError ? 'bad' : environment ? 'ok' : ''"
            :sub="environment ? (environment.dbName ?? active?.name) : envError ? 'see connection error above' : null"
            :loading="!environment && !envError"
          />
          <UiKpi label="Oracle version" icon="lucide:tag" :value="environment?.serverVersion" :sub="environment?.edition" :loading="!environment && !envError" />
          <UiKpi label="Role" icon="lucide:shield" :value="environment?.databaseRole" :sub="environment?.openMode" :unavailable="environment && !environment.databaseRole ? environment.unavailable.database : null" />
          <UiKpi label="Instance" icon="lucide:server" :value="environment?.instanceName" :sub="environment?.uptimeSeconds != null ? `up ${fmtDuration(environment.uptimeSeconds)}` : environment?.hostName" />
          <UiKpi label="Active sessions" icon="lucide:users" :value="live.latest.value?.activeSessions" :sub="live.summary.value?.status === 'ok' ? `${live.summary.value.data.inactiveUser} inactive` : null" :unavailable="vUnavailable" />
          <UiKpi label="Commits / s" icon="lucide:git-commit-horizontal" :value="live.latest.value?.commitsPerSec != null ? fmtNum(live.latest.value.commitsPerSec, 1) : null" :sub="live.latest.value?.execsPerSec != null ? `${fmtNum(live.latest.value.execsPerSec, 0)} execs/s` : 'collecting…'" :unavailable="live.sysstat.value?.status === 'unavailable' ? live.sysstat.value.reason : null" />
          <UiKpi
            label="Fullest tablespace"
            icon="lucide:hard-drive"
            :value="worstTs ? fmtPct(worstTs.usedPct) : null"
            :sub="worstTs?.name"
            :tone="pctTone(worstTs?.usedPct)"
            :unavailable="tsPanel?.status === 'unavailable' ? tsPanel.reason : null"
            :loading="ov.loading.value"
          />
          <UiKpi label="Objects / tables" icon="lucide:blocks" :value="objects?.status === 'ok' ? `${fmtNum(objects.data.total)} / ${fmtNum(objects.data.tables)}` : null" sub="in current schema" :loading="ov.loading.value" />
          <UiKpi label="Synthetic rows generated" icon="lucide:factory" :value="ov.data.value ? fmtCompact(ov.data.value.syntheticRows) : null" sub="completed generation jobs" :loading="ov.loading.value" />
          <UiKpi
            label="Insert throughput"
            icon="lucide:zap"
            :value="ov.data.value?.currentInsertRate ? `${fmtNum(ov.data.value.currentInsertRate.ratePerSec)} rows/s` : ov.data.value ? 'idle' : null"
            :sub="ov.data.value?.currentInsertRate?.phase ?? 'no generation running'"
            :tone="ov.data.value?.currentInsertRate ? 'info' : ''"
          />
          <UiKpi
            label="Latest benchmark"
            icon="lucide:gauge"
            :value="bench ? (bench.opsPerSec != null ? `${fmtNum(bench.opsPerSec, 1)} ops/s` : bench.status) : ov.data.value ? 'none yet' : null"
            :sub="bench ? `p95 ${fmtMs(bench.p95Ms)} · ${fmtRelative(bench.createdAt)}` : null"
            :tone="bench ? jobTone(bench.status) : ''"
          />
        </div>

        <div v-if="live.error.value && !envError" class="callout bad">{{ live.error.value }}</div>

        <div class="grid two">
          <UiCard title="Active sessions" icon="lucide:users">
            <ChartsLine :series="[{ name: 'Active user sessions', points: live.series('activeSessions') }]" :y-format="(v) => fmtNum(v)" area :height="180" />
            <p class="subtle">Sampled every 5 s since this page was opened.</p>
          </UiCard>
          <UiCard title="Host CPU (V$OSSTAT)" icon="lucide:cpu">
            <UiPanelView v-if="live.sysstat.value?.status === 'unavailable'" :panel="live.sysstat.value" />
            <template v-else>
              <ChartsLine :series="[{ name: 'CPU busy %', slot: 1, points: live.series('cpuPct') }]" :y-format="(v) => `${v.toFixed(0)}%`" :y-min="0" area :height="180" />
              <p class="subtle">BUSY_TIME / (BUSY_TIME + IDLE_TIME) between samples.</p>
            </template>
          </UiCard>
          <UiCard title="SQL throughput" icon="lucide:activity">
            <ChartsLine
              :series="[
                { name: 'Executions/s', slot: 0, points: live.series('execsPerSec') },
                { name: 'User calls/s', slot: 2, points: live.series('userCallsPerSec') },
              ]"
              :y-format="(v) => fmtCompact(v)"
              :height="180"
            />
          </UiCard>
          <UiCard title="Latest benchmark latency" icon="lucide:gauge">
            <template #actions>
              <NuxtLink v-if="bench" :to="`/performance?job=${bench.id}`" class="btn sm ghost">Open</NuxtLink>
            </template>
            <div v-if="!bench" class="subtle">No benchmark has run yet. <NuxtLink to="/performance">Open Performance Lab →</NuxtLink></div>
            <template v-else>
              <div class="subtle ellipsis" style="margin-bottom: 6px">{{ bench.title }}</div>
              <ChartsLine
                :series="[{ name: 'p95 latency (ms)', slot: 1, points: bench.timeline.map((t: any) => ({ x: t.t, y: t.p95Ms })) }]"
                :x-format="(v) => `${v}s`"
                :y-format="(v) => fmtMs(v)"
                :height="160"
              />
            </template>
          </UiCard>
        </div>

        <UiCard title="Tablespace utilization" icon="lucide:hard-drive">
          <UiPanelView :panel="tsPanel" :loading="ov.loading.value" :error="ov.error.value">
            <template #default="{ data }">
              <ChartsBars
                :items="(data as any[]).filter((t) => t.usedPct != null).slice(0, 12).map((t) => ({ label: t.name, value: t.usedPct, sub: `${fmtBytes(t.usedBytes)} of ${fmtBytes(t.maxBytes)}` }))"
                :format="(v) => fmtPct(v)"
                :max="100"
                aria-label="Tablespace used percent of max size"
              />
            </template>
          </UiPanelView>
        </UiCard>
      </div>
    </UiRequireProfile>
  </div>
</template>

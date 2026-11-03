<script setup lang="ts">
import type { ActivitySummary, Panel } from '~~/shared/types/lab'

useHead({ title: 'Instance Monitoring · OracleDB Data Lab' })
const { activeId, active } = useActiveProfile()
const live = useLiveMetrics(5000)
const tab = ref('activity')
const sessionFilter = ref<'ACTIVE' | 'ALL'>('ACTIVE')

const url = (p: string) => (activeId.value ? `/api/connections/${activeId.value}/monitor/${p}` : null)
const sessions = useLoader<Panel<any[]>>(() => (tab.value === 'sessions' ? url('sessions') : null), { query: () => (sessionFilter.value === 'ACTIVE' ? { status: 'ACTIVE' } : {}) })
const waits = useLoader<Panel<any>>(() => (tab.value === 'waits' ? url('waits') : null))
const blocking = useLoader<Panel<any>>(() => (tab.value === 'blocking' ? url('blocking') : null))
const memory = useLoader<Panel<any>>(() => (tab.value === 'memory' ? url('memory') : null))
const processes = useLoader<Panel<any[]>>(() => (tab.value === 'memory' ? url('processes') : null))
const longops = useLoader<Panel<any>>(() => (tab.value === 'longops' ? url('longops') : null))
const temp = useLoader<Panel<any[]>>(() => (tab.value === 'longops' ? url('temp') : null))

// Top activity: ASH-lite sampled server-side every second (or Oracle ASH when licensed).
const activityWindow = ref(300)
const activitySource = ref<'ash-lite' | 'ash'>('ash-lite')
watch(active, (p) => {
  if (!p?.diagnosticsPack) activitySource.value = 'ash-lite'
})
const activity = useLoader<{ summary: ActivitySummary; samplingSince: string | null; windowSec: number; cpuCount: number | null }>(
  () => (tab.value === 'activity' && activeId.value ? `/api/connections/${activeId.value}/activity` : null),
  { query: () => ({ window: activityWindow.value, source: activitySource.value }) },
)
const agoFormat = (t: number) => {
  const ago = Math.max(0, (activity.data.value?.windowSec ?? activityWindow.value) - t)
  return ago >= 60 ? `-${Math.round(ago / 60)}m` : `-${Math.round(ago)}s`
}
usePolling(() => tab.value === 'activity' && activity.load(), 5000)
usePolling(() => {
  if (tab.value === 'sessions') sessions.load()
  if (tab.value === 'waits') waits.load()
  if (tab.value === 'blocking') blocking.load()
  if (tab.value === 'longops') {
    longops.load()
    temp.load()
  }
}, 10000)

// Wait-event deltas between consecutive samples (cumulative counters → time waited per interval).
let prevWaits: { at: number; map: Map<string, number> } | null = null
const waitDeltas = ref<{ event: string; waitClass: string; msPerSec: number }[]>([])
watch(
  () => waits.data.value,
  (p) => {
    if (!p || p.status !== 'ok') return
    const map = new Map<string, number>((p.data.system as any[]).map((r) => [r.event, Number(r.timeWaitedMicro)]))
    if (prevWaits) {
      const dt = (p.data.sampledAtMs - prevWaits.at) / 1000
      waitDeltas.value = (p.data.system as any[])
        .map((r) => ({ event: r.event, waitClass: r.waitClass, msPerSec: dt > 0 ? Math.max(0, (Number(r.timeWaitedMicro) - (prevWaits!.map.get(r.event) ?? Number(r.timeWaitedMicro))) / 1000 / dt) : 0 }))
        .filter((r) => r.msPerSec > 0)
        .sort((a, b) => b.msPerSec - a.msPerSec)
        .slice(0, 10)
    }
    prevWaits = { at: p.data.sampledAtMs, map }
  },
)

const limits = computed(() => (live.summary.value?.status === 'ok' ? live.summary.value.data.limits : []))
const sga = (d: any) => (d.sga as any[]).filter((r) => ['Fixed SGA Size', 'Redo Buffers', 'Buffer Cache Size', 'Shared Pool Size', 'Large Pool Size', 'Java Pool Size', 'Streams Pool Size', 'In-Memory Area Size', 'Maximum SGA Size', 'Free SGA Memory Available'].includes(r.name))
const pgaPick = (d: any, name: string) => (d.pga as any[]).find((r) => r.name === name)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Instance & Session Monitoring</h1>
        <p>Sessions, CPU, memory, waits, locks and long operations from base-license V$ views (no ASH/AWR). Rates are derived from consecutive samples while this page is open.</p>
      </div>
    </div>

    <UiRequireProfile>
      <div class="stack">
        <div class="grid kpis">
          <UiKpi label="Active sessions" :value="live.latest.value?.activeSessions" :unavailable="live.summary.value?.status === 'unavailable' ? live.summary.value.reason : null" />
          <UiKpi label="Host CPU" :value="live.latest.value?.cpuPct != null ? fmtPct(live.latest.value.cpuPct) : null" :sub="live.sysstat.value?.status === 'ok' && live.sysstat.value.data.os ? `${live.sysstat.value.data.os.NUM_CPUS} CPUs` : 'collecting…'" :tone="pctTone(live.latest.value?.cpuPct, 75, 90)" />
          <UiKpi label="Commits / s" :value="fmtNum(live.latest.value?.commitsPerSec, 1)" />
          <UiKpi label="Logical reads / s" :value="fmtCompact(live.latest.value?.logicalReadsPerSec)" />
          <UiKpi label="Physical reads / s" :value="fmtCompact(live.latest.value?.physicalReadsPerSec)" />
          <UiKpi label="Redo / s" :value="live.latest.value?.redoBytesPerSec != null ? fmtBytes(live.latest.value.redoBytesPerSec) : null" />
          <UiKpi label="Hard parses / s" :value="fmtNum(live.latest.value?.hardParsesPerSec, 1)" />
          <UiKpi
            v-for="l in limits.filter((x) => x.name !== 'transactions')"
            :key="l.name"
            :label="`${l.name} used`"
            :value="`${l.current} / ${l.limit}`"
            :sub="`peak ${l.max}`"
            :tone="Number(l.limit) ? pctTone((l.current / Number(l.limit)) * 100, 80, 95) : ''"
          />
        </div>

        <div class="grid three">
          <UiCard title="Active sessions" icon="lucide:users">
            <ChartsLine :series="[{ name: 'active', points: live.series('activeSessions') }]" :height="150" area :y-format="(v) => fmtNum(v)" />
          </UiCard>
          <UiCard title="Logical vs physical reads / s" icon="lucide:book-open">
            <ChartsLine
              :series="[
                { name: 'logical', slot: 0, points: live.series('logicalReadsPerSec') },
                { name: 'physical', slot: 1, points: live.series('physicalReadsPerSec') },
              ]"
              :height="150"
            />
          </UiCard>
          <UiCard title="Redo generation / s" icon="lucide:file-clock">
            <ChartsLine :series="[{ name: 'redo bytes/s', slot: 2, points: live.series('redoBytesPerSec') }]" :height="150" :y-format="(v) => fmtBytes(v, 0)" area />
          </UiCard>
        </div>

        <UiTabs
          v-model="tab"
          :tabs="[
            { id: 'activity', label: 'Top activity' },
            { id: 'sessions', label: 'Sessions' },
            { id: 'waits', label: 'Wait events' },
            { id: 'blocking', label: 'Blocking & locks' },
            { id: 'memory', label: 'SGA / PGA' },
            { id: 'longops', label: 'Long-running & TEMP' },
          ]"
        />

        <UiCard v-if="tab === 'activity'" title="Top activity" icon="lucide:activity">
          <template #actions>
            <div class="seg" role="group" aria-label="Time window">
              <button v-for="w in [300, 900, 3600]" :key="w" :aria-pressed="activityWindow === w" @click="activityWindow = w">{{ w / 60 }} min</button>
            </div>
            <div class="seg" role="group" aria-label="Activity source">
              <button :aria-pressed="activitySource === 'ash-lite'" @click="activitySource = 'ash-lite'">ASH-lite</button>
              <button
                :aria-pressed="activitySource === 'ash'"
                :disabled="!active?.diagnosticsPack"
                :title="active?.diagnosticsPack ? 'Oracle ASH (Diagnostics Pack)' : 'Confirm a Diagnostics Pack license for this profile in Connections to use Oracle ASH'"
                @click="activitySource = 'ash'"
              >
                Oracle ASH
              </button>
            </div>
          </template>
          <div v-if="activity.error.value" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ activity.error.value }}</div>
          <div v-else-if="!activity.data.value" class="subtle">Starting the sampler…</div>
          <template v-else>
            <p v-if="activity.data.value.samplingSince && Date.now() - Date.parse(activity.data.value.samplingSince) < activityWindow * 1000" class="subtle" style="margin: 0 0 8px">
              ASH-lite started sampling {{ fmtRelative(activity.data.value.samplingSince) }} — the window fills up while this page stays open (sampling stops a minute after you leave).
            </p>
            <ActivitySummary :summary="activity.data.value.summary" :cpu-count="activity.data.value.cpuCount" :x-format="agoFormat" show-sessions :height="220" />
          </template>
        </UiCard>

        <UiCard v-if="tab === 'sessions'" title="User sessions (V$SESSION)" icon="lucide:users" flush>
          <template #actions>
            <div class="seg" role="group" aria-label="Session filter">
              <button :aria-pressed="sessionFilter === 'ACTIVE'" @click="sessionFilter = 'ACTIVE'">Active</button>
              <button :aria-pressed="sessionFilter === 'ALL'" @click="sessionFilter = 'ALL'">All</button>
            </div>
          </template>
          <div style="padding: 12px">
            <UiPanelView :panel="sessions.data.value" :loading="sessions.loading.value" :error="sessions.error.value" empty-text="No sessions match.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'sid', label: 'SID', num: true },
                    { key: 'username', label: 'User', mono: true },
                    { key: 'status', label: 'Status', tone: (v) => (v === 'ACTIVE' ? 'info' : '') },
                    { key: 'server', label: 'Server' },
                    { key: 'machine', label: 'Machine', maxWidth: '160px' },
                    { key: 'module', label: 'Module', maxWidth: '180px' },
                    { key: 'action', label: 'Action', maxWidth: '140px' },
                    { key: 'sqlId', label: 'SQL_ID', mono: true },
                    { key: 'event', label: 'Event / wait', maxWidth: '220px' },
                    { key: 'waitClass', label: 'Class' },
                    { key: 'lastCallEt', label: 'Last call (s)', num: true },
                    { key: 'blockingSession', label: 'Blocked by', num: true },
                  ]"
                  :rows="data"
                  row-key="sid"
                  max-height="520px"
                >
                  <template #cell-sqlId="{ value }">
                    <NuxtLink v-if="value" :to="`/tuning?sql=${value}`" class="mono">{{ value }}</NuxtLink>
                  </template>
                </UiDataTable>
              </template>
            </UiPanelView>
          </div>
        </UiCard>

        <div v-else-if="tab === 'waits'" class="grid two">
          <UiCard title="Time waited per second (last interval)" icon="lucide:hourglass">
            <UiPanelView :panel="waits.data.value" :loading="waits.loading.value" :error="waits.error.value">
              <ChartsBars v-if="waitDeltas.length" :items="waitDeltas.map((w) => ({ label: w.event, value: w.msPerSec, sub: w.waitClass }))" :format="(v) => `${fmtNum(v, 1)} ms/s`" :hue="1" />
              <p v-else class="subtle">Collecting a second sample… (refreshes every 10 s)</p>
            </UiPanelView>
          </UiCard>
          <UiCard title="Waiting right now" icon="lucide:clock">
            <UiPanelView :panel="waits.data.value" :loading="waits.loading.value" :error="waits.error.value">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'waitClass', label: 'Class' }, { key: 'event', label: 'Event' }, { key: 'sessions', label: 'Sessions', num: true }]" :rows="data.current" empty-text="No user session is waiting on a non-idle event." />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Top non-idle waits since startup" icon="lucide:list-ordered" style="grid-column: 1 / -1">
            <UiPanelView :panel="waits.data.value" :loading="waits.loading.value">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'event', label: 'Event' },
                    { key: 'waitClass', label: 'Class' },
                    { key: 'totalWaits', label: 'Waits', num: true, format: (v) => fmtCompact(v) },
                    { key: 'timeWaitedMicro', label: 'Time waited', num: true, format: (v) => fmtDuration(v / 1e6) },
                    { key: 'avg', label: 'Avg', num: true, format: (_, r) => fmtMs(r.totalWaits ? r.timeWaitedMicro / r.totalWaits / 1000 : null) },
                  ]"
                  :rows="data.system"
                  row-key="event"
                />
              </template>
            </UiPanelView>
          </UiCard>
        </div>

        <div v-else-if="tab === 'blocking'" class="stack">
          <UiCard title="Blocked sessions" icon="lucide:lock">
            <UiPanelView :panel="blocking.data.value" :loading="blocking.loading.value" :error="blocking.error.value">
              <template #default="{ data }">
                <div v-if="!data.blocked.length" class="callout ok"><Icon name="lucide:circle-check" size="16" />No blocking right now.</div>
                <UiDataTable
                  v-else
                  :columns="[
                    { key: 'sid', label: 'Waiting SID', num: true },
                    { key: 'username', label: 'User' },
                    { key: 'event', label: 'Event' },
                    { key: 'secondsInWait', label: 'Waiting (s)', num: true },
                    { key: 'sqlId', label: 'SQL_ID', mono: true },
                    { key: 'blocker', label: 'Blocker SID', num: true },
                    { key: 'blockerUser', label: 'Blocker user' },
                    { key: 'blockerStatus', label: 'Blocker status' },
                    { key: 'blockerIdleSeconds', label: 'Blocker idle (s)', num: true },
                    { key: 'blockerPrevSqlId', label: 'Blocker prev SQL', mono: true },
                  ]"
                  :rows="data.blocked"
                  row-key="sid"
                />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Locks held / requested (V$LOCK)" icon="lucide:key-round">
            <UiPanelView :panel="blocking.data.value" :loading="blocking.loading.value">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'sid', label: 'SID', num: true }, { key: 'type', label: 'Type' }, { key: 'mode', label: 'Held mode', num: true }, { key: 'request', label: 'Requested', num: true }, { key: 'seconds', label: 'Seconds', num: true }, { key: 'blocking', label: 'Blocking', format: (v) => (v ? 'yes' : '') }]" :rows="data.locks" empty-text="No blocking or waiting locks." />
              </template>
            </UiPanelView>
            <p class="subtle">Deadlocks since startup are counted as “enqueue deadlocks” in V$SYSSTAT{{ live.sysstat.value?.status === 'ok' ? `: ${live.sysstat.value.data.stats['enqueue deadlocks'] ?? 0}` : '' }}. Details are in the alert log / trace files (SQL Diagnostics).</p>
          </UiCard>
        </div>

        <div v-else-if="tab === 'memory'" class="stack">
          <UiPanelView :panel="memory.data.value" :loading="memory.loading.value" :error="memory.error.value">
            <template #default="{ data }">
              <div class="grid kpis">
                <UiKpi label="Buffer cache hit" :value="data.bufferCacheHitRatio != null ? fmtPct(data.bufferCacheHitRatio * 100, 2) : null" sub="cumulative since startup" />
                <UiKpi label="In-memory sorts" :value="data.memorySortRatio != null ? fmtPct(data.memorySortRatio * 100, 2) : null" sub="vs. disk sorts" />
                <UiKpi label="PGA allocated" :value="fmtBytes(pgaPick(data, 'total PGA allocated')?.value)" :sub="`target ${fmtBytes(pgaPick(data, 'aggregate PGA target parameter')?.value)}`" />
                <UiKpi label="PGA in use" :value="fmtBytes(pgaPick(data, 'total PGA inuse')?.value)" :sub="`over-allocations ${fmtNum(pgaPick(data, 'over allocation count')?.value)}`" />
              </div>
              <div class="callout info" style="margin-top: 12px"><Icon name="lucide:info" size="16" />{{ data.interpretation }}</div>
              <div class="grid two" style="margin-top: 16px">
                <UiCard title="SGA (V$SGAINFO)" icon="lucide:memory-stick">
                  <ChartsBars :items="sga(data).map((r: any) => ({ label: r.name, value: r.bytes }))" :format="(v) => fmtBytes(v)" />
                </UiCard>
                <UiCard title="Shared pool top allocations" icon="lucide:layers">
                  <ChartsBars :items="data.sharedPool.map((r: any) => ({ label: r.name, value: r.bytes }))" :format="(v) => fmtBytes(v)" :hue="2" />
                </UiCard>
                <UiCard title="Library cache" icon="lucide:library" flush>
                  <UiDataTable
                    :columns="[
                      { key: 'namespace', label: 'Namespace' },
                      { key: 'gets', label: 'Gets', num: true, format: (v) => fmtCompact(v) },
                      { key: 'getHitRatio', label: 'Get hit', num: true, format: (v) => fmtPct(v * 100) },
                      { key: 'pinHitRatio', label: 'Pin hit', num: true, format: (v) => fmtPct(v * 100) },
                      { key: 'reloads', label: 'Reloads', num: true },
                      { key: 'invalidations', label: 'Invalidations', num: true },
                    ]"
                    :rows="data.library"
                    row-key="namespace"
                  />
                </UiCard>
                <UiCard title="PGA work areas (temp spill)" icon="lucide:hard-drive-download" flush>
                  <UiDataTable
                    :columns="[
                      { key: 'lowBytes', label: 'Size from', num: true, format: (v) => fmtBytes(v) },
                      { key: 'highBytes', label: 'to', num: true, format: (v) => fmtBytes(v) },
                      { key: 'optimal', label: 'Optimal', num: true, format: (v) => fmtCompact(v) },
                      { key: 'onePass', label: 'One-pass', num: true, format: (v) => fmtCompact(v) },
                      { key: 'multiPass', label: 'Multi-pass', num: true, format: (v) => fmtCompact(v) },
                    ]"
                    :rows="data.workarea"
                    row-key="lowBytes"
                    max-height="300px"
                  />
                </UiCard>
              </div>
            </template>
          </UiPanelView>
          <UiCard title="Per-process PGA (top 25)" icon="lucide:cpu" flush>
            <div style="padding: 12px">
              <UiPanelView :panel="processes.data.value" :loading="processes.loading.value">
                <template #default="{ data }">
                  <UiDataTable
                    :columns="[
                      { key: 'spid', label: 'OS PID', mono: true },
                      { key: 'program', label: 'Program', maxWidth: '260px' },
                      { key: 'sid', label: 'SID', num: true },
                      { key: 'username', label: 'User' },
                      { key: 'pgaUsed', label: 'PGA used', num: true, format: (v) => fmtBytes(v) },
                      { key: 'pgaAlloc', label: 'Allocated', num: true, format: (v) => fmtBytes(v) },
                      { key: 'pgaMax', label: 'Max', num: true, format: (v) => fmtBytes(v) },
                    ]"
                    :rows="data"
                    row-key="spid"
                  />
                </template>
              </UiPanelView>
            </div>
          </UiCard>
        </div>

        <div v-else class="stack">
          <UiCard title="Long operations & long-running SQL" icon="lucide:timer">
            <UiPanelView :panel="longops.data.value" :loading="longops.loading.value" :error="longops.error.value">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'sid', label: 'SID', num: true },
                    { key: 'opname', label: 'Operation' },
                    { key: 'target', label: 'Target', mono: true },
                    { key: 'progress', label: 'Progress', num: true, format: (_, r) => fmtPct((r.sofar / r.totalwork) * 100) },
                    { key: 'elapsed', label: 'Elapsed', num: true, format: (v) => fmtDuration(v) },
                    { key: 'remaining', label: 'Remaining', num: true, format: (v) => fmtDuration(v) },
                    { key: 'sqlId', label: 'SQL_ID', mono: true },
                  ]"
                  :rows="data.longops"
                  empty-text="No long operations in progress."
                />
                <h3 style="margin: 14px 0 6px">Active calls running ≥ 30 s</h3>
                <UiDataTable
                  :columns="[{ key: 'sid', label: 'SID', num: true }, { key: 'username', label: 'User' }, { key: 'sqlId', label: 'SQL_ID', mono: true }, { key: 'seconds', label: 'Running', num: true, format: (v) => fmtDuration(v) }, { key: 'event', label: 'Event' }, { key: 'module', label: 'Module' }]"
                  :rows="data.longRunning"
                  empty-text="Nothing running longer than 30 seconds."
                >
                  <template #cell-sqlId="{ value }"><NuxtLink :to="`/tuning?sql=${value}`" class="mono">{{ value }}</NuxtLink></template>
                </UiDataTable>
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Temporary space usage (V$TEMPSEG_USAGE)" icon="lucide:database-zap">
            <UiPanelView :panel="temp.data.value" :loading="temp.loading.value" :error="temp.error.value" empty-text="No session is using TEMP right now.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[{ key: 'sid', label: 'SID', num: true }, { key: 'username', label: 'User' }, { key: 'sqlId', label: 'SQL_ID', mono: true }, { key: 'segtype', label: 'Segment' }, { key: 'tablespace', label: 'Tablespace' }, { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) }]"
                  :rows="data"
                />
              </template>
            </UiPanelView>
          </UiCard>
        </div>
      </div>
    </UiRequireProfile>
  </div>
</template>

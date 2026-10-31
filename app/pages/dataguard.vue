<script setup lang="ts">
useHead({ title: 'Data Guard Lab · OracleDB Data Lab' })
const { activeId } = useActiveProfile()
const d = useLoader<any>(() => (activeId.value ? `/api/connections/${activeId.value}/enterprise/dataguard` : null))
usePolling(() => d.load(), 15000)
const fmtHour = (v: number) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Data Guard & Disaster Recovery Lab</h1>
        <p>Role, protection mode, destinations, transport/apply lag, archive gaps and redo volume. Read-only: switchover/failover drills are not executed from this app.</p>
      </div>
    </div>
    <UiRequireProfile>
      <div v-if="d.error.value" class="callout bad">{{ d.error.value }}</div>
      <div v-else-if="!d.data.value" class="subtle">Loading…</div>
      <div v-else class="stack">
        <UiPanelView :panel="d.data.value.database">
          <template #default="{ data }">
            <div class="grid kpis">
              <UiKpi label="Database role" :value="data.role" :sub="data.dbUniqueName" tone="info" />
              <UiKpi label="Protection" :value="data.protectionMode" :sub="`level ${data.protectionLevel}`" />
              <UiKpi label="Switchover status" :value="data.switchoverStatus" :sub="d.data.value.readiness.explanation" :tone="d.data.value.readiness.ready ? 'ok' : 'warn'" />
              <UiKpi label="Force logging" :value="data.forceLogging" :tone="data.forceLogging === 'YES' ? 'ok' : 'warn'" />
              <UiKpi label="Flashback" :value="data.flashback" />
              <UiKpi label="Broker" :value="data.broker" :sub="data.logMode" />
            </div>
          </template>
        </UiPanelView>
        <div class="grid two">
          <UiCard title="Archive destinations" icon="lucide:send">
            <UiPanelView :panel="d.data.value.destinations" empty-text="No active archive destinations.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'destId', label: 'Dest', num: true },
                    { key: 'status', label: 'Status', tone: (v) => (v === 'VALID' ? 'ok' : 'bad') },
                    { key: 'type', label: 'Type' },
                    { key: 'destination', label: 'Target', mono: true },
                    { key: 'databaseMode', label: 'Mode' },
                    { key: 'recoveryMode', label: 'Recovery' },
                    { key: 'archivedSeq', label: 'Archived seq', num: true },
                    { key: 'appliedSeq', label: 'Applied seq', num: true },
                    { key: 'gapStatus', label: 'Gap' },
                    { key: 'error', label: 'Error', maxWidth: '200px' },
                  ]"
                  :rows="data"
                  row-key="destId"
                />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Transport & apply lag (V$DATAGUARD_STATS)" icon="lucide:timer">
            <UiPanelView :panel="d.data.value.lag" empty-text="No lag statistics — expected on a primary; query the standby for lag.">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'name', label: 'Metric' }, { key: 'value', label: 'Value', mono: true }, { key: 'computed', label: 'Computed' }]" :rows="data" row-key="name" />
              </template>
            </UiPanelView>
            <UiPanelView :panel="d.data.value.gaps" empty-text="No archive gap reported.">
              <template #default="{ data }">
                <div class="callout bad" style="margin-top: 10px">Archive gap: {{ data.map((g: any) => `thread ${g.thread} seq ${g.low}–${g.high}`).join(', ') }}</div>
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Archived redo per hour (24 h)" icon="lucide:file-clock">
            <UiPanelView :panel="d.data.value.redoRate" empty-text="No archived logs in the last 24 hours.">
              <template #default="{ data }">
                <ChartsLine :series="[{ name: 'Archived redo', points: data.map((h: any) => ({ x: Date.parse(h.hour), y: h.bytes })) }]" :x-format="fmtHour" :y-format="(v) => fmtBytes(v, 0)" area :height="180" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Recent archived logs" icon="lucide:list" flush>
            <div style="padding: 12px">
              <UiPanelView :panel="d.data.value.recentLogs">
                <template #default="{ data }">
                  <UiDataTable
                    :columns="[{ key: 'thread', label: 'Thr', num: true }, { key: 'sequence', label: 'Seq', num: true }, { key: 'destId', label: 'Dest', num: true }, { key: 'applied', label: 'Applied' }, { key: 'completed', label: 'Completed', format: (v) => fmtDate(v) }, { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) }]"
                    :rows="data"
                    :row-key="(x) => `${x.thread}:${x.sequence}:${x.destId}`"
                    max-height="300px"
                  />
                </template>
              </UiPanelView>
            </div>
          </UiCard>
        </div>
        <UiCard title="Planned: controlled switchover / failover drill" icon="lucide:hammer">
          <p class="muted">Role changes will require pre-flight validation on both primary and standby, typed confirmation, full action logging and a documented recovery path, and will only be offered for profiles marked as isolated lab environments. They are intentionally not available yet.</p>
        </UiCard>
      </div>
    </UiRequireProfile>
  </div>
</template>

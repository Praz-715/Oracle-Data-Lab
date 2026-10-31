<script setup lang="ts">
useHead({ title: 'RAC Lab · OracleDB Data Lab' })
const { activeId } = useActiveProfile()
const r = useLoader<any>(() => (activeId.value ? `/api/connections/${activeId.value}/enterprise/rac` : null))
usePolling(() => r.load(), 15000)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>RAC Cluster Lab</h1>
        <p>Instances, services, session distribution, Global Cache and interconnect from GV$ views. Read-only: service relocation and node-change simulations need a dedicated test cluster and are not executed from here.</p>
      </div>
    </div>
    <UiRequireProfile>
      <div v-if="r.error.value" class="callout bad">{{ r.error.value }}</div>
      <div v-else-if="!r.data.value" class="subtle">Loading…</div>
      <div v-else class="stack">
        <div class="callout" :class="r.data.value.isRac ? 'ok' : 'info'">
          <Icon :name="r.data.value.isRac ? 'lucide:network' : 'lucide:server'" size="16" />
          <div v-if="r.data.value.isRac">Clustered database detected.</div>
          <div v-else>This database runs as a <strong>single instance</strong>. RAC-specific panels are shown as unavailable; workload results here are your single-instance baseline for later comparison.</div>
        </div>
        <UiCard title="Instances (GV$INSTANCE)" icon="lucide:server" flush>
          <div style="padding: 12px">
            <UiPanelView :panel="r.data.value.instances">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[{ key: 'instId', label: 'Inst', num: true }, { key: 'instance', label: 'Instance', mono: true }, { key: 'host', label: 'Host' }, { key: 'status', label: 'Status', tone: (v) => (v === 'OPEN' ? 'ok' : 'warn') }, { key: 'thread', label: 'Thread', num: true }, { key: 'version', label: 'Version' }, { key: 'startup', label: 'Started', format: (v) => fmtDate(v) }]"
                  :rows="data"
                  row-key="instId"
                />
              </template>
            </UiPanelView>
          </div>
        </UiCard>
        <div class="grid two">
          <UiCard title="Session distribution" icon="lucide:users">
            <UiPanelView :panel="r.data.value.sessions">
              <template #default="{ data }">
                <ChartsBars :items="data.map((s: any) => ({ label: `instance ${s.instId}`, value: s.total, sub: `${s.active} active` }))" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Services (GV$ACTIVE_SERVICES)" icon="lucide:route">
            <UiPanelView :panel="r.data.value.services">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'service', label: 'Service', mono: true }, { key: 'instId', label: 'Running on inst', num: true }, { key: 'networkName', label: 'Network name', mono: true }]" :rows="data" :row-key="(x) => `${x.service}:${x.instId}`" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Global Cache statistics" icon="lucide:share-2">
            <UiPanelView :panel="r.data.value.gcStats">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'instId', label: 'Inst', num: true }, { key: 'name', label: 'Statistic' }, { key: 'value', label: 'Value', num: true, format: (v) => fmtCompact(v) }]" :rows="data" :row-key="(x) => `${x.instId}:${x.name}`" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="GC wait events" icon="lucide:hourglass">
            <UiPanelView :panel="r.data.value.gcWaits">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'instId', label: 'Inst', num: true }, { key: 'event', label: 'Event' }, { key: 'waits', label: 'Waits', num: true, format: (v) => fmtCompact(v) }, { key: 'waitedMs', label: 'Waited', num: true, format: (v) => fmtMs(v) }]" :rows="data" :row-key="(x) => `${x.instId}:${x.event}`" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Interconnect" icon="lucide:cable">
            <UiPanelView :panel="r.data.value.interconnect">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'instId', label: 'Inst', num: true }, { key: 'name', label: 'Interface' }, { key: 'ip', label: 'IP', mono: true }, { key: 'isPublic', label: 'Public' }, { key: 'source', label: 'Source' }]" :rows="data" :row-key="(x) => `${x.instId}:${x.name}`" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="Planned: failover & service relocation drills" icon="lucide:hammer">
            <p class="muted">Not executed from this app yet. Requires an isolated test cluster, pre-flight checks, explicit confirmation and an audit trail. Compare single-instance vs RAC by running the same Performance Lab scenario against each and using History & compare.</p>
          </UiCard>
        </div>
      </div>
    </UiRequireProfile>
  </div>
</template>

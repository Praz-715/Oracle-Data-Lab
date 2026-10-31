<script setup lang="ts">
useHead({ title: 'RMAN Lab · OracleDB Data Lab' })
const { activeId } = useActiveProfile()
const r = useLoader<any>(() => (activeId.value ? `/api/connections/${activeId.value}/enterprise/rman` : null))
const statusTone = (s: string) => (/COMPLETED$/.test(s) ? 'ok' : /WARNING/.test(s) ? 'warn' : /FAILED|ERRORS/.test(s) ? 'bad' : 'info')
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>RMAN Backup & Recovery Lab</h1>
        <p>Backup jobs, sets and pieces, throughput, archived-log coverage and an RPO estimate from the control file views. Restore validation and recovery drills must target a separate database and are not run from here yet.</p>
      </div>
    </div>
    <UiRequireProfile>
      <div v-if="r.error.value" class="callout bad">{{ r.error.value }}</div>
      <div v-else-if="!r.data.value" class="subtle">Loading…</div>
      <div v-else class="stack">
        <div class="grid kpis">
          <template v-if="r.data.value.rpo.status === 'ok' && r.data.value.rpo.data">
            <UiKpi label="Since last archivelog backup" :value="r.data.value.rpo.data.sinceArchivelogSec != null ? fmtDuration(r.data.value.rpo.data.sinceArchivelogSec) : 'never'" sub="RPO estimate" :tone="r.data.value.rpo.data.sinceArchivelogSec == null || r.data.value.rpo.data.sinceArchivelogSec > 86400 ? 'warn' : 'ok'" />
            <UiKpi label="Since any backup" :value="r.data.value.rpo.data.sinceAnySec != null ? fmtDuration(r.data.value.rpo.data.sinceAnySec) : 'never'" />
            <UiKpi label="Best DB read rate" :value="r.data.value.rpo.data.bestDbReadRate ? `${fmtBytes(r.data.value.rpo.data.bestDbReadRate)}/s` : null" sub="RTO lower-bound proxy" />
          </template>
          <UiKpi v-else label="RPO estimate" :unavailable="r.data.value.rpo.status === 'unavailable' ? r.data.value.rpo.reason : 'No RMAN history'" />
          <template v-if="r.data.value.archCoverage.status === 'ok' && r.data.value.archCoverage.data">
            <UiKpi label="Archived logs not backed up" :value="fmtNum(r.data.value.archCoverage.data.notBackedUp)" :sub="`of ${fmtNum(r.data.value.archCoverage.data.total)} · oldest ${fmtDate(r.data.value.archCoverage.data.oldestUnbacked)}`" :tone="r.data.value.archCoverage.data.notBackedUp ? 'warn' : 'ok'" />
          </template>
        </div>
        <p v-if="r.data.value.rpo.status === 'ok'" class="subtle">{{ r.data.value.rpo.note }}</p>

        <UiCard title="Backup jobs (last 60 days)" icon="lucide:archive">
          <UiPanelView :panel="r.data.value.jobs" empty-text="No RMAN backup jobs recorded in the control file.">
            <template #default="{ data }">
              <div class="grid two" style="margin-bottom: 14px">
                <div>
                  <div class="subtle">Duration</div>
                  <ChartsLine :series="[{ name: 'Elapsed', points: [...data].reverse().map((j: any) => ({ x: Date.parse(j.start), y: j.elapsed })) }]" :x-format="(v) => fmtDate(new Date(v).toISOString(), false)" :y-format="(v) => fmtDuration(v)" :height="160" />
                </div>
                <div>
                  <div class="subtle">Output size</div>
                  <ChartsLine :series="[{ name: 'Output bytes', slot: 2, points: [...data].reverse().map((j: any) => ({ x: Date.parse(j.start), y: j.outputBytes })) }]" :x-format="(v) => fmtDate(new Date(v).toISOString(), false)" :y-format="(v) => fmtBytes(v, 0)" :height="160" />
                </div>
              </div>
              <UiDataTable
                :columns="[
                  { key: 'start', label: 'Started', format: (v) => fmtDate(v) },
                  { key: 'inputType', label: 'Type' },
                  { key: 'status', label: 'Status', tone: (v) => statusTone(v) },
                  { key: 'elapsed', label: 'Duration', num: true, format: (v) => fmtDuration(v) },
                  { key: 'inputBytes', label: 'Read', num: true, format: (v) => fmtBytes(v) },
                  { key: 'outputBytes', label: 'Written', num: true, format: (v) => fmtBytes(v) },
                  { key: 'inputRate', label: 'Read/s', num: true, format: (v) => fmtBytes(v) },
                  { key: 'compression', label: 'Ratio', num: true, format: (v) => fmtNum(v, 2) },
                  { key: 'device', label: 'Device' },
                ]"
                :rows="data"
                row-key="sessionKey"
                max-height="360px"
              />
            </template>
          </UiPanelView>
        </UiCard>
        <div class="grid two">
          <UiCard title="Backup sets by type" icon="lucide:boxes">
            <UiPanelView :panel="r.data.value.sets" empty-text="No backup sets.">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'type', label: 'Type' }, { key: 'level', label: 'Level', num: true }, { key: 'sets', label: 'Sets', num: true }, { key: 'pieces', label: 'Pieces', num: true }, { key: 'lastCompleted', label: 'Last', format: (v) => fmtDate(v) }]" :rows="data" :row-key="(x) => `${x.type}:${x.level}`" />
              </template>
            </UiPanelView>
          </UiCard>
          <UiCard title="RMAN configuration (non-default)" icon="lucide:settings-2">
            <UiPanelView :panel="r.data.value.config" empty-text="All RMAN settings are at defaults.">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'name', label: 'Setting' }, { key: 'value', label: 'Value', mono: true }]" :rows="data" row-key="name" />
              </template>
            </UiPanelView>
          </UiCard>
        </div>
        <UiCard title="Backup pieces (latest 100)" icon="lucide:file-archive" flush>
          <div style="padding: 12px">
            <UiPanelView :panel="r.data.value.pieces" empty-text="No backup pieces.">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'completed', label: 'Completed', format: (v) => fmtDate(v) }, { key: 'handle', label: 'Handle', mono: true, maxWidth: '520px' }, { key: 'device', label: 'Device' }, { key: 'status', label: 'Status' }, { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) }]" :rows="data" row-key="recid" max-height="360px" />
              </template>
            </UiPanelView>
          </div>
        </UiCard>
      </div>
    </UiRequireProfile>
  </div>
</template>

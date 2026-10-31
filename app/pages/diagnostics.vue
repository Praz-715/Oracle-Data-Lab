<script setup lang="ts">
useHead({ title: 'SQL Diagnostics · OracleDB Data Lab' })
const { activeId } = useActiveProfile()
const { push } = useToasts()
const tab = ref('alert')
const alerts = useLoader<any>(() => (activeId.value && tab.value === 'alert' ? `/api/connections/${activeId.value}/diagnostics/alerts` : null))

const text = ref('')
const analyzing = ref(false)
const pasted = ref<any>(null)
async function analyze() {
  analyzing.value = true
  try {
    pasted.value = await api('/api/diagnostics/analyze', { method: 'POST', body: { text: text.value } })
  } catch (err) {
    push({ tone: 'bad', title: 'Analysis failed', detail: apiErrorMessage(err) })
  } finally {
    analyzing.value = false
  }
}
async function loadFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) text.value = await f.text()
}
const groupCols = [
  { key: 'code', label: 'Code', mono: true },
  { key: 'count', label: 'Count', num: true },
  { key: 'first', label: 'First seen', format: (v: string) => fmtDate(v) },
  { key: 'last', label: 'Last seen', format: (v: string) => fmtDate(v) },
  { key: 'guidance', label: 'What it usually means', maxWidth: '440px', format: (v: string | null) => v ?? '—' },
]
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>SQL Diagnostics · ORA Error & Alert Analyzer</h1>
        <p>Groups ORA-/TNS- errors from the alert log (V$DIAG_ALERT_EXT, 12c+) or from pasted alert-log / trace text, with first/last occurrence and first-step guidance.</p>
      </div>
    </div>
    <div class="stack">
      <UiTabs v-model="tab" :tabs="[{ id: 'alert', label: 'Alert log (last 3 days)' }, { id: 'paste', label: 'Analyze pasted text' }]" />

      <UiRequireProfile v-if="tab === 'alert'">
        <div class="stack">
          <div v-if="alerts.error.value" class="callout bad">{{ alerts.error.value }}</div>
          <template v-else-if="alerts.data.value">
            <UiCard title="Error groups" icon="lucide:layers" flush>
              <div style="padding: 12px">
                <UiPanelView :panel="alerts.data.value.panel">
                  <UiDataTable :columns="groupCols" :rows="alerts.data.value.groups" row-key="code" empty-text="No ORA/TNS errors in the last 3 days." />
                </UiPanelView>
              </div>
            </UiCard>
            <UiCard v-if="alerts.data.value.panel.status === 'ok'" title="Recent alert-log messages" icon="lucide:scroll-text" flush>
              <UiDataTable
                :columns="[{ key: 'ts', label: 'Time', format: (v) => fmtDate(v) }, { key: 'level', label: 'Level', num: true }, { key: 'text', label: 'Message', mono: true, maxWidth: '900px' }]"
                :rows="alerts.data.value.panel.data"
                max-height="520px"
              />
            </UiCard>
          </template>
          <div v-else class="subtle">Loading…</div>
        </div>
      </UiRequireProfile>

      <template v-else>
        <UiCard title="Alert log or trace text" icon="lucide:clipboard-paste">
          <div class="stack">
            <textarea v-model="text" class="input" rows="10" spellcheck="false" placeholder="Paste alert_<SID>.log or a trace file excerpt…" aria-label="Log text" />
            <div class="row">
              <label class="btn"><Icon name="lucide:upload" size="15" /> Load file<input type="file" accept=".log,.trc,.txt,text/plain" class="sr-only" @change="loadFile" ></label>
              <button class="btn primary" :disabled="!text || analyzing" @click="analyze"><Icon name="lucide:scan-search" size="15" /> Analyze</button>
              <span class="subtle">Processed on the server and not stored.</span>
            </div>
          </div>
        </UiCard>
        <UiCard v-if="pasted" :title="`${pasted.groups.length} error code(s) in ${fmtNum(pasted.lines)} lines`" icon="lucide:layers" flush>
          <UiDataTable :columns="groupCols" :rows="pasted.groups" row-key="code" empty-text="No ORA/TNS codes found." />
          <div v-for="g in pasted.groups.slice(0, 5)" :key="g.code" style="padding: 8px 14px">
            <div class="subtle mono">{{ g.code }} samples</div>
            <pre class="code">{{ g.samples.join('\n') }}</pre>
          </div>
        </UiCard>
      </template>
    </div>
  </div>
</template>

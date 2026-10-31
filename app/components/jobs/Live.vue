<script setup lang="ts">
import type { JobRecord } from '~~/shared/types/lab'

/** Live view of a background job: status, animated progress, throughput, log tail, cancel/resume. */
const props = defineProps<{ jobId: string | null; compact?: boolean }>()
const emit = defineEmits<{ settled: [job: JobRecord] }>()
const id = ref<string | null>(props.jobId)
watch(
  () => props.jobId,
  (v) => (id.value = v),
)
const { summary, full, log, settled, reload } = useJob(id)
const { push } = useToasts()
const busy = ref(false)

watch(full, (j) => {
  if (j && !['queued', 'running'].includes(j.status)) emit('settled', j)
})

const ratio = computed(() => {
  const p = summary.value?.progress
  if (!p || !p.total) return summary.value?.status === 'running' ? null : summary.value?.status === 'succeeded' ? 1 : 0
  return p.done / p.total
})
const tone = computed(() => jobTone(summary.value?.status ?? ''))

async function cancel() {
  if (!props.jobId) return
  busy.value = true
  try {
    await api(`/api/jobs/${props.jobId}/cancel`, { method: 'POST' })
    push({ tone: 'info', title: 'Cancellation requested', detail: 'The job stops after the current batch; committed work is kept.' })
  } catch (err) {
    push({ tone: 'bad', title: 'Cancel failed', detail: apiErrorMessage(err) })
  } finally {
    busy.value = false
  }
}

async function resume() {
  if (!props.jobId) return
  busy.value = true
  try {
    await api(`/api/jobs/${props.jobId}/resume`, { method: 'POST' })
    await reload()
    // Re-trigger the stream for the resumed job.
    const current = id.value
    id.value = null
    await nextTick()
    id.value = current
  } catch (err) {
    push({ tone: 'bad', title: 'Resume failed', detail: apiErrorMessage(err) })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="summary" class="job">
    <div class="row between">
      <div class="row">
        <span class="badge" :class="tone">{{ summary.status }}</span>
        <strong class="title">{{ summary.title }}</strong>
      </div>
      <div class="row">
        <button v-if="!settled" class="btn sm" :disabled="busy" @click="cancel"><Icon name="lucide:square" size="13" /> Cancel</button>
        <button
          v-if="settled && summary.resumable && ['failed', 'cancelled', 'interrupted'].includes(summary.status)"
          class="btn sm primary"
          :disabled="busy"
          @click="resume"
        >
          <Icon name="lucide:play" size="13" /> Resume
        </button>
        <NuxtLink :to="`/jobs?id=${summary.id}`" class="btn sm ghost">Details</NuxtLink>
      </div>
    </div>
    <UiProgress :value="ratio" :tone="tone === 'bad' ? 'bad' : tone === 'ok' ? 'ok' : ''" class="bar" :label="summary.title" />
    <div class="row meta subtle">
      <span>{{ summary.progress.phase }}</span>
      <span v-if="summary.progress.total" class="num">{{ fmtNum(summary.progress.done) }} / {{ fmtNum(summary.progress.total) }} {{ summary.progress.unit }}</span>
      <span v-if="summary.progress.ratePerSec && !settled" class="num">{{ fmtNum(summary.progress.ratePerSec) }} {{ summary.progress.unit === 'rows' ? 'rows' : 'ops' }}/s</span>
      <span v-if="summary.progress.message" class="ellipsis msg">{{ summary.progress.message }}</span>
    </div>
    <div v-if="summary.error" class="callout bad">
      <Icon name="lucide:circle-x" size="16" />
      <div><strong class="mono">{{ summary.error.code }}</strong> {{ summary.error.message }}</div>
    </div>
    <details v-if="!compact && log.length" class="log">
      <summary>Log ({{ log.length }})</summary>
      <div class="log-lines mono">
        <div v-for="(l, i) in log.slice(-80)" :key="i" :class="l.level">
          <span class="subtle">{{ new Date(l.ts).toLocaleTimeString() }}</span> {{ l.msg }}
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.job {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.title {
  font-size: 13px;
}
.bar {
  margin-top: 2px;
}
.meta {
  gap: 14px;
  min-width: 0;
}
.msg {
  max-width: 100%;
}
.log summary {
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-2);
}
.log-lines {
  margin-top: 6px;
  max-height: 220px;
  overflow: auto;
  background: var(--bg-sunken);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.6;
}
.log-lines .warn {
  color: var(--warn);
}
.log-lines .error {
  color: var(--bad);
}
</style>

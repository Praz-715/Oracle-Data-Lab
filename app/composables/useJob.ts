import type { JobLogEntry, JobRecord, JobSummary } from '~~/shared/types/lab'

/**
 * Follows one background job over Server-Sent Events. Falls back to the stored record when the
 * stream ends; `full` holds the complete record (result, checkpoint, log) once the job settles.
 */
export function useJob(jobId: Ref<string | null>) {
  const summary = ref<JobSummary | null>(null)
  const full = shallowRef<(JobRecord & { active?: boolean }) | null>(null)
  const log = ref<JobLogEntry[]>([])
  const connected = ref(false)
  let es: EventSource | null = null

  async function loadFull(id: string) {
    full.value = await api<JobRecord & { active?: boolean }>(`/api/jobs/${id}`)
    summary.value = { ...full.value, hasResult: full.value.result != null } as any
    log.value = full.value.log.slice(-300)
  }

  function close() {
    es?.close()
    es = null
    connected.value = false
  }

  function open(id: string) {
    close()
    es = new EventSource(`/api/jobs/${id}/events`)
    es.addEventListener('open', () => (connected.value = true))
    es.addEventListener('job', (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data) as { job: JobSummary; log?: JobLogEntry }
      summary.value = msg.job
      if (msg.log) log.value = [...log.value.slice(-299), msg.log]
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(msg.job.status)) {
        close()
        void loadFull(id)
      }
    })
    es.addEventListener('error', () => {
      // Stream dropped (server restart, network): fall back to the persisted record.
      close()
      void loadFull(id)
    })
  }

  watch(
    jobId,
    async (id) => {
      close()
      summary.value = null
      full.value = null
      log.value = []
      if (!id) return
      await loadFull(id)
      const loaded = full.value as JobRecord | null
      if (loaded && ['queued', 'running'].includes(loaded.status)) open(id)
    },
    { immediate: true },
  )
  onBeforeUnmount(close)

  const settled = computed(() => !!summary.value && !['queued', 'running'].includes(summary.value.status))
  return { summary, full, log, connected, settled, reload: () => jobId.value && loadFull(jobId.value) }
}

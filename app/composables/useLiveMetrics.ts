import type { Panel } from '~~/shared/types/lab'

interface SysstatData {
  sampledAtMs: number
  stats: Record<string, number>
  os: Record<string, number> | null
}
interface SummaryData {
  activeUser: number
  inactiveUser: number
  background: number
  total: number
  limits: { name: string; current: number; max: number; limit: string }[]
}

export interface MetricSample {
  t: number
  activeSessions: number | null
  cpuPct: number | null
  commitsPerSec: number | null
  execsPerSec: number | null
  logicalReadsPerSec: number | null
  physicalReadsPerSec: number | null
  redoBytesPerSec: number | null
  hardParsesPerSec: number | null
  userCallsPerSec: number | null
}

/**
 * Samples V$SYSSTAT / V$OSSTAT / V$SESSION periodically and derives per-second rates from
 * consecutive cumulative counters. History covers only the time this page has been open.
 */
export function useLiveMetrics(intervalMs = 5000, keep = 120) {
  const { activeId } = useActiveProfile()
  const samples = ref<MetricSample[]>([])
  const summary = shallowRef<Panel<SummaryData> | null>(null)
  const sysstat = shallowRef<Panel<SysstatData> | null>(null)
  const error = ref<string | null>(null)
  let prev: SysstatData | null = null

  async function sample() {
    const id = activeId.value
    if (!id) return
    try {
      const [sum, st] = await Promise.all([
        api<Panel<SummaryData>>(`/api/connections/${id}/monitor/summary`),
        api<Panel<SysstatData>>(`/api/connections/${id}/monitor/sysstat`),
      ])
      if (id !== activeId.value) return
      summary.value = sum
      sysstat.value = st
      error.value = null
      const cur = st.status === 'ok' ? st.data : null
      const s: MetricSample = {
        t: Date.now(),
        activeSessions: sum.status === 'ok' ? sum.data.activeUser : null,
        cpuPct: null, commitsPerSec: null, execsPerSec: null, logicalReadsPerSec: null,
        physicalReadsPerSec: null, redoBytesPerSec: null, hardParsesPerSec: null, userCallsPerSec: null,
      }
      if (cur && prev) {
        const dt = (cur.sampledAtMs - prev.sampledAtMs) / 1000
        const rate = (k: string) => (cur.stats[k] != null && prev!.stats[k] != null && dt > 0 ? Math.max(0, (cur.stats[k]! - prev!.stats[k]!) / dt) : null)
        s.commitsPerSec = rate('user commits')
        s.execsPerSec = rate('execute count')
        s.logicalReadsPerSec = rate('session logical reads')
        s.physicalReadsPerSec = rate('physical reads')
        s.redoBytesPerSec = rate('redo size')
        s.hardParsesPerSec = rate('parse count (hard)')
        s.userCallsPerSec = rate('user calls')
        if (cur.os && prev.os && cur.os.BUSY_TIME != null && cur.os.IDLE_TIME != null) {
          const busy = cur.os.BUSY_TIME - prev.os.BUSY_TIME!
          const idle = cur.os.IDLE_TIME - prev.os.IDLE_TIME!
          s.cpuPct = busy + idle > 0 ? (busy / (busy + idle)) * 100 : null
        }
      }
      prev = cur
      samples.value = [...samples.value.slice(-(keep - 1)), s]
    } catch (err) {
      error.value = apiErrorMessage(err)
    }
  }

  watch(
    activeId,
    () => {
      prev = null
      samples.value = []
      summary.value = null
      sysstat.value = null
      void sample()
    },
    { immediate: true },
  )
  usePolling(sample, intervalMs)

  const latest = computed(() => samples.value[samples.value.length - 1] ?? null)
  function series(key: keyof MetricSample) {
    return samples.value.map((s) => ({ x: s.t, y: s[key] as number | null }))
  }
  return { samples, latest, summary, sysstat, error, series, sample }
}

import type { FetchError } from 'ofetch'

/** Turns an API error into one readable sentence (status message + validation issues). */
export function apiErrorMessage(err: unknown): string {
  const e = err as FetchError & { data?: { statusMessage?: string; message?: string; data?: { issues?: { path: string; message: string }[] } } }
  const issues = e?.data?.data?.issues
  const base = e?.data?.statusMessage || e?.data?.message || e?.statusMessage || e?.message || 'Request failed'
  if (issues?.length) return `${base}: ${issues.map((i: { path: string; message: string }) => `${i.path || 'body'} — ${i.message}`).join('; ')}`
  return base
}

/** $fetch with the header the API requires for state-changing requests. */
export function api<T = any>(url: string, opts: Parameters<typeof $fetch>[1] = {}): Promise<T> {
  return $fetch<T>(url, {
    ...opts,
    headers: { 'x-odl-client': '1', ...(opts?.headers as Record<string, string> | undefined) },
  } as any) as Promise<T>
}

/**
 * Reactive loader for one endpoint: loading / error / data, with manual reload.
 * Keeps the previous data while reloading so tables don't flash empty.
 */
export function useLoader<T>(url: () => string | null, opts: { immediate?: boolean; query?: () => Record<string, unknown> } = {}) {
  const data = shallowRef<T | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)
  let seq = 0

  async function load() {
    const u = url()
    if (!u) return
    const my = ++seq
    loading.value = true
    try {
      const r = await api<T>(u, { query: opts.query?.() })
      if (my === seq) {
        data.value = r
        error.value = null
      }
    } catch (err) {
      if (my === seq) error.value = apiErrorMessage(err)
    } finally {
      if (my === seq) loading.value = false
    }
  }

  if (opts.immediate !== false) watch(() => [url(), JSON.stringify(opts.query?.() ?? {})], load, { immediate: true })
  return { data, error, loading, load }
}

/** Polls `fn` every `ms` while the tab is visible and the component is mounted. */
export function usePolling(fn: () => unknown, ms: number) {
  let timer: ReturnType<typeof setInterval> | null = null
  const paused = ref(false)
  const tick = () => {
    if (!paused.value && document.visibilityState === 'visible') void fn()
  }
  onMounted(() => {
    timer = setInterval(tick, ms)
  })
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
  })
  return { paused }
}

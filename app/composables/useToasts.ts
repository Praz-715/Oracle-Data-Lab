export interface Toast {
  id: number
  tone: 'ok' | 'warn' | 'bad' | 'info'
  title: string
  detail?: string
}

let next = 1

/** Transient feedback. Success toasts are only raised after the API confirmed the result. */
export function useToasts() {
  const toasts = useState<Toast[]>('odl-toasts', () => [])
  function push(t: Omit<Toast, 'id'>, ms = t.tone === 'bad' ? 9000 : 5000) {
    const id = next++
    toasts.value = [...toasts.value, { ...t, id }]
    setTimeout(() => dismiss(id), ms)
  }
  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }
  return { toasts, push, dismiss }
}

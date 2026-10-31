// Display formatting. All functions accept null/undefined and render an em dash for "no value".

const DASH = '—'

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(Number(v))) return DASH
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function fmtCompact(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return DASH
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(v))
}

export function fmtBytes(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(Number(v))) return DASH
  const n = Number(v)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  let x = Math.abs(n)
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${n < 0 ? '-' : ''}${x.toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function fmtMs(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return DASH
  const n = Number(v)
  if (n < 1) return `${(n * 1000).toFixed(0)} µs`
  if (n < 1000) return `${n.toFixed(n < 10 ? 2 : 1)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(Number(seconds))) return DASH
  let s = Math.max(0, Math.round(Number(seconds)))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(Number(v))) return DASH
  return `${Number(v).toFixed(digits)}%`
}

export function fmtDate(v: string | Date | null | undefined, withTime = true): string {
  if (!v) return DASH
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return String(v)
  return withTime
    ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

export function fmtRelative(v: string | null | undefined): string {
  if (!v) return DASH
  const diff = (Date.now() - Date.parse(v)) / 1000
  if (diff < 0) return fmtDate(v)
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
  return fmtDate(v, false)
}

export function jobTone(status: string): 'ok' | 'warn' | 'bad' | 'info' | '' {
  switch (status) {
    case 'succeeded':
      return 'ok'
    case 'failed':
      return 'bad'
    case 'running':
    case 'queued':
      return 'info'
    case 'cancelled':
    case 'interrupted':
      return 'warn'
    default:
      return ''
  }
}

export function pctTone(p: number | null | undefined, warn = 85, bad = 95): 'ok' | 'warn' | 'bad' | '' {
  if (p == null) return ''
  return p >= bad ? 'bad' : p >= warn ? 'warn' : 'ok'
}

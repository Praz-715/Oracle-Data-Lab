import { monitorPanel } from '../../../../services/monitoring'
import { analyzeErrors } from '../../../../services/tuning'

/** Recent alert-log entries (12c+, V$DIAG_ALERT_EXT) grouped by ORA/TNS code. */
export default defineEventHandler(async (event) => {
  const p = await monitorPanel(requireParam(event, 'id'), 'alerts', {})
  if (p.status !== 'ok') return { panel: p, groups: [] }
  const lines = (p.data as { ts: string; text: string }[]).map((r) => ({ ts: r.ts, text: r.text }))
  return { panel: p, groups: analyzeErrors(lines) }
})

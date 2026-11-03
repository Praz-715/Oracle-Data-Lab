import type { BenchmarkResult } from '../../../../shared/types/lab'
import { getJob } from '../../../jobs/runner'
import { awrReportHtml } from '../../../services/diagnostics-pack'

// AWR report (HTML) for the snapshots taken around a benchmark run — licensed profiles only.
export default defineEventHandler(async (event) => {
  const job = await getJob(requireParam(event, 'jobId'))
  const r = job.result as BenchmarkResult | null
  if (job.type !== 'benchmark' || !r?.awr) throw createError({ statusCode: 404, statusMessage: 'This run has no AWR snapshots.' })
  const html = await awrReportHtml(job.profileId, r.awr)
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="awr-${r.scenario.id}-${r.awr.beginSnap}-${r.awr.endSnap}.html"`)
  return html
})

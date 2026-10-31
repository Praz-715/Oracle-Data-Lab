import type { BenchmarkResult } from '../../../../shared/types/lab'
import { getJob } from '../../../jobs/runner'
import { benchmarkCsv } from '../../../services/benchmark'
import { benchmarkHtml } from '../../../services/benchmark-report'

const FORMATS = ['json', 'csv', 'html'] as const

export default defineEventHandler(async (event) => {
  const job = await getJob(requireParam(event, 'jobId'))
  if (job.type !== 'benchmark' || !job.result) throw createError({ statusCode: 404, statusMessage: 'No benchmark result for this job' })
  const result = job.result as BenchmarkResult
  const q = getQuery(event).format
  const format = FORMATS.find((f) => f === q) ?? 'json'
  const name = `odl-benchmark-${result.scenario.id}-${job.id.slice(0, 8)}.${format}`
  setHeader(event, 'Content-Disposition', `attachment; filename="${name}"`)
  if (format === 'csv') {
    setHeader(event, 'Content-Type', 'text/csv; charset=utf-8')
    return benchmarkCsv(result)
  }
  if (format === 'html') {
    setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
    return benchmarkHtml(result, { id: job.id, title: job.title, status: job.status })
  }
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  return JSON.stringify({ jobId: job.id, title: job.title, ...result }, null, 2)
})

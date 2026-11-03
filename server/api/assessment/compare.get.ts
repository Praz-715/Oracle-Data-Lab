import { z } from 'zod'
import { compareSnapshots } from '../../services/assessment-history'
import { compareHtml } from '../../services/assessment-compare-report'

const q = z.object({ a: z.string().min(1), b: z.string().min(1), format: z.enum(['json', 'html']).default('json') })

export default defineEventHandler(async (event) => {
  const { a, b, format } = queryAs(event, q)
  const diff = await compareSnapshots(a, b)
  if (format === 'json') return diff
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="odl-assessment-compare-${a.slice(0, 8)}-${b.slice(0, 8)}.html"`)
  return compareHtml(diff)
})

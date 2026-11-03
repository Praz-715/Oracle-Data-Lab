import { recommendationHtml, recommendationSql } from '../../../../recommend/render'
import { recommendationFor } from '../../../../recommend/service'

// "Fix it" for one health check: re-runs the check, then builds the advice (nothing is executed).
// ?format=sql|html downloads just this recommendation.
export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const finding = requireParam(event, 'finding')
  const format = String(getQuery(event).format ?? 'json')
  const out = await recommendationFor(id, finding)
  if ((format !== 'sql' && format !== 'html') || !out.recommendation) return out
  const safe = out.meta.profileName.replace(/[^A-Za-z0-9_-]+/g, '-')
  setHeader(event, 'Content-Disposition', `attachment; filename="odl-fix-${finding}-${safe}.${format}"`)
  setHeader(event, 'Content-Type', format === 'sql' ? 'application/sql; charset=utf-8' : 'text/html; charset=utf-8')
  return format === 'sql' ? recommendationSql(out.recommendation, out.meta) : recommendationHtml(out.recommendation, out.meta)
})

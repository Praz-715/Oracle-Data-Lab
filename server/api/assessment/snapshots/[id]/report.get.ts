import { assessmentHtml } from '../../../../services/assessment-report'
import { getSnapshot } from '../../../../services/assessment-history'

// The full HTML report of a stored snapshot (as it was at capture time).
export default defineEventHandler(async (event) => {
  const s = await getSnapshot(requireParam(event, 'id'))
  const stamp = s.meta.createdAt.slice(0, 16).replace(/-/g, '').replace('T', '-').replace(':', '')
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="odl-assessment-${s.meta.profileName.replace(/[^A-Za-z0-9_-]+/g, '-')}-${stamp}.html"`)
  return assessmentHtml(s.data, { profileName: s.meta.profileName })
})

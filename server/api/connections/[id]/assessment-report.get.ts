import { fullAssessment } from '../../../services/assessment'
import { assessmentHtml } from '../../../services/assessment-report'
import { getProfile } from '../../../services/profiles'

// Full database assessment as a downloadable standalone HTML report or JSON.
export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const profile = await getProfile(id)
  const format = getQuery(event).format === 'json' ? 'json' : 'html'
  const data = await fullAssessment(id)
  await audit({ action: 'assessment.exported', profileId: id, detail: format, outcome: 'ok' })
  const stamp = new Date().toISOString().slice(0, 16).replace(/-/g, '').replace('T', '-').replace(':', '')
  const safe = profile.name.replace(/[^A-Za-z0-9_-]+/g, '-')
  setHeader(event, 'Content-Disposition', `attachment; filename="odl-assessment-${safe}-${stamp}.${format}"`)
  if (format === 'json') {
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
    return JSON.stringify({ profile: { id, name: profile.name }, collectedAt: new Date().toISOString(), ...data }, null, 2)
  }
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  return assessmentHtml(data, { profileName: profile.name })
})

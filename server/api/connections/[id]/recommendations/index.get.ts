import { planHtml, planSql } from '../../../../recommend/render'
import { remediationPlan } from '../../../../recommend/service'

// Remediation plan for every open health-check finding (advice only — nothing is executed).
// ?format=sql|html downloads it as a runbook / standalone page; default is JSON for the UI.
export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const format = String(getQuery(event).format ?? 'json')
  const plan = await remediationPlan(id)
  await audit({ action: 'recommendations.generated', profileId: id, detail: `${plan.recommendations.length} recommendation(s), format ${format}`, outcome: 'ok' })
  if (format !== 'sql' && format !== 'html') return plan
  const stamp = plan.generatedAt.slice(0, 16).replace(/-/g, '').replace('T', '-').replace(':', '')
  const safe = plan.profileName.replace(/[^A-Za-z0-9_-]+/g, '-')
  setHeader(event, 'Content-Disposition', `attachment; filename="odl-remediation-${safe}-${stamp}.${format}"`)
  setHeader(event, 'Content-Type', format === 'sql' ? 'application/sql; charset=utf-8' : 'text/html; charset=utf-8')
  return format === 'sql' ? planSql(plan) : planHtml(plan)
})

import { getPlan, planToSql } from '../../../../services/schema'

export default defineEventHandler(async (event) => {
  const plan = await getPlan(requireParam(event, 'planId'))
  setHeader(event, 'Content-Type', 'application/sql; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="odl-${plan.schema.toLowerCase()}-${plan.options.prefix.toLowerCase()}ddl.sql"`)
  return planToSql(plan)
})

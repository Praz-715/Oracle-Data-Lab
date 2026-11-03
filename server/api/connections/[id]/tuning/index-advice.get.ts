import { sqlIndexReport } from '../../../../recommend/sql-index'

// Index recommendations for the top application SQL of the shared pool (real cursor plans).
export default defineEventHandler((event) => {
  const top = Math.min(100, Math.max(5, Number(getQuery(event).top ?? 30) || 30))
  return sqlIndexReport(requireParam(event, 'id'), top)
})

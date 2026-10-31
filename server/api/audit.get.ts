export default defineEventHandler(async (event) => {
  const limit = Math.min(Number(getQuery(event).limit ?? 200) || 200, 1000)
  return listAudit(limit)
})

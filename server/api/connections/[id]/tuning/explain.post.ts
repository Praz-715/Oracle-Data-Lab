import { z } from 'zod'
import { explainAdhoc } from '../../../../services/tuning'

export default defineEventHandler(async (event) => {
  const body = await readBodyAs(event, z.object({ sql: z.string().min(1).max(20_000) }))
  return explainAdhoc(requireParam(event, 'id'), body.sql)
})

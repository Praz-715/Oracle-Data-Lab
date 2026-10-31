import { z } from 'zod'
import { datasetAnalytics } from '../../../services/analytics'

const q = z.object({
  schema: z.string().min(1),
  prefix: z.string().default('DL_'),
  months: z.coerce.number().int().min(1).max(120).default(24),
})

export default defineEventHandler((event) => {
  const p = queryAs(event, q)
  return datasetAnalytics(requireParam(event, 'id'), p.schema, p.prefix, p.months)
})

import { z } from 'zod'
import { listJobs } from '../../jobs/runner'

const q = z.object({
  type: z.enum(['schema-apply', 'data-generate', 'quality', 'benchmark', 'cleanup', 'import', 'import-bundle', 'import-undo']).optional(),
  profileId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export default defineEventHandler((event) => listJobs(queryAs(event, q)))

import { z } from 'zod'
import { listAdvisorIndexes } from '../../services/index-advisor'

const q = z.object({ profileId: z.string().min(1) })

export default defineEventHandler((event) => listAdvisorIndexes(queryAs(event, q).profileId))

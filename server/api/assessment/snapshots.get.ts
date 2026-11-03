import { z } from 'zod'
import { listSnapshots } from '../../services/assessment-history'

const q = z.object({ profileId: z.string().optional() })

export default defineEventHandler((event) => listSnapshots(queryAs(event, q).profileId))

import { z } from 'zod'
import { targetTables } from '../../services/importer'

const q = z.object({ profileId: z.string().min(1), schema: z.string().min(1).max(128) })

export default defineEventHandler((event) => {
  const { profileId, schema } = queryAs(event, q)
  return targetTables(profileId, schema)
})

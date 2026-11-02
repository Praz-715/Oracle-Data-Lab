import { z } from 'zod'
import { targetColumns } from '../../services/importer'

const q = z.object({ profileId: z.string().min(1), schema: z.string().min(1).max(128), table: z.string().min(1).max(128) })

export default defineEventHandler((event) => {
  const { profileId, schema, table } = queryAs(event, q)
  return targetColumns(profileId, schema, table)
})

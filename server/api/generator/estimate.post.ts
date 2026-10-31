import { z } from 'zod'
import { estimateStorage } from '../../generators/estimate'
import { deriveCounts } from '../../generators/model'

const body = z.object({
  orders: z.coerce.number().int().min(100).max(1_000_000_000),
  includeLobs: z.boolean().default(true),
  extensionTables: z.coerce.number().int().min(0).max(1000).default(0),
  extensionRowsPerTable: z.coerce.number().int().min(0).default(10_000),
})

/** Pure estimate from the blueprint; no database access. */
export default defineEventHandler(async (event) => {
  const b = await readBodyAs(event, body)
  return { estimate: estimateStorage(b), counts: deriveCounts(b.orders, b.extensionTables, b.extensionRowsPerTable) }
})

import { z } from 'zod'
import { measureAdhoc } from '../../../../services/tuning'

const body = z.object({
  sql: z.string().min(1).max(20_000),
  runs: z.coerce.number().int().min(1).max(20).default(3),
  label: z.string().trim().max(80).default(''),
})

export default defineEventHandler(async (event) => {
  const b = await readBodyAs(event, body)
  const result = await measureAdhoc(requireParam(event, 'id'), b.sql, b.runs)
  return { label: b.label, sql: b.sql, measuredAt: nowIso(), ...result }
})

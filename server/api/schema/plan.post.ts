import { createPlan, planRequestSchema } from '../../services/schema'

export default defineEventHandler(async (event) => {
  const input = await readBodyAs(event, planRequestSchema)
  return createPlan(input)
})

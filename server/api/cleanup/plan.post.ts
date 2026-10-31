import { cleanupRequestSchema, planCleanup } from '../../services/cleanup'

export default defineEventHandler(async (event) => planCleanup(await readBodyAs(event, cleanupRequestSchema)))

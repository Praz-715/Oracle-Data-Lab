import { cleanupRequestSchema, startCleanup } from '../../services/cleanup'

export default defineEventHandler(async (event) => startCleanup(await readBodyAs(event, cleanupRequestSchema)))

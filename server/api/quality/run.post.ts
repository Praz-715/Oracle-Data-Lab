import { qualityRequestSchema, startQuality } from '../../services/quality'

export default defineEventHandler(async (event) => startQuality(await readBodyAs(event, qualityRequestSchema)))

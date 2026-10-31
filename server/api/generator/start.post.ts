import { generatorConfigSchema, startGeneration } from '../../services/generator'

export default defineEventHandler(async (event) => startGeneration(await readBodyAs(event, generatorConfigSchema)))

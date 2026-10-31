import { generatorConfigSchema, preflight } from '../../services/generator'

export default defineEventHandler(async (event) => preflight(await readBodyAs(event, generatorConfigSchema)))

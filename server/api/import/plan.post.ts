import { importConfigSchema, planImport } from '../../services/importer'

export default defineEventHandler(async (event) => planImport(await readBodyAs(event, importConfigSchema)))

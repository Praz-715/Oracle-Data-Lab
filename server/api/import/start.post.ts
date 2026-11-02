import { importConfigSchema, startImport } from '../../services/importer'

export default defineEventHandler(async (event) => startImport(await readBodyAs(event, importConfigSchema)))

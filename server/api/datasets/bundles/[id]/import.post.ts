import { bundleRequestSchema, startBundle } from '../../../../services/importer'

export default defineEventHandler(async (event) => startBundle(requireParam(event, 'id'), await readBodyAs(event, bundleRequestSchema)))

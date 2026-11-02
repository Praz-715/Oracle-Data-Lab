import { bundlePreflight, bundleRequestSchema } from '../../../../services/importer'

export default defineEventHandler(async (event) => bundlePreflight(requireParam(event, 'id'), await readBodyAs(event, bundleRequestSchema)))

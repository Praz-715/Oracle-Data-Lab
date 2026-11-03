import { saveQuery, savedSchema } from '../../services/playground'

export default defineEventHandler(async (event) => saveQuery(await readBodyAs(event, savedSchema)))

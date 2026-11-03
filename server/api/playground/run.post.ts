import { runPlayground, runSchema } from '../../services/playground'

export default defineEventHandler(async (event) => runPlayground(await readBodyAs(event, runSchema)))

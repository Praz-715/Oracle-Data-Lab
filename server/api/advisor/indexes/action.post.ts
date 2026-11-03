import { advisorIndexAction, indexActionSchema } from '../../../services/index-advisor'

export default defineEventHandler(async (event) => advisorIndexAction(await readBodyAs(event, indexActionSchema)))

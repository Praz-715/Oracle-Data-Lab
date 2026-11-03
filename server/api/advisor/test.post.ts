import { testCandidate, testSchema } from '../../services/index-advisor'

export default defineEventHandler(async (event) => testCandidate(await readBodyAs(event, testSchema)))

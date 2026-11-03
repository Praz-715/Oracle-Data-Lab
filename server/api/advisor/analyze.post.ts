import { analyzeSchema, analyzeSql } from '../../services/index-advisor'

export default defineEventHandler(async (event) => analyzeSql(await readBodyAs(event, analyzeSchema)))

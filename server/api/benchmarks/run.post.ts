import { benchmarkConfigSchema, startBenchmark } from '../../services/benchmark'

export default defineEventHandler(async (event) => startBenchmark(await readBodyAs(event, benchmarkConfigSchema)))

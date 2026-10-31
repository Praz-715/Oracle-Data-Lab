import { benchmarkHistory } from '../../services/benchmark'

export default defineEventHandler((event) => {
  const profileId = getQuery(event).profileId
  return benchmarkHistory(typeof profileId === 'string' && profileId ? profileId : undefined)
})

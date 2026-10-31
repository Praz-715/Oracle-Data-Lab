import { cancelJob, summarize } from '../../../jobs/runner'

export default defineEventHandler(async (event) => {
  const job = await cancelJob(requireParam(event, 'id'))
  await audit({ action: 'job.cancel', profileId: job.profileId, target: job.id, detail: job.title, outcome: 'requested' })
  return summarize(job)
})

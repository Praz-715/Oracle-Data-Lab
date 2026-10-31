import { resumeJob, summarize } from '../../../jobs/runner'

export default defineEventHandler(async (event) => {
  const job = await resumeJob(requireParam(event, 'id'))
  await audit({ action: 'job.resume', profileId: job.profileId, target: job.id, detail: job.title, outcome: 'requested' })
  return summarize(job)
})

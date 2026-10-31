import { getJob, isJobActive } from '../../../jobs/runner'

export default defineEventHandler(async (event) => {
  const job = await getJob(requireParam(event, 'id'))
  return { ...job, active: isJobActive(job.id) }
})

import { getJob, jobBus, summarize } from '../../../jobs/runner'

/** Server-Sent Events stream of one job's progress and log lines. */
export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const job = await getJob(id)
  const stream = createEventStream(event)
  const send = (payload: unknown) => stream.push({ event: 'job', data: JSON.stringify(payload) })

  // Coalesce bursts of progress updates to at most ~5 per second.
  let pending: unknown = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const onUpdate = (payload: { job: unknown; log?: unknown }) => {
    if (payload.log) {
      void send(payload)
      return
    }
    pending = payload
    timer ??= setTimeout(() => {
      timer = null
      if (pending) void send(pending)
      pending = null
    }, 200)
  }
  jobBus.on(`job:${id}`, onUpdate)
  const keepAlive = setInterval(() => void stream.push({ event: 'ping', data: '{}' }), 15000)
  stream.onClosed(async () => {
    jobBus.off(`job:${id}`, onUpdate)
    clearInterval(keepAlive)
    if (timer) clearTimeout(timer)
    await stream.close()
  })
  void send({ job: summarize(job), snapshot: true })
  return stream.send()
})

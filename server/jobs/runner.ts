import { EventEmitter } from 'node:events'
import type { JobLogEntry, JobProgress, JobRecord, JobStatus, JobSummary, JobType } from '../../shared/types/lab'
import { oracleErrorInfo } from '../database/errors'

// Background job runner. Long operations (DDL apply, data generation, validation, benchmarks, cleanup)
// never run inside an HTTP request: the request creates a job and the browser follows it over SSE.
// Job state is persisted in the lab store so history survives restarts; jobs that were running when
// the server stopped are marked "interrupted" and can be resumed from their last checkpoint.

export interface JobContext<C = any, K = any> {
  readonly job: JobRecord<C, any, K>
  readonly signal: AbortSignal
  log(level: JobLogEntry['level'], msg: string): void
  progress(p: Partial<JobProgress>): void
  /** Persist a resume point. Call only after the work it describes is committed. */
  checkpoint(k: K): Promise<void>
  throwIfCancelled(): void
}

export type Executor = (ctx: JobContext) => Promise<unknown>

export class JobCancelled extends Error {
  constructor() {
    super('Job cancelled')
  }
}

const executors = new Map<JobType, Executor>()
const running = new Map<string, { record: JobRecord; controller: AbortController; lastSave: number }>()
const queue: string[] = []
export const jobBus = new EventEmitter()
jobBus.setMaxListeners(200)

const MAX_LOG = 500
const key = (id: string) => `jobs:${id}`

export function registerExecutor(type: JobType, fn: Executor) {
  executors.set(type, fn)
}

async function save(record: JobRecord) {
  record.updatedAt = nowIso()
  await labStore().setItem(key(record.id), record)
}

export function summarize(r: JobRecord): JobSummary {
  const { log: _l, checkpoint: _c, result, ...rest } = r
  return { ...rest, hasResult: result != null }
}

function emit(record: JobRecord, extra?: { log?: JobLogEntry }) {
  jobBus.emit(`job:${record.id}`, { job: summarize(record), log: extra?.log })
  jobBus.emit('jobs', summarize(record))
}

export async function getJob(id: string): Promise<JobRecord> {
  const live = running.get(id)
  if (live) return live.record
  const r = await labStore().getItem<JobRecord>(key(id))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Job not found' })
  return r
}

export async function listJobs(filter: { type?: JobType; profileId?: string; limit?: number } = {}): Promise<JobSummary[]> {
  const store = labStore()
  const keys = await store.getKeys('jobs')
  const all = await Promise.all(keys.map((k) => store.getItem<JobRecord>(k)))
  return all
    .filter((r): r is JobRecord => !!r)
    .map((r) => running.get(r.id)?.record ?? r)
    .filter((r) => (!filter.type || r.type === filter.type) && (!filter.profileId || r.profileId === filter.profileId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, filter.limit ?? 200)
    .map(summarize)
}

export async function createJob<C>(input: {
  type: JobType
  profileId: string
  title: string
  config: C
  resumable?: boolean
}): Promise<JobRecord<C>> {
  if (!executors.has(input.type)) throw createError({ statusCode: 500, statusMessage: `No executor for ${input.type}` })
  const now = nowIso()
  const record: JobRecord<C> = {
    id: newId(),
    type: input.type,
    profileId: input.profileId,
    title: input.title,
    status: 'queued',
    config: input.config,
    progress: { phase: 'queued', done: 0, total: 0, unit: 'steps' },
    checkpoint: null,
    result: null,
    error: null,
    log: [],
    resumable: input.resumable ?? false,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  }
  await save(record)
  queue.push(record.id)
  emit(record)
  pump()
  return record
}

export async function cancelJob(id: string): Promise<JobRecord> {
  const live = running.get(id)
  if (live) {
    live.controller.abort()
    appendLog(live.record, 'warn', 'Cancellation requested')
    return live.record
  }
  const qi = queue.indexOf(id)
  const r = await getJob(id)
  if (qi >= 0) {
    queue.splice(qi, 1)
    await finish(r, 'cancelled')
  }
  return r
}

export async function resumeJob(id: string): Promise<JobRecord> {
  const r = await getJob(id)
  if (running.has(id) || queue.includes(id)) throw createError({ statusCode: 409, statusMessage: 'Job is already active' })
  if (!r.resumable) throw createError({ statusCode: 400, statusMessage: 'This job type cannot be resumed' })
  if (!['failed', 'cancelled', 'interrupted'].includes(r.status)) {
    throw createError({ statusCode: 400, statusMessage: `Cannot resume a ${r.status} job` })
  }
  r.status = 'queued'
  r.error = null
  r.finishedAt = null
  appendLog(r, 'info', r.checkpoint ? 'Resuming from last checkpoint' : 'Restarting (no checkpoint recorded)')
  await save(r)
  queue.push(id)
  emit(r)
  pump()
  return r
}

/** Called on server start: anything left running/queued was interrupted by a restart. */
export async function recoverJobs(): Promise<number> {
  const store = labStore()
  const keys = await store.getKeys('jobs')
  let n = 0
  for (const k of keys) {
    const r = await store.getItem<JobRecord>(k)
    if (r && (r.status === 'running' || r.status === 'queued')) {
      r.status = 'interrupted'
      r.finishedAt = nowIso()
      r.log.push({ ts: nowIso(), level: 'warn', msg: 'Server restarted while the job was active' })
      await save(r)
      n++
    }
  }
  return n
}

function appendLog(r: JobRecord, level: JobLogEntry['level'], msg: string) {
  const entry = { ts: nowIso(), level, msg }
  r.log.push(entry)
  if (r.log.length > MAX_LOG) r.log.splice(0, r.log.length - MAX_LOG)
  emit(r, { log: entry })
}

async function finish(r: JobRecord, status: JobStatus, error?: { message: string; code?: string }) {
  r.status = status
  r.finishedAt = nowIso()
  if (error) r.error = error
  await save(r)
  emit(r)
}

function pump() {
  const max = labLimits().maxConcurrentJobs
  while (running.size < max && queue.length) {
    const id = queue.shift()!
    void run(id)
  }
}

async function run(id: string) {
  const record = await getJob(id)
  const exec = executors.get(record.type)!
  const controller = new AbortController()
  const live = { record, controller, lastSave: 0 }
  running.set(id, live)
  record.status = 'running'
  record.startedAt = record.startedAt ?? nowIso()
  appendLog(record, 'info', `Started ${record.type}`)
  await save(record)

  const ctx: JobContext = {
    job: record,
    signal: controller.signal,
    log: (level, msg) => appendLog(record, level, msg),
    progress: (p) => {
      record.progress = { ...record.progress, ...p }
      emit(record)
      const now = Date.now()
      if (now - live.lastSave > 2000) {
        live.lastSave = now
        void save(record)
      }
    },
    checkpoint: async (k) => {
      record.checkpoint = k
      await save(record)
    },
    throwIfCancelled: () => {
      if (controller.signal.aborted) throw new JobCancelled()
    },
  }

  try {
    const result = await exec(ctx)
    record.result = result ?? null
    appendLog(record, 'info', 'Completed')
    await finish(record, 'succeeded')
  } catch (err) {
    if (err instanceof JobCancelled || controller.signal.aborted) {
      appendLog(record, 'warn', 'Cancelled')
      await finish(record, 'cancelled')
    } else {
      const info = oracleErrorInfo(err)
      appendLog(record, 'error', `${info.code}: ${info.message}${info.hint ? ` (${info.hint})` : ''}`)
      await finish(record, 'failed', { message: info.message, code: info.code })
    }
  } finally {
    running.delete(id)
    pump()
  }
}

export function isJobActive(id: string) {
  return running.has(id) || queue.includes(id)
}

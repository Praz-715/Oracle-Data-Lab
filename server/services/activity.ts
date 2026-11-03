import type { Connection } from 'oracledb'
import { z } from 'zod'
import type { ActivitySummary } from '../../shared/types/lab'
import { ActivitySampler, attachSqlText, summarizeActivity } from '../database/activity'
import { getConnection, withConnection } from '../database/driver'
import { one } from '../database/query'
import { oracleErrorInfo } from '../database/errors'
import { ashSummary } from './diagnostics-pack'
import { getProfile } from './profiles'

// Live "Top Activity" for Instance Monitoring. ASH-lite samplers start on demand per profile, keep
// up to one hour of 1-second samples in memory, and stop after a minute without readers so an idle
// browser tab never keeps sampling the database. Licensed profiles can read Oracle ASH instead.

const KEEP_TICKS = 3600
const IDLE_MS = 60_000

interface Live {
  sampler: ActivitySampler
  conn: Connection
  startedAt: number
  lastRead: number
}
const live = new Map<string, Live>()

const reaper = setInterval(() => {
  const now = Date.now()
  for (const [id, l] of live) {
    if (now - l.lastRead > IDLE_MS || !l.sampler.running) void stopLive(id)
  }
}, 15_000)
reaper.unref?.()

async function stopLive(profileId: string) {
  const l = live.get(profileId)
  if (!l) return
  live.delete(profileId)
  l.sampler.stop()
  await l.conn.close().catch(() => {})
}

export async function stopAllActivity() {
  await Promise.all([...live.keys()].map(stopLive))
}

async function ensureLive(profileId: string): Promise<Live> {
  let l = live.get(profileId)
  if (l && !l.sampler.running && l.sampler.error) {
    const err = l.sampler.error
    await stopLive(profileId)
    throw createError({ statusCode: 502, statusMessage: `ASH-lite sampling failed: ${err}` })
  }
  if (!l) {
    const conn = await getConnection(profileId, { action: 'ash-lite', callTimeoutMs: 20000 })
    l = { sampler: new ActivitySampler(conn, 1000, KEEP_TICKS).start(), conn, startedAt: Date.now(), lastRead: Date.now() }
    live.set(profileId, l)
  }
  l.lastRead = Date.now()
  return l
}

export const activityQuerySchema = z.object({
  window: z.coerce.number().int().min(30).max(3600).default(300),
  source: z.enum(['ash-lite', 'ash']).default('ash-lite'),
})

/** Number of CPUs the database host reports (reference line on the activity chart). */
async function cpuCount(conn: Connection): Promise<number | null> {
  try {
    const r = await one<{ V: number }>(conn, `SELECT VALUE AS "V" FROM V$OSSTAT WHERE STAT_NAME = 'NUM_CPUS'`)
    return r ? Number(r.V) : null
  } catch {
    return null
  }
}

export async function liveActivity(
  profileId: string,
  q: z.infer<typeof activityQuerySchema>,
): Promise<{ summary: ActivitySummary; samplingSince: string | null; windowSec: number; cpuCount: number | null }> {
  await getProfile(profileId)
  const bucketSec = q.window > 900 ? 30 : q.window > 300 ? 10 : 5
  if (q.source === 'ash') {
    const summary = await ashSummary(profileId, q.window, bucketSec)
    return { summary, samplingSince: null, windowSec: q.window, cpuCount: await withConnection(profileId, cpuCount, { action: 'ash-cpu' }) }
  }
  const l = await ensureLive(profileId)
  const now = Date.now()
  const summary = summarizeActivity(l.sampler.ticks, { source: 'ash-lite', intervalSec: 1, t0: now - q.window * 1000, t1: now, bucketSec })
  let withText = summary
  let cpus: number | null = null
  try {
    ;[withText, cpus] = await withConnection(profileId, async (conn) => [await attachSqlText(conn, summary), await cpuCount(conn)] as const, { action: 'ash-lite-text' })
  } catch (err) {
    console.warn('[odl] could not read SQL text for activity:', oracleErrorInfo(err).message)
  }
  return { summary: withText, samplingSince: new Date(l.startedAt).toISOString(), windowSec: q.window, cpuCount: cpus }
}

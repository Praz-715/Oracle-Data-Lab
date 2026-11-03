import type { Connection } from 'oracledb'
import type { ActivityClass, ActivitySummary } from '../../shared/types/lab'
import { oracleErrorInfo } from './errors'
import { rows } from './query'

// ASH-lite: this app's own active-session sampling. Once per interval it reads the non-idle user
// sessions from V$SESSION (no Diagnostics Pack needed — V$SESSION is a base view) and keeps the
// samples in memory. summarizeActivity() turns samples into average-active-sessions by wait class,
// top SQL, top events and top sessions — the same shape as an ASH summary, so the UI renders both.

export const ACTIVITY_CLASSES: ActivityClass[] = ['CPU', 'User I/O', 'Commit', 'Concurrency', 'Application', 'Other']

export interface ActiveSample {
  sid: number
  user: string | null
  sqlId: string | null
  event: string
  cls: ActivityClass
  module: string | null
}

export interface ActivityTick {
  ts: number
  rows: ActiveSample[]
}

/** Folds Oracle wait classes into the fixed chart classes (more than six hues would not stay distinct). */
export function foldClass(onCpu: boolean, waitClass: string | null | undefined): ActivityClass {
  if (onCpu) return 'CPU'
  switch (waitClass) {
    case 'User I/O':
    case 'Commit':
    case 'Concurrency':
    case 'Application':
      return waitClass
    default:
      return 'Other'
  }
}

const zero = (): Record<ActivityClass, number> => ({ CPU: 0, 'User I/O': 0, Commit: 0, Concurrency: 0, Application: 0, Other: 0 })
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

/** One sample of the active, non-idle user sessions (excluding the sampling session itself). */
export async function sampleActive(conn: Connection): Promise<ActiveSample[]> {
  const r = await rows<{ sid: number; user: string | null; sqlId: string | null; state: string; event: string | null; waitClass: string | null; module: string | null }>(
    conn,
    `SELECT s.SID AS "sid", s.USERNAME AS "user", s.SQL_ID AS "sqlId", s.STATE AS "state", s.EVENT AS "event", s.WAIT_CLASS AS "waitClass", s.MODULE AS "module"
       FROM V$SESSION s
      WHERE s.STATUS = 'ACTIVE' AND s.TYPE = 'USER' AND s.SID <> SYS_CONTEXT('USERENV', 'SID')
        AND NOT (s.STATE = 'WAITING' AND s.WAIT_CLASS = 'Idle')
        -- Leave out this app's own observability queries (sampling, monitoring, assessment); its
        -- workloads (benchmarks, imports, generation) stay visible.
        AND NOT (s.MODULE = 'OracleDB Data Lab' AND (s.ACTION LIKE 'ash%' OR s.ACTION LIKE 'monitor:%' OR s.ACTION LIKE 'storage:%'
                 OR s.ACTION LIKE 'assessment:%' OR s.ACTION LIKE 'enterprise:%' OR s.ACTION IN ('overview', 'environment', 'sql-detail', 'awr-report')))`,
  )
  return r.map((x) => {
    // STATE other than WAITING ("WAITED SHORT/KNOWN TIME") means the session is on CPU now.
    const onCpu = x.state !== 'WAITING'
    return { sid: Number(x.sid), user: x.user, sqlId: x.sqlId, event: onCpu ? 'ON CPU' : (x.event ?? 'unknown'), cls: foldClass(onCpu, x.waitClass), module: x.module }
  })
}

/** Background sampler on a dedicated connection. */
export class ActivitySampler {
  readonly ticks: ActivityTick[] = []
  error: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false

  constructor(
    private readonly conn: Connection,
    readonly intervalMs = 1000,
    private readonly maxTicks = Number.POSITIVE_INFINITY,
  ) {}

  start() {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get running() {
    return this.timer != null
  }

  private async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const rows = await sampleActive(this.conn)
      this.ticks.push({ ts: Date.now(), rows })
      if (this.ticks.length > this.maxTicks) this.ticks.splice(0, this.ticks.length - this.maxTicks)
    } catch (err) {
      const i = oracleErrorInfo(err)
      this.error = `${i.code}: ${i.hint ?? i.message}`
      this.stop()
    } finally {
      this.busy = false
    }
  }
}

export interface SummarizeOptions {
  source: ActivitySummary['source']
  intervalSec: number
  /** Window start (ms epoch); series t = seconds since this. */
  t0: number
  t1?: number
  bucketSec?: number
  filter?: (s: ActiveSample) => boolean
}

/** Average active sessions by class, top SQL/events/sessions over the ticks inside [t0, t1]. */
export function summarizeActivity(all: ActivityTick[], o: SummarizeOptions): ActivitySummary {
  const ticks = all.filter((t) => t.ts >= o.t0 && (o.t1 == null || t.ts <= o.t1))
  const bucketSec = o.bucketSec ?? o.intervalSec
  const ticksPerBucket = Math.max(1, Math.round(bucketSec / o.intervalSec))
  const byClass = zero()
  const buckets = new Map<number, Record<ActivityClass, number>>()
  const sql = new Map<string, { n: number; events: Map<string, number> }>()
  const events = new Map<string, { cls: ActivityClass; n: number }>()
  const sessions = new Map<number, { user: string | null; module: string | null; n: number }>()
  let samples = 0

  for (const t of ticks) {
    const b = Math.floor((t.ts - o.t0) / 1000 / bucketSec)
    const row = buckets.get(b) ?? zero()
    buckets.set(b, row)
    for (const s of t.rows) {
      if (o.filter && !o.filter(s)) continue
      samples++
      byClass[s.cls]++
      row[s.cls]++
      if (s.sqlId) {
        const e = sql.get(s.sqlId) ?? { n: 0, events: new Map() }
        e.n++
        e.events.set(s.event, (e.events.get(s.event) ?? 0) + 1)
        sql.set(s.sqlId, e)
      }
      const ev = events.get(s.event) ?? { cls: s.cls, n: 0 }
      ev.n++
      events.set(s.event, ev)
      const se = sessions.get(s.sid) ?? { user: s.user, module: s.module, n: 0 }
      se.n++
      sessions.set(s.sid, se)
    }
  }

  const n = ticks.length
  const pct = (v: number) => (samples ? round((v / samples) * 100, 1) : 0)
  const perTick = (rec: Record<ActivityClass, number>, div: number) =>
    Object.fromEntries(ACTIVITY_CLASSES.map((c) => [c, round(rec[c] / Math.max(1, div))])) as Record<ActivityClass, number>
  const series = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, rec]) => ({ t: b * bucketSec, v: perTick(rec, ticksPerBucket) }))

  return {
    source: o.source,
    intervalSec: o.intervalSec,
    ticks: n,
    samples,
    aas: n ? round(samples / n) : 0,
    byClass: perTick(byClass, n),
    series,
    topSql: [...sql.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 10)
      .map(([sqlId, e]) => ({ sqlId, samples: e.n, pct: pct(e.n), topEvent: [...e.events.entries()].sort((a, b) => b[1] - a[1])[0]![0], text: null })),
    topEvents: [...events.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 10)
      .map(([event, e]) => ({ event, cls: e.cls, samples: e.n, pct: pct(e.n) })),
    topSessions: [...sessions.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 10)
      .map(([sid, e]) => ({ sid, user: e.user, module: e.module, samples: e.n, pct: pct(e.n) })),
  }
}

/** Fills topSql[].text from the shared pool (best effort). */
export async function attachSqlText(conn: Connection, s: ActivitySummary): Promise<ActivitySummary> {
  const ids = s.topSql.map((x) => x.sqlId)
  if (!ids.length) return s
  try {
    const binds = Object.fromEntries(ids.map((id, i) => [`i${i}`, id]))
    const r = await rows<{ id: string; text: string }>(
      conn,
      `SELECT SQL_ID AS "id", MIN(SUBSTR(SQL_TEXT, 1, 300)) AS "text" FROM V$SQL WHERE SQL_ID IN (${ids.map((_, i) => `:i${i}`).join(', ')}) GROUP BY SQL_ID`,
      binds,
    )
    const m = new Map(r.map((x) => [x.id, x.text]))
    return { ...s, topSql: s.topSql.map((x) => ({ ...x, text: m.get(x.sqlId) ?? null })) }
  } catch {
    return s
  }
}

import type { Connection } from 'oracledb'
import type { ActivitySummary, AwrSnapshots, ConnectionProfile } from '../../shared/types/lab'
import { foldClass, summarizeActivity, attachSqlText, type ActivityTick } from '../database/activity'
import { oracledb, withConnection } from '../database/driver'
import { versionMajorOf } from '../database/environment'
import { one, rows } from '../database/query'
import { assertDiagnosticsPack, getProfile } from './profiles'

// Everything that needs the Oracle Diagnostics Pack lives here: AWR snapshots and reports
// (DBMS_WORKLOAD_REPOSITORY) and ASH (V$ACTIVE_SESSION_HISTORY). Every entry point checks that the
// user confirmed a license for the profile; nothing here runs otherwise. ASH-lite (our own V$SESSION
// sampling, server/database/activity.ts) is the license-free alternative used by default.

const DATE_FMT = 'YYYY-MM-DD HH24:MI:SS'

/** Database clock as 'YYYY-MM-DD HH24:MI:SS' (ASH sample times use the database clock). */
export async function dbNow(conn: Connection): Promise<string> {
  return (await one<{ T: string }>(conn, `SELECT TO_CHAR(SYSDATE, '${DATE_FMT}') AS "T" FROM DUAL`))!.T
}

export async function createAwrSnapshot(profile: ConnectionProfile, conn: Connection): Promise<number> {
  assertDiagnosticsPack(profile)
  const r = await conn.execute<{ id: number }>(`BEGIN :id := DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT(); END;`, { id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } })
  return Number((r.outBinds as { id: number }).id)
}

/** DBID / instance of a snapshot; inside a PDB prefers the PDB's own (CON_DBID) snapshot. */
export async function snapshotInfo(profile: ConnectionProfile, conn: Connection, snapId: number): Promise<{ dbid: number; instance: number }> {
  assertDiagnosticsPack(profile)
  const order = versionMajorOf(conn) >= 12 ? `ORDER BY CASE WHEN DBID = TO_NUMBER(SYS_CONTEXT('USERENV', 'CON_DBID')) THEN 0 ELSE 1 END` : ''
  const r = await one<{ DBID: number; INST: number }>(
    conn,
    `SELECT * FROM (SELECT DBID AS "DBID", INSTANCE_NUMBER AS "INST" FROM DBA_HIST_SNAPSHOT WHERE SNAP_ID = :id ${order}) WHERE ROWNUM = 1`,
    { id: snapId },
  )
  if (!r) throw new Error(`AWR snapshot ${snapId} is not visible in DBA_HIST_SNAPSHOT.`)
  return { dbid: Number(r.DBID), instance: Number(r.INST) }
}

export async function awrReportHtml(profileId: string, awr: AwrSnapshots): Promise<string> {
  const profile = await getProfile(profileId)
  assertDiagnosticsPack(profile)
  return withConnection(
    profile.id,
    async (conn) => {
      const lines = await rows<{ L: string | null }>(conn, `SELECT OUTPUT AS "L" FROM TABLE(DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(:dbid, :inst, :b, :e))`, {
        dbid: awr.dbid,
        inst: awr.instance,
        b: awr.beginSnap,
        e: awr.endSnap,
      })
      return lines.map((l) => l.L ?? '').join('\n')
    },
    { action: 'awr-report', callTimeoutMs: 300000 },
  )
}

/**
 * ASH rows between two database-clock times, turned into one tick per second (ASH only stores
 * active sessions, so seconds without rows are real "zero activity" ticks).
 */
export async function ashTicks(
  profile: ConnectionProfile,
  conn: Connection,
  o: { from: string; to: string; t0Ms: number; sids?: number[] },
): Promise<ActivityTick[]> {
  assertDiagnosticsPack(profile)
  const sidFilter = o.sids?.length ? `AND SESSION_ID IN (${o.sids.map((_, i) => `:s${i}`).join(', ')})` : `AND SESSION_TYPE = 'FOREGROUND'`
  const binds: Record<string, unknown> = { a: o.from, b: o.to, ...Object.fromEntries((o.sids ?? []).map((s, i) => [`s${i}`, s])) }
  const r = await rows<{ OFF: number; SID: number; USR: string | null; SQL_ID: string | null; STATE: string; EVENT: string | null; WCLASS: string | null; MODULE: string | null }>(
    conn,
    `SELECT ROUND((CAST(SAMPLE_TIME AS DATE) - TO_DATE(:a, '${DATE_FMT}')) * 86400) AS "OFF", SESSION_ID AS "SID",
            (SELECT USERNAME FROM ALL_USERS u WHERE u.USER_ID = h.USER_ID) AS "USR", SQL_ID AS "SQL_ID", SESSION_STATE AS "STATE",
            EVENT AS "EVENT", WAIT_CLASS AS "WCLASS", MODULE AS "MODULE"
       FROM V$ACTIVE_SESSION_HISTORY h
      WHERE SAMPLE_TIME >= TO_TIMESTAMP(:a, '${DATE_FMT}') AND SAMPLE_TIME <= TO_TIMESTAMP(:b, '${DATE_FMT}') ${sidFilter}`,
    binds,
  )
  const seconds = Math.max(1, Math.round((Date.parse(o.to.replace(' ', 'T')) - Date.parse(o.from.replace(' ', 'T'))) / 1000))
  const ticks: ActivityTick[] = Array.from({ length: seconds + 1 }, (_, i) => ({ ts: o.t0Ms + i * 1000, rows: [] }))
  for (const x of r) {
    const i = Math.min(seconds, Math.max(0, Number(x.OFF)))
    const onCpu = x.STATE === 'ON CPU'
    ticks[i]!.rows.push({ sid: Number(x.SID), user: x.USR, sqlId: x.SQL_ID, event: onCpu ? 'ON CPU' : (x.EVENT ?? 'unknown'), cls: foldClass(onCpu, x.WCLASS), module: x.MODULE })
  }
  return ticks
}

/** ASH summary for a window (live Activity view, licensed profiles only). */
export async function ashSummary(profileId: string, windowSec: number, bucketSec: number): Promise<ActivitySummary> {
  const profile = await getProfile(profileId)
  assertDiagnosticsPack(profile)
  return withConnection(
    profile.id,
    async (conn) => {
      // Window bounds on the database clock, computed by the database (no client time-zone math).
      const w = (await one<{ A: string; B: string }>(conn, `SELECT TO_CHAR(SYSDATE - :w / 86400, '${DATE_FMT}') AS "A", TO_CHAR(SYSDATE, '${DATE_FMT}') AS "B" FROM DUAL`, { w: windowSec }))!
      const from = w.A
      const to = w.B
      // Ticks are placed on the app clock relative to "now" so the UI can label them as "x s ago".
      const t0Ms = Date.now() - windowSec * 1000
      const ticks = await ashTicks(profile, conn, { from, to, t0Ms })
      return attachSqlText(conn, summarizeActivity(ticks, { source: 'ash', intervalSec: 1, t0: t0Ms, bucketSec }))
    },
    { action: 'ash-summary', callTimeoutMs: 120000 },
  )
}

/** control_management_pack_access, shown before the user confirms a license. */
export async function packAccessParameter(profileId: string): Promise<string | null> {
  return withConnection(profileId, async (conn) => {
    try {
      return (await one<{ V: string }>(conn, `SELECT VALUE AS "V" FROM V$PARAMETER WHERE NAME = 'control_management_pack_access'`))?.V ?? null
    } catch {
      return null
    }
  })
}

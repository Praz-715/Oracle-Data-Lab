import type { Connection } from 'oracledb'
import type { Panel } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { versionMajorOf } from '../database/environment'
import { panel, rows } from '../database/query'

// Instance & session monitoring. Uses V$ views that are part of the base license only
// (no ASH/AWR/V$METRIC*), so it works without the Diagnostics Pack. Cumulative counters are
// returned raw with a timestamp; the browser derives per-second rates from consecutive samples.

const CATALOG = 'SELECT_CATALOG_ROLE (or SELECT ANY DICTIONARY)'

type Q = Record<string, string | undefined>
type PanelFn = (conn: Connection, q: Q) => Promise<Panel<unknown>>

const SYSSTAT_NAMES = [
  'user commits', 'user rollbacks', 'execute count', 'user calls', 'session logical reads', 'physical reads',
  'physical writes', 'redo size', 'parse count (total)', 'parse count (hard)', 'DB time', 'CPU used by this session',
  'sorts (memory)', 'sorts (disk)', 'enqueue deadlocks', 'table scans (long tables)', 'consistent gets', 'db block gets',
  'physical reads cache', 'bytes sent via SQL*Net to client', 'bytes received via SQL*Net from client',
]

export const MONITOR_PANELS: Record<string, PanelFn> = {
  /** Counts of sessions by status/type plus process/session limits. */
  summary: (conn) =>
    panel(async () => {
      const byStatus = await rows<{ status: string; type: string; n: number }>(
        conn,
        `SELECT STATUS AS "status", TYPE AS "type", COUNT(*) AS "n" FROM V$SESSION GROUP BY STATUS, TYPE`,
      )
      const limits = await rows<{ name: string; current: number; max: number; limit: string }>(
        conn,
        `SELECT RESOURCE_NAME AS "name", CURRENT_UTILIZATION AS "current", MAX_UTILIZATION AS "max", TRIM(LIMIT_VALUE) AS "limit"
           FROM V$RESOURCE_LIMIT WHERE RESOURCE_NAME IN ('processes', 'sessions', 'transactions')`,
      )
      const user = byStatus.filter((r) => r.type === 'USER')
      return {
        activeUser: user.filter((r) => r.status === 'ACTIVE').reduce((n, r) => n + Number(r.n), 0),
        inactiveUser: user.filter((r) => r.status === 'INACTIVE').reduce((n, r) => n + Number(r.n), 0),
        background: byStatus.filter((r) => r.type === 'BACKGROUND').reduce((n, r) => n + Number(r.n), 0),
        total: byStatus.reduce((n, r) => n + Number(r.n), 0),
        limits,
      }
    }, CATALOG),

  /** Cumulative system statistics + OS CPU counters for rate computation. */
  sysstat: (conn) =>
    panel(async () => {
      const stats = await rows<{ name: string; value: number }>(
        conn,
        `SELECT NAME AS "name", VALUE AS "value" FROM V$SYSSTAT WHERE NAME IN (${SYSSTAT_NAMES.map((_, i) => `:n${i}`).join(', ')})`,
        Object.fromEntries(SYSSTAT_NAMES.map((n, i) => [`n${i}`, n])),
      )
      let os: Record<string, number> | null
      try {
        const o = await rows<{ name: string; value: number }>(
          conn,
          `SELECT STAT_NAME AS "name", VALUE AS "value" FROM V$OSSTAT WHERE STAT_NAME IN ('NUM_CPUS','BUSY_TIME','IDLE_TIME','USER_TIME','SYS_TIME','IOWAIT_TIME','LOAD','PHYSICAL_MEMORY_BYTES')`,
        )
        os = Object.fromEntries(o.map((r) => [r.name, Number(r.value)]))
      } catch {
        os = null
      }
      return { sampledAtMs: Date.now(), stats: Object.fromEntries(stats.map((s) => [s.name, Number(s.value)])), os }
    }, CATALOG),

  sessions: (conn, q) =>
    panel(async () => {
      const status = q.status === 'ACTIVE' || q.status === 'INACTIVE' ? q.status : null
      return rows(
        conn,
        `SELECT * FROM (
           SELECT s.SID AS "sid", s.SERIAL# AS "serial", s.USERNAME AS "username", s.STATUS AS "status", s.SERVER AS "server",
                  s.OSUSER AS "osUser", s.MACHINE AS "machine", s.PROGRAM AS "program", s.MODULE AS "module", s.ACTION AS "action",
                  s.SQL_ID AS "sqlId", s.EVENT AS "event", s.WAIT_CLASS AS "waitClass", s.STATE AS "state",
                  s.SECONDS_IN_WAIT AS "secondsInWait", s.LAST_CALL_ET AS "lastCallEt", s.BLOCKING_SESSION AS "blockingSession",
                  TO_CHAR(s.LOGON_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "logonTime"
             FROM V$SESSION s
            WHERE s.TYPE = 'USER' ${status ? 'AND s.STATUS = :st' : ''}
            ORDER BY CASE s.STATUS WHEN 'ACTIVE' THEN 0 ELSE 1 END, s.LAST_CALL_ET DESC)
          WHERE ROWNUM <= 500`,
        status ? { st: status } : {},
      )
    }, CATALOG),

  /** Cumulative non-idle wait events (rates derived client-side) + what sessions wait on right now. */
  waits: (conn) =>
    panel(async () => {
      const system = await rows(
        conn,
        `SELECT * FROM (
           SELECT EVENT AS "event", WAIT_CLASS AS "waitClass", TOTAL_WAITS AS "totalWaits", TIME_WAITED_MICRO AS "timeWaitedMicro"
             FROM V$SYSTEM_EVENT WHERE WAIT_CLASS <> 'Idle' ORDER BY TIME_WAITED_MICRO DESC)
          WHERE ROWNUM <= 25`,
      )
      const current = await rows(
        conn,
        `SELECT WAIT_CLASS AS "waitClass", EVENT AS "event", COUNT(*) AS "sessions"
           FROM V$SESSION WHERE TYPE = 'USER' AND STATE = 'WAITING' AND WAIT_CLASS <> 'Idle'
          GROUP BY WAIT_CLASS, EVENT ORDER BY 3 DESC`,
      )
      return { sampledAtMs: Date.now(), system, current }
    }, CATALOG),

  blocking: (conn) =>
    panel(async () => {
      const blocked = await rows(
        conn,
        `SELECT s.SID AS "sid", s.SERIAL# AS "serial", s.USERNAME AS "username", s.BLOCKING_SESSION AS "blocker",
                s.EVENT AS "event", s.SECONDS_IN_WAIT AS "secondsInWait", s.SQL_ID AS "sqlId", s.MODULE AS "module",
                b.USERNAME AS "blockerUser", b.STATUS AS "blockerStatus", b.SQL_ID AS "blockerSqlId", b.PREV_SQL_ID AS "blockerPrevSqlId",
                b.MACHINE AS "blockerMachine", b.LAST_CALL_ET AS "blockerIdleSeconds"
           FROM V$SESSION s LEFT JOIN V$SESSION b ON b.SID = s.BLOCKING_SESSION
          WHERE s.BLOCKING_SESSION IS NOT NULL ORDER BY s.SECONDS_IN_WAIT DESC`,
      )
      const locks = await rows(
        conn,
        `SELECT l.SID AS "sid", l.TYPE AS "type", l.LMODE AS "mode", l.REQUEST AS "request", l.CTIME AS "seconds", l.BLOCK AS "blocking"
           FROM V$LOCK l WHERE l.BLOCK = 1 OR l.REQUEST > 0`,
      )
      return { blocked, locks }
    }, CATALOG),

  memory: (conn) =>
    panel(async () => {
      const sga = await rows<{ name: string; bytes: number; resizeable: string }>(
        conn,
        `SELECT NAME AS "name", BYTES AS "bytes", RESIZEABLE AS "resizeable" FROM V$SGAINFO`,
      )
      const pga = await rows<{ name: string; value: number; unit: string }>(
        conn,
        `SELECT NAME AS "name", VALUE AS "value", UNIT AS "unit" FROM V$PGASTAT`,
      )
      const components = await rows(
        conn,
        `SELECT COMPONENT AS "component", CURRENT_SIZE AS "currentSize", MIN_SIZE AS "minSize", MAX_SIZE AS "maxSize"
           FROM V$SGA_DYNAMIC_COMPONENTS WHERE CURRENT_SIZE > 0 ORDER BY CURRENT_SIZE DESC`,
      )
      const sharedPool = await rows(
        conn,
        `SELECT * FROM (SELECT NAME AS "name", BYTES AS "bytes" FROM V$SGASTAT WHERE POOL = 'shared pool' ORDER BY BYTES DESC) WHERE ROWNUM <= 12`,
      )
      const library = await rows(
        conn,
        `SELECT NAMESPACE AS "namespace", GETS AS "gets", GETHITRATIO AS "getHitRatio", PINS AS "pins", PINHITRATIO AS "pinHitRatio",
                RELOADS AS "reloads", INVALIDATIONS AS "invalidations"
           FROM V$LIBRARYCACHE WHERE GETS > 0 ORDER BY GETS DESC`,
      )
      const workarea = await rows(
        conn,
        `SELECT LOW_OPTIMAL_SIZE AS "lowBytes", HIGH_OPTIMAL_SIZE AS "highBytes", OPTIMAL_EXECUTIONS AS "optimal",
                ONEPASS_EXECUTIONS AS "onePass", MULTIPASSES_EXECUTIONS AS "multiPass"
           FROM V$SQL_WORKAREA_HISTOGRAM WHERE TOTAL_EXECUTIONS > 0 ORDER BY LOW_OPTIMAL_SIZE`,
      )
      const ratios = await rows<{ name: string; value: number }>(
        conn,
        `SELECT NAME AS "name", VALUE AS "value" FROM V$SYSSTAT
          WHERE NAME IN ('db block gets from cache', 'consistent gets from cache', 'physical reads cache', 'sorts (memory)', 'sorts (disk)')`,
      )
      const r = Object.fromEntries(ratios.map((x) => [x.name, Number(x.value)]))
      const logical = (r['db block gets from cache'] ?? 0) + (r['consistent gets from cache'] ?? 0)
      const bufferHit = logical > 0 ? 1 - (r['physical reads cache'] ?? 0) / logical : null
      const sorts = (r['sorts (memory)'] ?? 0) + (r['sorts (disk)'] ?? 0)
      return {
        sga,
        pga,
        components,
        sharedPool,
        library,
        workarea,
        bufferCacheHitRatio: bufferHit,
        memorySortRatio: sorts > 0 ? (r['sorts (memory)'] ?? 0) / sorts : null,
        interpretation:
          'Buffer cache hit ratio is cumulative since startup and is a weak tuning signal on its own: a high ratio can hide inefficient SQL doing excessive logical reads. Prefer wait events and top SQL by buffer gets.',
      }
    }, CATALOG),

  processes: (conn) =>
    panel(
      () =>
        rows(
          conn,
          `SELECT * FROM (
             SELECT p.SPID AS "spid", p.PROGRAM AS "program", s.SID AS "sid", s.USERNAME AS "username",
                    p.PGA_USED_MEM AS "pgaUsed", p.PGA_ALLOC_MEM AS "pgaAlloc", p.PGA_MAX_MEM AS "pgaMax"
               FROM V$PROCESS p LEFT JOIN V$SESSION s ON s.PADDR = p.ADDR
              ORDER BY p.PGA_ALLOC_MEM DESC) WHERE ROWNUM <= 25`,
        ),
      CATALOG,
    ),

  longops: (conn) =>
    panel(async () => {
      const ops = await rows(
        conn,
        `SELECT SID AS "sid", SERIAL# AS "serial", OPNAME AS "opname", TARGET AS "target", SOFAR AS "sofar", TOTALWORK AS "totalwork",
                UNITS AS "units", ELAPSED_SECONDS AS "elapsed", TIME_REMAINING AS "remaining", SQL_ID AS "sqlId", MESSAGE AS "message"
           FROM V$SESSION_LONGOPS WHERE SOFAR < TOTALWORK AND TOTALWORK > 0 ORDER BY ELAPSED_SECONDS DESC`,
      )
      const running = await rows(
        conn,
        `SELECT * FROM (
           SELECT s.SID AS "sid", s.USERNAME AS "username", s.SQL_ID AS "sqlId", s.LAST_CALL_ET AS "seconds", s.EVENT AS "event", s.MODULE AS "module"
             FROM V$SESSION s WHERE s.TYPE = 'USER' AND s.STATUS = 'ACTIVE' AND s.LAST_CALL_ET >= 30 AND s.SQL_ID IS NOT NULL
            ORDER BY s.LAST_CALL_ET DESC) WHERE ROWNUM <= 50`,
      )
      return { longops: ops, longRunning: running }
    }, CATALOG),

  temp: (conn) =>
    panel(
      () =>
        rows(
          conn,
          `SELECT u.USERNAME AS "username", u.SESSION_NUM AS "serial", s.SID AS "sid", u.SQL_ID AS "sqlId", u.TABLESPACE AS "tablespace",
                  u.SEGTYPE AS "segtype", u.BLOCKS * t.BLOCK_SIZE AS "bytes"
             FROM V$TEMPSEG_USAGE u
             JOIN V$SESSION s ON s.SADDR = u.SESSION_ADDR
             JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = u.TABLESPACE
            ORDER BY u.BLOCKS DESC`,
        ),
      `${CATALOG} and DBA_TABLESPACES`,
    ),

  topsql: async (conn, q) => {
    const by = ({ elapsed: 'ELAPSED_TIME', cpu: 'CPU_TIME', gets: 'BUFFER_GETS', reads: 'DISK_READS', execs: 'EXECUTIONS' } as const)[
      (q.by ?? 'elapsed') as 'elapsed'
    ] ?? 'ELAPSED_TIME'
    return panel(
      () =>
        rows(
          conn,
          `SELECT * FROM (
             SELECT SQL_ID AS "sqlId", PLAN_HASH_VALUE AS "planHash", EXECUTIONS AS "executions",
                    ROUND(ELAPSED_TIME / 1000) AS "elapsedMs", ROUND(CPU_TIME / 1000) AS "cpuMs", BUFFER_GETS AS "bufferGets",
                    DISK_READS AS "diskReads", ROWS_PROCESSED AS "rowsProcessed",
                    ROUND(ELAPSED_TIME / 1000 / GREATEST(EXECUTIONS, 1), 3) AS "msPerExec",
                    ROUND(BUFFER_GETS / GREATEST(EXECUTIONS, 1)) AS "getsPerExec",
                    SUBSTR(SQL_TEXT, 1, 300) AS "sqlText"
               FROM V$SQLSTATS ORDER BY ${by} DESC)
            WHERE ROWNUM <= 30`,
        ),
      CATALOG,
      'Cumulative since the cursor was loaded (V$SQLSTATS, no Diagnostics Pack required).',
    )
  },

  /** SQL that differs only by literals: candidates for bind variables. */
  literals: (conn) =>
    panel(
      () =>
        rows(
          conn,
          `SELECT * FROM (
             SELECT FORCE_MATCHING_SIGNATURE AS "signature", COUNT(*) AS "cursors", SUM(EXECUTIONS) AS "executions",
                    MIN(SQL_ID) AS "exampleSqlId", SUBSTR(MIN(SQL_TEXT), 1, 200) AS "example"
               FROM V$SQLSTATS WHERE FORCE_MATCHING_SIGNATURE <> 0
              GROUP BY FORCE_MATCHING_SIGNATURE HAVING COUNT(*) >= 10 ORDER BY 2 DESC)
            WHERE ROWNUM <= 20`,
        ),
      CATALOG,
    ),

  alerts: async (conn) => {
    if (versionMajorOf(conn) < 12) {
      return {
        status: 'unavailable',
        reason: 'V$DIAG_ALERT_EXT is available from Oracle 12c. On 11g, paste alert log text into the analyzer instead.',
        collectedAt: new Date().toISOString(),
      }
    }
    return panel(
      () =>
        rows(
          conn,
          `SELECT * FROM (
             SELECT TO_CHAR(ORIGINATING_TIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS') AS "ts", MESSAGE_LEVEL AS "level",
                    SUBSTR(MESSAGE_TEXT, 1, 1000) AS "text"
               FROM V$DIAG_ALERT_EXT
              WHERE ORIGINATING_TIMESTAMP > SYSTIMESTAMP - INTERVAL '3' DAY
                AND (MESSAGE_TEXT LIKE '%ORA-%' OR MESSAGE_TEXT LIKE '%TNS-%' OR MESSAGE_LEVEL <= 2)
              ORDER BY ORIGINATING_TIMESTAMP DESC)
            WHERE ROWNUM <= 300`,
        ),
      'SELECT on V$DIAG_ALERT_EXT (SELECT_CATALOG_ROLE)',
    )
  },
}

export async function monitorPanel(profileId: string, name: string, q: Q) {
  const fn = MONITOR_PANELS[name]
  if (!fn) throw createError({ statusCode: 404, statusMessage: `Unknown panel ${name}` })
  return withConnection(profileId, (conn) => fn(conn, q), { action: `monitor:${name}`, callTimeoutMs: 60000 })
}

export async function sqlDetail(profileId: string, sqlId: string) {
  if (!/^[0-9a-z]{13}$/.test(sqlId)) throw createError({ statusCode: 400, statusMessage: 'Invalid SQL_ID' })
  return withConnection(profileId, async (conn) => {
    const stats = await panel(
      () =>
        rows(
          conn,
          `SELECT SQL_ID AS "sqlId", PLAN_HASH_VALUE AS "planHash", EXECUTIONS AS "executions", ROUND(ELAPSED_TIME / 1000) AS "elapsedMs",
                  ROUND(CPU_TIME / 1000) AS "cpuMs", BUFFER_GETS AS "bufferGets", DISK_READS AS "diskReads", ROWS_PROCESSED AS "rowsProcessed",
                  PARSE_CALLS AS "parseCalls", SORTS AS "sorts", ROUND(USER_IO_WAIT_TIME / 1000) AS "userIoMs",
                  ROUND(CONCURRENCY_WAIT_TIME / 1000) AS "concurrencyMs", ROUND(CLUSTER_WAIT_TIME / 1000) AS "clusterMs"
             FROM V$SQLSTATS WHERE SQL_ID = :id`,
          { id: sqlId },
        ),
      CATALOG,
    )
    const cursors = await panel(
      () =>
        rows(
          conn,
          `SELECT CHILD_NUMBER AS "child", PLAN_HASH_VALUE AS "planHash", PARSING_SCHEMA_NAME AS "schema", EXECUTIONS AS "executions",
                  OPTIMIZER_COST AS "cost", OPTIMIZER_MODE AS "optimizerMode", IS_BIND_SENSITIVE AS "bindSensitive", IS_BIND_AWARE AS "bindAware",
                  ROUND(ELAPSED_TIME / 1000) AS "elapsedMs", BUFFER_GETS AS "bufferGets",
                  TO_CHAR(LAST_ACTIVE_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastActive"
             FROM V$SQL WHERE SQL_ID = :id ORDER BY CHILD_NUMBER`,
          { id: sqlId },
        ),
      CATALOG,
    )
    const text = await panel(async () => {
      const r = await rows<{ t: string }>(conn, `SELECT SQL_FULLTEXT AS "t" FROM V$SQL WHERE SQL_ID = :id AND ROWNUM = 1`, { id: sqlId })
      return r[0]?.t ?? null
    }, CATALOG)
    const plan = await panel(async () => {
      const r = await rows<{ l: string }>(
        conn,
        `SELECT PLAN_TABLE_OUTPUT AS "l" FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:id, NULL, 'TYPICAL +PEEKED_BINDS'))`,
        { id: sqlId },
      )
      return r.map((x) => x.l).join('\n')
    }, `${CATALOG} (V$SQL_PLAN access)`)
    const planLines = await panel(
      () =>
        rows(
          conn,
          `SELECT CHILD_NUMBER AS "child", ID AS "id", OPERATION AS "operation", OPTIONS AS "options", OBJECT_OWNER AS "owner",
                  OBJECT_NAME AS "object", COST AS "cost", CARDINALITY AS "cardinality", ACCESS_PREDICATES AS "access", FILTER_PREDICATES AS "filter"
             FROM V$SQL_PLAN WHERE SQL_ID = :id AND CHILD_NUMBER = (SELECT MIN(CHILD_NUMBER) FROM V$SQL_PLAN WHERE SQL_ID = :id) ORDER BY ID`,
          { id: sqlId },
        ),
      CATALOG,
    )
    const binds = await panel(
      () =>
        rows(
          conn,
          `SELECT * FROM (
             SELECT CHILD_NUMBER AS "child", NAME AS "name", POSITION AS "position", DATATYPE_STRING AS "datatype",
                    VALUE_STRING AS "value", TO_CHAR(LAST_CAPTURED, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastCaptured"
               FROM V$SQL_BIND_CAPTURE WHERE SQL_ID = :id ORDER BY CHILD_NUMBER, POSITION)
            WHERE ROWNUM <= 200`,
          { id: sqlId },
        ),
      CATALOG,
    )
    return { sqlId, stats, cursors, text, plan, planLines, binds }
  }, { action: 'sql-detail' })
}

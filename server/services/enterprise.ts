import type { Connection } from 'oracledb'
import type { Panel } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { one, panel, rows, softPanel } from '../database/query'

// Enterprise HA/DR observability (read-only). Role changes, failover drills and restores are
// intentionally not executed from this app yet: they need an isolated lab, pre-flight checks,
// explicit confirmation and a recovery procedure (see docs/OPERATIONS.md).

const CATALOG = 'SELECT_CATALOG_ROLE (or SELECT ANY DICTIONARY)'

async function rac(conn: Connection) {
  const instances = await panel(
    () =>
      rows(
        conn,
        `SELECT INST_ID AS "instId", INSTANCE_NAME AS "instance", HOST_NAME AS "host", STATUS AS "status", THREAD# AS "thread",
                VERSION AS "version", TO_CHAR(STARTUP_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "startup", DATABASE_STATUS AS "dbStatus"
           FROM GV$INSTANCE ORDER BY INST_ID`,
      ),
    CATALOG,
  )
  const isRac = instances.status === 'ok' && (instances.data as unknown[]).length > 1
  const sessions = await softPanel(
    () =>
      rows(
        conn,
        `SELECT INST_ID AS "instId", COUNT(*) AS "total", SUM(CASE WHEN STATUS = 'ACTIVE' THEN 1 ELSE 0 END) AS "active"
           FROM GV$SESSION WHERE TYPE = 'USER' GROUP BY INST_ID ORDER BY INST_ID`,
      ),
    CATALOG,
  )
  const services = await softPanel(
    () =>
      rows(
        conn,
        `SELECT INST_ID AS "instId", NAME AS "service", NETWORK_NAME AS "networkName" FROM GV$ACTIVE_SERVICES
          WHERE NAME NOT LIKE 'SYS$%' ORDER BY NAME, INST_ID`,
      ),
    CATALOG,
    'Preferred/available instance placement is Clusterware configuration (srvctl config service) and is not exposed through SQL.',
  )
  const gcStats = isRac
    ? await softPanel(
        () =>
          rows(
            conn,
            `SELECT INST_ID AS "instId", NAME AS "name", VALUE AS "value" FROM GV$SYSSTAT
              WHERE NAME IN ('gc cr blocks received', 'gc current blocks received', 'gc cr block receive time', 'gc current block receive time',
                             'gc cr blocks served', 'gc current blocks served') ORDER BY INST_ID, NAME`,
          ),
        CATALOG,
      )
    : notRac()
  const gcWaits = isRac
    ? await softPanel(
        () =>
          rows(
            conn,
            `SELECT * FROM (SELECT INST_ID AS "instId", EVENT AS "event", TOTAL_WAITS AS "waits", ROUND(TIME_WAITED_MICRO / 1000) AS "waitedMs"
               FROM GV$SYSTEM_EVENT WHERE EVENT LIKE 'gc%' ORDER BY TIME_WAITED_MICRO DESC) WHERE ROWNUM <= 30`,
          ),
        CATALOG,
      )
    : notRac()
  const interconnect = isRac
    ? await softPanel(
        () => rows(conn, `SELECT INST_ID AS "instId", NAME AS "name", IP_ADDRESS AS "ip", IS_PUBLIC AS "isPublic", SOURCE AS "source" FROM GV$CLUSTER_INTERCONNECTS`),
        CATALOG,
      )
    : notRac()
  return { isRac, instances, sessions, services, gcStats, gcWaits, interconnect }
}

function notRac(): Panel<never> {
  return { status: 'unavailable', reason: 'Single-instance database: Global Cache and interconnect metrics apply to RAC only.', collectedAt: new Date().toISOString() }
}

async function dataguard(conn: Connection) {
  const database = await panel(
    () =>
      one(
        conn,
        `SELECT NAME AS "name", DB_UNIQUE_NAME AS "dbUniqueName", DATABASE_ROLE AS "role", OPEN_MODE AS "openMode",
                PROTECTION_MODE AS "protectionMode", PROTECTION_LEVEL AS "protectionLevel", SWITCHOVER_STATUS AS "switchoverStatus",
                DATAGUARD_BROKER AS "broker", FORCE_LOGGING AS "forceLogging", FLASHBACK_ON AS "flashback", LOG_MODE AS "logMode"
           FROM V$DATABASE`,
      ),
    CATALOG,
  )
  const destinations = await softPanel(
    () =>
      rows(
        conn,
        `SELECT DEST_ID AS "destId", DEST_NAME AS "name", STATUS AS "status", TYPE AS "type", DATABASE_MODE AS "databaseMode",
                RECOVERY_MODE AS "recoveryMode", PROTECTION_MODE AS "protectionMode", DESTINATION AS "destination",
                ARCHIVED_SEQ# AS "archivedSeq", APPLIED_SEQ# AS "appliedSeq", GAP_STATUS AS "gapStatus", ERROR AS "error"
           FROM V$ARCHIVE_DEST_STATUS WHERE STATUS <> 'INACTIVE' ORDER BY DEST_ID`,
      ),
    CATALOG,
  )
  const lag = await softPanel(
    () =>
      rows(
        conn,
        `SELECT NAME AS "name", VALUE AS "value", UNIT AS "unit", TIME_COMPUTED AS "computed", DATUM_TIME AS "datum" FROM V$DATAGUARD_STATS`,
      ),
    CATALOG,
    'Transport/apply lag is reported on the standby database.',
  )
  const gaps = await softPanel(
    () => rows(conn, `SELECT THREAD# AS "thread", LOW_SEQUENCE# AS "low", HIGH_SEQUENCE# AS "high" FROM V$ARCHIVE_GAP`),
    CATALOG,
    'V$ARCHIVE_GAP is meaningful on a physical standby.',
  )
  const redoRate = await softPanel(
    () =>
      rows(
        conn,
        `SELECT TO_CHAR(TRUNC(FIRST_TIME, 'HH24'), 'YYYY-MM-DD"T"HH24:MI') AS "hour", COUNT(*) AS "logs", SUM(BLOCKS * BLOCK_SIZE) AS "bytes"
           FROM V$ARCHIVED_LOG WHERE FIRST_TIME > SYSDATE - 1 AND DEST_ID = (SELECT MIN(DEST_ID) FROM V$ARCHIVED_LOG WHERE FIRST_TIME > SYSDATE - 1)
          GROUP BY TRUNC(FIRST_TIME, 'HH24') ORDER BY 1`,
      ),
    CATALOG,
    'Archived redo per hour over the last 24 hours (proxy for redo generation and shipping volume).',
  )
  const recentLogs = await softPanel(
    () =>
      rows(
        conn,
        `SELECT * FROM (SELECT THREAD# AS "thread", SEQUENCE# AS "sequence", DEST_ID AS "destId", APPLIED AS "applied", STATUS AS "status",
                TO_CHAR(FIRST_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "firstTime", TO_CHAR(COMPLETION_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "completed",
                BLOCKS * BLOCK_SIZE AS "bytes"
           FROM V$ARCHIVED_LOG ORDER BY COMPLETION_TIME DESC) WHERE ROWNUM <= 50`,
      ),
    CATALOG,
  )
  let readiness: { ready: boolean | null; explanation: string } = { ready: null, explanation: 'Unknown (V$DATABASE not visible).' }
  if (database.status === 'ok' && database.data) {
    const s = String((database.data as any).switchoverStatus ?? '')
    const ok = ['TO STANDBY', 'TO PRIMARY', 'SESSIONS ACTIVE'].includes(s)
    readiness = {
      ready: ok,
      explanation:
        s === 'NOT ALLOWED'
          ? 'NOT ALLOWED: no standby is configured or this is a standby that has not received the switchover request.'
          : s === 'SESSIONS ACTIVE'
            ? 'SESSIONS ACTIVE: switchover possible WITH SESSION SHUTDOWN.'
            : s === 'RESOLVABLE GAP' || s === 'UNRESOLVABLE GAP'
              ? `${s}: archive gap must be resolved first.`
              : `Status ${s || 'n/a'}.`,
    }
  }
  return { database, destinations, lag, gaps, redoRate, recentLogs, readiness }
}

async function rman(conn: Connection) {
  const jobs = await panel(
    () =>
      rows(
        conn,
        `SELECT * FROM (SELECT SESSION_KEY AS "sessionKey", INPUT_TYPE AS "inputType", STATUS AS "status",
                TO_CHAR(START_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "start", TO_CHAR(END_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "end",
                ELAPSED_SECONDS AS "elapsed", INPUT_BYTES AS "inputBytes", OUTPUT_BYTES AS "outputBytes",
                INPUT_BYTES_PER_SEC AS "inputRate", OUTPUT_BYTES_PER_SEC AS "outputRate", COMPRESSION_RATIO AS "compression",
                OUTPUT_DEVICE_TYPE AS "device"
           FROM V$RMAN_BACKUP_JOB_DETAILS WHERE START_TIME > SYSDATE - 60 ORDER BY START_TIME DESC) WHERE ROWNUM <= 200`,
      ),
    CATALOG,
  )
  const sets = await softPanel(
    () =>
      rows(
        conn,
        `SELECT BACKUP_TYPE AS "type", INCREMENTAL_LEVEL AS "level", COUNT(*) AS "sets", SUM(PIECES) AS "pieces",
                TO_CHAR(MAX(COMPLETION_TIME), 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastCompleted"
           FROM V$BACKUP_SET GROUP BY BACKUP_TYPE, INCREMENTAL_LEVEL ORDER BY 1, 2`,
      ),
    CATALOG,
    'Backup type: D = datafile full/level 0, I = incremental, L = archived log.',
  )
  const pieces = await softPanel(
    () =>
      rows(
        conn,
        `SELECT * FROM (SELECT RECID AS "recid", HANDLE AS "handle", DEVICE_TYPE AS "device", STATUS AS "status", BYTES AS "bytes",
                TO_CHAR(COMPLETION_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "completed"
           FROM V$BACKUP_PIECE ORDER BY COMPLETION_TIME DESC) WHERE ROWNUM <= 100`,
      ),
    CATALOG,
  )
  const config = await softPanel(() => rows(conn, `SELECT NAME AS "name", VALUE AS "value" FROM V$RMAN_CONFIGURATION ORDER BY NAME`), CATALOG, 'Only non-default RMAN settings are listed.')
  const archCoverage = await softPanel(
    () =>
      one(
        conn,
        `SELECT COUNT(*) AS "total", SUM(CASE WHEN BACKUP_COUNT = 0 THEN 1 ELSE 0 END) AS "notBackedUp",
                TO_CHAR(MIN(CASE WHEN BACKUP_COUNT = 0 THEN FIRST_TIME END), 'YYYY-MM-DD"T"HH24:MI:SS') AS "oldestUnbacked"
           FROM V$ARCHIVED_LOG WHERE DELETED = 'NO' AND STANDBY_DEST = 'NO'`,
      ),
    CATALOG,
  )
  // RPO proxy: time since the most recent completed backup of archived logs (or any backup).
  const rpo = await softPanel(
    () =>
      one(
        conn,
        `SELECT ROUND((SYSDATE - MAX(CASE WHEN INPUT_TYPE = 'ARCHIVELOG' AND STATUS LIKE 'COMPLETED%' THEN END_TIME END)) * 86400) AS "sinceArchivelogSec",
                ROUND((SYSDATE - MAX(CASE WHEN STATUS LIKE 'COMPLETED%' THEN END_TIME END)) * 86400) AS "sinceAnySec",
                MAX(CASE WHEN INPUT_TYPE LIKE 'DB%' AND STATUS LIKE 'COMPLETED%' THEN INPUT_BYTES_PER_SEC END) AS "bestDbReadRate",
                MAX(CASE WHEN INPUT_TYPE LIKE 'DB FULL' OR INPUT_TYPE LIKE 'DB INCR' THEN INPUT_BYTES END) AS "largestDbInputBytes"
           FROM V$RMAN_BACKUP_JOB_DETAILS`,
      ),
    CATALOG,
    'RPO ≈ time since the last completed archived-log backup. RTO needs a timed restore drill; backup read rate is only a lower-bound proxy.',
  )
  return { jobs, sets, pieces, config, archCoverage, rpo }
}

export const ENTERPRISE_PANELS = { rac, dataguard, rman } as const

export async function enterprisePanel(profileId: string, name: string) {
  const fn = (ENTERPRISE_PANELS as Record<string, (c: Connection) => Promise<unknown>>)[name]
  if (!fn) throw createError({ statusCode: 404, statusMessage: `Unknown panel ${name}` })
  return withConnection(profileId, fn, { action: `enterprise:${name}`, callTimeoutMs: 60000 })
}

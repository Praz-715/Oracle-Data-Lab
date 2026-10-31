import type { Connection } from 'oracledb'
import type { Panel } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { ident, panel, rows } from '../database/query'

// Tablespace & storage lab. Prefers DBA_* views; falls back to USER_* views when they are not
// visible. "Allocated" numbers come from segments (measured); "estimated" numbers come from
// optimizer statistics (NUM_ROWS × AVG_ROW_LEN) and are labeled as such.

const DBA = 'SELECT_CATALOG_ROLE or SELECT on DBA_TABLESPACES / DBA_DATA_FILES / DBA_TABLESPACE_USAGE_METRICS'
type Q = Record<string, string | undefined>

export interface TablespaceRow {
  name: string
  contents: string
  status: string
  bigfile: string
  blockSize: number
  allocatedBytes: number
  usedBytes: number | null
  maxBytes: number | null
  usedPct: number | null
  autoextend: boolean
  datafiles: number
}

async function tablespaces(conn: Connection): Promise<TablespaceRow[]> {
  const r = await rows<any>(
    conn,
    `SELECT t.TABLESPACE_NAME AS "name", t.CONTENTS AS "contents", t.STATUS AS "status", t.BIGFILE AS "bigfile", t.BLOCK_SIZE AS "blockSize",
            NVL(f.bytes, 0) AS "allocatedBytes", m.USED_SPACE * t.BLOCK_SIZE AS "usedBytes", m.TABLESPACE_SIZE * t.BLOCK_SIZE AS "maxBytes",
            ROUND(m.USED_PERCENT, 2) AS "usedPct", NVL(f.autoext, 'NO') AS "autoextend", NVL(f.files, 0) AS "datafiles"
       FROM DBA_TABLESPACES t
       LEFT JOIN DBA_TABLESPACE_USAGE_METRICS m ON m.TABLESPACE_NAME = t.TABLESPACE_NAME
       LEFT JOIN (
         SELECT TABLESPACE_NAME, SUM(BYTES) AS bytes, MAX(AUTOEXTENSIBLE) AS autoext, COUNT(*) AS files FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME
         UNION ALL
         SELECT TABLESPACE_NAME, SUM(BYTES), MAX(AUTOEXTENSIBLE), COUNT(*) FROM DBA_TEMP_FILES GROUP BY TABLESPACE_NAME
       ) f ON f.TABLESPACE_NAME = t.TABLESPACE_NAME
      ORDER BY m.USED_PERCENT DESC NULLS LAST, t.TABLESPACE_NAME`,
  )
  return r.map((x) => ({ ...x, autoextend: x.autoextend === 'YES' }))
}

async function snapshotIfDue(profileId: string, ts: TablespaceRow[]) {
  const store = labStore()
  const k = `storage-history:${profileId}`
  const hist = (await store.getItem<{ ts: string; items: { name: string; used: number | null; max: number | null }[] }[]>(k)) ?? []
  const last = hist[hist.length - 1]
  if (last && Date.now() - Date.parse(last.ts) < 15 * 60_000) return
  hist.push({ ts: nowIso(), items: ts.map((t) => ({ name: t.name, used: t.usedBytes, max: t.maxBytes })) })
  // ~3 months at one snapshot per 15 minutes is far more than needed; keep the latest 5000.
  await store.setItem(k, hist.slice(-5000))
}

export const STORAGE_PANELS: Record<string, (conn: Connection, q: Q, profileId: string) => Promise<Panel<unknown>>> = {
  tablespaces: async (conn, _q, profileId) => {
    const p = await panel(async () => {
      const ts = await tablespaces(conn)
      await snapshotIfDue(profileId, ts)
      return ts
    }, DBA)
    if (p.status === 'ok') return p
    // Fallback for users without DBA views: their own quotas.
    return panel(
      () =>
        rows(
          conn,
          `SELECT q.TABLESPACE_NAME AS "name", 'PERMANENT' AS "contents", 'ONLINE' AS "status", NULL AS "bigfile", NULL AS "blockSize",
                  q.BYTES AS "allocatedBytes", q.BYTES AS "usedBytes", DECODE(q.MAX_BYTES, -1, NULL, q.MAX_BYTES) AS "maxBytes",
                  CASE WHEN q.MAX_BYTES > 0 THEN ROUND(q.BYTES / q.MAX_BYTES * 100, 2) END AS "usedPct", 0 AS "autoextend", 0 AS "datafiles"
             FROM USER_TS_QUOTAS q`,
        ),
      DBA,
      'Limited view: DBA views are not visible, showing this user\'s quotas (USER_TS_QUOTAS) only.',
    )
  },

  datafiles: (conn) =>
    panel(
      () =>
        rows(
          conn,
          `SELECT 'DATA' AS "kind", FILE_ID AS "fileId", FILE_NAME AS "fileName", TABLESPACE_NAME AS "tablespace", BYTES AS "bytes",
                  MAXBYTES AS "maxBytes", AUTOEXTENSIBLE AS "autoextend", INCREMENT_BY AS "incrementBlocks", STATUS AS "status", ONLINE_STATUS AS "online"
             FROM DBA_DATA_FILES
           UNION ALL
           SELECT 'TEMP', FILE_ID, FILE_NAME, TABLESPACE_NAME, BYTES, MAXBYTES, AUTOEXTENSIBLE, INCREMENT_BY, STATUS, NULL
             FROM DBA_TEMP_FILES
           ORDER BY 4, 2`,
        ),
      DBA,
    ),

  /** Table/index/LOB sizes for an owner: measured segment bytes vs. statistics-based estimate. */
  objects: async (conn, q) => {
    const owner = ident(q.owner ?? '', 'owner')
    const like = q.prefix ? `${ident(q.prefix, 'prefix').replace(/_/g, '\\_')}%` : '%'
    const note = 'Allocated = segment bytes (measured). Estimated = NUM_ROWS × AVG_ROW_LEN from optimizer statistics (may be stale).'
    const dba = await panel(
      () =>
        rows(
          conn,
          `SELECT t.TABLE_NAME AS "table", t.NUM_ROWS AS "numRows", t.AVG_ROW_LEN AS "avgRowLen", t.NUM_ROWS * t.AVG_ROW_LEN AS "estimatedBytes",
                  TO_CHAR(t.LAST_ANALYZED, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastAnalyzed", t.PARTITIONED AS "partitioned",
                  NVL(ts.b, 0) AS "tableBytes", NVL(ts.ext, 0) AS "extents", NVL(ts.segs, 0) AS "segments",
                  NVL(ix.b, 0) AS "indexBytes", NVL(lb.b, 0) AS "lobBytes"
             FROM DBA_TABLES t
             LEFT JOIN (SELECT SEGMENT_NAME, SUM(BYTES) b, SUM(EXTENTS) ext, COUNT(*) segs FROM DBA_SEGMENTS
                         WHERE OWNER = :o AND SEGMENT_TYPE LIKE 'TABLE%' GROUP BY SEGMENT_NAME) ts ON ts.SEGMENT_NAME = t.TABLE_NAME
             LEFT JOIN (SELECT i.TABLE_NAME, SUM(s.BYTES) b FROM DBA_INDEXES i JOIN DBA_SEGMENTS s ON s.OWNER = i.OWNER AND s.SEGMENT_NAME = i.INDEX_NAME
                         WHERE i.OWNER = :o AND s.SEGMENT_TYPE LIKE 'INDEX%' GROUP BY i.TABLE_NAME) ix ON ix.TABLE_NAME = t.TABLE_NAME
             LEFT JOIN (SELECT l.TABLE_NAME, SUM(s.BYTES) b FROM DBA_LOBS l JOIN DBA_SEGMENTS s ON s.OWNER = l.OWNER AND s.SEGMENT_NAME IN (l.SEGMENT_NAME, l.INDEX_NAME)
                         WHERE l.OWNER = :o GROUP BY l.TABLE_NAME) lb ON lb.TABLE_NAME = t.TABLE_NAME
            WHERE t.OWNER = :o AND t.TABLE_NAME LIKE :p ESCAPE '\\'
            ORDER BY NVL(ts.b, 0) + NVL(ix.b, 0) + NVL(lb.b, 0) DESC`,
          { o: owner, p: like },
        ),
      DBA,
      note,
    )
    if (dba.status === 'ok') return dba
    return panel(
      () =>
        rows(
          conn,
          `SELECT t.TABLE_NAME AS "table", t.NUM_ROWS AS "numRows", t.AVG_ROW_LEN AS "avgRowLen", t.NUM_ROWS * t.AVG_ROW_LEN AS "estimatedBytes",
                  TO_CHAR(t.LAST_ANALYZED, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastAnalyzed", t.PARTITIONED AS "partitioned",
                  NVL(ts.b, 0) AS "tableBytes", NVL(ts.ext, 0) AS "extents", NVL(ts.segs, 0) AS "segments",
                  NVL(ix.b, 0) AS "indexBytes", NVL(lb.b, 0) AS "lobBytes"
             FROM USER_TABLES t
             LEFT JOIN (SELECT SEGMENT_NAME, SUM(BYTES) b, SUM(EXTENTS) ext, COUNT(*) segs FROM USER_SEGMENTS
                         WHERE SEGMENT_TYPE LIKE 'TABLE%' GROUP BY SEGMENT_NAME) ts ON ts.SEGMENT_NAME = t.TABLE_NAME
             LEFT JOIN (SELECT i.TABLE_NAME, SUM(s.BYTES) b FROM USER_INDEXES i JOIN USER_SEGMENTS s ON s.SEGMENT_NAME = i.INDEX_NAME
                         WHERE s.SEGMENT_TYPE LIKE 'INDEX%' GROUP BY i.TABLE_NAME) ix ON ix.TABLE_NAME = t.TABLE_NAME
             LEFT JOIN (SELECT l.TABLE_NAME, SUM(s.BYTES) b FROM USER_LOBS l JOIN USER_SEGMENTS s ON s.SEGMENT_NAME IN (l.SEGMENT_NAME, l.INDEX_NAME)
                         GROUP BY l.TABLE_NAME) lb ON lb.TABLE_NAME = t.TABLE_NAME
            WHERE t.TABLE_NAME LIKE :p ESCAPE '\\'
            ORDER BY NVL(ts.b, 0) + NVL(ix.b, 0) + NVL(lb.b, 0) DESC`,
          { p: like },
        ),
      DBA,
      `Limited view: DBA views not visible, showing the connected user's own schema (USER_*). ${note}`,
    )
  },

  segments: (conn, q) => {
    const owner = ident(q.owner ?? '', 'owner')
    return panel(
      () =>
        rows(
          conn,
          `SELECT * FROM (
             SELECT SEGMENT_NAME AS "segment", PARTITION_NAME AS "partition", SEGMENT_TYPE AS "type", TABLESPACE_NAME AS "tablespace",
                    BYTES AS "bytes", BLOCKS AS "blocks", EXTENTS AS "extents"
               FROM DBA_SEGMENTS WHERE OWNER = :o ORDER BY BYTES DESC)
            WHERE ROWNUM <= 200`,
          { o: owner },
        ),
      DBA,
    )
  },

  temp: (conn) =>
    panel(async () => {
      const space = await rows(
        conn,
        `SELECT TABLESPACE_NAME AS "tablespace", TABLESPACE_SIZE AS "sizeBytes", ALLOCATED_SPACE AS "allocatedBytes", FREE_SPACE AS "freeBytes"
           FROM DBA_TEMP_FREE_SPACE`,
      )
      const users = await rows(
        conn,
        `SELECT u.USERNAME AS "username", s.SID AS "sid", u.SQL_ID AS "sqlId", u.SEGTYPE AS "segtype", u.TABLESPACE AS "tablespace",
                u.BLOCKS * t.BLOCK_SIZE AS "bytes"
           FROM V$TEMPSEG_USAGE u JOIN V$SESSION s ON s.SADDR = u.SESSION_ADDR JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = u.TABLESPACE
          ORDER BY u.BLOCKS DESC`,
      )
      return { space, users }
    }, DBA),

  undo: (conn) =>
    panel(async () => {
      const extents = await rows(
        conn,
        `SELECT TABLESPACE_NAME AS "tablespace", STATUS AS "status", SUM(BYTES) AS "bytes", COUNT(*) AS "extents"
           FROM DBA_UNDO_EXTENTS GROUP BY TABLESPACE_NAME, STATUS ORDER BY 1, 2`,
      )
      const stat = await rows(
        conn,
        `SELECT * FROM (
           SELECT TO_CHAR(BEGIN_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "begin", TO_CHAR(END_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "end",
                  UNDOBLKS AS "undoBlocks", TXNCOUNT AS "txnCount", MAXQUERYLEN AS "maxQuerySeconds", MAXCONCURRENCY AS "maxConcurrency",
                  SSOLDERRCNT AS "snapshotTooOld", NOSPACEERRCNT AS "noSpace", TUNED_UNDORETENTION AS "tunedRetention"
             FROM V$UNDOSTAT ORDER BY BEGIN_TIME DESC)
          WHERE ROWNUM <= 144`,
      )
      return { extents, stat }
    }, DBA),

  history: async (_conn, _q, profileId) => {
    const hist = (await labStore().getItem<any[]>(`storage-history:${profileId}`)) ?? []
    return {
      status: 'ok',
      data: { snapshots: hist, forecast: capacityForecast(hist) },
      collectedAt: nowIso(),
      note: 'Snapshots are taken by this app at most every 15 minutes while the Storage page is open; forecast is a linear fit.',
    }
  },
}

export async function storagePanel(profileId: string, name: string, q: Q) {
  const fn = STORAGE_PANELS[name]
  if (!fn) throw createError({ statusCode: 404, statusMessage: `Unknown panel ${name}` })
  return withConnection(profileId, (conn) => fn(conn, q, profileId), { action: `storage:${name}`, callTimeoutMs: 120000 })
}

/** Linear growth fit per tablespace over stored snapshots -> days until the max size is reached. */
export function capacityForecast(hist: { ts: string; items: { name: string; used: number | null; max: number | null }[] }[]) {
  const by = new Map<string, { t: number; used: number; max: number | null }[]>()
  for (const h of hist) {
    for (const it of h.items) {
      if (it.used == null) continue
      const arr = by.get(it.name) ?? []
      arr.push({ t: Date.parse(h.ts) / 86400000, used: it.used, max: it.max })
      by.set(it.name, arr)
    }
  }
  const out = []
  for (const [name, pts] of by) {
    if (pts.length < 2 || pts[pts.length - 1]!.t - pts[0]!.t < 1 / 24) {
      out.push({ name, points: pts.length, bytesPerDay: null, daysToFull: null, note: 'Not enough history (need ≥ 2 snapshots over ≥ 1 hour)' })
      continue
    }
    const n = pts.length
    const mt = pts.reduce((a, p) => a + p.t, 0) / n
    const mu = pts.reduce((a, p) => a + p.used, 0) / n
    const cov = pts.reduce((a, p) => a + (p.t - mt) * (p.used - mu), 0)
    const vt = pts.reduce((a, p) => a + (p.t - mt) ** 2, 0)
    const slope = vt > 0 ? cov / vt : 0
    const last = pts[n - 1]!
    const daysToFull = slope > 0 && last.max ? Math.max(0, (last.max - last.used) / slope) : null
    out.push({ name, points: n, bytesPerDay: Math.round(slope), daysToFull: daysToFull != null ? Math.round(daysToFull * 10) / 10 : null, note: slope <= 0 ? 'No growth observed' : null })
  }
  return out
}

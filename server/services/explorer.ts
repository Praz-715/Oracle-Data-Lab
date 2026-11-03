import { cellValue } from './playground'
import { withConnection } from '../database/driver'
import { versionMajorOf } from '../database/environment'
import { ident, one, paginate, rows } from '../database/query'

// Table / schema explorer built on ALL_* views, so it shows exactly what the connected user can see.

export async function listSchemas(profileId: string) {
  return withConnection(profileId, (conn) =>
    rows<{ owner: string; tables: number; objects: number }>(
      conn,
      `SELECT o.OWNER AS "owner", SUM(CASE WHEN o.OBJECT_TYPE = 'TABLE' THEN 1 ELSE 0 END) AS "tables", COUNT(*) AS "objects"
         FROM ALL_OBJECTS o
        WHERE o.OWNER NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS','ORDSYS','ORDDATA','OLAPSYS','WMSYS','LBACSYS','DVSYS','GSMADMIN_INTERNAL',
                              'APPQOSSYS','DBSNMP','OUTLN','AUDSYS','OJVMSYS','DVF','ORACLE_OCM','REMOTE_SCHEDULER_AGENT','DBSFWUSER','GGSYS',
                              'ANONYMOUS','APEX_PUBLIC_USER','FLOWS_FILES','SI_INFORMTN_SCHEMA','EXFSYS','MGMT_VIEW','SYSMAN','ORDPLUGINS',
                              'PUBLIC','DIP','XS$NULL','GSMCATUSER','GSMUSER','SYSBACKUP','SYSDG','SYSKM','SYSRAC','SYS$UMF','VECSYS')
          AND o.OWNER NOT LIKE 'APEX\\_%' ESCAPE '\\'
        GROUP BY o.OWNER ORDER BY o.OWNER`,
    ),
  )
}

export async function objectInventory(profileId: string, ownerIn: string) {
  const owner = ident(ownerIn, 'owner')
  return withConnection(profileId, async (conn) => {
    const byType = await rows(
      conn,
      `SELECT OBJECT_TYPE AS "type", STATUS AS "status", COUNT(*) AS "count" FROM ALL_OBJECTS WHERE OWNER = :o
        GROUP BY OBJECT_TYPE, STATUS ORDER BY OBJECT_TYPE, STATUS`,
      { o: owner },
    )
    const objects = await rows(
      conn,
      `SELECT * FROM (SELECT OBJECT_NAME AS "name", OBJECT_TYPE AS "type", STATUS AS "status",
              TO_CHAR(CREATED, 'YYYY-MM-DD"T"HH24:MI:SS') AS "created", TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastDdl"
         FROM ALL_OBJECTS WHERE OWNER = :o AND OBJECT_TYPE NOT IN ('LOB', 'INDEX PARTITION', 'TABLE PARTITION', 'LOB PARTITION')
        ORDER BY OBJECT_TYPE, OBJECT_NAME) WHERE ROWNUM <= 5000`,
      { o: owner },
    )
    const invalid = await rows(
      conn,
      `SELECT NAME AS "name", TYPE AS "type", LINE AS "line", POSITION AS "position", TEXT AS "text"
         FROM ALL_ERRORS WHERE OWNER = :o ORDER BY NAME, SEQUENCE`,
      { o: owner },
    )
    return { owner, byType, objects, errors: invalid }
  })
}

export async function listTables(profileId: string, ownerIn: string) {
  const owner = ident(ownerIn, 'owner')
  return withConnection(profileId, (conn) =>
    rows(
      conn,
      `SELECT t.TABLE_NAME AS "table", t.NUM_ROWS AS "numRows", t.BLOCKS AS "blocks", t.AVG_ROW_LEN AS "avgRowLen",
              TO_CHAR(t.LAST_ANALYZED, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastAnalyzed", t.PARTITIONED AS "partitioned",
              t.TABLESPACE_NAME AS "tablespace", t.TEMPORARY AS "temporary", c.COMMENTS AS "comment"
         FROM ALL_TABLES t LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
        WHERE t.OWNER = :o AND t.NESTED = 'NO' AND t.TABLE_NAME NOT LIKE 'BIN$%'
        ORDER BY t.TABLE_NAME`,
      { o: owner },
    ),
  )
}

export async function tableDetail(profileId: string, ownerIn: string, tableIn: string) {
  const owner = ident(ownerIn, 'owner')
  const table = ident(tableIn, 'table')
  return withConnection(profileId, async (conn) => {
    const b = { o: owner, t: table }
    const info = await one(
      conn,
      `SELECT TABLE_NAME AS "table", NUM_ROWS AS "numRows", BLOCKS AS "blocks", AVG_ROW_LEN AS "avgRowLen", PARTITIONED AS "partitioned",
              TABLESPACE_NAME AS "tablespace", COMPRESSION AS "compression", LOGGING AS "logging",
              TO_CHAR(LAST_ANALYZED, 'YYYY-MM-DD"T"HH24:MI:SS') AS "lastAnalyzed"
         FROM ALL_TABLES WHERE OWNER = :o AND TABLE_NAME = :t`,
      b,
    )
    if (!info) throw createError({ statusCode: 404, statusMessage: `${owner}.${table} not found or not visible` })
    const columns = await rows(
      conn,
      `SELECT c.COLUMN_ID AS "id", c.COLUMN_NAME AS "name", c.DATA_TYPE AS "dataType", c.DATA_LENGTH AS "length", c.DATA_PRECISION AS "precision",
              c.DATA_SCALE AS "scale", c.NULLABLE AS "nullable", c.NUM_DISTINCT AS "distinct", c.NUM_NULLS AS "nulls", c.CHAR_LENGTH AS "charLength",
              cc.COMMENTS AS "comment"
         FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cc ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.OWNER = :o AND c.TABLE_NAME = :t ORDER BY c.COLUMN_ID`,
      b,
    )
    const constraints = await rows(
      conn,
      `SELECT c.CONSTRAINT_NAME AS "name", c.CONSTRAINT_TYPE AS "type", c.STATUS AS "status", c.VALIDATED AS "validated",
              c.R_OWNER AS "refOwner", r.TABLE_NAME AS "refTable", c.SEARCH_CONDITION AS "condition",
              (SELECT LISTAGG(cc.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY cc.POSITION) FROM ALL_CONS_COLUMNS cc
                WHERE cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME) AS "columns"
         FROM ALL_CONSTRAINTS c LEFT JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
        WHERE c.OWNER = :o AND c.TABLE_NAME = :t
          AND NOT (c.CONSTRAINT_TYPE = 'C' AND c.CONSTRAINT_NAME LIKE 'SYS\\_C%' ESCAPE '\\')
        ORDER BY DECODE(c.CONSTRAINT_TYPE, 'P', 1, 'U', 2, 'R', 3, 4), c.CONSTRAINT_NAME`,
      b,
    )
    const indexes = await rows(
      conn,
      `SELECT i.INDEX_NAME AS "name", i.INDEX_TYPE AS "type", i.UNIQUENESS AS "uniqueness", i.STATUS AS "status", i.PARTITIONED AS "partitioned",
              i.BLEVEL AS "blevel", i.LEAF_BLOCKS AS "leafBlocks", i.DISTINCT_KEYS AS "distinctKeys", i.CLUSTERING_FACTOR AS "clusteringFactor",
              i.COMPRESSION AS "compression", p.LOCALITY AS "locality",
              (SELECT LISTAGG(ic.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) FROM ALL_IND_COLUMNS ic
                WHERE ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME) AS "columns"
         FROM ALL_INDEXES i LEFT JOIN ALL_PART_INDEXES p ON p.OWNER = i.OWNER AND p.INDEX_NAME = i.INDEX_NAME
        WHERE i.TABLE_OWNER = :o AND i.TABLE_NAME = :t ORDER BY i.INDEX_NAME`,
      b,
    )
    const partitions = await rows(
      conn,
      `SELECT * FROM (SELECT PARTITION_NAME AS "name", PARTITION_POSITION AS "position", HIGH_VALUE AS "highValue", NUM_ROWS AS "numRows",
              TABLESPACE_NAME AS "tablespace" FROM ALL_TAB_PARTITIONS WHERE TABLE_OWNER = :o AND TABLE_NAME = :t ORDER BY PARTITION_POSITION)
        WHERE ROWNUM <= 500`,
      b,
    )
    const partInfo = await one(
      conn,
      `SELECT PARTITIONING_TYPE AS "type", SUBPARTITIONING_TYPE AS "subType", PARTITION_COUNT AS "count", INTERVAL AS "interval"
         FROM ALL_PART_TABLES WHERE OWNER = :o AND TABLE_NAME = :t`,
      b,
    ).catch(() => null)
    const triggers = await rows(
      conn,
      `SELECT TRIGGER_NAME AS "name", TRIGGER_TYPE AS "type", TRIGGERING_EVENT AS "event", STATUS AS "status"
         FROM ALL_TRIGGERS WHERE TABLE_OWNER = :o AND TABLE_NAME = :t`,
      b,
    )
    return { owner, ...info, columns, constraints, indexes, partitions, partitioning: partInfo, triggers }
  })
}

const SAMPLEABLE = /^(NUMBER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE|VARCHAR2|NVARCHAR2|CHAR|NCHAR|DATE|TIMESTAMP.*|RAW|CLOB|NCLOB|BLOB|INTERVAL.*)$/

export async function tableRows(profileId: string, ownerIn: string, tableIn: string, page: number, pageSize: number) {
  const owner = ident(ownerIn, 'owner')
  const table = ident(tableIn, 'table')
  const size = Math.min(Math.max(pageSize, 1), 200)
  return withConnection(profileId, async (conn) => {
    const cols = await rows<{ name: string; type: string }>(
      conn,
      `SELECT COLUMN_NAME AS "name", DATA_TYPE AS "type" FROM ALL_TAB_COLUMNS WHERE OWNER = :o AND TABLE_NAME = :t ORDER BY COLUMN_ID`,
      { o: owner, t: table },
    )
    if (!cols.length) throw createError({ statusCode: 404, statusMessage: 'Table not found or not visible' })
    // LOBs are previewed, never streamed in full; unsupported types are shown as their type name.
    const select = cols.map((c) => {
      const q = `"${c.name.replace(/"/g, '')}"`
      if (c.type === 'CLOB' || c.type === 'NCLOB') return `DBMS_LOB.SUBSTR(${q}, 200, 1) AS ${q}`
      if (c.type === 'BLOB') return `'(BLOB ' || DBMS_LOB.GETLENGTH(${q}) || ' bytes)' AS ${q}`
      if (c.type === 'RAW') return `RAWTOHEX(${q}) AS ${q}`
      if (!SAMPLEABLE.test(c.type)) return `'(${c.type.replace(/'/g, '')})' AS ${q}`
      return q
    })
    const order = cols[0] ? `"${cols[0].name}"` : '1'
    const base = `SELECT ${select.join(', ')} FROM "${owner}"."${table}" ORDER BY ${order}`
    const vm = versionMajorOf(conn)
    const data = await rows<Record<string, unknown>>(conn, paginate(base, vm), { off: (page - 1) * size, lim: size })
    // DATE/TIMESTAMP values arrive as JS Dates in the server zone; send the database wall clock as text
    // (JSON would turn them into UTC ISO strings, shifted by the server's offset).
    const out = data.map((r) => {
      delete r.RN_
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? cellValue(v) : v]))
    })
    return { columns: cols, rows: out, page, pageSize: size }
  }, { callTimeoutMs: 30000 })
}

export async function exactCount(profileId: string, ownerIn: string, tableIn: string) {
  const owner = ident(ownerIn, 'owner')
  const table = ident(tableIn, 'table')
  return withConnection(profileId, async (conn) => {
    const t0 = performance.now()
    const r = await one<{ n: number }>(conn, `SELECT COUNT(*) AS "n" FROM "${owner}"."${table}"`)
    return { count: Number(r?.n ?? 0), elapsedMs: Math.round(performance.now() - t0) }
  }, { callTimeoutMs: 300000 })
}

export async function objectDdl(profileId: string, ownerIn: string, nameIn: string, typeIn: string) {
  const owner = ident(ownerIn, 'owner')
  const name = ident(nameIn, 'name')
  const type = typeIn.toUpperCase().replace(/ /g, '_')
  if (!/^(TABLE|VIEW|INDEX|SEQUENCE|SYNONYM|PACKAGE|PACKAGE_BODY|PROCEDURE|FUNCTION|TRIGGER|MATERIALIZED_VIEW|TYPE)$/.test(type)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported object type' })
  }
  return withConnection(profileId, async (conn) => {
    await conn.execute(
      `BEGIN
         DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
         DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE);
         DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
       END;`,
    )
    const r = await one<{ ddl: string }>(conn, `SELECT DBMS_METADATA.GET_DDL(:t, :n, :o) AS "ddl" FROM DUAL`, { t: type, n: name, o: owner })
    return { ddl: r?.ddl ?? '' }
  })
}

export async function dependencies(profileId: string, ownerIn: string) {
  const owner = ident(ownerIn, 'owner')
  return withConnection(profileId, (conn) =>
    rows(
      conn,
      `SELECT * FROM (SELECT NAME AS "name", TYPE AS "type", REFERENCED_OWNER AS "refOwner", REFERENCED_NAME AS "refName",
              REFERENCED_TYPE AS "refType", DEPENDENCY_TYPE AS "depType"
         FROM ALL_DEPENDENCIES WHERE OWNER = :o AND REFERENCED_OWNER NOT IN ('SYS', 'PUBLIC')
        ORDER BY NAME, REFERENCED_NAME) WHERE ROWNUM <= 3000`,
      { o: owner },
    ),
  )
}

/** Tables + FK edges for the ERD. Optional prefix filter keeps large schemas readable. */
export async function erd(profileId: string, ownerIn: string, prefix?: string) {
  const owner = ident(ownerIn, 'owner')
  const like = prefix ? `${ident(prefix, 'prefix').replace(/_/g, '\\_')}%` : '%'
  return withConnection(profileId, async (conn) => {
    const tables = await rows<{ table: string; numRows: number | null }>(
      conn,
      `SELECT * FROM (SELECT TABLE_NAME AS "table", NUM_ROWS AS "numRows" FROM ALL_TABLES
         WHERE OWNER = :o AND TABLE_NAME LIKE :p ESCAPE '\\' AND NESTED = 'NO' AND TABLE_NAME NOT LIKE 'BIN$%' ORDER BY TABLE_NAME) WHERE ROWNUM <= 400`,
      { o: owner, p: like },
    )
    const pkCols = await rows<{ table: string; column: string }>(
      conn,
      `SELECT cc.TABLE_NAME AS "table", cc.COLUMN_NAME AS "column" FROM ALL_CONSTRAINTS c
         JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
        WHERE c.OWNER = :o AND c.CONSTRAINT_TYPE = 'P' AND c.TABLE_NAME LIKE :p ESCAPE '\\' ORDER BY cc.TABLE_NAME, cc.POSITION`,
      { o: owner, p: like },
    )
    const edges = await rows<{ name: string; from: string; to: string; columns: string }>(
      conn,
      `SELECT c.CONSTRAINT_NAME AS "name", c.TABLE_NAME AS "from", r.TABLE_NAME AS "to",
              (SELECT LISTAGG(cc.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY cc.POSITION) FROM ALL_CONS_COLUMNS cc
                WHERE cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME) AS "columns"
         FROM ALL_CONSTRAINTS c JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
        WHERE c.OWNER = :o AND c.CONSTRAINT_TYPE = 'R' AND c.TABLE_NAME LIKE :p ESCAPE '\\'`,
      { o: owner, p: like },
    )
    const pk = new Map<string, string[]>()
    for (const r of pkCols) pk.set(r.table, [...(pk.get(r.table) ?? []), r.column])
    const names = new Set(tables.map((t) => t.table))
    return {
      tables: tables.map((t) => ({ ...t, pk: pk.get(t.table) ?? [] })),
      edges: edges.filter((e) => names.has(e.from) && names.has(e.to)),
      truncated: tables.length >= 400,
    }
  })
}

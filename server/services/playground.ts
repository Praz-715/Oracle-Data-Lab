import type { Connection } from 'oracledb'
import { z } from 'zod'
import type { PlaygroundRun, RunStats, SavedQuery } from '../../shared/types/lab'
import { oracledb, withConnection } from '../database/driver'
import { oracleErrorInfo } from '../database/errors'
import { ident, one, rows } from '../database/query'
import { bindNames } from '../../shared/utils/sql'
import { assertSelectOnly } from './tuning'

export { bindNames }

// SQL Playground: run one SELECT/WITH at a time inside a READ ONLY transaction, in any schema's
// name resolution context, with bind variables. Each run returns the rows, the actual plan
// (DBMS_XPLAN 'ALLSTATS LAST': real rows and buffers per step) and the session statistics deltas
// (logical/physical reads, CPU, sorts…) — the autotrace view used to compare query versions.
// Pool sessions are restored afterwards (schema, statistics level, transaction).

export const STAT_NAMES = [
  'session logical reads',
  'consistent gets',
  'db block gets',
  'physical reads',
  'CPU used by this session',
  'sorts (memory)',
  'sorts (disk)',
  'redo size',
  'parse count (hard)',
  'bytes sent via SQL*Net to client',
  'SQL*Net roundtrips to/from client',
] as const

export const runSchema = z.object({
  profileId: z.string().min(1),
  sql: z.string().trim().min(1).max(50_000),
  schema: z.string().trim().max(128).nullable().optional(),
  binds: z.record(z.string(), z.string().max(4000)).default({}),
  maxRows: z.coerce.number().int().min(1).max(5000).default(200),
  actualPlan: z.boolean().default(true),
})

/**
 * Empty → NULL, everything else bound as a string. A string bind compared with a NUMBER column is
 * converted once (TO_NUMBER(:b)); a NUMBER bind compared with a VARCHAR2 column would convert the
 * column on every row (TO_NUMBER(col)), disabling its index and failing on non-numeric values.
 */
export function coerceBinds(names: string[], values: Record<string, string>) {
  const out: Record<string, string | null> = {}
  for (const n of names) {
    const key = Object.keys(values).find((k) => k.toUpperCase() === n.toUpperCase())
    const v = key != null ? values[key]! : ''
    out[n] = v === '' ? null : v
  }
  return out
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** JSON-safe cell. DATE/TIMESTAMP come back as JS Dates in the server's zone: format that wall clock. */
export function cellValue(v: unknown): string | number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) {
    const base = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`
    return v.getMilliseconds() ? `${base}.${pad(v.getMilliseconds(), 3)}` : base
  }
  if (Buffer.isBuffer(v)) return `0x${v.subarray(0, 32).toString('hex').toUpperCase()}${v.length > 32 ? `… (${v.length} bytes)` : ''}`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export async function myStats(conn: Connection): Promise<RunStats | null> {
  try {
    const r = await rows<{ N: string; V: number }>(
      conn,
      `SELECT n.NAME AS "N", m.VALUE AS "V" FROM V$MYSTAT m JOIN V$STATNAME n ON n.STATISTIC# = m.STATISTIC# WHERE n.NAME IN (${STAT_NAMES.map((_, i) => `:s${i}`).join(', ')})`,
      Object.fromEntries(STAT_NAMES.map((s, i) => [`s${i}`, s])),
    )
    return Object.fromEntries(r.map((x) => [x.N, Number(x.V)]))
  } catch {
    return null
  }
}

export function statDelta(a: RunStats | null, b: RunStats | null, overhead?: RunStats | null): RunStats | null {
  if (!a || !b) return null
  return Object.fromEntries(Object.keys(b).map((k) => [k, Math.max(0, (b[k] ?? 0) - (a[k] ?? 0) - (overhead?.[k] ?? 0))]))
}

/**
 * Runs fn in a READ ONLY transaction with CURRENT_SCHEMA set, restoring the pooled session after.
 */
export async function inSchema<T>(conn: Connection, schema: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  const me = (await one<{ U: string }>(conn, `SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') AS "U" FROM DUAL`))!.U
  const target = schema ? ident(schema, 'schema') : null
  try {
    if (target && target !== me) await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${target}`)
    return await fn()
  } finally {
    await conn.rollback().catch(() => {})
    if (target && target !== me) await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${ident(me)}`).catch(() => {})
  }
}

/** Plan text + hash of a cursor, with actual statistics when STATISTICS_LEVEL=ALL was on. */
async function cursorPlan(conn: Connection, sqlId: string, child: number, format: string) {
  const lines = await rows<{ L: string }>(conn, `SELECT PLAN_TABLE_OUTPUT AS "L" FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:id, :c, :f))`, { id: sqlId, c: child, f: format })
  return lines.map((l) => l.L).join('\n')
}

export async function explainText(conn: Connection, sql: string): Promise<string> {
  const stmt = `ODLP${Date.now().toString(36)}`.toUpperCase()
  await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${stmt}' FOR ${sql}`)
  const lines = await rows<{ L: string }>(conn, `SELECT PLAN_TABLE_OUTPUT AS "L" FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :s, 'TYPICAL'))`, { s: stmt })
  await conn.rollback()
  return lines.map((l) => l.L).join('\n')
}

export async function runPlayground(input: z.infer<typeof runSchema>): Promise<PlaygroundRun> {
  const sql = assertSelectOnly(input.sql)
  const binds = coerceBinds(bindNames(sql), input.binds)
  return withConnection(
    input.profileId,
    (conn) =>
      inSchema(conn, input.schema, async () => {
        // Overhead of reading V$MYSTAT itself, subtracted from the measured delta.
        const o0 = await myStats(conn)
        const o1 = await myStats(conn)
        const overhead = statDelta(o0, o1)
        if (input.actualPlan) await conn.execute(`ALTER SESSION SET STATISTICS_LEVEL = ALL`).catch(() => {})
        await conn.execute('SET TRANSACTION READ ONLY')
        const s0 = await myStats(conn)
        const t0 = performance.now()
        let res
        try {
          res = await conn.execute<unknown[]>(sql, binds, {
            maxRows: input.maxRows + 1,
            // Re-parse every run so STATISTICS_LEVEL=ALL (actual plan statistics) always applies.
            keepInStmtCache: false,
            outFormat: oracledb.OUT_FORMAT_ARRAY,
            fetchTypeHandler: (meta) => (meta.dbType === oracledb.DB_TYPE_BLOB ? { type: oracledb.BUFFER } : undefined),
          })
        } catch (err) {
          const i = oracleErrorInfo(err)
          throw createError({ statusCode: 400, statusMessage: `${i.code}: ${i.message}`, data: { code: i.code } })
        }
        const elapsedMs = Math.round((performance.now() - t0) * 1000) / 1000
        const s1 = await myStats(conn)
        // The cursor that just ran: same text (first 1000 chars), parsed in this schema, most recently
        // active child. (V$SESSION.PREV_SQL_ID is not reliable once the statement cache is bypassed.)
        const cur = await one<{ ID: string | null; CH: number | null }>(
          conn,
          `SELECT * FROM (
             SELECT SQL_ID AS "ID", CHILD_NUMBER AS "CH" FROM V$SQL
              WHERE SQL_TEXT = :t AND PARSING_SCHEMA_NAME = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
              ORDER BY LAST_ACTIVE_TIME DESC, CHILD_NUMBER DESC)
            WHERE ROWNUM = 1`,
          // SQL_TEXT stores line breaks and tabs as spaces (SQL_FULLTEXT keeps the original).
          { t: sql.replace(/[\r\n\t]/g, ' ').slice(0, 1000) },
        ).catch(() => null)
        if (input.actualPlan) await conn.execute(`ALTER SESSION SET STATISTICS_LEVEL = TYPICAL`).catch(() => {})
        const all = (res.rows ?? []) as unknown[][]
        const truncated = all.length > input.maxRows
        let plan: string | null = null
        let planKind: PlaygroundRun['planKind'] = null
        let planHash: number | null = null
        if (cur?.ID) {
          try {
            plan = await cursorPlan(conn, cur.ID, Number(cur.CH ?? 0), input.actualPlan ? 'ALLSTATS LAST +PEEKED_BINDS' : 'TYPICAL')
            planKind = input.actualPlan ? 'actual' : 'estimated'
            planHash = Number(/Plan hash value: (\d+)/.exec(plan)?.[1] ?? 0) || null
          } catch {
            plan = null
          }
        }
        if (!plan) {
          try {
            // Leave the READ ONLY transaction first: EXPLAIN PLAN writes to PLAN_TABLE.
            await conn.rollback()
            plan = await explainText(conn, sql)
            planKind = 'estimated'
          } catch {
            plan = null
          }
        }
        const stats = statDelta(s0, s1, overhead)
        return {
          sqlId: cur?.ID ?? null,
          childNumber: cur?.CH ?? null,
          planHash,
          columns: (res.metaData ?? []).map((m) => ({ name: m.name, type: m.dbTypeName ?? String(m.dbType) })),
          rows: all.slice(0, input.maxRows).map((r) => r.map(cellValue)),
          rowCount: Math.min(all.length, input.maxRows),
          truncated,
          elapsedMs,
          plan,
          planKind,
          stats,
          statsNote: stats
            ? truncated
              ? `Fetched only the first ${input.maxRows} rows, so the actual plan statistics cover a partial execution.`
              : null
            : 'Session statistics need SELECT on V$MYSTAT and V$STATNAME (SELECT_CATALOG_ROLE).',
          ranAt: nowIso(),
        }
      }),
    { action: 'playground', callTimeoutMs: 300000 },
  )
}

// ---------------------------------------------------------------------------------------------
// Saved queries
// ---------------------------------------------------------------------------------------------

export const savedSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  sql: z.string().trim().min(1).max(50_000),
  schema: z.string().trim().max(128).nullable().default(null),
  binds: z.record(z.string(), z.string().max(4000)).default({}),
})

export async function listSaved(): Promise<SavedQuery[]> {
  const store = labStore()
  const keys = await store.getKeys('playground')
  const items = await Promise.all(keys.map((k) => store.getItem<SavedQuery>(k)))
  return items.filter((x): x is SavedQuery => !!x).sort((a, b) => a.name.localeCompare(b.name))
}

export async function saveQuery(input: z.infer<typeof savedSchema>): Promise<SavedQuery> {
  const q: SavedQuery = { id: input.id || newId(), name: input.name, sql: input.sql, schema: input.schema, binds: input.binds, updatedAt: nowIso() }
  await labStore().setItem(`playground:${q.id}`, q)
  return q
}

export async function deleteSaved(id: string) {
  await labStore().removeItem(`playground:${id}`)
}

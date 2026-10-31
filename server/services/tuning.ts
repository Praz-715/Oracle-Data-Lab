import { createError } from 'h3'
import { z } from 'zod'
import type { Connection } from 'oracledb'
import { withConnection } from '../database/driver'
import { oracleErrorInfo } from '../database/errors'
import { rows } from '../database/query'

// SQL Tuning Workbench helpers that work without the Tuning/Diagnostics packs:
// EXPLAIN PLAN, timed read-only executions for before/after comparison, and heuristic index hints.

export const adhocSqlSchema = z.object({
  profileId: z.string().min(1),
  sql: z.string().trim().min(1).max(20_000),
  runs: z.coerce.number().int().min(1).max(20).default(3),
  label: z.string().trim().max(80).default(''),
})

/** Only a single SELECT/WITH statement is accepted; it runs inside a READ ONLY transaction. */
export function assertSelectOnly(sqlIn: string): string {
  const sql = sqlIn.trim().replace(/;\s*$/, '')
  const stripped = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim()
  if (!/^(SELECT|WITH)\b/i.test(stripped)) throw createError({ statusCode: 400, statusMessage: 'Only SELECT / WITH queries are allowed here.' })
  if (/;/.test(stripped.replace(/'[^']*'/g, "''"))) throw createError({ statusCode: 400, statusMessage: 'Submit a single statement (no ";").' })
  if (/\bFOR\s+UPDATE\b/i.test(stripped)) throw createError({ statusCode: 400, statusMessage: 'SELECT ... FOR UPDATE is not allowed.' })
  return sql
}

interface PlanLine {
  id: number
  parentId: number | null
  operation: string
  options: string | null
  object: string | null
  owner: string | null
  cost: number | null
  cardinality: number | null
  bytes: number | null
  access: string | null
  filter: string | null
}

async function explain(conn: Connection, sql: string) {
  const stmtId = `ODL${Date.now().toString(36)}`.toUpperCase()
  await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${stmtId}' FOR ${sql}`)
  const text = await rows<{ l: string }>(conn, `SELECT PLAN_TABLE_OUTPUT AS "l" FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :s, 'TYPICAL'))`, { s: stmtId })
  const lines = await rows<PlanLine>(
    conn,
    `SELECT ID AS "id", PARENT_ID AS "parentId", OPERATION AS "operation", OPTIONS AS "options", OBJECT_NAME AS "object",
            OBJECT_OWNER AS "owner", COST AS "cost", CARDINALITY AS "cardinality", BYTES AS "bytes",
            ACCESS_PREDICATES AS "access", FILTER_PREDICATES AS "filter"
       FROM PLAN_TABLE WHERE STATEMENT_ID = :s ORDER BY ID`,
    { s: stmtId },
  )
  await conn.rollback()
  return { text: text.map((t) => t.l).join('\n'), lines }
}

/** Heuristic: full scans with filter predicates on large tables suggest an index on the filtered columns. */
export function indexSuggestions(lines: PlanLine[], tableRows: Map<string, number>) {
  const out: { table: string; columns: string[]; reason: string; ddl: string }[] = []
  for (const l of lines) {
    if (l.operation !== 'TABLE ACCESS' || !/FULL/.test(l.options ?? '') || !l.object || !l.filter) continue
    const rowsTotal = tableRows.get(`${l.owner}.${l.object}`) ?? null
    if (rowsTotal != null && rowsTotal < 10_000) continue
    const cols = [...new Set([...l.filter.matchAll(/"([A-Z0-9_$#]+)"\s*(?:=|<=|>=|<|>|LIKE|IN\b|BETWEEN)/g)].map((m) => m[1]!))]
      .filter((c) => c !== l.object)
      .slice(0, 3)
    if (!cols.length) continue
    const est = l.cardinality != null && rowsTotal ? ` (est. ${l.cardinality} of ${rowsTotal.toLocaleString()} rows)` : ''
    out.push({
      table: `${l.owner}.${l.object}`,
      columns: cols,
      reason: `Full scan filtered on ${cols.join(', ')}${est}. An index helps only if the predicate is selective.`,
      ddl: `CREATE INDEX ${l.owner}.${l.object.slice(0, 18)}_${cols[0]!.slice(0, 6)}_IX ON ${l.owner}.${l.object} (${cols.join(', ')})`,
    })
  }
  return out
}

export async function explainAdhoc(profileId: string, sqlIn: string) {
  const sql = assertSelectOnly(sqlIn)
  return withConnection(profileId, async (conn) => {
    const plan = await explain(conn, sql)
    const objs = [...new Set(plan.lines.filter((l) => l.object && l.owner).map((l) => `${l.owner}.${l.object}`))]
    const sizes = new Map<string, number>()
    for (const o of objs) {
      const [owner, name] = o.split('.')
      const r = await rows<{ n: number }>(conn, `SELECT NUM_ROWS AS "n" FROM ALL_TABLES WHERE OWNER = :o AND TABLE_NAME = :t`, { o: owner, t: name })
      if (r[0]?.n != null) sizes.set(o, Number(r[0].n))
    }
    return { ...plan, suggestions: indexSuggestions(plan.lines, sizes) }
  }, { action: 'tuning:explain' })
}

/** Executes the query N times in a READ ONLY transaction and reports timings (first run includes parse). */
export async function measureAdhoc(profileId: string, sqlIn: string, runs: number) {
  const sql = assertSelectOnly(sqlIn)
  return withConnection(profileId, async (conn) => {
    const timings: { run: number; ms: number; rows: number }[] = []
    try {
      await conn.execute('SET TRANSACTION READ ONLY')
      for (let i = 1; i <= runs; i++) {
        const t0 = performance.now()
        const r = await conn.execute(sql, {}, { maxRows: 5000 })
        timings.push({ run: i, ms: Math.round((performance.now() - t0) * 1000) / 1000, rows: r.rows?.length ?? 0 })
      }
    } catch (err) {
      const info = oracleErrorInfo(err)
      throw createError({ statusCode: 400, statusMessage: `${info.code}: ${info.message}` })
    } finally {
      await conn.rollback().catch(() => {})
    }
    const ms = timings.map((t) => t.ms).sort((a, b) => a - b)
    return {
      timings,
      minMs: ms[0] ?? 0,
      medianMs: ms[Math.floor(ms.length / 2)] ?? 0,
      maxMs: ms[ms.length - 1] ?? 0,
      rowsFetched: timings[0]?.rows ?? 0,
      note: 'Client-observed elapsed time incl. network and fetch of up to 5000 rows. Run 1 includes parsing.',
    }
  }, { action: 'tuning:measure', callTimeoutMs: 300000 })
}

// ---------------------------------------------------------------------------
// ORA error & alert analyzer (module 19): groups error codes in pasted text or alert-log rows.
// ---------------------------------------------------------------------------

const ORA_GUIDE: Record<string, string> = {
  'ORA-00060': 'Deadlock detected: check the trace file for the two sessions and the rows involved; fix lock ordering in the application.',
  'ORA-00600': 'Internal error: collect the incident (ADRCI), search My Oracle Support with the first argument.',
  'ORA-07445': 'OS exception in Oracle code: collect the incident and check for a matching bug/patch.',
  'ORA-01555': 'Snapshot too old: undo retention too short for long queries, or undo tablespace too small.',
  'ORA-01653': 'Unable to extend table: tablespace full. Add a datafile or enable autoextend.',
  'ORA-01654': 'Unable to extend index: tablespace full.',
  'ORA-01652': 'Unable to extend temp segment: TEMP is full or a query spills heavily.',
  'ORA-04031': 'Shared pool memory exhausted: check for literal SQL (no binds) and shared pool sizing.',
  'ORA-04030': 'Process (PGA) memory exhausted: check PGA_AGGREGATE_LIMIT and the offending session.',
  'ORA-00257': 'Archiver stuck: the archive destination / FRA is full.',
  'ORA-19809': 'Recovery area limit exceeded: free space in the FRA (RMAN DELETE OBSOLETE) or increase DB_RECOVERY_FILE_DEST_SIZE.',
  'ORA-16038': 'Log cannot be archived: check archive destinations and space.',
  'ORA-12170': 'Connect timeout: network or firewall issue between client and listener.',
  'ORA-03113': 'End-of-file on communication channel: the server process died or the network dropped.',
  'ORA-01017': 'Invalid username/password: repeated entries may indicate a misconfigured client or a brute-force attempt.',
  'ORA-28000': 'Account locked.',
  'ORA-00020': 'Maximum number of processes exceeded: raise PROCESSES or fix connection leaks / pool sizing.',
  'ORA-00018': 'Maximum number of sessions exceeded.',
  'ORA-01031': 'Insufficient privileges.',
  'ORA-00942': 'Table or view does not exist (or no privilege).',
  'ORA-01400': 'Cannot insert NULL into a NOT NULL column.',
  'ORA-00001': 'Unique constraint violated.',
  'ORA-02291': 'Integrity constraint violated: parent key not found.',
  'ORA-02292': 'Integrity constraint violated: child record found.',
}

export function analyzeErrors(lines: { ts?: string | null; text: string }[]) {
  const groups = new Map<string, { code: string; count: number; first: string | null; last: string | null; samples: string[] }>()
  for (const l of lines) {
    for (const m of l.text.matchAll(/\b(ORA|TNS)-(\d{5})\b/g)) {
      const code = `${m[1]}-${m[2]}`
      const g = groups.get(code) ?? { code, count: 0, first: null, last: null, samples: [] }
      g.count++
      if (l.ts) {
        if (!g.first || l.ts < g.first) g.first = l.ts
        if (!g.last || l.ts > g.last) g.last = l.ts
      }
      if (g.samples.length < 3) g.samples.push(l.text.slice(0, 300))
      groups.set(code, g)
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => ({ ...g, guidance: ORA_GUIDE[g.code] ?? null }))
}

export function parseAlertText(text: string) {
  // Alert logs put a timestamp line before each message block; carry it onto the following lines.
  const out: { ts: string | null; text: string }[] = []
  let ts: string | null = null
  for (const raw of text.split(/\r?\n/).slice(0, 200_000)) {
    const line = raw.trim()
    if (!line) continue
    const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(line)
    const classic = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(line)
    if (iso) ts = iso[1]!
    else if (classic) {
      const d = new Date(`${classic[1]} ${classic[2]} ${classic[4]} ${classic[3]}`)
      ts = Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 19)
    }
    out.push({ ts, text: line })
  }
  return out
}

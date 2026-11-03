import { createHash } from 'node:crypto'
import type { Connection } from 'oracledb'
import { z } from 'zod'
import type { AdvisorIndex, AdvisorResult, IndexTestResult, RunMetrics } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { oracleErrorInfo } from '../database/errors'
import { ident, one, rows } from '../database/query'
import { buildAdvice, type PlanRow, type TableInfo } from '../tuning/advisor'
import { bindNames, coerceBinds, inSchema, myStats, statDelta } from './playground'
import { assertWritable, getProfile } from './profiles'
import { assertSelectOnly } from './tuning'

// Index Advisor service: EXPLAIN PLAN + dictionary statistics → candidates (server/tuning/advisor.ts).
// "Test" creates the candidate as an INVISIBLE index (only this session sees it, via
// OPTIMIZER_USE_INVISIBLE_INDEXES), measures the query before and after, and leaves the decision to
// keep (make visible) or drop it to the user. Only authorized lab schemas can get test indexes, and
// only indexes created here (prefix ODLX_) can be altered or dropped from the app.

export const analyzeSchema = z.object({
  profileId: z.string().min(1),
  sql: z.string().trim().min(1).max(50_000),
  schema: z.string().trim().max(128).nullable().optional(),
})

export const testSchema = analyzeSchema.extend({
  binds: z.record(z.string(), z.string().max(4000)).default({}),
  owner: z.string().trim().min(1).max(128),
  table: z.string().trim().min(1).max(128),
  columns: z.array(z.string().trim().min(1).max(128)).min(1).max(8),
  runs: z.coerce.number().int().min(1).max(10).default(3),
})

export const indexActionSchema = z.object({
  profileId: z.string().min(1),
  owner: z.string().min(1).max(128),
  name: z.string().regex(/^ODLX_[A-Z0-9_$#]+$/),
  action: z.enum(['keep', 'hide', 'drop']),
})

interface ExplainOut {
  rows: PlanRow[]
  text: string
  cost: number | null
  planHash: number | null
}

async function explainRows(conn: Connection, sql: string): Promise<ExplainOut> {
  const stmt = `ODLA${Date.now().toString(36)}`.toUpperCase()
  try {
    await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${stmt}' FOR ${sql}`)
  } catch (err) {
    const i = oracleErrorInfo(err)
    throw createError({ statusCode: 400, statusMessage: `${i.code}: ${i.message}` })
  }
  const r = await rows<PlanRow>(
    conn,
    `SELECT ID AS "id", PARENT_ID AS "parentId", OPERATION AS "operation", OPTIONS AS "options", OBJECT_OWNER AS "owner",
            OBJECT_NAME AS "object", OBJECT_ALIAS AS "alias", COST AS "cost", CARDINALITY AS "cardinality",
            ACCESS_PREDICATES AS "access", FILTER_PREDICATES AS "filter"
       FROM PLAN_TABLE WHERE STATEMENT_ID = :s ORDER BY ID`,
    { s: stmt },
  )
  const text = (await rows<{ L: string }>(conn, `SELECT PLAN_TABLE_OUTPUT AS "L" FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :s, 'TYPICAL'))`, { s: stmt })).map((l) => l.L).join('\n')
  // EXPLAIN PLAN is DML on PLAN_TABLE: end that transaction so a READ ONLY one can start next.
  await conn.rollback()
  return { rows: r, text, cost: r[0]?.cost ?? null, planHash: Number(/Plan hash value: (\d+)/.exec(text)?.[1] ?? 0) || null }
}

/**
 * Row counts, column NDVs and existing indexes of the tables a plan reads. ALL_* views show only
 * tables the account can query; pass `dict: 'DBA'` (SELECT_CATALOG_ROLE) to see every schema.
 */
export async function tableInfos(conn: Connection, plan: PlanRow[], dict: 'ALL' | 'DBA' = 'ALL'): Promise<Map<string, TableInfo>> {
  const tables = new Map<string, TableInfo>()
  const keys = [...new Set(plan.filter((r) => r.operation === 'TABLE ACCESS' && r.owner && r.object).map((r) => `${r.owner}.${r.object}`))]
  for (const k of keys) {
    const [owner, table] = k.split('.') as [string, string]
    const t = await one<{ N: number | null }>(conn, `SELECT NUM_ROWS AS "N" FROM ${dict}_TABLES WHERE OWNER = :o AND TABLE_NAME = :t`, { o: owner, t: table })
    const cols = await rows<{ C: string; D: number | null }>(conn, `SELECT COLUMN_NAME AS "C", NUM_DISTINCT AS "D" FROM ${dict}_TAB_COL_STATISTICS WHERE OWNER = :o AND TABLE_NAME = :t`, { o: owner, t: table }).catch(() => [])
    const ix = await rows<{ I: string; C: string }>(
      conn,
      `SELECT INDEX_NAME AS "I", COLUMN_NAME AS "C" FROM ${dict}_IND_COLUMNS WHERE TABLE_OWNER = :o AND TABLE_NAME = :t ORDER BY INDEX_NAME, COLUMN_POSITION`,
      { o: owner, t: table },
    )
    const byIx = new Map<string, string[]>()
    for (const x of ix) byIx.set(x.I, [...(byIx.get(x.I) ?? []), x.C])
    tables.set(k, {
      owner,
      table,
      visible: !!t,
      rows: t?.N != null ? Number(t.N) : null,
      ndv: Object.fromEntries(cols.map((c) => [c.C, c.D == null ? null : Number(c.D)])),
      indexes: [...byIx.entries()].map(([name, columns]) => ({ name, columns })),
    })
  }
  return tables
}

export async function analyzeSql(input: z.infer<typeof analyzeSchema>): Promise<AdvisorResult> {
  const sql = assertSelectOnly(input.sql)
  return withConnection(
    input.profileId,
    (conn) =>
      inSchema(conn, input.schema, async () => {
        const ex = await explainRows(conn, sql)
        const tables = await tableInfos(conn, ex.rows)
        const advice = buildAdvice(ex.rows, tables)
        const stale = [...tables.values()].filter((t) => t.visible !== false && t.rows == null)
        const notes = [...advice.notes]
        for (const t of stale) notes.push({ severity: 'warning', table: `${t.owner}.${t.table}`, text: `${t.table} has no optimizer statistics — estimates are guesses. Gather them first: EXEC DBMS_STATS.GATHER_TABLE_STATS('${t.owner}', '${t.table}').` })
        return { planText: ex.text, totalCost: ex.cost, fullScans: advice.fullScans, candidates: advice.candidates, notes }
      }),
    { action: 'advisor', callTimeoutMs: 120000 },
  )
}

/** Runs the query `runs` times; median elapsed and per-execution logical/physical reads. */
async function measure(conn: Connection, sql: string, binds: Record<string, string | null>, runs: number, ex: ExplainOut): Promise<RunMetrics> {
  const o0 = await myStats(conn)
  const overhead = statDelta(o0, await myStats(conn))
  const times: number[] = []
  const gets: number[] = []
  const reads: number[] = []
  let n = 0
  await conn.execute('SET TRANSACTION READ ONLY')
  for (let i = 0; i < runs; i++) {
    const s0 = await myStats(conn)
    const t0 = performance.now()
    // No client statement cache: a cached open cursor would skip the re-parse that picks up the index.
    const r = await conn.execute(sql, binds, { maxRows: 10_000, keepInStmtCache: false })
    times.push(performance.now() - t0)
    const d = statDelta(s0, await myStats(conn), overhead)
    if (d) {
      gets.push(d['session logical reads'] ?? 0)
      reads.push(d['physical reads'] ?? 0)
    }
    n = r.rows?.length ?? 0
  }
  await conn.rollback()
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : null)
  return { cost: ex.cost, planHash: ex.planHash, plan: ex.text, medianMs: Math.round((med(times) ?? 0) * 1000) / 1000, gets: med(gets), physicalReads: med(reads), rows: n }
}

export async function testCandidate(input: z.infer<typeof testSchema>): Promise<IndexTestResult> {
  const sql = assertSelectOnly(input.sql)
  const profile = await getProfile(input.profileId)
  const owner = ident(input.owner, 'owner')
  const table = ident(input.table, 'table')
  const cols = input.columns.map((c) => ident(c, 'column'))
  assertWritable(profile, owner)
  const binds = coerceBinds(bindNames(sql), input.binds)
  const name = `ODLX_${table.slice(0, 16)}_${createHash('sha1').update(cols.join(',')).digest('hex').slice(0, 6).toUpperCase()}`.replace(/_+(?=_)/g, '')

  return withConnection(
    profile.id,
    async (conn) => {
      const known = await rows<{ C: string }>(conn, `SELECT COLUMN_NAME AS "C" FROM ALL_TAB_COLUMNS WHERE OWNER = :o AND TABLE_NAME = :t`, { o: owner, t: table })
      const missing = cols.filter((c) => !known.some((k) => k.C === c))
      if (missing.length) throw createError({ statusCode: 400, statusMessage: `Column(s) not in ${owner}.${table}: ${missing.join(', ')}` })
      if (await one(conn, `SELECT 1 AS "x" FROM ALL_INDEXES WHERE OWNER = :o AND INDEX_NAME = :n`, { o: owner, n: name })) {
        throw createError({ statusCode: 409, statusMessage: `Test index ${owner}.${name} already exists — keep or drop it in "Advisor indexes" first.` })
      }

      const before = await inSchema(conn, input.schema, async () => measure(conn, `${sql} /* ODLX before */`, binds, input.runs, await explainRows(conn, sql)))

      const t0 = Date.now()
      await conn.execute(`CREATE INDEX ${owner}.${name} ON ${owner}.${table} (${cols.join(', ')}) INVISIBLE`)
      const seconds = Math.round((Date.now() - t0) / 100) / 10
      const rec: AdvisorIndex = { name, owner, table, columns: cols, profileId: profile.id, visible: false, createdAt: nowIso(), sql }
      await labStore().setItem(`advisor-index:${profile.id}:${owner}.${name}`, rec)
      await audit({ action: 'advisor.index.created', profileId: profile.id, target: `${owner}.${name}`, detail: `INVISIBLE on ${table}(${cols.join(', ')})`, outcome: 'ok' })

      let after: RunMetrics
      try {
        await conn.execute(`ALTER SESSION SET OPTIMIZER_USE_INVISIBLE_INDEXES = TRUE`)
        // Different text → its own cursor, optimized with the invisible index allowed.
        after = await inSchema(conn, input.schema, async () => measure(conn, `${sql} /* ODLX after */`, binds, input.runs, await explainRows(conn, sql)))
      } finally {
        await conn.execute(`ALTER SESSION SET OPTIMIZER_USE_INVISIBLE_INDEXES = FALSE`).catch(() => {})
      }
      const size = await one<{ B: number }>(conn, `SELECT SUM(BYTES) AS "B" FROM DBA_SEGMENTS WHERE OWNER = :o AND SEGMENT_NAME = :n`, { o: owner, n: name }).catch(() => null)
      const used = after.plan.includes(name)
      const pct = (a: number | null, b: number | null) => (a && b != null ? Math.round(((a - b) / a) * 100) : null)
      const getsSaved = pct(before.gets, after.gets)
      const timeSaved = pct(before.medianMs, after.medianMs)
      const verdict = !used
        ? 'The optimizer did not use the index for this statement — drop it.'
        : getsSaved != null && getsSaved >= 50
          ? `Used: ${getsSaved}% fewer logical reads per execution${timeSaved != null ? `, ${timeSaved}% faster` : ''}. Worth keeping (remember it also costs on every INSERT/UPDATE/DELETE).`
          : `Used, but only ${getsSaved ?? '?'}% fewer logical reads — probably not worth the maintenance cost.`
      return { index: { name, owner, table, columns: cols, sizeBytes: size?.B != null ? Number(size.B) : null, seconds }, before, after, used, verdict }
    },
    { action: 'advisor-test', callTimeoutMs: 600000 },
  )
}

export async function listAdvisorIndexes(profileId: string): Promise<(AdvisorIndex & { exists: boolean })[]> {
  const keys = await labStore().getKeys(`advisor-index:${profileId}`)
  const recs = (await Promise.all(keys.map((k) => labStore().getItem<AdvisorIndex>(k)))).filter((r): r is AdvisorIndex => !!r)
  if (!recs.length) return []
  return withConnection(profileId, async (conn) => {
    const out = []
    for (const r of recs) {
      const cur = await one<{ V: string }>(conn, `SELECT VISIBILITY AS "V" FROM ALL_INDEXES WHERE OWNER = :o AND INDEX_NAME = :n`, { o: r.owner, n: r.name })
      out.push({ ...r, exists: !!cur, visible: cur?.V === 'VISIBLE' })
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  })
}

export async function advisorIndexAction(input: z.infer<typeof indexActionSchema>) {
  const profile = await getProfile(input.profileId)
  const owner = ident(input.owner, 'owner')
  assertWritable(profile, owner)
  const key = `advisor-index:${profile.id}:${owner}.${input.name}`
  const rec = await labStore().getItem<AdvisorIndex>(key)
  if (!rec) throw createError({ statusCode: 404, statusMessage: 'Only indexes created by the advisor can be changed here.' })
  await withConnection(profile.id, async (conn) => {
    const exists = await one(conn, `SELECT 1 AS "x" FROM ALL_INDEXES WHERE OWNER = :o AND INDEX_NAME = :n`, { o: owner, n: rec.name })
    if (!exists) return
    if (input.action === 'drop') await conn.execute(`DROP INDEX ${owner}.${rec.name}`)
    else await conn.execute(`ALTER INDEX ${owner}.${rec.name} ${input.action === 'keep' ? 'VISIBLE' : 'INVISIBLE'}`)
  })
  if (input.action === 'drop') await labStore().removeItem(key)
  else await labStore().setItem(key, { ...rec, visible: input.action === 'keep' })
  await audit({ action: `advisor.index.${input.action}`, profileId: profile.id, target: `${owner}.${rec.name}`, outcome: 'ok' })
  return { ok: true }
}

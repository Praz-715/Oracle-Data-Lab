import type { Connection } from 'oracledb'
import type { IndexCandidate, SqlIndexAdvice, SqlIndexReport, SqlRef } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { versionMajorOf } from '../database/environment'
import { oracleErrorInfo } from '../database/errors'
import { one, rows } from '../database/query'
import { customUser } from '../services/assessment'
import { tableInfos } from '../services/index-advisor'
import { buildAdvice, type PlanRow, type TableInfo } from '../tuning/advisor'

// Index advice for the SQL that really costs time: the top statements of the shared pool by
// elapsed time, analyzed on their real cursor plans (V$SQL_PLAN with predicates) by the same
// heuristics as the Index Advisor. Candidates are merged across statements and weighted by the
// share of elapsed time they could affect. Read-only and license-free; the DBA tests a candidate
// in the SQL Playground (INVISIBLE index) before creating it.

/** Pure: one advice per index; an index on (A, B) also serves a candidate on (A), so prefixes fold in. */
export function mergeAdvice(items: { sql: SqlRef; candidates: IndexCandidate[] }[]): SqlIndexAdvice[] {
  const by = new Map<string, SqlIndexAdvice>()
  for (const it of items) {
    for (const c of it.candidates) {
      const cur = by.get(c.id)
      if (!cur) by.set(c.id, { candidate: c, sql: [it.sql], impactPct: it.sql.dbTimePct })
      else {
        if (!cur.sql.some((s) => s.sqlId === it.sql.sqlId)) {
          cur.sql.push(it.sql)
          cur.impactPct += it.sql.dbTimePct
        }
        if (c.score > cur.candidate.score) cur.candidate = c
      }
    }
  }
  const list = [...by.values()].sort((a, b) => b.candidate.columns.length - a.candidate.columns.length)
  const folded = new Set<SqlIndexAdvice>()
  for (const short of [...list].reverse()) {
    if (short.candidate.coveredBy) continue
    const s = short.candidate
    const long = list.find((l) => l !== short && !folded.has(l) && !l.candidate.coveredBy && l.candidate.owner === s.owner && l.candidate.table === s.table && l.candidate.columns.length > s.columns.length && s.columns.every((col, i) => l.candidate.columns[i] === col))
    if (!long) continue
    for (const q of short.sql) {
      if (!long.sql.some((x) => x.sqlId === q.sqlId)) {
        long.sql.push(q)
        long.impactPct += q.dbTimePct
      }
    }
    folded.add(short)
  }
  return list
    .filter((a) => !folded.has(a))
    .map((a) => ({ ...a, impactPct: Math.min(100, Math.round(a.impactPct * 10) / 10), sql: a.sql.sort((x, y) => y.dbTimePct - x.dbTimePct) }))
    .sort((a, b) => Number(!!a.candidate.coveredBy) - Number(!!b.candidate.coveredBy) || b.impactPct - a.impactPct || b.candidate.score - a.candidate.score)
}

/**
 * Application SQL only: no Oracle-maintained schemas, none of this app's own dictionary queries,
 * and none of Oracle's recursive SQL that runs under the application schema (dynamic sampling,
 * statistics gathering, SQL tuning analysis).
 */
function sqlFilter(users: string) {
  return `s.COMMAND_TYPE IN (2, 3, 6, 7, 189) AND s.EXECUTIONS > 0
     AND s.PARSING_SCHEMA_NAME IN (${users})
     AND (NVL(s.MODULE, '-') <> 'OracleDB Data Lab' OR s.ACTION LIKE 'bench:%' OR s.ACTION = 'playground')
     AND s.SQL_TEXT NOT LIKE '%ODLX%' AND UPPER(s.SQL_TEXT) NOT LIKE 'EXPLAIN PLAN%'
     AND s.SQL_TEXT NOT LIKE '%/* DS_SVC */%' AND s.SQL_TEXT NOT LIKE '%OPT_DYN_SAMP%'
     AND s.SQL_TEXT NOT LIKE '/* SQL Analyze(%' AND s.SQL_TEXT NOT LIKE '%DBMS_STATS%'`
}

async function appUsers(conn: Connection) {
  const major = versionMajorOf(conn)
  for (const view of ['DBA_USERS', 'ALL_USERS']) {
    try {
      const r = await rows<{ U: string }>(conn, `SELECT u.USERNAME AS "U" FROM ${view} u WHERE ${customUser(major, 'u')}`)
      return { sql: `SELECT u.USERNAME FROM ${view} u WHERE ${customUser(major, 'u')}`, set: new Set(r.map((x) => x.U)) }
    } catch {
      // try the next view
    }
  }
  throw createError({ statusCode: 403, statusMessage: 'Cannot list database users (needs DBA_USERS or ALL_USERS).' })
}

export async function sqlIndexReport(profileId: string, top = 30): Promise<SqlIndexReport> {
  return withConnection(
    profileId,
    async (conn) => {
      const users = await appUsers(conn)
      const filter = sqlFilter(users.sql)
      const total = Number((await one<{ E: number }>(conn, `SELECT SUM(s.ELAPSED_TIME) AS "E" FROM V$SQL s WHERE ${filter}`))?.E ?? 0)
      const list = await rows<{ sqlId: string; planHash: number; child: number; execs: number; elapsed: number; gets: number; schema: string; text: string }>(
        conn,
        `SELECT * FROM (
           SELECT s.SQL_ID AS "sqlId",
                  MAX(s.PLAN_HASH_VALUE) KEEP (DENSE_RANK LAST ORDER BY s.EXECUTIONS) AS "planHash",
                  MAX(s.CHILD_NUMBER) KEEP (DENSE_RANK LAST ORDER BY s.EXECUTIONS) AS "child",
                  SUM(s.EXECUTIONS) AS "execs", SUM(s.ELAPSED_TIME) AS "elapsed", SUM(s.BUFFER_GETS) AS "gets",
                  MAX(s.PARSING_SCHEMA_NAME) AS "schema", MAX(DBMS_LOB.SUBSTR(s.SQL_FULLTEXT, 2000, 1)) AS "text"
             FROM V$SQL s WHERE ${filter}
            GROUP BY s.SQL_ID ORDER BY SUM(s.ELAPSED_TIME) DESC)
          WHERE ROWNUM <= :n`,
        { n: top },
      )

      const cache = new Map<string, TableInfo>()
      const items: { sql: SqlRef; candidates: IndexCandidate[] }[] = []
      const notes: SqlIndexReport['notes'] = []
      const skipped: SqlIndexReport['skipped'] = []
      const seenNote = new Set<string>()
      for (const s of list) {
        const ref: SqlRef = {
          sqlId: s.sqlId,
          planHash: s.planHash != null ? Number(s.planHash) : null,
          schema: s.schema,
          executions: Number(s.execs),
          elapsedMsPerExec: Math.round((Number(s.elapsed) / 1000 / Math.max(1, Number(s.execs))) * 1000) / 1000,
          bufferGetsPerExec: Math.round(Number(s.gets) / Math.max(1, Number(s.execs))),
          dbTimePct: total ? Math.round((Number(s.elapsed) / total) * 1000) / 10 : 0,
          text: s.text ?? '',
        }
        try {
          const plan = await rows<PlanRow>(
            conn,
            `SELECT ID AS "id", PARENT_ID AS "parentId", OPERATION AS "operation", OPTIONS AS "options", OBJECT_OWNER AS "owner",
                    OBJECT_NAME AS "object", OBJECT_ALIAS AS "alias", COST AS "cost", CARDINALITY AS "cardinality",
                    ACCESS_PREDICATES AS "access", FILTER_PREDICATES AS "filter"
               FROM V$SQL_PLAN WHERE SQL_ID = :id AND CHILD_NUMBER = :c ORDER BY ID`,
            { id: s.sqlId, c: Number(s.child) },
          )
          if (!plan.length) {
            skipped.push({ sqlId: s.sqlId, reason: 'Plan no longer in the shared pool.' })
            continue
          }
          const missing = plan.filter((r) => r.owner && r.object && !cache.has(`${r.owner}.${r.object}`))
          if (missing.length) for (const [k, v] of await tableInfos(conn, missing)) cache.set(k, v)
          const advice = buildAdvice(plan, cache)
          items.push({ sql: ref, candidates: advice.candidates.filter((c) => users.set.has(c.owner)) })
          for (const n of advice.notes) {
            if (n.table && !users.set.has(n.table.split('.')[0]!)) continue
            const k = `${n.table}|${n.text}`
            if (seenNote.has(k)) continue
            seenNote.add(k)
            notes.push({ ...n, sqlId: s.sqlId })
          }
          for (const t of new Set(plan.filter((r) => r.operation === 'TABLE ACCESS' && r.owner && users.set.has(r.owner)).map((r) => `${r.owner}.${r.object}`))) {
            if (cache.get(t)?.rows != null) continue
            const k = `${t}|nostats`
            if (seenNote.has(k)) continue
            seenNote.add(k)
            const [o, tb] = t.split('.')
            notes.push({ severity: 'warning', table: t, sqlId: s.sqlId, text: `${t} has no optimizer statistics, so plan estimates are guesses — gather them first: EXEC DBMS_STATS.GATHER_TABLE_STATS('${o}', '${tb}').` })
          }
        } catch (err) {
          const i = oracleErrorInfo(err)
          skipped.push({ sqlId: s.sqlId, reason: `${i.code}: ${i.message}` })
        }
      }
      return {
        analyzedSql: items.length,
        windowNote: 'Top application SQL by elapsed time, cumulative since each cursor was loaded into the shared pool (V$SQL / V$SQL_PLAN — no Diagnostics Pack needed). Cursors that aged out are not seen.',
        advice: mergeAdvice(items),
        notes,
        skipped,
      }
    },
    { action: 'recommend:sql-index', callTimeoutMs: 180000 },
  )
}

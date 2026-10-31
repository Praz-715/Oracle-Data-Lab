import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SchemaOptions, SchemaPlan } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { versionMajorOf } from '../database/environment'
import { oracleErrorInfo } from '../database/errors'
import { ident, one, rows } from '../database/query'
import { buildSchemaDdl } from '../generators/ddl'
import { registerExecutor, type JobContext } from '../jobs/runner'
import { assertWritable, getProfile } from './profiles'

export const schemaOptionsSchema = z.object({
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,7}$/, '1-8 chars, letter first').default('DL_'),
  partitioning: z.enum(['none', 'range', 'interval', 'list', 'hash']).default('interval'),
  includeLobs: z.boolean().default(true),
  includePlsql: z.boolean().default(true),
  includeMaterializedViews: z.boolean().default(true),
  includeSynonyms: z.boolean().default(true),
  compression: z.boolean().default(false),
  extensionTables: z.coerce.number().int().min(0).max(1000).default(0),
  tablespace: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_$#]*$/).optional().or(z.literal('').transform(() => undefined)),
  historyStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => `${new Date().getFullYear() - 3}-01-01`),
})

export const planRequestSchema = z.object({
  profileId: z.string().min(1),
  schema: z.string().trim().toUpperCase(),
  options: schemaOptionsSchema,
})

export async function createPlan(input: z.infer<typeof planRequestSchema>): Promise<SchemaPlan> {
  const profile = await getProfile(input.profileId)
  const schema = ident(input.schema, 'schema')
  if (input.options.extensionTables > labLimits().maxExtensionTables) {
    throw createError({ statusCode: 400, statusMessage: `At most ${labLimits().maxExtensionTables} extension tables (NUXT_LIMITS_MAX_EXTENSION_TABLES)` })
  }
  return withConnection(profile.id, async (conn) => {
    const versionMajor = versionMajorOf(conn)
    const user = await one(conn, `SELECT USERNAME FROM ALL_USERS WHERE USERNAME = :s`, { s: schema })
    if (!user) throw createError({ statusCode: 400, statusMessage: `Schema ${schema} does not exist. This app never creates database users.` })

    let partitioningAvailable: boolean | null
    try {
      const o = await one<{ v: string }>(conn, `SELECT VALUE AS "v" FROM V$OPTION WHERE PARAMETER = 'Partitioning'`)
      partitioningAvailable = o ? o.v === 'TRUE' : null
    } catch {
      partitioningAvailable = null
    }

    const ddl = buildSchemaDdl(input.options as SchemaOptions, { schema, versionMajor, partitioningAvailable })
    const warnings = [...ddl.warnings]
    if (profile.mode !== 'lab' || !profile.allowedSchemas.includes(schema)) {
      warnings.push(`Profile "${profile.name}" is not authorized to write to ${schema}. You can review and export this DDL, but applying it requires lab mode and ${schema} in authorized schemas.`)
    }
    const existing = await rows<{ name: string; type: string }>(
      conn,
      `SELECT OBJECT_NAME AS "name", OBJECT_TYPE AS "type" FROM ALL_OBJECTS
        WHERE OWNER = :s AND OBJECT_NAME LIKE :p ESCAPE '\\' AND ROWNUM <= 2000`,
      { s: schema, p: `${ddl.effectiveOptions.prefix.replace(/_/g, '\\_')}%` },
    )
    if (existing.length) {
      warnings.push(`${existing.length} object(s) with prefix ${ddl.effectiveOptions.prefix} already exist in ${schema}. Enable "skip existing objects" when applying, or use a different prefix.`)
    }
    if (versionMajor && versionMajor < 12) {
      warnings.push('Oracle 11g detected: identifiers are limited to 30 characters (the blueprint already respects this).')
    }

    const sha256 = createHash('sha256').update(ddl.statements.map((s) => s.sql).join('\n;\n')).digest('hex')
    const plan: SchemaPlan = {
      id: newId(),
      profileId: profile.id,
      schema,
      blueprint: 'retail-commerce',
      options: ddl.effectiveOptions,
      statements: ddl.statements,
      warnings,
      versionMajor,
      createdAt: nowIso(),
      sha256,
    }
    await labStore().setItem(`plans:${plan.id}`, plan)
    return plan
  })
}

export async function getPlan(id: string): Promise<SchemaPlan> {
  const p = await labStore().getItem<SchemaPlan>(`plans:${id}`)
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Plan not found' })
  return p
}

export function planToSql(plan: SchemaPlan): string {
  const header = [
    `-- OracleDB Data Lab — Retail Commerce blueprint`,
    `-- Schema: ${plan.schema}   Prefix: ${plan.options.prefix}   Partitioning: ${plan.options.partitioning}`,
    `-- Generated: ${plan.createdAt}   Statements: ${plan.statements.length}   SHA-256: ${plan.sha256}`,
    `-- Review before running. Statements marked OPTIONAL may fail on editions/privileges that lack the feature.`,
    '',
  ]
  const body = plan.statements.map((s) => {
    const plsql = /^CREATE OR REPLACE (PACKAGE|PROCEDURE|FUNCTION|TRIGGER)/.test(s.sql)
    const tag = `-- [${s.seq}] ${s.objectType} ${s.objectName}${s.optional ? ' (OPTIONAL)' : ''}${s.note ? ` — ${s.note}` : ''}`
    return `${tag}\n${s.sql}${plsql ? '\n/' : ';'}\n`
  })
  return [...header, ...body].join('\n')
}

// ORA codes meaning "this object already exists" — tolerated when skipExisting is set.
const EXISTS_CODES = new Set(['ORA-00955', 'ORA-02260', 'ORA-02261', 'ORA-02264', 'ORA-02275', 'ORA-01408', 'ORA-01430'])

export interface ApplyConfig {
  planId: string
  schema: string
  skipExisting: boolean
  statementCount: number
}

export interface StatementResult {
  seq: number
  objectType: string
  objectName: string
  status: 'ok' | 'skipped' | 'exists' | 'warning' | 'failed'
  elapsedMs: number
  message?: string
}

interface ApplyCheckpoint {
  nextSeq: number
  results: StatementResult[]
}

async function applyExecutor(ctx: JobContext<ApplyConfig, ApplyCheckpoint>) {
  const plan = await getPlan(ctx.job.config.planId)
  const profile = await getProfile(plan.profileId)
  assertWritable(profile, plan.schema)
  const cp: ApplyCheckpoint = ctx.job.checkpoint ?? { nextSeq: 1, results: [] }
  // On resume, re-run from the failed statement and drop its previous result.
  cp.results = cp.results.filter((r) => r.seq < cp.nextSeq)
  const total = plan.statements.length
  ctx.progress({ phase: 'applying DDL', total, done: cp.nextSeq - 1, unit: 'statements' })

  await withConnection(
    profile.id,
    async (conn) => {
      for (const st of plan.statements.filter((s) => s.seq >= cp.nextSeq)) {
        ctx.throwIfCancelled()
        const t0 = performance.now()
        let res: StatementResult
        try {
          const r = await conn.execute(st.sql)
          res = { seq: st.seq, objectType: st.objectType, objectName: st.objectName, status: 'ok', elapsedMs: 0 }
          if ((r as any).warning) {
            const errs = await rows<{ line: number; text: string }>(
              conn,
              `SELECT LINE AS "line", TEXT AS "text" FROM ALL_ERRORS WHERE OWNER = :o AND NAME = :n ORDER BY SEQUENCE`,
              { o: plan.schema, n: st.objectName },
            ).catch(() => [])
            res.status = 'warning'
            res.message = errs.length ? errs.map((e) => `line ${e.line}: ${e.text.trim()}`).join('; ') : 'Compiled with warnings'
            ctx.log('warn', `${st.objectType} ${st.objectName}: ${res.message}`)
          }
        } catch (err) {
          const info = oracleErrorInfo(err)
          const base = { seq: st.seq, objectType: st.objectType, objectName: st.objectName, elapsedMs: 0, message: `${info.code}: ${info.message}` }
          if (ctx.job.config.skipExisting && EXISTS_CODES.has(info.code)) {
            res = { ...base, status: 'exists' }
            ctx.log('info', `${st.objectType} ${st.objectName} already exists — skipped`)
          } else if (st.optional) {
            res = { ...base, status: 'skipped' }
            ctx.log('warn', `Optional ${st.objectType} ${st.objectName} skipped: ${info.code} ${info.hint ?? info.message}`)
          } else {
            res = { ...base, status: 'failed' }
            cp.results.push({ ...res, elapsedMs: Math.round(performance.now() - t0) })
            await ctx.checkpoint({ nextSeq: st.seq, results: cp.results })
            throw err
          }
        }
        res.elapsedMs = Math.round(performance.now() - t0)
        cp.results.push(res)
        cp.nextSeq = st.seq + 1
        if (st.seq % 10 === 0 || st.seq === total) await ctx.checkpoint({ ...cp })
        ctx.progress({ done: st.seq, message: `${st.objectType} ${st.objectName}` })
      }
    },
    { action: 'schema-apply', callTimeoutMs: 600000 },
  )
  await ctx.checkpoint({ ...cp })
  const counts = cp.results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})
  await audit({ action: 'schema.apply.completed', profileId: profile.id, target: plan.schema, detail: JSON.stringify(counts), outcome: 'ok' })
  return { planId: plan.id, schema: plan.schema, prefix: plan.options.prefix, counts, results: cp.results }
}

registerExecutor('schema-apply', applyExecutor as any)

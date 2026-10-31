import { z } from 'zod'
import { withConnection } from '../database/driver'
import { oracleErrorInfo } from '../database/errors'
import { ident, rows } from '../database/query'
import { CORE_TABLES } from '../generators/blueprint'
import { dropOrder } from '../generators/ddl'
import { createJob, registerExecutor, type JobContext } from '../jobs/runner'
import { assertWritable, getProfile } from './profiles'

// Backup Dataset & Cleanup Manager. Never drops users/schemas and never truncates: it deletes rows
// tagged with a job id (DL_JOB_ID / RUN_ID) or drops objects that carry the lab prefix, after the
// plan has been reviewed and the schema name typed back as confirmation.

export const cleanupRequestSchema = z.object({
  profileId: z.string().min(1),
  schema: z.string().trim().toUpperCase(),
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,7}$/).default('DL_'),
  mode: z.enum(['job-rows', 'bench-rows', 'drop-objects']),
  /** Generation job id (job-rows) or benchmark run id (bench-rows). */
  targetId: z.string().uuid().optional(),
  confirmText: z.string().optional(),
})
type CleanupRequest = z.infer<typeof cleanupRequestSchema>

interface CleanupStep {
  seq: number
  kind: 'delete' | 'drop'
  objectType: string
  objectName: string
  sql: string
  rows?: number | null
}

// Children before parents so FK constraints are never violated.
const DELETE_ORDER = [
  'PRODUCT_REVIEWS', 'RETURNS', 'PAYMENTS', 'SHIPMENTS', 'ORDER_ITEMS', 'ORDERS', 'INVENTORY_MOVEMENTS', 'INVENTORY',
  'PRODUCT_IMAGES', 'CUSTOMERS', 'PRODUCTS', 'SUPPLIERS', 'WAREHOUSES', 'CATEGORIES', 'REGIONS',
]

export async function planCleanup(input: CleanupRequest) {
  const profile = await getProfile(input.profileId)
  const S = ident(input.schema, 'schema')
  const P = input.prefix
  if ((input.mode === 'job-rows' || input.mode === 'bench-rows') && !input.targetId) {
    throw createError({ statusCode: 400, statusMessage: 'targetId (job or run id) is required' })
  }
  return withConnection(profile.id, async (conn) => {
    const like = `${P.replace(/_/g, '\\_')}%`
    const existing = await rows<{ name: string; type: string }>(
      conn,
      `SELECT OBJECT_NAME AS "name", OBJECT_TYPE AS "type" FROM ALL_OBJECTS
        WHERE OWNER = :s AND OBJECT_NAME LIKE :p ESCAPE '\\' AND OBJECT_TYPE IN
              ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','SYNONYM','PACKAGE','PACKAGE BODY','PROCEDURE','FUNCTION','TRIGGER')`,
      { s: S, p: like },
    )
    const tables = new Set(existing.filter((o) => o.type === 'TABLE').map((o) => o.name))
    const steps: CleanupStep[] = []

    if (input.mode === 'job-rows') {
      const ext = [...tables].filter((t) => /EXT_\d{3}$/.test(t)).sort().reverse()
      const ordered = [...ext, ...DELETE_ORDER.map((k) => `${P}${k}`)].filter((t) => tables.has(t))
      for (const t of ordered) {
        let n: number | null
        try {
          const r = await rows<{ n: number }>(conn, `SELECT COUNT(*) AS "n" FROM ${S}.${t} WHERE DL_JOB_ID = :j`, { j: input.targetId })
          n = Number(r[0]?.n ?? 0)
        } catch {
          n = null
        }
        if (n === 0) continue
        steps.push({ seq: steps.length + 1, kind: 'delete', objectType: 'TABLE', objectName: t, rows: n, sql: `DELETE FROM ${S}.${t} WHERE DL_JOB_ID = :j AND ROWNUM <= 50000` })
      }
    } else if (input.mode === 'bench-rows') {
      const t = `${P}BENCH_EVENTS`
      if (tables.has(t)) {
        const r = await rows<{ n: number }>(conn, `SELECT COUNT(*) AS "n" FROM ${S}.${t} WHERE RUN_ID = :j`, { j: input.targetId })
        steps.push({ seq: 1, kind: 'delete', objectType: 'TABLE', objectName: t, rows: Number(r[0]?.n ?? 0), sql: `DELETE FROM ${S}.${t} WHERE RUN_ID = :j AND ROWNUM <= 50000` })
      }
    } else {
      const known = new Set(CORE_TABLES.map((t) => `${P}${t.key}`))
      // A materialized view also appears as a TABLE (its container) that goes away with the MV.
      const mvs = new Set(existing.filter((o) => o.type === 'MATERIALIZED VIEW').map((o) => o.name))
      const sorted = [...existing]
        .filter((o) => o.type !== 'PACKAGE BODY') // dropped with its package
        .filter((o) => !(o.type === 'TABLE' && mvs.has(o.name)))
        .sort((a, b) => dropOrder(a.type) - dropOrder(b.type) || a.name.localeCompare(b.name))
      for (const o of sorted) {
        const sql =
          o.type === 'TABLE'
            ? `DROP TABLE ${S}.${o.name} CASCADE CONSTRAINTS PURGE`
            : `DROP ${o.type} ${S}.${o.name}`
        steps.push({ seq: steps.length + 1, kind: 'drop', objectType: o.type, objectName: o.name, sql })
      }
      const foreign = existing.filter((o) => o.type === 'TABLE' && !known.has(o.name) && !/EXT_\d{3}$/.test(o.name))
      if (foreign.length) {
        return { schema: S, prefix: P, mode: input.mode, steps, warnings: [`${foreign.length} table(s) with prefix ${P} are not part of the lab blueprint (${foreign.slice(0, 5).map((f) => f.name).join(', ')}…). Review carefully.`] }
      }
    }
    return { schema: S, prefix: P, mode: input.mode, steps, warnings: [] as string[] }
  })
}

export async function startCleanup(input: CleanupRequest) {
  const profile = await getProfile(input.profileId)
  const S = ident(input.schema, 'schema')
  assertWritable(profile, S)
  if ((input.confirmText ?? '').trim().toUpperCase() !== S) {
    throw createError({ statusCode: 400, statusMessage: `Type the schema name (${S}) to confirm.` })
  }
  const plan = await planCleanup(input)
  if (!plan.steps.length) throw createError({ statusCode: 400, statusMessage: 'Nothing to clean up' })
  const job = await createJob({
    type: 'cleanup',
    profileId: profile.id,
    title: `Cleanup ${input.mode} in ${S}${input.targetId ? ` (${input.targetId.slice(0, 8)})` : ''}`,
    config: { ...input, schema: S, steps: plan.steps },
  })
  await audit({ action: `cleanup.${input.mode}.started`, profileId: profile.id, target: S, detail: `${plan.steps.length} steps, job ${job.id}`, outcome: 'requested' })
  return job
}

async function cleanupExecutor(ctx: JobContext<CleanupRequest & { steps: CleanupStep[] }>) {
  const cfg = ctx.job.config
  const profile = await getProfile(ctx.job.profileId)
  assertWritable(profile, cfg.schema)
  const results: { seq: number; objectName: string; status: 'ok' | 'failed'; rows?: number; message?: string }[] = []
  ctx.progress({ phase: 'cleanup', total: cfg.steps.length, done: 0, unit: 'steps' })
  await withConnection(
    profile.id,
    async (conn) => {
      for (const st of cfg.steps) {
        ctx.throwIfCancelled()
        try {
          if (st.kind === 'delete') {
            let total = 0
            for (;;) {
              ctx.throwIfCancelled()
              const r = await conn.execute(st.sql, { j: cfg.targetId })
              await conn.commit()
              total += r.rowsAffected ?? 0
              ctx.progress({ message: `${st.objectName}: ${total.toLocaleString()} rows deleted` })
              if ((r.rowsAffected ?? 0) < 50000) break
            }
            results.push({ seq: st.seq, objectName: st.objectName, status: 'ok', rows: total })
          } else {
            await conn.execute(st.sql)
            results.push({ seq: st.seq, objectName: st.objectName, status: 'ok' })
          }
          ctx.log('info', `${st.kind === 'delete' ? 'Deleted from' : 'Dropped'} ${st.objectName}`)
        } catch (err) {
          const info = oracleErrorInfo(err)
          // Shared reference rows still referenced by other jobs fail with ORA-02292: keep them.
          results.push({ seq: st.seq, objectName: st.objectName, status: 'failed', message: `${info.code}: ${info.message}` })
          ctx.log(info.code === 'ORA-02292' ? 'warn' : 'error', `${st.objectName}: ${info.code} ${info.hint ?? info.message}`)
          await conn.rollback().catch(() => {})
        }
        ctx.progress({ done: results.length })
      }
    },
    { action: 'cleanup', callTimeoutMs: 600000 },
  )
  await audit({ action: `cleanup.${cfg.mode}.completed`, profileId: profile.id, target: cfg.schema, detail: `${results.filter((r) => r.status === 'ok').length}/${results.length} ok`, outcome: 'ok' })
  return { results }
}

registerExecutor('cleanup', cleanupExecutor as any)

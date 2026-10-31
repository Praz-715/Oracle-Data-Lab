import type { Connection } from 'oracledb'
import type { Panel } from '../../shared/types/lab'
import { oracleErrorInfo } from './errors'

export async function rows<T = Record<string, any>>(
  conn: Connection,
  sql: string,
  binds: Record<string, unknown> | unknown[] = {},
  opts: { maxRows?: number } = {},
): Promise<T[]> {
  const r = await conn.execute<T>(sql, binds as any, { maxRows: opts.maxRows ?? 0 })
  return (r.rows ?? []) as T[]
}

export async function one<T = Record<string, any>>(
  conn: Connection,
  sql: string,
  binds: Record<string, unknown> | unknown[] = {},
): Promise<T | null> {
  const r = await rows<T>(conn, sql, binds, { maxRows: 1 })
  return r[0] ?? null
}

/** Runs a query, mapping privilege/feature errors to an explicit "unavailable" panel instead of fake data. */
export async function panel<T>(fn: () => Promise<T>, requires?: string, note?: string): Promise<Panel<T>> {
  const collectedAt = new Date().toISOString()
  try {
    return { status: 'ok', data: await fn(), collectedAt, note }
  } catch (err) {
    const info = oracleErrorInfo(err)
    if (info.unavailable) {
      return { status: 'unavailable', reason: info.hint ?? info.message, code: info.code, requires, collectedAt }
    }
    throw err
  }
}

/** Same as panel() but never throws: real errors also become unavailable with the error message. */
export async function softPanel<T>(fn: () => Promise<T>, requires?: string, note?: string): Promise<Panel<T>> {
  try {
    return await panel(fn, requires, note)
  } catch (err) {
    const info = oracleErrorInfo(err)
    return {
      status: 'unavailable',
      reason: `${info.code}: ${info.message}${info.hint ? ` — ${info.hint}` : ''}`,
      code: info.code,
      requires,
      collectedAt: new Date().toISOString(),
    }
  }
}

/** Upper-cases and validates an Oracle identifier so it can be safely spliced into DDL. */
export function ident(name: string, what = 'identifier'): string {
  const v = name.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_$#]{0,127}$/.test(v)) {
    throw createError({ statusCode: 400, statusMessage: `Invalid ${what}: ${name}` })
  }
  return v
}

/** Pagination clause that works on Oracle 11g (ROWNUM) and 12c+ (OFFSET/FETCH). */
export function paginate(sql: string, versionMajor: number): string {
  if (versionMajor >= 12) return `${sql} OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`
  return `SELECT * FROM (SELECT q_.*, ROWNUM rn_ FROM (${sql}) q_ WHERE ROWNUM <= :off + :lim) WHERE rn_ > :off`
}

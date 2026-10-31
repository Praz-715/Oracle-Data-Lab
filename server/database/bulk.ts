import type { Connection } from 'oracledb'
import { oracledb } from './driver'
import type { TableDef } from '../generators/blueprint'

// Array-binding insert helpers shared by the data generator and benchmarks.

const cache = new Map<string, { sql: string; bindDefs: oracledb.BindDefinition[] }>()

function bindDef(type: string): oracledb.BindDefinition {
  const t = type.toUpperCase()
  const len = Number(/\((\d+)/.exec(t)?.[1] ?? 4000)
  if (t.startsWith('NUMBER')) return { type: oracledb.NUMBER }
  if (t.startsWith('VARCHAR2') || t.startsWith('CHAR')) return { type: oracledb.STRING, maxSize: len }
  if (t === 'DATE') return { type: oracledb.DB_TYPE_DATE }
  if (t.startsWith('TIMESTAMP')) return { type: oracledb.DB_TYPE_TIMESTAMP }
  // LOBs are bound as in-line values; the generator keeps them below the conventional bind limits.
  if (t === 'CLOB') return { type: oracledb.STRING, maxSize: 4000 }
  if (t === 'BLOB') return { type: oracledb.BUFFER, maxSize: 2000 }
  throw new Error(`No bind mapping for ${type}`)
}

export function insertStatement(schema: string, prefix: string, t: TableDef) {
  const k = `${schema}.${prefix}${t.key}`
  let c = cache.get(k)
  if (!c) {
    const cols = t.columns.map((col) => col.name)
    c = {
      sql: `INSERT INTO ${schema}.${prefix}${t.key} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `:${i + 1}`).join(', ')})`,
      bindDefs: t.columns.map((col) => bindDef(col.type)),
    }
    cache.set(k, c)
  }
  return c
}

export async function insertRows(conn: Connection, schema: string, prefix: string, t: TableDef, data: unknown[][]): Promise<number> {
  if (!data.length) return 0
  const { sql, bindDefs } = insertStatement(schema, prefix, t)
  const r = await conn.executeMany(sql, data as any[], { bindDefs, autoCommit: false })
  return r.rowsAffected ?? data.length
}

/**
 * Reserves `n` consecutive values from a sequence: temporarily raise INCREMENT BY so one NEXTVAL
 * jumps over the whole block. Works on 11g+ and with cached sequences. Returns the first id.
 */
export async function reserveIds(conn: Connection, qualifiedSeq: string, n: number): Promise<number> {
  if (n <= 0) return 0
  await conn.execute(`SELECT ${qualifiedSeq}.NEXTVAL FROM DUAL`)
  await conn.execute(`ALTER SEQUENCE ${qualifiedSeq} INCREMENT BY ${Math.floor(n)}`)
  let last: number
  try {
    const r = await conn.execute<{ V: number }>(`SELECT ${qualifiedSeq}.NEXTVAL AS V FROM DUAL`)
    last = Number(r.rows![0]!.V)
  } finally {
    await conn.execute(`ALTER SEQUENCE ${qualifiedSeq} INCREMENT BY 1`)
  }
  return last - Math.floor(n) + 1
}

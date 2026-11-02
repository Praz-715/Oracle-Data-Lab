import { createError } from 'h3'
import type { ImportColumn } from '../../shared/types/lab'
import { normalizeDecimalComma } from './infer'

// SQL building blocks for imports. Every identifier, type and date mask that ends up spliced into
// SQL is validated here; values are always bound. Conversion is done by Oracle (TO_NUMBER/TO_DATE)
// so rejected rows carry the real ORA error.

export type TypeClass = 'number' | 'date' | 'timestamp' | 'text' | 'clob'

const TYPE_RE =
  /^(?:NUMBER(?:\(\s*(?:\d{1,2}|\*)\s*(?:,\s*-?\d{1,2}\s*)?\))?|INTEGER|FLOAT(?:\(\s*\d{1,3}\s*\))?|BINARY_DOUBLE|BINARY_FLOAT|N?VARCHAR2\(\s*\d{1,5}(?:\s+(?:CHAR|BYTE))?\s*\)|N?CHAR\(\s*\d{1,4}(?:\s+(?:CHAR|BYTE))?\s*\)|DATE|TIMESTAMP(?:\(\s*\d\s*\))?|N?CLOB)$/i

export function normalizeType(t: string): string {
  const v = t.trim().replace(/\s+/g, ' ').toUpperCase()
  if (!TYPE_RE.test(v)) throw createError({ statusCode: 400, statusMessage: `Unsupported column type: ${t}` })
  return v
}

export function typeClass(t: string): TypeClass {
  const v = t.toUpperCase()
  if (/^(NUMBER|INTEGER|FLOAT|BINARY_)/.test(v)) return 'number'
  if (v === 'DATE') return 'date'
  if (v.startsWith('TIMESTAMP')) return 'timestamp'
  if (/CLOB$/.test(v)) return 'clob'
  return 'text'
}

/** Maximum length of a character type and whether it counts bytes. */
export function textLimit(t: string): { size: number; bytes: boolean } | null {
  const m = /^N?(?:VARCHAR2|CHAR)\(\s*(\d+)(?:\s+(CHAR|BYTE))?\s*\)$/i.exec(t)
  if (!m) return null
  return { size: Number(m[1]), bytes: !t.toUpperCase().startsWith('N') && m[2]?.toUpperCase() !== 'CHAR' }
}

const MASK_RE = /^[A-Za-z0-9 :\-/.,"]{1,60}$/

export function validateMask(mask: string): string {
  if (!MASK_RE.test(mask) || (mask.match(/"/g)?.length ?? 0) % 2) throw createError({ statusCode: 400, statusMessage: `Invalid date mask: ${mask}` })
  return mask
}

export const DEFAULT_DATE_MASK = 'YYYY-MM-DD HH24:MI:SS'
export const DEFAULT_TS_MASK = 'YYYY-MM-DD HH24:MI:SS.FF'

/** Bind expression for one column, converting the bound string to the column's type. */
export function bindExpr(c: Pick<ImportColumn, 'type' | 'dateMask'>, n: number): string {
  switch (typeClass(c.type)) {
    case 'number':
      return `TO_NUMBER(:${n})`
    case 'date':
      return `TO_DATE(:${n}, '${validateMask(c.dateMask || DEFAULT_DATE_MASK)}')`
    case 'timestamp':
      return `TO_TIMESTAMP(:${n}, '${validateMask(c.dateMask || DEFAULT_TS_MASK)}')`
    default:
      return `:${n}`
  }
}

/** Applies trim / empty-as-null / decimal comma / constant to one source cell. */
export function transformValue(c: ImportColumn, raw: string | null | undefined): string | null {
  let v = c.source == null ? (c.constant ?? null) : (raw ?? null)
  if (v == null) return null
  if (c.trim !== false) v = v.trim()
  if (v === '' && c.emptyAsNull !== false) return null
  if (c.decimalComma && typeClass(c.type) === 'number') v = normalizeDecimalComma(v)
  return v
}

export const IDENT_RE = /^[A-Z][A-Z0-9_$#]*$/

export function checkIdent(name: string, maxLen: number, what: string): string {
  const v = name.trim().toUpperCase()
  if (!IDENT_RE.test(v) || v.length > maxLen) throw createError({ statusCode: 400, statusMessage: `Invalid ${what} "${name}" (letters, digits, _ $ #; max ${maxLen} characters; must start with a letter).` })
  return v
}

/** Constraint/index name within the identifier limit: base truncated, suffix kept. */
export function shortName(base: string, suffix: string, maxLen = 30): string {
  return `${base.slice(0, maxLen - suffix.length).replace(/_+$/, '')}${suffix}`
}

export function insertSql(schema: string, table: string, columns: Pick<ImportColumn, 'target' | 'type' | 'dateMask'>[], tag: boolean): string {
  const names = columns.map((c) => c.target)
  const exprs = columns.map((c, i) => bindExpr(c, i + 1))
  if (tag) {
    names.push('DL_IMPORT_ID')
    exprs.push(`:${columns.length + 1}`)
  }
  return `INSERT INTO ${schema}.${table} (${names.join(', ')}) VALUES (${exprs.join(', ')})`
}

export function createTableSql(schema: string, table: string, columns: Pick<ImportColumn, 'target' | 'type'>[], tag: boolean): string {
  const defs = columns.map((c) => `  ${c.target} ${c.type}`)
  if (tag) defs.push('  DL_IMPORT_ID VARCHAR2(36)')
  return `CREATE TABLE ${schema}.${table} (\n${defs.join(',\n')}\n)`
}

export interface LoadCounters {
  rowsRead: number
  inserted: number
  rejected: number
}

/**
 * A crash between a batch COMMIT and its checkpoint leaves at most one batch committed but not
 * recorded. With tagged rows the database count reveals it, so a resume skips that batch instead of
 * loading it twice. Returns the corrected counters and how many source rows were skipped.
 */
export function reconcileLoad<T extends LoadCounters>(state: T, taggedInDb: number, batchSize: number, totalRows: number | null): { state: T; skipped: number } {
  const extra = taggedInDb - state.inserted
  if (extra <= 0) return { state, skipped: 0 }
  const remaining = totalRows != null ? totalRows - state.rowsRead : batchSize
  const batch = Math.min(batchSize, remaining > 0 ? remaining : batchSize)
  if (extra > batch) {
    throw createError({ statusCode: 409, statusMessage: `The table holds ${extra} more rows tagged with this import than one uncommitted batch can explain; refusing to resume. Undo the import and start again.` })
  }
  return { state: { ...state, rowsRead: state.rowsRead + batch, inserted: taggedInDb, rejected: state.rejected + (batch - extra) }, skipped: batch }
}

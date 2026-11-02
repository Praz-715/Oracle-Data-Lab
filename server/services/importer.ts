import type { Connection } from 'oracledb'
import { z } from 'zod'
import type { ImportColumn, ImportConfig, ImportPlan, ImportRejected, ImportResult, JobRecord } from '../../shared/types/lab'
import { oracledb, withConnection } from '../database/driver'
import { oracleErrorInfo } from '../database/errors'
import { one, rows } from '../database/query'
import { readRows } from '../datasets/reader'
import { bindExpr, checkIdent, createTableSql, insertSql, normalizeType, reconcileLoad, shortName, textLimit, transformValue, typeClass, validateMask } from '../datasets/sql'
import { createJob, getJob, isJobActive, registerExecutor, type JobContext } from '../jobs/runner'
import { bundleSource, loadBundle, profileSource, resolveSource, sourceFingerprint, type ProfileQuery } from './datasets'
import { assertWritable, getProfile } from './profiles'

// Import Manager: loads CSV/XLSX files into authorized lab schemas. Same model as the generator —
// planned and reviewed first, executed as a resumable background job with array-bound batches,
// per-row rejects (batchErrors) instead of all-or-nothing, and rows tagged DL_IMPORT_ID so an import
// can be undone precisely. Tables are only ever created or appended to, never truncated.

const MAX_SAMPLES = 200
const PREVIEW = 20

const columnSchema = z.object({
  source: z.number().int().min(0).nullable(),
  target: z.string().min(1).max(128),
  type: z.string().min(1).max(60),
  dateMask: z.string().max(60).nullable().optional(),
  decimalComma: z.boolean().optional(),
  trim: z.boolean().optional(),
  emptyAsNull: z.boolean().optional(),
  constant: z.string().max(4000).nullable().optional(),
})

export const importConfigSchema = z.object({
  profileId: z.string().min(1),
  sourceId: z.string().min(1),
  sheet: z.string().max(200).nullable().optional(),
  hasHeader: z.boolean().default(true),
  delimiter: z.enum([',', ';', '\t', '|']).nullable().optional(),
  encoding: z.enum(['utf8', 'latin1']).optional(),
  schema: z.string().min(1).max(128),
  table: z.string().min(1).max(128),
  mode: z.enum(['create', 'append']),
  columns: z.array(columnSchema).min(1).max(1000),
  primaryKey: z.array(z.string().max(128)).max(32).optional(),
  tagRows: z.boolean().default(true),
  batchSize: z.number().int().min(1).max(100000).default(5000),
  maxErrors: z.number().int().min(0).max(10_000_000).default(1000),
  gatherStats: z.boolean().default(true),
})

interface Compiled {
  schema: string
  table: string
  columns: ImportColumn[]
  tag: boolean
  createSql: string | null
  insertSql: string
  post: { kind: 'constraint' | 'index' | 'stats'; sql: string; binds?: Record<string, string> }[]
  warnings: string[]
  errors: string[]
}

function identLimit(conn: Connection) {
  return (conn.oracleServerVersion ?? 0) >= 1202000000 ? 128 : 30
}

async function tableExists(conn: Connection, schema: string, table: string) {
  return !!(await one(conn, `SELECT 1 AS "x" FROM ALL_TABLES WHERE OWNER = :o AND TABLE_NAME = :t`, { o: schema, t: table }))
}

interface TabColumn {
  name: string
  dataType: string
  dataLength: number
  charLength: number
  charUsed: string | null
  precision: number | null
  scale: number | null
  nullable: string
  hasDefault: number
}

export async function tableColumns(conn: Connection, schema: string, table: string): Promise<TabColumn[]> {
  return rows<TabColumn>(
    conn,
    `SELECT COLUMN_NAME AS "name", DATA_TYPE AS "dataType", DATA_LENGTH AS "dataLength", CHAR_LENGTH AS "charLength", CHAR_USED AS "charUsed",
            DATA_PRECISION AS "precision", DATA_SCALE AS "scale", NULLABLE AS "nullable", CASE WHEN DEFAULT_LENGTH > 0 THEN 1 ELSE 0 END AS "hasDefault"
       FROM ALL_TAB_COLUMNS WHERE OWNER = :o AND TABLE_NAME = :t ORDER BY COLUMN_ID`,
    { o: schema, t: table },
  )
}

/** Oracle type text of an existing column, in the form the importer understands. */
export function columnTypeText(c: TabColumn): string {
  const t = c.dataType
  if (t === 'NUMBER') return c.precision != null ? `NUMBER(${c.precision}${c.scale ? `,${c.scale}` : ''})` : 'NUMBER'
  if (t === 'VARCHAR2' || t === 'CHAR') return `${t}(${c.charUsed === 'C' ? `${c.charLength} CHAR` : `${c.dataLength} BYTE`})`
  if (t === 'NVARCHAR2' || t === 'NCHAR') return `${t}(${c.charLength})`
  if (t.startsWith('TIMESTAMP') && !t.includes('ZONE')) return t
  if (['DATE', 'CLOB', 'NCLOB', 'FLOAT', 'BINARY_DOUBLE', 'BINARY_FLOAT'].includes(t)) return t
  return `UNSUPPORTED:${t}`
}

/** Validates a config against the database and produces everything the job will execute. */
async function compile(conn: Connection, cfg: ImportConfig, opts: { resuming?: boolean; tableCreated?: boolean } = {}): Promise<Compiled> {
  const max = identLimit(conn)
  const errors: string[] = []
  const warnings: string[] = []
  const schema = checkIdent(cfg.schema, 128, 'schema')
  const table = checkIdent(cfg.table, max, 'table name')
  let tag = cfg.tagRows
  let columns: ImportColumn[]
  const seen = new Set<string>()
  const dup = (n: string) => {
    if (seen.has(n)) errors.push(`Target column ${n} is mapped twice.`)
    seen.add(n)
  }

  if (cfg.mode === 'create') {
    if (!opts.tableCreated && (await tableExists(conn, schema, table))) errors.push(`Table ${schema}.${table} already exists. Choose another name or use "Append to existing table".`)
    columns = cfg.columns.map((c) => {
      const target = checkIdent(c.target, max, 'column name')
      if (target === 'DL_IMPORT_ID' && tag) errors.push('DL_IMPORT_ID is reserved for row tagging.')
      dup(target)
      const type = normalizeType(c.type)
      if (c.dateMask) validateMask(c.dateMask)
      return { ...c, target, type }
    })
  } else {
    if (!(await tableExists(conn, schema, table))) {
      errors.push(`Table ${schema}.${table} does not exist.`)
      columns = []
    } else {
      const tcols = await tableColumns(conn, schema, table)
      const byName = new Map(tcols.map((c) => [c.name, c]))
      columns = []
      for (const c of cfg.columns) {
        const target = c.target.trim().toUpperCase()
        const tc = byName.get(target)
        if (!tc) {
          errors.push(`Column ${target} does not exist in ${table}.`)
          continue
        }
        const type = columnTypeText(tc)
        if (type.startsWith('UNSUPPORTED')) {
          errors.push(`Column ${target} has type ${tc.dataType}, which the importer cannot load.`)
          continue
        }
        dup(target)
        if (c.dateMask) validateMask(c.dateMask)
        columns.push({ ...c, target, type })
      }
      const missing = tcols.filter((c) => c.nullable === 'N' && !c.hasDefault && !seen.has(c.name) && c.name !== 'DL_IMPORT_ID')
      if (missing.length) errors.push(`NOT NULL column(s) without a default are not mapped: ${missing.map((c) => c.name).join(', ')}.`)
      if (tag && !byName.has('DL_IMPORT_ID')) {
        tag = false
        warnings.push(`${table} has no DL_IMPORT_ID column, so rows will not be tagged and "Delete imported rows" will not be available.`)
      }
    }
  }
  if (!columns.length && !errors.length) errors.push('Map at least one column.')

  const post: Compiled['post'] = []
  const pk = (cfg.primaryKey ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean)
  if (cfg.mode === 'create' && pk.length) {
    const unknown = pk.filter((c) => !seen.has(c))
    if (unknown.length) errors.push(`Primary key column(s) not in the table: ${unknown.join(', ')}.`)
    else post.push({ kind: 'constraint', sql: `ALTER TABLE ${schema}.${table} ADD CONSTRAINT ${shortName(table, '_PK', max)} PRIMARY KEY (${pk.join(', ')})` })
  }
  if (cfg.gatherStats) post.push({ kind: 'stats', sql: `BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => :o, tabname => :t); END;`, binds: { o: schema, t: table } })

  return {
    schema,
    table,
    columns,
    tag,
    createSql: cfg.mode === 'create' ? createTableSql(schema, table, columns, tag) : null,
    insertSql: insertSql(schema, table, columns, tag),
    post,
    warnings,
    errors,
  }
}

/** Reads the first data rows of a source for previews. */
async function firstRows(cfg: Pick<ImportConfig, 'sourceId' | 'sheet' | 'hasHeader' | 'delimiter' | 'encoding'>, n: number) {
  const { source, file } = await resolveSource(cfg.sourceId)
  const out: (string | null)[][] = []
  let first = true
  for await (const rec of readRows(file, { format: source.format, sheet: cfg.sheet, delimiter: cfg.delimiter, encoding: cfg.encoding })) {
    if (first && cfg.hasHeader) {
      first = false
      continue
    }
    first = false
    out.push(rec)
    if (out.length >= n) break
  }
  return out
}

function localIssues(c: ImportColumn, v: string | null): string | null {
  if (v == null) return null
  const lim = textLimit(c.type)
  if (lim) {
    const len = lim.bytes ? Buffer.byteLength(v, 'utf8') : v.length
    if (len > lim.size) return `${c.target}: value too long (${len} > ${lim.size}${lim.bytes ? ' bytes' : ''})`
  }
  return null
}

export async function planImport(input: unknown): Promise<ImportPlan> {
  const cfg = importConfigSchema.parse(input) as ImportConfig
  const profile = await getProfile(cfg.profileId)
  assertWritable(profile, cfg.schema)
  const { source } = await resolveSource(cfg.sourceId)
  return withConnection(profile.id, async (conn) => {
    const c = await compile(conn, cfg)
    const statements: ImportPlan['statements'] = []
    if (c.createSql) statements.push({ kind: 'create', sql: c.createSql })
    for (const p of c.post) statements.push({ kind: p.kind, sql: p.binds ? p.sql.replace(':o', `'${c.schema}'`).replace(':t', `'${c.table}'`) : p.sql })

    // Preview: transform the first rows and let Oracle convert them (SELECT ... FROM DUAL), so
    // date masks and numbers are validated exactly as the load will do it.
    const preview: ImportPlan['preview'] = []
    if (!c.errors.length) {
      await conn.execute(`ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'`)
      const sample = await firstRows(cfg, PREVIEW)
      const sql = `SELECT ${c.columns.map((col, i) => `${bindExpr(col, i + 1)} AS "c${i}"`).join(', ')} FROM DUAL`
      for (let r = 0; r < sample.length; r++) {
        const vals = c.columns.map((col) => transformValue(col, col.source == null ? null : sample[r]![col.source]))
        const issues = c.columns.map((col, i) => localIssues(col, vals[i]!)).filter((x): x is string => !!x)
        try {
          await conn.execute(sql, vals)
        } catch (err) {
          // Find the column(s) that fail by converting them one at a time.
          for (let i = 0; i < c.columns.length; i++) {
            if (typeClass(c.columns[i]!.type) === 'text' || typeClass(c.columns[i]!.type) === 'clob') continue
            try {
              await conn.execute(`SELECT ${bindExpr(c.columns[i]!, 1)} FROM DUAL`, [vals[i]])
            } catch (e) {
              issues.push(`${c.columns[i]!.target}: ${oracleErrorInfo(e).message}`)
            }
          }
          if (!issues.length) issues.push(oracleErrorInfo(err).message)
        }
        preview.push({ row: r + 1 + (cfg.hasHeader ? 1 : 0), values: vals, issues })
      }
    }
    let totalRows: number | null
    try {
      totalRows = (await profileSource(cfg.sourceId, { sheet: cfg.sheet ?? undefined, hasHeader: cfg.hasHeader, delimiter: (cfg.delimiter ?? undefined) as ProfileQuery['delimiter'], encoding: cfg.encoding as ProfileQuery['encoding'] })).rows
    } catch {
      totalRows = null
    }
    const bad = preview.filter((p) => p.issues.length).length
    const warnings = [...c.warnings]
    if (bad) warnings.push(`${bad} of the first ${preview.length} rows would be rejected — check types and date masks.`)
    if (source.origin === 'folder' && totalRows != null && totalRows > 500_000) warnings.push(`Large file (${totalRows.toLocaleString()} rows): expect the load to take a few minutes.`)
    return { schema: c.schema, table: c.table, mode: cfg.mode, statements, insertSql: c.insertSql, preview, warnings, errors: c.errors, totalRows }
  })
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

interface LoadState {
  rowsRead: number
  inserted: number
  rejected: number
  samples: ImportRejected[]
}

interface LoadSpec {
  sourceId: string
  sheet?: string | null
  hasHeader: boolean
  delimiter?: string | null
  encoding?: string
  columns: ImportColumn[]
  insertSql: string
  tagValue: string | null
  batchSize: number
  maxErrors: number
}

/** Streams the source into the table from state.rowsRead on; commits and checkpoints per batch. */
async function loadRows(ctx: JobContext, conn: Connection, spec: LoadSpec, state: LoadState, onBatch: () => Promise<void>) {
  const { source, file } = await resolveSource(spec.sourceId)
  const width = spec.columns.length + (spec.tagValue ? 1 : 0)
  let skip = state.rowsRead
  let first = true
  let batch: (string | null)[][] = []

  const flush = async () => {
    if (!batch.length) return
    const binds = batch.map((r) => {
      const v = spec.columns.map((c) => transformValue(c, c.source == null ? null : r[c.source]))
      if (spec.tagValue) v.push(spec.tagValue)
      return v
    })
    const maxSize = new Array<number>(width).fill(1)
    for (const b of binds) for (let i = 0; i < width; i++) if (b[i] != null) maxSize[i] = Math.max(maxSize[i]!, Buffer.byteLength(b[i]!, 'utf8'))
    const res = await conn.executeMany(spec.insertSql, binds, {
      bindDefs: maxSize.map((m) => ({ type: oracledb.STRING, maxSize: m })),
      batchErrors: true,
      autoCommit: false,
    })
    const errs = res.batchErrors ?? []
    for (const e of errs) {
      if (state.samples.length < MAX_SAMPLES) {
        const off = e.offset ?? 0
        state.samples.push({
          row: state.rowsRead + off + 1 + (spec.hasHeader ? 1 : 0),
          error: e.message.split('\n')[0]!,
          values: binds[off]!.slice(0, spec.columns.length).map((v: string | null) => (v != null && v.length > 120 ? `${v.slice(0, 120)}…` : v)),
        })
      }
    }
    await conn.commit()
    state.rowsRead += batch.length
    state.inserted += batch.length - errs.length
    state.rejected += errs.length
    batch = []
    await onBatch()
    if (state.rejected > spec.maxErrors) throw new Error(`Stopped: ${state.rejected.toLocaleString()} rejected rows exceed the limit of ${spec.maxErrors.toLocaleString()}. Committed rows are kept; fix the mapping and use Undo, or raise the limit and resume.`)
    ctx.throwIfCancelled()
  }

  for await (const rec of readRows(file, { format: source.format, sheet: spec.sheet, delimiter: spec.delimiter, encoding: spec.encoding, signal: ctx.signal })) {
    if (first && spec.hasHeader) {
      first = false
      continue
    }
    first = false
    if (skip > 0) {
      skip--
      continue
    }
    batch.push(rec)
    if (batch.length >= spec.batchSize) await flush()
  }
  ctx.throwIfCancelled()
  await flush()
}

/** Before resuming a load: detect a batch committed after the last checkpoint and skip it. */
async function reconcileResume<T extends LoadState>(ctx: JobContext, conn: Connection, c: Pick<Compiled, 'schema' | 'table' | 'tag'>, state: T, batchSize: number, totalRows: number | null): Promise<T> {
  if (!c.tag) {
    ctx.log('warn', 'Rows are not tagged, so a batch committed just before the interruption cannot be detected and may be loaded twice.')
    return state
  }
  const r = await one<{ N: number }>(conn, `SELECT COUNT(*) AS "N" FROM ${c.schema}.${c.table} WHERE DL_IMPORT_ID = :id`, { id: ctx.job.id })
  const fixed = reconcileLoad(state, Number(r?.N ?? 0), batchSize, totalRows)
  if (fixed.skipped) ctx.log('warn', `${c.table}: one batch (${fixed.skipped.toLocaleString()} source rows) was committed after the last checkpoint — skipping it on resume (its rejected-row samples are not available).`)
  return fixed.state
}

async function runPost(conn: Connection, post: Compiled['post'], ctx: JobContext) {
  const out: ImportResult['constraints'] = []
  for (const p of post) {
    ctx.throwIfCancelled()
    try {
      await conn.execute(p.sql, p.binds ?? {})
      out.push({ sql: p.sql, status: 'ok' })
      ctx.log('info', `${p.kind}: ${p.sql.slice(0, 160)}`)
    } catch (err) {
      const i = oracleErrorInfo(err)
      out.push({ sql: p.sql, status: 'failed', error: `${i.code}: ${i.message}` })
      ctx.log('warn', `${p.kind} failed (${i.code}): ${p.sql.slice(0, 160)}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Single-file import job
// ---------------------------------------------------------------------------------------------

type ImportJobConfig = ImportConfig & { fingerprint: { size: number; mtimeMs: number }; totalRows: number | null; tagEffective: boolean }
interface ImportCheckpoint extends LoadState {
  tableCreated: boolean
  loaded: boolean
  /** OBJECT_ID of the created table, so undo never drops a later table with the same name. */
  objectId?: number | null
}

async function objectIdOf(conn: Connection, schema: string, table: string): Promise<number | null> {
  const r = await one<{ ID: number }>(conn, `SELECT OBJECT_ID AS "ID" FROM ALL_OBJECTS WHERE OWNER = :o AND OBJECT_NAME = :t AND OBJECT_TYPE = 'TABLE'`, { o: schema, t: table })
  return r ? Number(r.ID) : null
}

export async function startImport(input: unknown): Promise<JobRecord> {
  const cfg = importConfigSchema.parse(input) as ImportConfig
  cfg.batchSize = Math.min(cfg.batchSize, labLimits().maxBatchSize)
  const profile = await getProfile(cfg.profileId)
  assertWritable(profile, cfg.schema)
  const { file, source } = await resolveSource(cfg.sourceId)
  const plan = await planImport(cfg)
  if (plan.errors.length) throw createError({ statusCode: 400, statusMessage: plan.errors.join(' ') })
  const tagEffective = await withConnection(profile.id, async (conn) => (await compile(conn, cfg)).tag)
  const job = await createJob<ImportJobConfig>({
    type: 'import',
    profileId: profile.id,
    title: `Import ${source.name} → ${plan.schema}.${plan.table}${plan.totalRows != null ? ` (${plan.totalRows.toLocaleString()} rows)` : ''}`,
    config: { ...cfg, schema: plan.schema, table: plan.table, fingerprint: await sourceFingerprint(file), totalRows: plan.totalRows, tagEffective },
    resumable: true,
  })
  await audit({ action: 'import.started', profileId: profile.id, target: `${plan.schema}.${plan.table}`, detail: `${source.name}, ${cfg.mode}, job ${job.id}`, outcome: 'requested' })
  return job
}

async function importExecutor(ctx: JobContext<ImportJobConfig, ImportCheckpoint>): Promise<ImportResult> {
  const cfg = ctx.job.config
  const profile = await getProfile(ctx.job.profileId)
  assertWritable(profile, cfg.schema)
  const { file } = await resolveSource(cfg.sourceId)
  const fp = await sourceFingerprint(file)
  if (ctx.job.checkpoint && (fp.size !== cfg.fingerprint.size || fp.mtimeMs !== cfg.fingerprint.mtimeMs)) {
    throw new Error('The source file changed since this import started; resuming would load inconsistent rows. Undo and start a new import.')
  }
  const t0 = Date.now()
  return withConnection(
    profile.id,
    async (conn) => {
      const cp: ImportCheckpoint = ctx.job.checkpoint ?? { tableCreated: false, loaded: false, rowsRead: 0, inserted: 0, rejected: 0, samples: [] }
      const c = await compile(conn, { ...cfg, tagRows: cfg.tagEffective }, { resuming: !!ctx.job.checkpoint, tableCreated: cp.tableCreated })
      if (c.errors.length) throw new Error(c.errors.join(' '))
      await conn.execute(`ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'`)
      if (c.createSql && !cp.tableCreated) {
        ctx.progress({ phase: 'creating table', message: c.createSql.split('\n')[0] })
        await conn.execute(c.createSql)
        cp.tableCreated = true
        cp.objectId = await objectIdOf(conn, c.schema, c.table)
        await ctx.checkpoint({ ...cp })
        ctx.log('info', `Created ${c.schema}.${c.table} (${c.columns.length} columns${c.tag ? ' + DL_IMPORT_ID' : ''})`)
      }
      if (!cp.loaded) {
        const total = cfg.totalRows ?? 0
        if (ctx.job.checkpoint) Object.assign(cp, await reconcileResume(ctx, conn, c, cp, cfg.batchSize, cfg.totalRows))
        let lastT = Date.now()
        let lastRows = cp.rowsRead
        ctx.progress({ phase: 'loading', done: cp.rowsRead, total, unit: 'rows', message: cp.rowsRead ? `Resuming after row ${cp.rowsRead.toLocaleString()}` : 'Reading source' })
        await loadRows(
          ctx,
          conn,
          { sourceId: cfg.sourceId, sheet: cfg.sheet, hasHeader: cfg.hasHeader, delimiter: cfg.delimiter, encoding: cfg.encoding, columns: c.columns, insertSql: c.insertSql, tagValue: c.tag ? ctx.job.id : null, batchSize: cfg.batchSize, maxErrors: cfg.maxErrors },
          cp,
          async () => {
            await ctx.checkpoint({ ...cp, samples: cp.samples.slice(0, MAX_SAMPLES) })
            const now = Date.now()
            const rate = now > lastT ? ((cp.rowsRead - lastRows) / (now - lastT)) * 1000 : 0
            lastT = now
            lastRows = cp.rowsRead
            ctx.progress({ phase: 'loading', done: cp.rowsRead, total: Math.max(total, cp.rowsRead), unit: 'rows', ratePerSec: Math.round(rate), message: `${cp.inserted.toLocaleString()} inserted · ${cp.rejected.toLocaleString()} rejected` })
          },
        )
        cp.loaded = true
        await ctx.checkpoint({ ...cp })
        ctx.log('info', `Loaded ${cp.inserted.toLocaleString()} rows, rejected ${cp.rejected.toLocaleString()}`)
      }
      ctx.progress({ phase: 'finishing', message: 'Constraints and statistics' })
      const constraints = await runPost(conn, c.post, ctx)
      const result: ImportResult = {
        schema: c.schema,
        table: c.table,
        rowsRead: cp.rowsRead,
        inserted: cp.inserted,
        rejected: cp.rejected,
        rejectedSamples: cp.samples,
        tableCreated: cp.tableCreated,
        constraints,
        seconds: Math.round((Date.now() - t0) / 100) / 10,
      }
      ctx.progress({ phase: 'done', done: cp.rowsRead, total: cp.rowsRead, message: `${cp.inserted.toLocaleString()} rows in ${c.schema}.${c.table}` })
      await audit({ action: 'import.completed', profileId: profile.id, target: `${c.schema}.${c.table}`, detail: `job ${ctx.job.id}: ${cp.inserted} inserted, ${cp.rejected} rejected`, outcome: 'ok' })
      return result
    },
    { action: 'import', callTimeoutMs: 600000 },
  )
}

// ---------------------------------------------------------------------------------------------
// Bundle import (datasets/*.bundle.json)
// ---------------------------------------------------------------------------------------------

export const bundleRequestSchema = z.object({
  profileId: z.string().min(1),
  schema: z.string().min(1).max(128),
  prefix: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,9}$/),
  batchSize: z.number().int().min(100).max(100000).default(5000),
  gatherStats: z.boolean().default(true),
  maxErrors: z.number().int().min(0).max(10_000_000).default(1000),
})
type BundleRequest = z.infer<typeof bundleRequestSchema>

export async function bundlePreflight(bundleId: string, input: unknown) {
  const req = bundleRequestSchema.parse(input)
  const profile = await getProfile(req.profileId)
  assertWritable(profile, req.schema)
  const m = await loadBundle(bundleId)
  const schema = req.schema.toUpperCase()
  const prefix = req.prefix.toUpperCase()
  return withConnection(profile.id, async (conn) => {
    const max = identLimit(conn)
    const errors: string[] = []
    const tables = []
    let totalBytes = 0
    for (const t of m.tables) {
      const name = `${prefix}${t.table}`
      const src = await bundleSource(t.file)
      if (!src) errors.push(`Missing file ${t.file} in the datasets folder.`)
      if (name.length > max) errors.push(`${name} exceeds ${max} characters; use a shorter prefix.`)
      const exists = await tableExists(conn, schema, name)
      if (exists) errors.push(`${schema}.${name} already exists — drop it first or choose another prefix.`)
      totalBytes += src?.sizeBytes ?? 0
      tables.push({ table: name, file: t.file, sizeBytes: src?.sizeBytes ?? null, exists, primaryKey: t.primaryKey, foreignKeys: t.foreignKeys.length, indexes: t.indexes.length, notes: t.notes ?? null })
    }
    return { schema, prefix, tables, totalBytes, errors, warnings: totalBytes > 50 * 1024 * 1024 ? [`About ${Math.round(totalBytes / 1048576)} MB of source data — the load takes a few minutes.`] : [] }
  })
}

type BundleJobConfig = BundleRequest & { bundleId: string; schema: string; prefix: string }
interface BundleCheckpoint {
  tableIndex: number
  created: string[]
  objectIds?: Record<string, number | null>
  state: LoadState | null
  loaded: Record<string, { inserted: number; rejected: number; rowsRead: number }>
  samples: Record<string, ImportRejected[]>
  postDone: boolean
}

export async function startBundle(bundleId: string, input: unknown): Promise<JobRecord> {
  const req = bundleRequestSchema.parse(input)
  const pf = await bundlePreflight(bundleId, req)
  if (pf.errors.length) throw createError({ statusCode: 400, statusMessage: pf.errors.join(' ') })
  const m = await loadBundle(bundleId)
  const job = await createJob<BundleJobConfig>({
    type: 'import-bundle',
    profileId: req.profileId,
    title: `Import bundle ${m.name} → ${pf.schema}.${pf.prefix}* (${m.tables.length} tables)`,
    config: { ...req, bundleId, schema: pf.schema, prefix: pf.prefix, batchSize: Math.min(req.batchSize, labLimits().maxBatchSize) },
    resumable: true,
  })
  await audit({ action: 'import.bundle.started', profileId: req.profileId, target: `${pf.schema}.${pf.prefix}*`, detail: `${bundleId}, job ${job.id}`, outcome: 'requested' })
  return job
}

async function bundleExecutor(ctx: JobContext<BundleJobConfig, BundleCheckpoint>) {
  const cfg = ctx.job.config
  const profile = await getProfile(ctx.job.profileId)
  assertWritable(profile, cfg.schema)
  const m = await loadBundle(cfg.bundleId)
  const S = cfg.schema
  const P = cfg.prefix
  const t0 = Date.now()
  const cp: BundleCheckpoint = ctx.job.checkpoint ?? { tableIndex: 0, created: [], state: null, loaded: {}, samples: {}, postDone: false }

  return withConnection(
    profile.id,
    async (conn) => {
      const max = identLimit(conn)
      await conn.execute(`ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'`)
      for (; cp.tableIndex < m.tables.length; cp.tableIndex++) {
        const t = m.tables[cp.tableIndex]!
        const name = `${P}${t.table}`
        const src = await bundleSource(t.file)
        if (!src) throw new Error(`Missing file ${t.file}`)
        const label = `${cp.tableIndex + 1}/${m.tables.length} ${name}`
        ctx.progress({ phase: `profiling ${label}`, done: cp.tableIndex, total: m.tables.length, unit: 'tables', message: t.file })
        const prof = await profileSource(src.id, { hasHeader: true }, ctx.signal)
        const columns: ImportColumn[] = prof.columns.map((col) => {
          const o = t.columns[col.header] ?? {}
          return { source: col.index, target: o.name ?? col.name, type: o.type ?? col.oracleType, dateMask: col.dateMask, decimalComma: col.decimalComma, trim: true, emptyAsNull: true }
        })
        const resumed = cp.created.includes(name)
        const c = await compile(conn, { profileId: profile.id, sourceId: src.id, hasHeader: true, schema: S, table: name, mode: 'create', columns, tagRows: true, batchSize: cfg.batchSize, maxErrors: cfg.maxErrors, gatherStats: false }, { tableCreated: resumed })
        if (c.errors.length) throw new Error(`${name}: ${c.errors.join(' ')}`)
        if (!resumed) {
          await conn.execute(c.createSql!)
          cp.created.push(name)
          cp.objectIds = { ...cp.objectIds, [name]: await objectIdOf(conn, S, name) }
          cp.state = { rowsRead: 0, inserted: 0, rejected: 0, samples: [] }
          await ctx.checkpoint({ ...cp })
          ctx.log('info', `Created ${S}.${name} (${columns.length} columns)`)
        }
        let state = cp.state ?? { rowsRead: 0, inserted: 0, rejected: 0, samples: [] }
        if (resumed) state = await reconcileResume(ctx, conn, c, state, cfg.batchSize, prof.rows)
        cp.state = state
        let lastT = Date.now()
        let lastRows = state.rowsRead
        await loadRows(
          ctx,
          conn,
          { sourceId: src.id, hasHeader: true, columns: c.columns, insertSql: c.insertSql, tagValue: ctx.job.id, batchSize: cfg.batchSize, maxErrors: cfg.maxErrors },
          state,
          async () => {
            await ctx.checkpoint({ ...cp, state: { ...state, samples: state.samples.slice(0, 50) } })
            const now = Date.now()
            const rate = now > lastT ? ((state.rowsRead - lastRows) / (now - lastT)) * 1000 : 0
            lastT = now
            lastRows = state.rowsRead
            ctx.progress({ phase: `loading ${label}`, done: state.rowsRead, total: Math.max(prof.rows, state.rowsRead), unit: 'rows', ratePerSec: Math.round(rate), message: `${state.inserted.toLocaleString()} inserted · ${state.rejected.toLocaleString()} rejected` })
          },
        )
        cp.loaded[name] = { inserted: state.inserted, rejected: state.rejected, rowsRead: state.rowsRead }
        cp.samples[name] = state.samples.slice(0, 50)
        cp.state = null
        await ctx.checkpoint({ ...cp, tableIndex: cp.tableIndex + 1 })
        ctx.log('info', `${name}: ${state.inserted.toLocaleString()} rows (${state.rejected} rejected)`)
      }

      let constraints: ImportResult['constraints'] = []
      if (!cp.postDone) {
        // Keys after the load (much faster than maintaining them row by row), parents before children.
        const post: Compiled['post'] = []
        for (const t of m.tables) {
          if (t.primaryKey.length) post.push({ kind: 'constraint', sql: `ALTER TABLE ${S}.${P}${t.table} ADD CONSTRAINT ${shortName(`${P}${t.table}`, '_PK', max)} PRIMARY KEY (${t.primaryKey.join(', ')})` })
        }
        for (const t of m.tables) {
          t.foreignKeys.forEach((fk, i) => {
            post.push({ kind: 'constraint', sql: `ALTER TABLE ${S}.${P}${t.table} ADD CONSTRAINT ${shortName(`${P}${t.table}`, `_FK${i + 1}`, max)} FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${S}.${P}${fk.references} (${fk.refColumns.join(', ')})` })
          })
          t.indexes.forEach((ix, i) => {
            post.push({ kind: 'index', sql: `CREATE INDEX ${S}.${shortName(`${P}${t.table}`, `_IX${i + 1}`, max)} ON ${S}.${P}${t.table} (${ix.join(', ')})` })
          })
        }
        if (cfg.gatherStats) {
          for (const t of m.tables) post.push({ kind: 'stats', sql: `BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => :o, tabname => :t); END;`, binds: { o: S, t: `${P}${t.table}` } })
        }
        ctx.progress({ phase: 'constraints & indexes', done: 0, total: post.length, unit: 'steps', message: 'Primary keys, foreign keys, indexes, statistics' })
        constraints = await runPost(conn, post, ctx)
        cp.postDone = true
        await ctx.checkpoint({ ...cp })
      }
      const tables = m.tables.map((t) => ({ table: `${P}${t.table}`, ...(cp.loaded[`${P}${t.table}`] ?? { inserted: 0, rejected: 0, rowsRead: 0 }), samples: cp.samples[`${P}${t.table}`] ?? [] }))
      const inserted = tables.reduce((a, t) => a + t.inserted, 0)
      ctx.progress({ phase: 'done', done: inserted, total: inserted, unit: 'rows', message: `${inserted.toLocaleString()} rows in ${tables.length} tables` })
      await audit({ action: 'import.bundle.completed', profileId: profile.id, target: `${S}.${P}*`, detail: `job ${ctx.job.id}: ${inserted} rows`, outcome: 'ok' })
      return { schema: S, prefix: P, bundle: m.name, tables, created: cp.created, constraints, seconds: Math.round((Date.now() - t0) / 100) / 10 }
    },
    { action: 'import-bundle', callTimeoutMs: 900000 },
  )
}

// ---------------------------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------------------------

export const undoRequestSchema = z.object({
  jobId: z.string().min(1),
  action: z.enum(['delete-rows', 'drop-tables']),
  confirm: z.string().max(200),
})

interface UndoConfig {
  importJobId: string
  action: 'delete-rows' | 'drop-tables'
  schema: string
  tables: string[]
  /** OBJECT_IDs recorded when the import created the tables (absent for older jobs). */
  objectIds: Record<string, number | null>
}

export async function startUndo(input: unknown): Promise<JobRecord> {
  const req = undoRequestSchema.parse(input)
  const src = await getJob(req.jobId)
  if (src.type !== 'import' && src.type !== 'import-bundle') throw createError({ statusCode: 400, statusMessage: 'Not an import job' })
  if (isJobActive(src.id)) throw createError({ statusCode: 409, statusMessage: 'The import is still running — cancel it first.' })
  const profile = await getProfile(src.profileId)
  const cfg = src.config as ImportJobConfig & BundleJobConfig
  assertWritable(profile, cfg.schema)
  let tables: string[]
  let expected: string
  if (src.type === 'import') {
    tables = [cfg.table]
    expected = cfg.table
    const created = (src.result as ImportResult | null)?.tableCreated ?? (src.checkpoint as ImportCheckpoint | null)?.tableCreated ?? false
    if (req.action === 'drop-tables' && !created) throw createError({ statusCode: 400, statusMessage: 'This import appended to an existing table; only "Delete imported rows" is available.' })
    if (req.action === 'delete-rows' && !cfg.tagEffective) throw createError({ statusCode: 400, statusMessage: 'Rows of this import were not tagged with DL_IMPORT_ID, so they cannot be selected for deletion.' })
  } else {
    if (req.action !== 'drop-tables') throw createError({ statusCode: 400, statusMessage: 'A bundle import is undone by dropping its tables.' })
    tables = [...((src.checkpoint as BundleCheckpoint | null)?.created ?? [])].reverse()
    expected = cfg.prefix
  }
  if (req.confirm.trim().toUpperCase() !== expected.toUpperCase()) throw createError({ statusCode: 400, statusMessage: `Type ${expected} to confirm.` })
  if (!tables.length) throw createError({ statusCode: 400, statusMessage: 'Nothing to undo: no tables were created by this job.' })
  const job = await createJob<UndoConfig>({
    type: 'import-undo',
    profileId: profile.id,
    title: `Undo import ${src.id.slice(0, 8)}: ${req.action === 'drop-tables' ? `drop ${tables.length} table(s)` : `delete rows from ${tables[0]}`}`,
    config: {
      importJobId: src.id,
      action: req.action,
      schema: cfg.schema,
      tables,
      objectIds:
        src.type === 'import'
          ? { [cfg.table]: (src.checkpoint as ImportCheckpoint | null)?.objectId ?? null }
          : ((src.checkpoint as BundleCheckpoint | null)?.objectIds ?? {}),
    },
  })
  await audit({ action: `import.undo.${req.action}`, profileId: profile.id, target: `${cfg.schema}.${tables.join(',')}`, detail: `import job ${src.id}, undo job ${job.id}`, outcome: 'requested' })
  return job
}

async function undoExecutor(ctx: JobContext<UndoConfig>) {
  const cfg = ctx.job.config
  const profile = await getProfile(ctx.job.profileId)
  assertWritable(profile, cfg.schema)
  return withConnection(
    profile.id,
    async (conn) => {
      const results: { table: string; status: 'ok' | 'failed' | 'missing' | 'skipped'; rows?: number; error?: string }[] = []
      ctx.progress({ phase: cfg.action, done: 0, total: cfg.tables.length, unit: 'tables' })
      for (const [i, t] of cfg.tables.entries()) {
        ctx.throwIfCancelled()
        const table = checkIdent(t, 128, 'table')
        if (!(await tableExists(conn, cfg.schema, table))) {
          results.push({ table, status: 'missing' })
          continue
        }
        try {
          if (cfg.action === 'drop-tables') {
            // Only drop the very object this import created: a table re-created later under the
            // same name (e.g. by a newer import) has a different OBJECT_ID / different tagged rows.
            const recorded = cfg.objectIds?.[table]
            const same = recorded != null
              ? (await objectIdOf(conn, cfg.schema, table)) === recorded
              : !!(await one(conn, `SELECT 1 AS "x" FROM ${cfg.schema}.${table} WHERE DL_IMPORT_ID = :id AND ROWNUM = 1`, { id: cfg.importJobId }).catch(() => null))
            if (!same) {
              results.push({ table, status: 'skipped', error: 'Table was re-created by another job since this import — not dropped.' })
              ctx.log('warn', `${table}: not created by this import any more (re-created since) — skipped`)
              continue
            }
            await conn.execute(`DROP TABLE ${cfg.schema}.${table} CASCADE CONSTRAINTS PURGE`)
            results.push({ table, status: 'ok' })
            ctx.log('info', `Dropped ${cfg.schema}.${table}`)
          } else {
            let total = 0
            for (;;) {
              const r = await conn.execute(`DELETE FROM ${cfg.schema}.${table} WHERE DL_IMPORT_ID = :id AND ROWNUM <= 50000`, { id: cfg.importJobId }, { autoCommit: true })
              total += r.rowsAffected ?? 0
              ctx.progress({ message: `${total.toLocaleString()} rows deleted from ${table}` })
              if (!r.rowsAffected) break
              ctx.throwIfCancelled()
            }
            results.push({ table, status: 'ok', rows: total })
            ctx.log('info', `Deleted ${total.toLocaleString()} rows from ${cfg.schema}.${table}`)
          }
        } catch (err) {
          const e = oracleErrorInfo(err)
          results.push({ table, status: 'failed', error: `${e.code}: ${e.message}` })
          ctx.log('error', `${table}: ${e.code} ${e.message}`)
        }
        ctx.progress({ done: i + 1 })
      }
      await audit({ action: `import.undo.${cfg.action}.completed`, profileId: profile.id, target: cfg.schema, detail: results.map((r) => `${r.table}:${r.status}`).join(', '), outcome: results.some((r) => r.status === 'failed') ? 'failed' : 'ok' })
      return { importJobId: cfg.importJobId, action: cfg.action, results }
    },
    { action: 'import-undo', callTimeoutMs: 600000 },
  )
}

// ---------------------------------------------------------------------------------------------
// Target metadata for the mapping UI
// ---------------------------------------------------------------------------------------------

export async function targetTables(profileId: string, schema: string) {
  const owner = checkIdent(schema, 128, 'schema')
  return withConnection(profileId, (conn) =>
    rows(
      conn,
      `SELECT t.TABLE_NAME AS "table", t.NUM_ROWS AS "numRows",
              (SELECT COUNT(*) FROM ALL_TAB_COLUMNS c WHERE c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME) AS "columns",
              (SELECT COUNT(*) FROM ALL_TAB_COLUMNS c WHERE c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME AND c.COLUMN_NAME = 'DL_IMPORT_ID') AS "tagged"
         FROM ALL_TABLES t WHERE t.OWNER = :o AND t.TABLE_NAME NOT LIKE 'BIN$%' ORDER BY t.TABLE_NAME`,
      { o: owner },
    ),
  )
}

export async function targetColumns(profileId: string, schema: string, table: string) {
  const owner = checkIdent(schema, 128, 'schema')
  const t = checkIdent(table, 128, 'table')
  return withConnection(profileId, async (conn) =>
    (await tableColumns(conn, owner, t)).map((c) => ({ name: c.name, type: columnTypeText(c), nullable: c.nullable === 'Y', hasDefault: !!c.hasDefault })),
  )
}

registerExecutor('import', importExecutor as any)
registerExecutor('import-bundle', bundleExecutor as any)
registerExecutor('import-undo', undoExecutor as any)

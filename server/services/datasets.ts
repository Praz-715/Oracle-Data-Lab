import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { H3Event } from 'h3'
import { z } from 'zod'
import type { ColumnProfile, DataSource, DatasetBundle, SourceFormat, SourceProfile } from '../../shared/types/lab'
import { ColumnStats, oracleName } from '../datasets/infer'
import { listSheets, readRows, sniffCsv } from '../datasets/reader'

// Data Sources: files in the datasets folder (read-only, never modified) plus files uploaded
// through the UI (stored under .data/uploads). Clients only ever see opaque source ids, so no
// request can make the server read an arbitrary path.

const EXT: Record<string, SourceFormat> = { '.csv': 'csv', '.tsv': 'csv', '.txt': 'csv', '.xlsx': 'xlsx' }
const PREVIEW_ROWS = 50

interface UploadMeta {
  id: string
  name: string
  file: string
  sizeBytes: number
  uploadedAt: string
}

export function datasetsDir() {
  return resolve(String(useRuntimeConfig().datasets?.dir || './datasets'))
}
function uploadDir() {
  return resolve(String(useRuntimeConfig().datasets?.uploadDir || './.data/uploads'))
}
const folderId = (rel: string) => `f_${createHash('sha1').update(rel.split(sep).join('/')).digest('hex').slice(0, 16)}`

async function walk(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 4) return out
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out, depth + 1)
    else if (EXT[extname(e.name).toLowerCase()]) out.push(p)
  }
  return out
}

async function summaryOf(id: string) {
  const c = await labStore().getItem<{ rows: number; columns: number; mtimeMs: number; size: number }>(`dsprofile-summary:${id}`)
  return c
}

export async function listSources(): Promise<DataSource[]> {
  const root = datasetsDir()
  const files = await walk(root)
  const out: DataSource[] = []
  for (const f of files) {
    const st = await stat(f)
    const rel = relative(root, f).split(sep).join('/')
    const id = folderId(rel)
    const sum = await summaryOf(id)
    const fresh = sum && sum.mtimeMs === st.mtimeMs && sum.size === st.size
    out.push({ id, name: basename(f), origin: 'folder', format: EXT[extname(f).toLowerCase()]!, path: rel, sizeBytes: st.size, modifiedAt: st.mtime.toISOString(), rows: fresh ? sum.rows : null, columns: fresh ? sum.columns : null })
  }
  const keys = await labStore().getKeys('uploads')
  for (const k of keys) {
    const m = await labStore().getItem<UploadMeta>(k)
    if (!m) continue
    const sum = await summaryOf(m.id)
    out.push({ id: m.id, name: m.name, origin: 'upload', format: EXT[extname(m.name).toLowerCase()] ?? 'csv', path: m.name, sizeBytes: m.sizeBytes, modifiedAt: m.uploadedAt, rows: sum?.rows ?? null, columns: sum?.columns ?? null })
  }
  return out.sort((a, b) => a.origin.localeCompare(b.origin) || a.path.localeCompare(b.path))
}

/** Maps an opaque source id to its file. Throws 404 for anything unknown. */
export async function resolveSource(id: string): Promise<{ source: DataSource; file: string }> {
  if (id.startsWith('u_')) {
    const m = await labStore().getItem<UploadMeta>(`uploads:${id}`)
    if (!m) throw createError({ statusCode: 404, statusMessage: 'Uploaded file not found' })
    const st = await stat(m.file).catch(() => null)
    if (!st) throw createError({ statusCode: 404, statusMessage: 'Uploaded file is missing on disk' })
    return { source: { id, name: m.name, origin: 'upload', format: EXT[extname(m.name).toLowerCase()] ?? 'csv', path: m.name, sizeBytes: st.size, modifiedAt: m.uploadedAt }, file: m.file }
  }
  const root = datasetsDir()
  for (const f of await walk(root)) {
    const rel = relative(root, f).split(sep).join('/')
    if (folderId(rel) === id) {
      const st = await stat(f)
      return { source: { id, name: basename(f), origin: 'folder', format: EXT[extname(f).toLowerCase()]!, path: rel, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() }, file: f }
    }
  }
  throw createError({ statusCode: 404, statusMessage: 'Data source not found' })
}

export async function sourceFingerprint(file: string) {
  const st = await stat(file)
  return { size: st.size, mtimeMs: st.mtimeMs }
}

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

/** Streams the raw request body to disk (no multipart buffering), enforcing the size limit. */
export async function uploadSource(event: H3Event): Promise<DataSource> {
  const raw = decodeURIComponent(getHeader(event, 'x-file-name') ?? '')
  const name = basename(raw).replace(/[^\w.\- ()]+/g, '_').slice(0, 120)
  const ext = extname(name).toLowerCase()
  if (!name || !EXT[ext]) throw createError({ statusCode: 400, statusMessage: 'Only .csv, .tsv, .txt and .xlsx files can be uploaded.' })
  const max = labLimits().maxUploadMb * 1024 * 1024
  const declared = Number(getHeader(event, 'content-length') ?? 0)
  if (declared > max) throw createError({ statusCode: 413, statusMessage: `File exceeds the ${labLimits().maxUploadMb} MB upload limit.` })

  const id = `u_${newId()}`
  const dir = join(uploadDir(), id)
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  let size = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > max) cb(createError({ statusCode: 413, statusMessage: `File exceeds the ${labLimits().maxUploadMb} MB upload limit.` }))
      else cb(null, chunk)
    },
  })
  try {
    await pipeline(event.node.req, limiter, createWriteStream(file))
    if (!size) throw createError({ statusCode: 400, statusMessage: 'Empty upload.' })
    if (EXT[ext] === 'xlsx') await listSheets(file)
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  const meta: UploadMeta = { id, name, file, sizeBytes: size, uploadedAt: nowIso() }
  await labStore().setItem(`uploads:${id}`, meta)
  await audit({ action: 'dataset.uploaded', target: name, detail: `${size} bytes`, outcome: 'ok' })
  return { id, name, origin: 'upload', format: EXT[ext]!, path: name, sizeBytes: size, modifiedAt: meta.uploadedAt, rows: null, columns: null }
}

export async function deleteUpload(id: string) {
  if (!id.startsWith('u_')) throw createError({ statusCode: 400, statusMessage: 'Only uploaded files can be deleted; files in the datasets folder are managed on disk.' })
  const m = await labStore().getItem<UploadMeta>(`uploads:${id}`)
  if (!m) throw createError({ statusCode: 404, statusMessage: 'Uploaded file not found' })
  await rm(join(uploadDir(), id), { recursive: true, force: true })
  await labStore().removeItem(`uploads:${id}`)
  for (const k of await labStore().getKeys(`dsprofile:${id}`)) await labStore().removeItem(k)
  await labStore().removeItem(`dsprofile-summary:${id}`)
  await audit({ action: 'dataset.deleted', target: m.name, outcome: 'ok' })
}

// ---------------------------------------------------------------------------------------------
// Profiling
// ---------------------------------------------------------------------------------------------

export const profileQuerySchema = z.object({
  sheet: z.string().max(200).optional(),
  hasHeader: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  delimiter: z.enum([',', ';', '\t', '|']).optional(),
  encoding: z.enum(['utf8', 'latin1']).optional(),
  refresh: z.enum(['1', '0']).optional(),
})
export type ProfileQuery = z.infer<typeof profileQuerySchema>

/** Full scan of a source: row count, per-column statistics and inferred Oracle types. */
export async function profileSource(id: string, q: ProfileQuery, signal?: AbortSignal): Promise<SourceProfile> {
  const { source, file } = await resolveSource(id)
  const fp = await sourceFingerprint(file)
  const sheets = source.format === 'xlsx' ? await listSheets(file) : []
  const sheet = source.format === 'xlsx' ? (q.sheet && sheets.includes(q.sheet) ? q.sheet : sheets[0] ?? null) : null
  const dialect = source.format === 'csv' ? await sniffCsv(file) : null
  const delimiter = source.format === 'csv' ? q.delimiter ?? dialect!.delimiter : null
  const encoding = source.format === 'csv' ? q.encoding ?? dialect!.encoding : 'utf8'
  const cacheKey = `dsprofile:${id}:${createHash('sha1').update(JSON.stringify([sheet, q.hasHeader, delimiter, encoding])).digest('hex').slice(0, 12)}`
  const cached = await labStore().getItem<{ fp: typeof fp; profile: SourceProfile }>(cacheKey)
  if (!q.refresh && cached && cached.fp.size === fp.size && cached.fp.mtimeMs === fp.mtimeMs) return cached.profile

  const t0 = Date.now()
  const stats: ColumnStats[] = []
  let headers: string[] = []
  const preview: (string | null)[][] = []
  let rows = 0
  let first = true
  for await (const rec of readRows(file, { format: source.format, sheet, delimiter, encoding, signal })) {
    if (first && q.hasHeader) {
      headers = rec.map((h, i) => (h ?? '').trim() || `COL${i + 1}`)
      first = false
      continue
    }
    first = false
    // Ragged rows: grow the column set and back-fill the new columns with nulls.
    while (stats.length < rec.length) {
      const i = stats.length
      const s = new ColumnStats(i, headers[i] ?? `COL${i + 1}`)
      for (let k = 0; k < rows; k++) s.add(null)
      stats.push(s)
    }
    for (let i = 0; i < stats.length; i++) stats[i]!.add(rec[i])
    if (preview.length < PREVIEW_ROWS) preview.push(rec.map((c) => (c == null || c === '' ? null : c)))
    rows++
  }
  for (let i = stats.length; i < headers.length; i++) {
    const s = new ColumnStats(i, headers[i]!)
    for (let k = 0; k < rows; k++) s.add(null)
    stats.push(s)
  }
  const used = new Set<string>()
  const columns: ColumnProfile[] = stats.map((s) => s.finish(oracleName(s.header, used)))
  const profile: SourceProfile = {
    sourceId: id,
    sheet,
    sheets,
    delimiter,
    encoding,
    hasHeader: q.hasHeader,
    rows,
    columns,
    preview,
    profiledAt: nowIso(),
    durationMs: Date.now() - t0,
  }
  await labStore().setItem(cacheKey, { fp, profile })
  await labStore().setItem(`dsprofile-summary:${id}`, { rows, columns: columns.length, ...fp })
  return profile
}

// ---------------------------------------------------------------------------------------------
// Bundles (datasets/*.bundle.json)
// ---------------------------------------------------------------------------------------------

const ident = z.string().regex(/^[A-Za-z][A-Za-z0-9_$#]{0,29}$/)
export const bundleManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().max(120),
  description: z.string().max(2000).default(''),
  license: z.string().max(200).nullable().default(null),
  url: z.string().max(500).nullable().default(null),
  defaultPrefix: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,9}$/).default('DS_'),
  tables: z
    .array(
      z.object({
        file: z.string().max(300),
        table: ident,
        primaryKey: z.array(ident).default([]),
        columns: z.record(z.string(), z.object({ name: ident.optional(), type: z.string().max(60).optional() })).default({}),
        foreignKeys: z.array(z.object({ columns: z.array(ident).min(1), references: ident, refColumns: z.array(ident).min(1) })).default([]),
        indexes: z.array(z.array(ident).min(1)).default([]),
        notes: z.string().max(500).optional(),
      }),
    )
    .min(1),
})
export type BundleManifest = z.infer<typeof bundleManifestSchema>

export async function loadBundle(id: string): Promise<BundleManifest> {
  for (const m of await readManifests()) if (m.id === id) return m
  throw createError({ statusCode: 404, statusMessage: `Bundle ${id} not found` })
}

async function readManifests(): Promise<BundleManifest[]> {
  const root = datasetsDir()
  let names: string[]
  try {
    names = (await readdir(root)).filter((n) => n.endsWith('.bundle.json'))
  } catch {
    return []
  }
  const out: BundleManifest[] = []
  for (const n of names) {
    try {
      out.push(bundleManifestSchema.parse(JSON.parse(await readFile(join(root, n), 'utf8'))))
    } catch (err) {
      console.warn(`[odl] ignoring invalid bundle manifest ${n}: ${(err as Error).message}`)
    }
  }
  return out
}

/** Source id of a bundle file path (relative to the datasets folder), or null if it is missing. */
export async function bundleSource(rel: string): Promise<{ id: string; sizeBytes: number } | null> {
  const f = resolve(datasetsDir(), rel)
  if (!f.startsWith(datasetsDir() + sep)) return null
  const st = await stat(f).catch(() => null)
  return st ? { id: folderId(relative(datasetsDir(), f)), sizeBytes: st.size } : null
}

export async function listBundles(): Promise<(DatasetBundle & { defaultPrefix: string })[]> {
  const out = []
  for (const m of await readManifests()) {
    const tables = []
    const missing: string[] = []
    for (const t of m.tables) {
      const s = await bundleSource(t.file)
      if (!s) missing.push(t.file)
      tables.push({ file: t.file, table: t.table, sourceId: s?.id ?? null, sizeBytes: s?.sizeBytes ?? null, primaryKey: t.primaryKey })
    }
    out.push({ id: m.id, name: m.name, description: m.description, license: m.license, url: m.url, defaultPrefix: m.defaultPrefix, tables, missing })
  }
  return out
}

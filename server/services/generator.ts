import { z } from 'zod'
import type { Connection } from 'oracledb'
import type { GeneratorConfig, JobRecord } from '../../shared/types/lab'
import { insertRows, reserveIds } from '../database/bulk'
import { withConnection } from '../database/driver'
import { ident, one, rows } from '../database/query'
import { CORE_TABLES, extSeqName, seqName, tableByKey, type TableDef } from '../generators/blueprint'
import { SIZE_PRESETS, estimateStorage } from '../generators/estimate'
import {
  DataModel,
  buildRefData,
  categoryRows,
  deriveCounts,
  expectedRows,
  idDemand,
  regionRows,
  warehouseRows,
  type Counts,
  type IdBases,
  type RefData,
} from '../generators/model'
import { createJob, registerExecutor, type JobContext } from '../jobs/runner'
import { assertWritable, getProfile } from './profiles'

const today = () => new Date().toISOString().slice(0, 10)

export const generatorConfigSchema = z
  .object({
    profileId: z.string().min(1),
    schema: z.string().trim().toUpperCase(),
    prefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,7}$/).default('DL_'),
    preset: z.enum(['small', 'medium', 'large', 'xl', 'custom']).default('small'),
    orders: z.coerce.number().int().min(100).default(17_000),
    seed: z.coerce.number().int().min(0).max(2 ** 31 - 1).default(20260101),
    batchSize: z.coerce.number().int().min(50).default(2_000),
    commitEvery: z.coerce.number().int().min(50).default(10_000),
    includeLobs: z.boolean().default(true),
    historyStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => `${new Date().getFullYear() - 3}-01-01`),
    historyEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(today),
    extensionRowsPerTable: z.coerce.number().int().min(0).max(10_000_000).default(10_000),
  })
  .transform((v) => (v.preset === 'custom' ? v : { ...v, orders: SIZE_PRESETS[v.preset].orders }))
  .refine((v) => v.historyStart < v.historyEnd, { message: 'historyStart must be before historyEnd', path: ['historyStart'] })

interface SchemaInspection {
  missing: string[]
  extTables: number
  lobTables: boolean
}

async function inspectSchema(conn: Connection, schema: string, prefix: string): Promise<SchemaInspection> {
  const found = await rows<{ t: string }>(
    conn,
    `SELECT TABLE_NAME AS "t" FROM ALL_TABLES WHERE OWNER = :s AND TABLE_NAME LIKE :p ESCAPE '\\'`,
    { s: schema, p: `${prefix.replace(/_/g, '\\_')}%` },
  )
  const names = new Set(found.map((r) => r.t.slice(prefix.length)))
  const required = CORE_TABLES.filter((t) => !t.lobTable && t.kind !== 'log').map((t) => t.key)
  let extTables = 0
  while (names.has(`EXT_${String(extTables + 1).padStart(3, '0')}`)) extTables++
  return {
    missing: required.filter((k) => !names.has(k)),
    extTables,
    lobTables: names.has('PRODUCT_REVIEWS') && names.has('PRODUCT_IMAGES'),
  }
}

export async function preflight(cfg: GeneratorConfig) {
  const profile = await getProfile(cfg.profileId)
  const schema = ident(cfg.schema, 'schema')
  const limits = labLimits()
  return withConnection(profile.id, async (conn) => {
    const insp = await inspectSchema(conn, schema, cfg.prefix)
    const includeLobs = cfg.includeLobs && insp.lobTables
    const estimate = estimateStorage({
      orders: cfg.orders,
      includeLobs,
      extensionTables: insp.extTables,
      extensionRowsPerTable: cfg.extensionRowsPerTable,
    })
    const warnings: string[] = []
    const errors: string[] = []
    if (insp.missing.length) errors.push(`Missing tables in ${schema}: ${insp.missing.map((k) => cfg.prefix + k).join(', ')}. Create the schema in Schema Designer first.`)
    if (cfg.includeLobs && !insp.lobTables) warnings.push('LOB tables were not created for this schema; CLOB/BLOB data will be skipped.')
    if (estimate.totalRows > limits.maxRows) errors.push(`Estimated ${estimate.totalRows.toLocaleString()} rows exceeds the limit of ${limits.maxRows.toLocaleString()} (NUXT_LIMITS_MAX_ROWS).`)
    if (cfg.batchSize > limits.maxBatchSize) errors.push(`Batch size exceeds the limit of ${limits.maxBatchSize} (NUXT_LIMITS_MAX_BATCH_SIZE).`)
    if (profile.mode !== 'lab' || !profile.allowedSchemas.includes(schema)) {
      errors.push(`Profile "${profile.name}" is not authorized to write to ${schema} (requires lab mode and ${schema} in authorized schemas).`)
    }
    let freeBytes: number | null = null
    try {
      const r = await one<{ b: number }>(
        conn,
        `SELECT SUM(m.TABLESPACE_SIZE - m.USED_SPACE) * MAX(t.BLOCK_SIZE) AS "b"
           FROM DBA_TABLESPACE_USAGE_METRICS m JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = m.TABLESPACE_NAME
           JOIN DBA_USERS u ON u.DEFAULT_TABLESPACE = m.TABLESPACE_NAME WHERE u.USERNAME = :s`,
        { s: schema },
      )
      freeBytes = r?.b != null ? Number(r.b) : null
      if (freeBytes != null && freeBytes < estimate.totalBytes * 1.2) {
        warnings.push(`Default tablespace has about ${(freeBytes / 1024 ** 3).toFixed(1)} GiB free (incl. autoextend); estimate needs ${(estimate.totalBytes / 1024 ** 3).toFixed(1)} GiB.`)
      }
    } catch {
      warnings.push('Could not check free tablespace space (DBA views not visible).')
    }
    return { schema, includeLobs, extTables: insp.extTables, estimate, freeBytes, warnings, errors, counts: deriveCounts(cfg.orders, insp.extTables, cfg.extensionRowsPerTable) }
  })
}

export async function startGeneration(cfg: GeneratorConfig): Promise<JobRecord> {
  const profile = await getProfile(cfg.profileId)
  assertWritable(profile, cfg.schema)
  const pf = await preflight(cfg)
  if (pf.errors.length) throw createError({ statusCode: 400, statusMessage: pf.errors.join(' ') })
  const job = await createJob<GeneratorConfig & { includeLobsEffective: boolean; extTables: number }>({
    type: 'data-generate',
    profileId: profile.id,
    title: `Generate ${pf.estimate.totalRows.toLocaleString()} rows into ${pf.schema}.${cfg.prefix}*`,
    config: { ...cfg, schema: pf.schema, includeLobsEffective: pf.includeLobs, extTables: pf.extTables },
    resumable: true,
  })
  await audit({ action: 'data.generate.started', profileId: profile.id, target: pf.schema, detail: `job ${job.id}, orders ${cfg.orders}, seed ${cfg.seed}`, outcome: 'requested' })
  return job
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GenCheckpoint {
  bases: IdBases
  refs: RefData
  counts: Counts
  phase: number
  phaseDone: number
  inserted: Record<string, number>
}

interface Phase {
  name: string
  units: number
  run: (conn: Connection, from: number, to: number) => Promise<Record<string, number>>
}

async function loadRefs(conn: Connection, S: string, P: string, jobId: string): Promise<RefData> {
  const T = (k: string) => `${S}.${P}${k}`
  const seq = (k: string) => `${S}.${seqName(P, tableByKey(k))}`
  const count = async (k: string) => Number((await one<{ n: number }>(conn, `SELECT COUNT(*) AS "n" FROM ${T(k)}`))!.n)

  if ((await count('REGIONS')) === 0) {
    const data = regionRows(jobId, 0)
    const base = await reserveIds(conn, seq('REGIONS'), data.length)
    await insertRows(conn, S, P, tableByKey('REGIONS'), regionRows(jobId, base))
    await conn.commit()
  }
  const regions = await rows<{ id: number; code: string }>(conn, `SELECT REGION_ID AS "id", REGION_CODE AS "code" FROM ${T('REGIONS')} ORDER BY REGION_ID`)
  if ((await count('CATEGORIES')) === 0) {
    const data = categoryRows(jobId, 0)
    const base = await reserveIds(conn, seq('CATEGORIES'), data.length)
    await insertRows(conn, S, P, tableByKey('CATEGORIES'), categoryRows(jobId, base))
    await conn.commit()
  }
  const categories = await rows<{ id: number; name: string; parentId: number | null }>(
    conn,
    `SELECT CATEGORY_ID AS "id", CATEGORY_NAME AS "name", PARENT_CATEGORY_ID AS "parentId" FROM ${T('CATEGORIES')} ORDER BY CATEGORY_ID`,
  )
  if ((await count('WAREHOUSES')) === 0) {
    const byCode = new Map(regions.map((r) => [r.code, r.id]))
    const data = warehouseRows(jobId, 0, byCode)
    const base = await reserveIds(conn, seq('WAREHOUSES'), data.length)
    await insertRows(conn, S, P, tableByKey('WAREHOUSES'), warehouseRows(jobId, base, byCode))
    await conn.commit()
  }
  const warehouses = await rows<{ id: number; regionId: number }>(
    conn,
    `SELECT WAREHOUSE_ID AS "id", REGION_ID AS "regionId" FROM ${T('WAREHOUSES')} ORDER BY WAREHOUSE_ID`,
  )
  return buildRefData(regions, categories, warehouses)
}

async function reserveBases(conn: Connection, S: string, P: string, counts: Counts, includeLobs: boolean): Promise<IdBases> {
  const demand = idDemand(counts, includeLobs)
  const seq = (k: string) => `${S}.${seqName(P, tableByKey(k))}`
  const b: IdBases = { region: 0, category: 0, warehouse: 0, supplier: 0, product: 0, customer: 0, order: 0, payment: 0, shipment: 0, return: 0, movement: 0, review: 0, image: 0, ext: 0 }
  b.supplier = await reserveIds(conn, seq('SUPPLIERS'), demand.supplier)
  b.product = await reserveIds(conn, seq('PRODUCTS'), demand.product)
  b.customer = await reserveIds(conn, seq('CUSTOMERS'), demand.customer)
  b.order = await reserveIds(conn, seq('ORDERS'), demand.order)
  b.payment = await reserveIds(conn, seq('PAYMENTS'), demand.payment)
  b.shipment = await reserveIds(conn, seq('SHIPMENTS'), demand.shipment)
  b.return = await reserveIds(conn, seq('RETURNS'), demand.return)
  b.movement = await reserveIds(conn, seq('INVENTORY_MOVEMENTS'), demand.movement)
  if (includeLobs) {
    b.review = await reserveIds(conn, seq('PRODUCT_REVIEWS'), demand.review)
    b.image = await reserveIds(conn, seq('PRODUCT_IMAGES'), demand.image)
  }
  if (demand.ext > 0) b.ext = await reserveIds(conn, `${S}.${extSeqName(P)}`, demand.ext)
  return b
}

type GenJobConfig = GeneratorConfig & { includeLobsEffective: boolean; extTables: number }

async function generateExecutor(ctx: JobContext<GenJobConfig, GenCheckpoint>) {
  const cfg = ctx.job.config
  const profile = await getProfile(ctx.job.profileId)
  assertWritable(profile, cfg.schema)
  const S = cfg.schema
  const P = cfg.prefix
  const includeLobs = cfg.includeLobsEffective
  const started = Date.now()

  return withConnection(
    profile.id,
    async (conn) => {
      let cp = ctx.job.checkpoint
      if (!cp) {
        ctx.progress({ phase: 'preparing', message: 'Loading reference data and reserving id ranges' })
        const counts = deriveCounts(cfg.orders, cfg.extTables, cfg.extensionRowsPerTable)
        const refs = await loadRefs(conn, S, P, ctx.job.id)
        const bases = await reserveBases(conn, S, P, counts, includeLobs)
        cp = { bases, refs, counts, phase: 0, phaseDone: 0, inserted: {} }
        await ctx.checkpoint(cp)
        ctx.log('info', `Reserved id ranges; orders ${bases.order}..${bases.order + counts.orders - 1}`)
      }
      const state = cp
      ctx.progress({ phase: 'building model', message: 'Precomputing distributions' })
      const model = new DataModel({
        seed: cfg.seed,
        jobId: ctx.job.id,
        includeLobs,
        historyStart: cfg.historyStart,
        historyEnd: cfg.historyEnd,
        counts: state.counts,
        bases: state.bases,
        refs: state.refs,
      })
      const t = (k: string): TableDef => tableByKey(k)
      const ins = (k: string, data: unknown[][]) => insertRows(conn, S, P, t(k), data)
      const c = state.counts

      const phases: Phase[] = [
        { name: 'suppliers', units: c.suppliers, run: async (_c, a, b) => ({ SUPPLIERS: await ins('SUPPLIERS', model.supplierRows(a, b)) }) },
        { name: 'products', units: c.products, run: async (_c, a, b) => ({ PRODUCTS: await ins('PRODUCTS', model.productRows(a, b)) }) },
        ...(includeLobs
          ? [{ name: 'product images (BLOB)', units: c.products, run: async (_c: Connection, a: number, b: number) => ({ PRODUCT_IMAGES: await ins('PRODUCT_IMAGES', model.imageRows(a, b)) }) }]
          : []),
        {
          name: 'inventory',
          units: c.products,
          run: async (_c, a, b) => {
            const { inventory, movements } = model.inventoryRows(a, b)
            return { INVENTORY: await ins('INVENTORY', inventory), INVENTORY_MOVEMENTS: await ins('INVENTORY_MOVEMENTS', movements) }
          },
        },
        { name: 'customers', units: c.customers, run: async (_c, a, b) => ({ CUSTOMERS: await ins('CUSTOMERS', model.customerRows(a, b)) }) },
        {
          name: 'orders',
          units: c.orders,
          run: async (_c, a, b) => {
            const o = model.orderBatch(a, b)
            const r: Record<string, number> = {}
            r.ORDERS = await ins('ORDERS', o.orders)
            r.ORDER_ITEMS = await ins('ORDER_ITEMS', o.items)
            r.PAYMENTS = await ins('PAYMENTS', o.payments)
            r.SHIPMENTS = await ins('SHIPMENTS', o.shipments)
            r.RETURNS = await ins('RETURNS', o.returns)
            if (includeLobs) r.PRODUCT_REVIEWS = await ins('PRODUCT_REVIEWS', o.reviews)
            return r
          },
        },
        ...Array.from({ length: c.extTables }, (_, i) => {
          const no = i + 1
          const key = `EXT_${String(no).padStart(3, '0')}`
          return { name: `${P}${key}`, units: c.extRows, run: async (_c: Connection, a: number, b: number) => ({ [key]: await ins(key, model.extensionRows(no, a, b)) }) }
        }),
      ]

      const expected = expectedRows(c, includeLobs)
      const totalExpected = Object.values(expected).reduce((n, v) => n + v, 0)
      let insertedTotal = Object.values(state.inserted).reduce((n, v) => n + v, 0)
      const rateWindow: { t: number; n: number }[] = []
      const batch = Math.min(cfg.batchSize, labLimits().maxBatchSize)

      for (let pi = state.phase; pi < phases.length; pi++) {
        const ph = phases[pi]!
        let done = pi === state.phase ? state.phaseDone : 0
        let sinceCommit = 0
        // Dimension rows are small: commit each batch. Facts commit every `commitEvery` units.
        const commitEvery = ph.name === 'orders' ? Math.max(batch, cfg.commitEvery) : batch
        while (done < ph.units) {
          ctx.throwIfCancelled()
          const to = Math.min(ph.units, done + batch)
          const r = await ph.run(conn, done, to)
          for (const [k, v] of Object.entries(r)) {
            state.inserted[k] = (state.inserted[k] ?? 0) + v
            insertedTotal += v
          }
          sinceCommit += to - done
          done = to
          if (sinceCommit >= commitEvery || done >= ph.units) {
            await conn.commit()
            sinceCommit = 0
            state.phase = pi
            state.phaseDone = done
            await ctx.checkpoint({ ...state, inserted: { ...state.inserted } })
          }
          const now = Date.now()
          rateWindow.push({ t: now, n: insertedTotal })
          while (rateWindow.length > 2 && now - rateWindow[0]!.t > 10_000) rateWindow.shift()
          const first = rateWindow[0]!
          const rate = now > first.t ? ((insertedTotal - first.n) * 1000) / (now - first.t) : 0
          ctx.progress({
            phase: ph.name,
            done: insertedTotal,
            total: Math.max(totalExpected, insertedTotal),
            unit: 'rows',
            ratePerSec: Math.round(rate),
            message: `${ph.name}: ${done.toLocaleString()} / ${ph.units.toLocaleString()} (phase ${pi + 1}/${phases.length})`,
          })
        }
        // Uncommitted rows of a cancelled batch are rolled back when the connection closes.
        state.phase = pi + 1
        state.phaseDone = 0
        await ctx.checkpoint({ ...state, inserted: { ...state.inserted } })
        ctx.log('info', `Phase ${ph.name} done (${ph.units.toLocaleString()} units)`)
      }

      const elapsedSec = (Date.now() - started) / 1000
      ctx.progress({ phase: 'done', done: insertedTotal, total: insertedTotal, message: 'All phases committed' })
      await audit({ action: 'data.generate.completed', profileId: profile.id, target: S, detail: `job ${ctx.job.id}: ${insertedTotal} rows`, outcome: 'ok' })
      return {
        schema: S,
        prefix: P,
        seed: cfg.seed,
        rowsInserted: insertedTotal,
        tables: state.inserted,
        elapsedSec,
        rowsPerSec: Math.round(insertedTotal / Math.max(1, elapsedSec)),
        bases: state.bases,
        counts: state.counts,
        historyStart: cfg.historyStart,
        historyEnd: cfg.historyEnd,
        note: 'Elapsed time covers this run only; resumed jobs report the final run.',
      }
    },
    { action: 'data-generate', callTimeoutMs: 600000 },
  )
}

registerExecutor('data-generate', generateExecutor as any)

import os from 'node:os'
import { z } from 'zod'
import type { Connection } from 'oracledb'
import type { BenchmarkConfig, BenchmarkEnvironment, BenchmarkResult } from '../../shared/types/lab'
import { LatencyHistogram } from '../benchmarks/histogram'
import { loadOlistKeys } from '../benchmarks/olist'
import { SCENARIOS, getScenario, inlineBinds, scenarioInfo, type BenchRanges, type Op, type ScenarioEnv, type WorkerState } from '../benchmarks/scenarios'
import { ActivitySampler, attachSqlText, summarizeActivity } from '../database/activity'
import { driverInfo, getConnection, withConnection } from '../database/driver'
import { detectEnvironment, versionMajorOf } from '../database/environment'
import { oracleErrorInfo } from '../database/errors'
import { ident, one, rows } from '../database/query'
import { Rng, hash32 } from '../generators/prng'
import { createJob, getJob, listJobs, registerExecutor, type JobContext } from '../jobs/runner'
import { ashTicks, createAwrSnapshot, dbNow, snapshotInfo } from './diagnostics-pack'
import { assertWritable, getProfile } from './profiles'

/** Retail key ranges are not used by the Olist scenarios (they sample real keys instead). */
const NO_RANGES: BenchRanges = { orderMin: 0, orderMax: 0, customerMin: 0, customerMax: 0, productMin: 0, productMax: 0, regionIds: [], dateMin: new Date(0), dateMax: new Date(0) }

export const benchmarkConfigSchema = z.object({
  profileId: z.string().min(1),
  schema: z.string().trim().toUpperCase(),
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,7}$/).default('DL_'),
  scenarioId: z.enum(SCENARIOS.map((s) => s.id) as [string, ...string[]]),
  concurrency: z.coerce.number().int().min(1).default(4),
  warmupSeconds: z.coerce.number().int().min(0).max(600).default(10),
  durationSeconds: z.coerce.number().int().min(5).default(60),
  thinkTimeMs: z.coerce.number().int().min(0).max(10_000).default(0),
  batchSize: z.coerce.number().int().min(1).max(50_000).default(100),
  readRatio: z.coerce.number().min(0).max(1).default(0.8),
  label: z.string().trim().max(120).default(''),
  capturePlan: z.boolean().default(true),
  cleanupAfter: z.boolean().default(true),
  confirmHeavy: z.boolean().default(false),
})

export function listScenarios() {
  return SCENARIOS.map(scenarioInfo)
}

export async function startBenchmark(cfg: BenchmarkConfig) {
  const profile = await getProfile(cfg.profileId)
  const schema = ident(cfg.schema, 'schema')
  const scenario = getScenario(cfg.scenarioId)
  const limits = labLimits()
  if (cfg.concurrency > limits.maxConcurrency) {
    throw createError({ statusCode: 400, statusMessage: `Concurrency limit is ${limits.maxConcurrency} (NUXT_LIMITS_MAX_CONCURRENCY)` })
  }
  if (cfg.durationSeconds + cfg.warmupSeconds > limits.maxBenchmarkSeconds) {
    throw createError({ statusCode: 400, statusMessage: `Warm-up + duration limit is ${limits.maxBenchmarkSeconds}s` })
  }
  if (scenario.writes) assertWritable(profile, schema)
  const heavy = scenario.writes || cfg.concurrency > limits.heavyConcurrencyThreshold || scenario.category === 'analytic'
  if (heavy && !cfg.confirmHeavy) {
    throw createError({ statusCode: 409, statusMessage: 'This benchmark writes data or generates heavy load. Confirm explicitly to run it.' })
  }
  const job = await createJob({
    type: 'benchmark',
    profileId: profile.id,
    title: `#${scenario.no} ${scenario.name} · ${cfg.concurrency} session(s) · ${cfg.durationSeconds}s${cfg.label ? ` · ${cfg.label}` : ''}`,
    config: { ...cfg, schema },
  })
  await audit({ action: 'benchmark.started', profileId: profile.id, target: schema, detail: `${scenario.id} c=${cfg.concurrency} d=${cfg.durationSeconds}s job ${job.id}`, outcome: 'requested' })
  return job
}

async function loadRanges(conn: Connection, S: string, P: string): Promise<BenchRanges> {
  const T = (k: string) => `${S}.${P}${k}`
  const v = async (sql: string) => (await one<{ v: any }>(conn, sql))?.v ?? null
  const r: BenchRanges = {
    orderMin: Number(await v(`SELECT MIN(ORDER_ID) AS "v" FROM ${T('ORDERS')}`)),
    orderMax: Number(await v(`SELECT MAX(ORDER_ID) AS "v" FROM ${T('ORDERS')}`)),
    customerMin: Number(await v(`SELECT MIN(CUSTOMER_ID) AS "v" FROM ${T('CUSTOMERS')}`)),
    customerMax: Number(await v(`SELECT MAX(CUSTOMER_ID) AS "v" FROM ${T('CUSTOMERS')}`)),
    productMin: Number(await v(`SELECT MIN(PRODUCT_ID) AS "v" FROM ${T('PRODUCTS')}`)),
    productMax: Number(await v(`SELECT MAX(PRODUCT_ID) AS "v" FROM ${T('PRODUCTS')}`)),
    regionIds: (await rows<{ id: number }>(conn, `SELECT REGION_ID AS "id" FROM ${T('REGIONS')}`)).map((x) => x.id),
    dateMin: (await v(`SELECT MIN(ORDER_DATE) AS "v" FROM ${T('ORDERS')}`)) ?? new Date(),
    dateMax: (await v(`SELECT MAX(ORDER_DATE) AS "v" FROM ${T('ORDERS')}`)) ?? new Date(),
  }
  if (!r.orderMax || !r.customerMax) throw new Error('No generated data found. Run the Data Generator for this schema first.')
  return r
}

async function captureEnvironment(conn: Connection, S: string, P: string): Promise<BenchmarkEnvironment> {
  const env = await detectEnvironment(conn)
  let dbCpuCount: number | null = null
  let dbPhysicalMemoryBytes: number | null = null
  try {
    const stats = await rows<{ n: string; v: number }>(conn, `SELECT STAT_NAME AS "n", VALUE AS "v" FROM V$OSSTAT WHERE STAT_NAME IN ('NUM_CPUS','PHYSICAL_MEMORY_BYTES')`)
    for (const r of stats) {
      if (r.n === 'NUM_CPUS') dbCpuCount = Number(r.v)
      else dbPhysicalMemoryBytes = Number(r.v)
    }
  } catch {
    // V$OSSTAT not visible: recorded as null
  }
  const like = `${P.replace(/_/g, '\\_')}%`
  const dataSize = await rows<{ table: string; rows: number | null }>(
    conn,
    `SELECT TABLE_NAME AS "table", NUM_ROWS AS "rows" FROM ALL_TABLES WHERE OWNER = :s AND TABLE_NAME LIKE :p ESCAPE '\\' AND TABLE_NAME NOT LIKE '%EXT\\_%' ESCAPE '\\' ORDER BY TABLE_NAME`,
    { s: S, p: like },
  ).catch(() => [])
  const indexes = await rows<{ table: string; index: string; columns: string }>(
    conn,
    `SELECT TABLE_NAME AS "table", INDEX_NAME AS "index", LISTAGG(COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY COLUMN_POSITION) AS "columns"
       FROM ALL_IND_COLUMNS WHERE TABLE_OWNER = :s AND TABLE_NAME LIKE :p ESCAPE '\\' AND TABLE_NAME NOT LIKE '%EXT\\_%' ESCAPE '\\'
      GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME, INDEX_NAME`,
    { s: S, p: like },
  ).catch(() => [])
  const cpus = os.cpus()
  return {
    oracleVersion: env.serverVersion,
    banner: env.banner,
    edition: env.edition,
    instanceName: env.instanceName,
    isRac: env.isRac,
    dbCpuCount,
    dbPhysicalMemoryBytes,
    appHost: { platform: `${os.platform()} ${os.release()}`, cpus: cpus.length, cpuModel: cpus[0]?.model ?? 'unknown', totalMemBytes: os.totalmem(), node: process.version },
    driverMode: driverInfo().mode,
    dataSize: dataSize.map((d) => ({ table: d.table, rows: d.rows == null ? null : Number(d.rows) })),
    indexes,
  }
}

async function seedWorker(conn: Connection, env: ScenarioEnv, w: WorkerState, n: number) {
  const T = `${env.S}.${env.P}BENCH_EVENTS`
  await conn.execute(
    `INSERT INTO ${T} (EVENT_ID, RUN_ID, WORKER_NO, EVENT_TS, CUSTOMER_ID, PRODUCT_ID, AMOUNT, PAYLOAD)
     SELECT ${env.S}.${env.P}BEV_SEQ.NEXTVAL, :run, :w, SYSTIMESTAMP, NULL, NULL, LEVEL, 'seed' FROM DUAL CONNECT BY LEVEL <= :n`,
    { run: env.runId, w: w.worker, n },
  )
  await conn.commit()
  const r = await conn.execute<{ ID: number }>(`SELECT EVENT_ID AS ID FROM ${T} WHERE RUN_ID = :run AND WORKER_NO = :w AND PAYLOAD = 'seed'`, { run: env.runId, w: w.worker })
  w.ids = (r.rows ?? []).map((x) => Number(x.ID))
  w.cursor = 0
}

const isTimeout = (msg: string, code: string) =>
  /timeout|timed out/i.test(msg) || ['DPI-1067', 'NJS-040', 'ORA-01013', 'ORA-03156'].includes(code)

async function execOp(conn: Connection, op: Op): Promise<number> {
  if (op.kind === 'query') {
    const r = await conn.execute(op.sql, op.binds as any, { maxRows: 1000 })
    return r.rows?.length ?? 0
  }
  if (op.kind === 'dml') {
    const r = await conn.execute(op.sql, op.binds as any, { autoCommit: !!op.autoCommit })
    if (op.commit && !op.autoCommit) await conn.commit()
    return r.rowsAffected ?? 0
  }
  const r = await conn.executeMany(op.sql, op.rows as any[], { autoCommit: false })
  if (op.commit) await conn.commit()
  return r.rowsAffected ?? op.rows.length
}

async function capturePlan(conn: Connection, tagId: string, sample: Op | null, topSqlId?: string | null): Promise<string | null> {
  // Preferred: the actual cursor plan from the shared pool (needs V$SQL / V$SQL_PLAN access) — of the
  // statement that used the most DB time in this run when known (mixed workloads), else by tag.
  try {
    const s = await one<{ id: string; child: number }>(
      conn,
      topSqlId
        ? `SELECT * FROM (SELECT SQL_ID AS "id", CHILD_NUMBER AS "child" FROM V$SQL WHERE SQL_ID = :t ORDER BY LAST_ACTIVE_TIME DESC) WHERE ROWNUM = 1`
        : `SELECT * FROM (SELECT SQL_ID AS "id", CHILD_NUMBER AS "child" FROM V$SQL
             WHERE SQL_TEXT LIKE :t AND SQL_TEXT NOT LIKE '%V$SQL%' ORDER BY LAST_ACTIVE_TIME DESC) WHERE ROWNUM = 1`,
      { t: topSqlId ?? `%ODL-BENCH ${tagId} */%` },
    )
    if (s) {
      const plan = await rows<{ l: string }>(
        conn,
        `SELECT PLAN_TABLE_OUTPUT AS "l" FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:id, :c, 'TYPICAL'))`,
        { id: s.id, c: s.child },
      )
      if (plan.length > 3) return plan.map((p) => p.l).join('\n')
    }
  } catch {
    // fall through to EXPLAIN PLAN
  }
  if (!sample || sample.kind === 'many') return null
  try {
    const stmtId = `ODL${Date.now()}`.slice(0, 30)
    await conn.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${stmtId}' FOR ${inlineBinds(sample.sql, sample.binds)}`)
    const plan = await rows<{ l: string }>(conn, `SELECT PLAN_TABLE_OUTPUT AS "l" FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :s, 'TYPICAL'))`, { s: stmtId })
    await conn.rollback()
    return `-- EXPLAIN PLAN (estimated; actual cursor plan not visible)\n${plan.map((p) => p.l).join('\n')}`
  } catch (err) {
    return `-- Plan unavailable: ${oracleErrorInfo(err).message}`
  }
}

async function benchmarkExecutor(ctx: JobContext<BenchmarkConfig>): Promise<BenchmarkResult> {
  const cfg = ctx.job.config
  const scenario = getScenario(cfg.scenarioId)
  const profile = await getProfile(ctx.job.profileId)
  if (scenario.writes) assertWritable(profile, cfg.schema)
  const S = cfg.schema
  const P = cfg.prefix

  const olistRun = scenarioInfo(scenario).dataset === 'olist'
  ctx.progress({ phase: 'preparing', message: olistRun ? 'Capturing environment and sampling real Olist keys' : 'Capturing environment and key ranges' })
  const { ranges, olist, environment, versionMajor } = await withConnection(profile.id, async (conn) => ({
    ranges: olistRun ? NO_RANGES : await loadRanges(conn, S, P),
    olist: olistRun ? await loadOlistKeys(conn, S, P) : undefined,
    environment: await captureEnvironment(conn, S, P),
    versionMajor: versionMajorOf(conn),
  }))

  const env: ScenarioEnv = { S, P, runId: ctx.job.id, versionMajor, batchSize: cfg.batchSize, readRatio: cfg.readRatio, ranges, olist }
  const licensed = profile.diagnosticsPack
  const diagNotes: string[] = []
  let sampler: ActivitySampler | null = null
  let diagConn: Connection | null = null
  let dbStart: string | null = null
  let beginSnap: number | null = null
  const benchSids = new Set<number>()
  const conns: Connection[] = []
  const hist = new LatencyHistogram()
  const secHist = new LatencyHistogram()
  const timeline: BenchmarkResult['timeline'] = []
  const errorSamples: string[] = []
  let ops = 0
  let rowsDone = 0
  let errors = 0
  let timeouts = 0
  let sample: Op | null = null
  let secOps = 0
  let secErrors = 0

  try {
    ctx.progress({ phase: 'connecting', message: `Opening ${cfg.concurrency} session(s)` })
    for (let i = 0; i < cfg.concurrency; i++) {
      conns.push(await getConnection(profile.id, { purpose: 'bench', size: cfg.concurrency, action: `bench:${scenario.id}`, callTimeoutMs: 60000 }))
    }
    const workers: WorkerState[] = conns.map((_, i) => ({ worker: i + 1, rng: new Rng(hash32(ctx.job.id, i)), opIndex: 0, ids: [], cursor: 0 }))

    // ASH-lite: sample V$SESSION every second on a separate session, attributing samples to this
    // run by the SIDs of its own sessions.
    for (const c of conns) {
      const r = await one<{ SID: string }>(c, `SELECT SYS_CONTEXT('USERENV', 'SID') AS "SID" FROM DUAL`)
      if (r) benchSids.add(Number(r.SID))
    }
    try {
      diagConn = await getConnection(profile.id, { action: 'ash-lite', callTimeoutMs: 120000 })
      sampler = new ActivitySampler(diagConn).start()
    } catch (err) {
      diagNotes.push(`ASH-lite sampling unavailable: ${oracleErrorInfo(err).message}`)
    }
    const markStart = async () => {
      if (!diagConn) return
      try {
        dbStart = await dbNow(diagConn)
        if (licensed) beginSnap = await createAwrSnapshot(profile, diagConn)
      } catch (err) {
        diagNotes.push(`AWR begin snapshot failed: ${oracleErrorInfo(err).message}`)
      }
    }
    if (scenario.seedPerWorker) {
      ctx.progress({ phase: 'seeding', message: `Seeding ${scenario.seedPerWorker.toLocaleString()} rows per session` })
      await Promise.all(workers.map((w, i) => seedWorker(conns[i]!, env, w, scenario.seedPerWorker!)))
    }

    const t0 = Date.now()
    const warmEnd = t0 + cfg.warmupSeconds * 1000
    const end = warmEnd + cfg.durationSeconds * 1000
    let measuring = cfg.warmupSeconds === 0
    let measureStart = measuring ? t0 : 0
    let secStart = measureStart
    let startMarked: Promise<void> | null = measuring ? markStart() : null

    const tick = setInterval(() => {
      const now = Date.now()
      if (!measuring && now >= warmEnd) {
        measuring = true
        measureStart = now
        secStart = now
        startMarked = markStart()
      }
      if (measuring && now - secStart >= 1000) {
        timeline.push({ t: Math.round((secStart - measureStart) / 1000), ops: secOps, p95Ms: Math.round(secHist.percentile(95) * 1000) / 1000, errors: secErrors })
        secOps = 0
        secErrors = 0
        secHist.reset()
        secStart = now
      }
      const elapsed = measuring ? (now - measureStart) / 1000 : 0
      ctx.progress({
        phase: measuring ? 'measuring' : 'warm-up',
        done: measuring ? Math.min(cfg.durationSeconds, Math.round(elapsed)) : 0,
        total: cfg.durationSeconds,
        unit: 'seconds',
        ratePerSec: timeline.length ? timeline[timeline.length - 1]!.ops : 0,
        message: measuring ? `${ops.toLocaleString()} ops · ${errors} errors` : `Warm-up ${Math.max(0, Math.ceil((warmEnd - now) / 1000))}s left`,
      })
    }, 250)

    const loop = async (w: WorkerState, conn: Connection) => {
      while (Date.now() < end && !ctx.signal.aborted) {
        if (scenario.id === 'delete' && w.cursor >= w.ids.length) {
          // Refill outside the measured window so DELETE always hits a real row.
          await conn.commit()
          await seedWorker(conn, env, w, scenario.seedPerWorker!)
          continue
        }
        const op = scenario.next(env, w)
        sample ??= op
        const startNs = process.hrtime.bigint()
        try {
          const n = await execOp(conn, op)
          const ms = Number(process.hrtime.bigint() - startNs) / 1e6
          if (measuring) {
            hist.record(ms)
            secHist.record(ms)
            ops++
            secOps++
            rowsDone += n
          }
        } catch (err) {
          const info = oracleErrorInfo(err)
          if (measuring) {
            errors++
            secErrors++
            if (isTimeout(info.message, info.code)) timeouts++
          }
          if (errorSamples.length < 20) errorSamples.push(`${info.code}: ${info.message}`)
          if (info.code === 'NJS-500' || info.code === 'NJS-501' || info.code === 'DPI-1080') break
          await conn.rollback().catch(() => {})
        }
        w.opIndex++
        if (cfg.thinkTimeMs) await new Promise((r) => setTimeout(r, cfg.thinkTimeMs))
      }
      await conn.commit().catch(() => {})
    }

    await Promise.all(workers.map((w, i) => loop(w, conns[i]!)))
    clearInterval(tick)
    sampler?.stop()
    ctx.throwIfCancelled()
    const finishedAt = new Date()
    const measuredSeconds = Math.max(0.001, (finishedAt.getTime() - (measureStart || finishedAt.getTime())) / 1000)
    await startMarked

    // Database activity of this run: ASH-lite always, Oracle ASH + AWR only when licensed.
    ctx.progress({ phase: 'activity', message: licensed ? 'Summarizing activity, AWR snapshot and ASH' : 'Summarizing sampled activity (ASH-lite)' })
    let activity: BenchmarkResult['activity'] = null
    let otherAas: number | null = null
    let ash: BenchmarkResult['ash'] = null
    let awr: BenchmarkResult['awr'] = null
    const bucketSec = cfg.durationSeconds > 300 ? 5 : 1
    if (sampler && diagConn) {
      if (sampler.error) diagNotes.push(`ASH-lite sampling stopped: ${sampler.error}`)
      else {
        const win = { source: 'ash-lite' as const, intervalSec: 1, t0: measureStart, t1: finishedAt.getTime(), bucketSec }
        activity = await attachSqlText(diagConn, summarizeActivity(sampler.ticks, { ...win, filter: (s) => benchSids.has(s.sid) }))
        otherAas = summarizeActivity(sampler.ticks, { ...win, filter: (s) => !benchSids.has(s.sid) }).aas
      }
    }
    if (licensed && diagConn) {
      try {
        const dbEnd = await dbNow(diagConn)
        if (beginSnap != null) {
          const endSnap = await createAwrSnapshot(profile, diagConn)
          awr = { ...(await snapshotInfo(profile, diagConn, beginSnap)), beginSnap, endSnap }
        }
        if (dbStart) {
          const ticks = await ashTicks(profile, diagConn, { from: dbStart, to: dbEnd, t0Ms: measureStart, sids: [...benchSids] })
          ash = await attachSqlText(diagConn, summarizeActivity(ticks, { source: 'ash', intervalSec: 1, t0: measureStart, bucketSec }))
        }
      } catch (err) {
        diagNotes.push(`ASH/AWR capture failed: ${oracleErrorInfo(err).code}: ${oracleErrorInfo(err).message}`)
      }
    }

    let plan: string | null = null
    if (cfg.capturePlan) {
      ctx.progress({ phase: 'capturing plan', message: 'Reading execution plan' })
      // Mixed scenarios: show the plan of the statement that dominated DB time (ASH-lite), else the sampled one.
      const top = activity?.topSql.find((q) => q.text?.includes('ODL-BENCH'))?.sqlId ?? null
      plan = await capturePlan(conns[0]!, (sample as Op | null)?.label ?? scenario.id, sample, scenario.category === 'mixed' ? top : null)
    }
    if (scenario.writes && cfg.cleanupAfter) {
      ctx.progress({ phase: 'cleanup', message: 'Deleting rows written by this run' })
      const c = conns[0]!
      for (;;) {
        const r = await c.execute(`DELETE FROM ${S}.${P}BENCH_EVENTS WHERE RUN_ID = :r AND ROWNUM <= 50000`, { r: ctx.job.id })
        await c.commit()
        if ((r.rowsAffected ?? 0) < 50000) break
      }
    }

    const result: BenchmarkResult = {
      scenario: scenarioInfo(scenario),
      config: cfg,
      startedAt: new Date(t0).toISOString(),
      finishedAt: finishedAt.toISOString(),
      measuredSeconds: Math.round(measuredSeconds * 100) / 100,
      operations: ops,
      rows: rowsDone,
      opsPerSec: Math.round((ops / measuredSeconds) * 100) / 100,
      rowsPerSec: Math.round((rowsDone / measuredSeconds) * 100) / 100,
      errors,
      timeouts,
      latency: hist.summary(),
      timeline,
      errorSamples,
      plan,
      environment,
      activity,
      otherAas,
      ash,
      awr,
      diagnosticsNote: diagNotes.length ? diagNotes.join(' · ') : null,
    }
    await audit({ action: 'benchmark.completed', profileId: profile.id, target: S, detail: `${scenario.id}: ${result.opsPerSec} ops/s p95 ${result.latency.p95Ms}ms`, outcome: 'ok' })
    return result
  } finally {
    sampler?.stop()
    await diagConn?.close().catch(() => {})
    await Promise.all(conns.map((c) => c.close().catch(() => {})))
  }
}

registerExecutor('benchmark', benchmarkExecutor as any)

export async function benchmarkHistory(profileId?: string) {
  const jobs = await listJobs({ type: 'benchmark', profileId, limit: 500 })
  const out = []
  for (const j of jobs) {
    const full = await getJob(j.id)
    const r = full.result as BenchmarkResult | null
    out.push({
      id: j.id,
      title: j.title,
      status: j.status,
      createdAt: j.createdAt,
      scenarioId: full.config.scenarioId,
      label: full.config.label,
      concurrency: full.config.concurrency,
      durationSeconds: full.config.durationSeconds,
      opsPerSec: r?.opsPerSec ?? null,
      rowsPerSec: r?.rowsPerSec ?? null,
      p50Ms: r?.latency.p50Ms ?? null,
      p95Ms: r?.latency.p95Ms ?? null,
      p99Ms: r?.latency.p99Ms ?? null,
      errors: r?.errors ?? null,
      oracleVersion: r?.environment.oracleVersion ?? null,
    })
  }
  return out
}

export function benchmarkCsv(r: BenchmarkResult): string {
  const head = ['scenario', 'label', 'concurrency', 'duration_s', 'operations', 'rows', 'ops_per_sec', 'rows_per_sec', 'avg_ms', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'errors', 'timeouts', 'oracle_version', 'started_at']
  const v = [
    r.scenario.id, r.config.label, r.config.concurrency, r.measuredSeconds, r.operations, r.rows, r.opsPerSec, r.rowsPerSec,
    r.latency.avgMs, r.latency.p50Ms, r.latency.p95Ms, r.latency.p99Ms, r.latency.maxMs, r.errors, r.timeouts, r.environment.oracleVersion, r.startedAt,
  ]
  const esc = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`
  const timeline = ['', 't_s,ops,p95_ms,errors', ...r.timeline.map((t) => `${t.t},${t.ops},${t.p95Ms},${t.errors}`)]
  return [head.join(','), v.map(esc).join(','), ...timeline].join('\n')
}

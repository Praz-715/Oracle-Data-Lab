import type { BenchmarkScenarioInfo } from '../../shared/types/lab'
import type { Rng } from '../generators/prng'
import { OLIST_SCENARIOS, type OlistKeys } from './olist'

export interface BenchRanges {
  orderMin: number
  orderMax: number
  customerMin: number
  customerMax: number
  productMin: number
  productMax: number
  regionIds: number[]
  dateMin: Date
  dateMax: Date
}

export interface ScenarioEnv {
  S: string
  P: string
  runId: string
  versionMajor: number
  batchSize: number
  readRatio: number
  ranges: BenchRanges
  /** Real key samples for the Olist scenarios. */
  olist?: OlistKeys
}

export interface WorkerState {
  worker: number
  rng: Rng
  opIndex: number
  /** BENCH_EVENTS ids seeded for this worker (update/delete scenarios). */
  ids: number[]
  cursor: number
}

export type Op =
  | { kind: 'query'; sql: string; binds: Record<string, unknown>; label?: string }
  | { kind: 'dml'; sql: string; binds: Record<string, unknown>; commit: boolean; autoCommit?: boolean; label?: string }
  | { kind: 'many'; sql: string; rows: unknown[][]; commit: boolean; label?: string }

export interface Scenario extends Omit<BenchmarkScenarioInfo, 'dataset' | 'defaultPrefix'> {
  dataset?: BenchmarkScenarioInfo['dataset']
  defaultPrefix?: string
  /** Rows to pre-seed per worker in BENCH_EVENTS (update/delete targets). */
  seedPerWorker?: number
  next(env: ScenarioEnv, w: WorkerState): Op
}

const DAY = 86400000
const tag = (id: string) => `/* ODL-BENCH ${id} */`

function rid(w: WorkerState, min: number, max: number) {
  return min + Math.floor(w.rng.next() * Math.max(1, max - min + 1))
}

function randomDay(env: ScenarioEnv, w: WorkerState, windowDays: number): [Date, Date] {
  const span = Math.max(1, (env.ranges.dateMax.getTime() - env.ranges.dateMin.getTime()) / DAY - windowDays)
  const start = new Date(env.ranges.dateMin.getTime() + Math.floor(w.rng.next() * span) * DAY)
  return [start, new Date(start.getTime() + windowDays * DAY)]
}

const T = (env: ScenarioEnv, k: string) => `${env.S}.${env.P}${k}`

// --- building blocks --------------------------------------------------------

const pkLookup = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'select-pk',
  sql: `SELECT ${tag('select-pk')} ORDER_ID, ORDER_NO, ORDER_DATE, STATUS, ORDER_TOTAL FROM ${T(env, 'ORDERS')} WHERE ORDER_ID = :id`,
  binds: { id: rid(w, env.ranges.orderMin, env.ranges.orderMax) },
})

const indexedFilter = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'select-indexed',
  sql: `SELECT ${tag('select-indexed')} ORDER_ID, ORDER_DATE, STATUS, ORDER_TOTAL FROM ${T(env, 'ORDERS')}
         WHERE CUSTOMER_ID = :c AND ORDER_DATE >= :d`,
  binds: { c: rid(w, env.ranges.customerMin, env.ranges.customerMax), d: new Date(env.ranges.dateMax.getTime() - 365 * DAY) },
})

const joinQuery = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'join',
  sql: `SELECT ${tag('join')} o.ORDER_ID, o.ORDER_DATE, c.CUSTOMER_CODE, p.SKU, p.PRODUCT_NAME, i.QUANTITY, i.LINE_TOTAL
          FROM ${T(env, 'ORDERS')} o
          JOIN ${T(env, 'CUSTOMERS')} c ON c.CUSTOMER_ID = o.CUSTOMER_ID
          JOIN ${T(env, 'ORDER_ITEMS')} i ON i.ORDER_ID = o.ORDER_ID
          JOIN ${T(env, 'PRODUCTS')} p ON p.PRODUCT_ID = i.PRODUCT_ID
         WHERE o.CUSTOMER_ID = :c`,
  binds: { c: rid(w, env.ranges.customerMin, env.ranges.customerMax) },
})

const insertSingle = (env: ScenarioEnv, w: WorkerState, commitEach = false): Op => ({
  kind: 'dml',
  label: 'insert-single',
  sql: `INSERT ${tag(commitEach ? 'commit' : 'insert-single')} INTO ${T(env, 'BENCH_EVENTS')}
          (EVENT_ID, RUN_ID, WORKER_NO, EVENT_TS, CUSTOMER_ID, PRODUCT_ID, AMOUNT, PAYLOAD)
        VALUES (${env.S}.${env.P}BEV_SEQ.NEXTVAL, :run, :w, SYSTIMESTAMP, :c, :p, :a, :pl)`,
  binds: {
    run: env.runId,
    w: w.worker,
    c: rid(w, env.ranges.customerMin, env.ranges.customerMax),
    p: rid(w, env.ranges.productMin, env.ranges.productMax),
    a: Math.round(w.rng.next() * 10_000_000) / 100,
    pl: `evt-${w.worker}-${w.opIndex}`,
  },
  commit: commitEach || (w.opIndex + 1) % env.batchSize === 0,
  autoCommit: commitEach,
})

const updateSeeded = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'dml',
  label: 'update',
  sql: `UPDATE ${tag('update')} ${T(env, 'BENCH_EVENTS')} SET AMOUNT = :a, PAYLOAD = :pl, EVENT_TS = SYSTIMESTAMP WHERE EVENT_ID = :id`,
  binds: { a: Math.round(w.rng.next() * 10_000_000) / 100, pl: `upd-${w.opIndex}`, id: w.ids.length ? w.ids[Math.floor(w.rng.next() * w.ids.length)]! : -1 },
  commit: (w.opIndex + 1) % env.batchSize === 0,
})

const RETAIL: Scenario[] = [
  {
    id: 'insert-single', no: 1, name: 'Single-row INSERT', category: 'write', writes: true, defaultConcurrency: 4, requiresSchema: true,
    description: 'One INSERT per round trip using a sequence; commit every "batch size" operations.',
    next: (env, w) => insertSingle(env, w),
  },
  {
    id: 'insert-bulk', no: 2, name: 'Bulk INSERT (array binding)', category: 'write', writes: true, defaultConcurrency: 2, requiresSchema: true,
    description: 'executeMany() with "batch size" rows per call, committed per batch. Reports rows/sec.',
    next: (env, w) => ({
      kind: 'many',
      label: 'insert-bulk',
      sql: `INSERT ${tag('insert-bulk')} INTO ${T(env, 'BENCH_EVENTS')} (EVENT_ID, RUN_ID, WORKER_NO, EVENT_TS, CUSTOMER_ID, PRODUCT_ID, AMOUNT, PAYLOAD)
            VALUES (${env.S}.${env.P}BEV_SEQ.NEXTVAL, :1, :2, SYSTIMESTAMP, :3, :4, :5, :6)`,
      rows: Array.from({ length: env.batchSize }, (_, k) => [
        env.runId, w.worker, rid(w, env.ranges.customerMin, env.ranges.customerMax), rid(w, env.ranges.productMin, env.ranges.productMax),
        Math.round(w.rng.next() * 10_000_000) / 100, `bulk-${w.worker}-${w.opIndex}-${k}`,
      ]),
      commit: true,
    }),
  },
  {
    id: 'select-pk', no: 3, name: 'SELECT by primary key', category: 'read', writes: false, defaultConcurrency: 4, requiresSchema: true,
    description: 'Random ORDER_ID lookup through the primary key index (bind variable).',
    next: pkLookup,
  },
  {
    id: 'select-indexed', no: 4, name: 'Indexed filtering', category: 'read', writes: false, defaultConcurrency: 4, requiresSchema: true,
    description: 'Orders of one customer in the last year via the (CUSTOMER_ID, ORDER_DATE) composite index.',
    next: indexedFilter,
  },
  {
    id: 'full-scan', no: 5, name: 'Full table scan', category: 'analytic', writes: false, defaultConcurrency: 1, requiresSchema: true,
    description: 'COUNT/SUM over ORDERS with a FULL hint, filtered by channel. Heavy on large datasets.',
    next: (env, w) => ({
      kind: 'query',
      label: 'full-scan',
      // The hint must directly follow SELECT or Oracle ignores it.
      sql: `SELECT /*+ FULL(o) */ ${tag('full-scan')} COUNT(*) AS N, SUM(o.ORDER_TOTAL) AS TOTAL FROM ${T(env, 'ORDERS')} o WHERE o.CHANNEL = :ch`,
      binds: { ch: w.rng.pick(['WEB', 'MOBILE', 'STORE', 'MARKETPLACE']) },
    }),
  },
  {
    id: 'update', no: 6, name: 'UPDATE', category: 'write', writes: true, defaultConcurrency: 4, requiresSchema: true, seedPerWorker: 5000,
    description: 'Single-row UPDATE by primary key on rows seeded for this run in BENCH_EVENTS.',
    next: updateSeeded,
  },
  {
    id: 'delete', no: 7, name: 'DELETE', category: 'write', writes: true, defaultConcurrency: 4, requiresSchema: true, seedPerWorker: 20000,
    description: 'Single-row DELETE by primary key on seeded BENCH_EVENTS rows (each row deleted once).',
    next: (env, w) => {
      const id = w.cursor < w.ids.length ? w.ids[w.cursor++]! : -1
      return {
        kind: 'dml',
        label: 'delete',
        sql: `DELETE ${tag('delete')} FROM ${T(env, 'BENCH_EVENTS')} WHERE EVENT_ID = :id`,
        binds: { id },
        commit: (w.opIndex + 1) % env.batchSize === 0,
      }
    },
  },
  {
    id: 'join', no: 8, name: 'Multi-table JOIN', category: 'read', writes: false, defaultConcurrency: 4, requiresSchema: true,
    description: 'ORDERS ⋈ CUSTOMERS ⋈ ORDER_ITEMS ⋈ PRODUCTS for one customer.',
    next: joinQuery,
  },
  {
    id: 'group-by', no: 9, name: 'GROUP BY aggregation', category: 'analytic', writes: false, defaultConcurrency: 2, requiresSchema: true,
    description: 'Revenue by category over a random 7-day window.',
    next: (env, w) => {
      const [d1, d2] = randomDay(env, w, 7)
      return {
        kind: 'query',
        label: 'group-by',
        sql: `SELECT ${tag('group-by')} cat.CATEGORY_NAME, COUNT(*) AS LINES, SUM(i.LINE_TOTAL) AS REVENUE
                FROM ${T(env, 'ORDERS')} o
                JOIN ${T(env, 'ORDER_ITEMS')} i ON i.ORDER_ID = o.ORDER_ID
                JOIN ${T(env, 'PRODUCTS')} p ON p.PRODUCT_ID = i.PRODUCT_ID
                JOIN ${T(env, 'CATEGORIES')} cat ON cat.CATEGORY_ID = p.CATEGORY_ID
               WHERE o.ORDER_DATE >= :d1 AND o.ORDER_DATE < :d2
               GROUP BY cat.CATEGORY_NAME`,
        binds: { d1, d2 },
      }
    },
  },
  {
    id: 'subquery', no: 10, name: 'Subquery', category: 'analytic', writes: false, defaultConcurrency: 2, requiresSchema: true,
    description: 'Customers in a region whose weekly spend exceeds a threshold (IN + GROUP BY/HAVING).',
    next: (env, w) => {
      const [d1, d2] = randomDay(env, w, 7)
      return {
        kind: 'query',
        label: 'subquery',
        sql: `SELECT ${tag('subquery')} c.CUSTOMER_ID, c.CUSTOMER_CODE, c.SEGMENT FROM ${T(env, 'CUSTOMERS')} c
               WHERE c.REGION_ID = :r
                 AND c.CUSTOMER_ID IN (SELECT o.CUSTOMER_ID FROM ${T(env, 'ORDERS')} o
                                        WHERE o.ORDER_DATE >= :d1 AND o.ORDER_DATE < :d2
                                        GROUP BY o.CUSTOMER_ID HAVING SUM(o.ORDER_TOTAL) > :t)`,
        binds: { r: w.rng.pick(env.ranges.regionIds.length ? env.ranges.regionIds : [0]), d1, d2, t: 1_000_000 },
      }
    },
  },
  {
    id: 'analytic', no: 11, name: 'Analytic functions', category: 'analytic', writes: false, defaultConcurrency: 2, requiresSchema: true,
    description: 'Running totals and RANK() per customer for a block of 20 customers.',
    next: (env, w) => {
      const c1 = rid(w, env.ranges.customerMin, Math.max(env.ranges.customerMin, env.ranges.customerMax - 20))
      return {
        kind: 'query',
        label: 'analytic',
        sql: `SELECT ${tag('analytic')} o.CUSTOMER_ID, o.ORDER_DATE, o.ORDER_TOTAL,
                     SUM(o.ORDER_TOTAL) OVER (PARTITION BY o.CUSTOMER_ID ORDER BY o.ORDER_DATE ROWS UNBOUNDED PRECEDING) AS RUNNING_TOTAL,
                     RANK() OVER (PARTITION BY o.CUSTOMER_ID ORDER BY o.ORDER_TOTAL DESC) AS SPEND_RANK
                FROM ${T(env, 'ORDERS')} o WHERE o.CUSTOMER_ID BETWEEN :c1 AND :c2`,
        binds: { c1, c2: c1 + 20 },
      }
    },
  },
  {
    id: 'literal-sql', no: 12, name: 'Literal SQL (no binds)', category: 'read', writes: false, defaultConcurrency: 4, requiresSchema: true,
    description: 'Same lookup as #3 but with the id inlined: every statement is a hard parse. Compare with #3.',
    next: (env, w) => {
      // The literal is a server-generated integer, never user input.
      const id = Math.floor(rid(w, env.ranges.orderMin, env.ranges.orderMax))
      return {
        kind: 'query',
        label: 'literal-sql',
        sql: `SELECT ${tag('literal-sql')} ORDER_ID, ORDER_NO, ORDER_DATE, STATUS, ORDER_TOTAL FROM ${T(env, 'ORDERS')} WHERE ORDER_ID = ${id}`,
        binds: {},
      }
    },
  },
  {
    id: 'concurrent-read', no: 13, name: 'Concurrent read workload', category: 'read', writes: false, defaultConcurrency: 8, requiresSchema: true,
    description: 'Mix of PK lookups (50%), indexed filters (30%) and joins (20%).',
    next: (env, w) => {
      const r = w.rng.next()
      return r < 0.5 ? pkLookup(env, w) : r < 0.8 ? indexedFilter(env, w) : joinQuery(env, w)
    },
  },
  {
    id: 'concurrent-write', no: 14, name: 'Concurrent write workload', category: 'write', writes: true, defaultConcurrency: 8, requiresSchema: true, seedPerWorker: 5000,
    description: 'Inserts (60%) and updates (40%) on BENCH_EVENTS from many sessions.',
    next: (env, w) => (w.rng.next() < 0.6 ? insertSingle(env, w) : updateSeeded(env, w)),
  },
  {
    id: 'mixed', no: 15, name: 'Mixed read/write', category: 'mixed', writes: true, defaultConcurrency: 8, requiresSchema: true, seedPerWorker: 5000,
    description: 'Reads (PK/indexed/join) vs writes (insert/update) at the configured read ratio.',
    next: (env, w) => {
      if (w.rng.next() < env.readRatio) {
        const r = w.rng.next()
        return r < 0.5 ? pkLookup(env, w) : r < 0.8 ? indexedFilter(env, w) : joinQuery(env, w)
      }
      return w.rng.next() < 0.6 ? insertSingle(env, w) : updateSeeded(env, w)
    },
  },
  {
    id: 'commit', no: 16, name: 'Transaction commit throughput', category: 'write', writes: true, defaultConcurrency: 4, requiresSchema: true,
    description: 'INSERT + COMMIT on every operation: dominated by redo write latency (log file sync).',
    next: (env, w) => insertSingle(env, w, true),
  },
  {
    id: 'pagination', no: 17, name: 'Pagination', category: 'read', writes: false, defaultConcurrency: 4, requiresSchema: true,
    description: 'Page of 50 orders in a 30-day window, random page 1–20 (OFFSET/FETCH on 12c+, ROWNUM on 11g).',
    next: (env, w) => {
      const [d1, d2] = randomDay(env, w, 30)
      const base = `SELECT ${tag('pagination')} ORDER_ID, ORDER_NO, ORDER_DATE, ORDER_TOTAL FROM ${T(env, 'ORDERS')}
                     WHERE ORDER_DATE >= :d1 AND ORDER_DATE < :d2 ORDER BY ORDER_DATE, ORDER_ID`
      const sql =
        env.versionMajor >= 12
          ? `${base} OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`
          : `SELECT * FROM (SELECT q_.*, ROWNUM rn_ FROM (${base}) q_ WHERE ROWNUM <= :off + :lim) WHERE rn_ > :off`
      return { kind: 'query', label: 'pagination', sql, binds: { d1, d2, off: w.rng.int(0, 19) * 50, lim: 50 } }
    },
  },
  {
    id: 'historical', no: 18, name: 'Historical analytical query', category: 'analytic', writes: false, defaultConcurrency: 1, requiresSchema: true,
    description: 'Monthly revenue and order count for the last 24 months (heavy scan/aggregation).',
    next: (env) => ({
      kind: 'query',
      label: 'historical',
      sql: `SELECT ${tag('historical')} TRUNC(ORDER_DATE, 'MM') AS MONTH, COUNT(*) AS ORDERS_CNT, SUM(ORDER_TOTAL) AS REVENUE
              FROM ${T(env, 'ORDERS')}
             WHERE ORDER_DATE >= ADD_MONTHS(:d, -24) AND STATUS <> 'CANCELLED'
             GROUP BY TRUNC(ORDER_DATE, 'MM') ORDER BY 1`,
      binds: { d: env.ranges.dateMax },
    }),
  },
]

export const SCENARIOS: Scenario[] = [...RETAIL, ...OLIST_SCENARIOS]

export function scenarioInfo(s: Scenario): BenchmarkScenarioInfo {
  const { next: _n, seedPerWorker: _s, ...info } = s
  return { ...info, dataset: info.dataset ?? 'retail', defaultPrefix: info.defaultPrefix ?? 'DL_' }
}

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id)
  if (!s) throw new Error(`Unknown scenario ${id}`)
  return s
}

/** Inlines server-generated bind values so the statement can be passed to EXPLAIN PLAN. */
export function inlineBinds(sql: string, binds: Record<string, unknown>): string {
  return sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name: string) => {
    if (!(name in binds)) return m
    const v = binds[name]
    if (v instanceof Date) {
      const p = (n: number) => String(n).padStart(2, '0')
      return `TO_DATE('${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}', 'YYYY-MM-DD HH24:MI:SS')`
    }
    if (typeof v === 'number') return String(v)
    return `'${String(v).replace(/'/g, "''")}'`
  })
}

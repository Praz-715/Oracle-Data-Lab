import { withConnection } from '../database/driver'
import { ident, panel, rows } from '../database/query'
import { getJob, listJobs } from '../jobs/runner'
import { MONITOR_PANELS } from './monitoring'
import { STORAGE_PANELS } from './storage-lab'

// Visual analytics over a generated dataset: every number is an aggregate query on the lab tables.

export async function datasetAnalytics(profileId: string, schemaIn: string, prefixIn: string, months: number) {
  const S = ident(schemaIn, 'schema')
  const P = ident(prefixIn, 'prefix')
  const T = (k: string) => `${S}.${P}${k}`
  const m = Math.min(Math.max(months, 1), 120)
  return withConnection(profileId, async (conn) => {
    const anchor = `(SELECT MAX(ORDER_DATE) FROM ${T('ORDERS')})`
    const monthly = await panel(() =>
      rows(
        conn,
        `SELECT TO_CHAR(TRUNC(o.ORDER_DATE, 'MM'), 'YYYY-MM') AS "month", COUNT(*) AS "orders", SUM(o.ORDER_TOTAL) AS "revenue",
                SUM(CASE WHEN o.STATUS = 'CANCELLED' THEN 1 ELSE 0 END) AS "cancelled", COUNT(DISTINCT o.CUSTOMER_ID) AS "customers"
           FROM ${T('ORDERS')} o WHERE o.ORDER_DATE >= ADD_MONTHS(TRUNC(${anchor}, 'MM'), -:m)
          GROUP BY TRUNC(o.ORDER_DATE, 'MM') ORDER BY 1`,
        { m },
      ),
    )
    const byChannel = await panel(() =>
      rows(
        conn,
        `SELECT o.CHANNEL AS "channel", COUNT(*) AS "orders", SUM(o.ORDER_TOTAL) AS "revenue"
           FROM ${T('ORDERS')} o WHERE o.ORDER_DATE >= ADD_MONTHS(${anchor}, -:m) GROUP BY o.CHANNEL ORDER BY 3 DESC`,
        { m },
      ),
    )
    const byStatus = await panel(() =>
      rows(
        conn,
        `SELECT o.STATUS AS "status", COUNT(*) AS "orders" FROM ${T('ORDERS')} o
          WHERE o.ORDER_DATE >= ADD_MONTHS(${anchor}, -:m) GROUP BY o.STATUS ORDER BY 2 DESC`,
        { m },
      ),
    )
    const byCategory = await panel(() =>
      rows(
        conn,
        `SELECT * FROM (
           SELECT pc.CATEGORY_NAME AS "category", SUM(i.LINE_TOTAL) AS "revenue", SUM(i.QUANTITY) AS "units",
                  ROUND(NVL(SUM(r.RETURN_QTY), 0) / NULLIF(SUM(i.QUANTITY), 0) * 100, 2) AS "returnRatePct"
             FROM ${T('ORDER_ITEMS')} i
             JOIN ${T('ORDERS')} o ON o.ORDER_ID = i.ORDER_ID
             JOIN ${T('PRODUCTS')} p ON p.PRODUCT_ID = i.PRODUCT_ID
             JOIN ${T('CATEGORIES')} c ON c.CATEGORY_ID = p.CATEGORY_ID
             JOIN ${T('CATEGORIES')} pc ON pc.CATEGORY_ID = NVL(c.PARENT_CATEGORY_ID, c.CATEGORY_ID)
             LEFT JOIN ${T('RETURNS')} r ON r.ORDER_ID = i.ORDER_ID AND r.LINE_NO = i.LINE_NO
            WHERE o.ORDER_DATE >= ADD_MONTHS(${anchor}, -:m)
            GROUP BY pc.CATEGORY_NAME ORDER BY 2 DESC) WHERE ROWNUM <= 15`,
        { m },
      ),
    )
    const topCustomers = await panel(() =>
      rows(
        conn,
        `SELECT * FROM (
           SELECT c.CUSTOMER_CODE AS "customer", c.SEGMENT AS "segment", c.LOYALTY_TIER AS "tier", COUNT(*) AS "orders", SUM(o.ORDER_TOTAL) AS "revenue"
             FROM ${T('ORDERS')} o JOIN ${T('CUSTOMERS')} c ON c.CUSTOMER_ID = o.CUSTOMER_ID
            WHERE o.ORDER_DATE >= ADD_MONTHS(${anchor}, -:m) AND o.STATUS <> 'CANCELLED'
            GROUP BY c.CUSTOMER_CODE, c.SEGMENT, c.LOYALTY_TIER ORDER BY 5 DESC) WHERE ROWNUM <= 10`,
        { m },
      ),
    )
    const weekday = await panel(() =>
      rows(
        conn,
        `SELECT TO_CHAR(o.ORDER_DATE, 'D') AS "dow", TO_CHAR(o.ORDER_DATE, 'DY', 'NLS_DATE_LANGUAGE=ENGLISH') AS "day", COUNT(*) AS "orders"
           FROM ${T('ORDERS')} o WHERE o.ORDER_DATE >= ADD_MONTHS(${anchor}, -:m)
          GROUP BY TO_CHAR(o.ORDER_DATE, 'D'), TO_CHAR(o.ORDER_DATE, 'DY', 'NLS_DATE_LANGUAGE=ENGLISH') ORDER BY 1`,
        { m },
      ),
    )
    return { schema: S, prefix: P, months: m, monthly, byChannel, byStatus, byCategory, topCustomers, weekday }
  }, { action: 'analytics', callTimeoutMs: 300000 })
}

/** Overview KPIs. Each block degrades to "unavailable" independently. */
export async function overview(profileId: string) {
  const jobs = await listJobs({ profileId, limit: 500 })
  let syntheticRows = 0
  for (const j of jobs.filter((x) => x.type === 'data-generate' && x.status === 'succeeded')) {
    const full = await getJob(j.id)
    syntheticRows += Number((full.result as any)?.rowsInserted ?? 0)
  }
  const runningGen = jobs.find((j) => j.type === 'data-generate' && j.status === 'running')
  const latestBench = jobs.find((j) => j.type === 'benchmark')
  let latestBenchResult = null
  if (latestBench) {
    const full = await getJob(latestBench.id)
    const r = full.result as any
    latestBenchResult = { id: latestBench.id, title: latestBench.title, status: latestBench.status, createdAt: latestBench.createdAt, opsPerSec: r?.opsPerSec ?? null, p95Ms: r?.latency?.p95Ms ?? null, errors: r?.errors ?? null, timeline: r?.timeline ?? [] }
  }

  return withConnection(profileId, async (conn) => {
    const sessions = await MONITOR_PANELS.summary!(conn, {})
    const sysstat = await MONITOR_PANELS.sysstat!(conn, {})
    const tablespaces = await STORAGE_PANELS.tablespaces!(conn, {}, profileId)
    const objects = await panel(async () => {
      const r = await rows<{ type: string; n: number }>(
        conn,
        `SELECT OBJECT_TYPE AS "type", COUNT(*) AS "n" FROM ALL_OBJECTS WHERE OWNER = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') GROUP BY OBJECT_TYPE`,
      )
      return {
        schema: null as string | null,
        total: r.reduce((a, x) => a + Number(x.n), 0),
        tables: Number(r.find((x) => x.type === 'TABLE')?.n ?? 0),
      }
    })
    return {
      sessions,
      sysstat,
      tablespaces,
      objects,
      syntheticRows,
      currentInsertRate: runningGen ? { jobId: runningGen.id, ratePerSec: runningGen.progress.ratePerSec ?? 0, phase: runningGen.progress.phase } : null,
      latestBenchmark: latestBenchResult,
      jobs: { running: jobs.filter((j) => j.status === 'running').length, failed24h: jobs.filter((j) => j.status === 'failed' && Date.now() - Date.parse(j.createdAt) < 86_400_000).length },
    }
  }, { action: 'overview' })
}

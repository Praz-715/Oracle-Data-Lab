import type { Connection } from 'oracledb'
import { rows } from '../database/query'
import type { Op, Scenario, ScenarioEnv, WorkerState } from './scenarios'

// Benchmark scenarios on the imported Olist e-commerce bundle (real, skewed data: ~100k orders,
// 1M geolocation rows). All read-only — imported data is never modified by a benchmark. Keys are
// strings (md5 ids), so a sample of real keys is loaded once per run and workers pick from it.

export interface OlistKeys {
  orderIds: string[]
  customerUniqueIds: string[]
  sellerIds: string[]
  zips: string[]
  dateMin: Date
  dateMax: Date
}

const DAY = 86400000
const tag = (id: string) => `/* ODL-BENCH ${id} */`
const T = (env: ScenarioEnv, k: string) => `${env.S}.${env.P}${k}`
const pick = <V>(w: WorkerState, arr: V[]): V => arr[Math.floor(w.rng.next() * arr.length)]!
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const WORDS = ['%atraso%', '%defeito%', '%entrega%', '%recebi%', '%qualidade%', '%prazo%', '%errado%', '%produto%']

function keys(env: ScenarioEnv): OlistKeys {
  if (!env.olist) throw new Error('Olist keys not loaded')
  return env.olist
}

/** Random [from, to) window of `days` inside the order history, as 'YYYY-MM-DD' strings. */
function window(env: ScenarioEnv, w: WorkerState, days: number): { d1: string; d2: string } {
  const k = keys(env)
  const span = Math.max(1, (k.dateMax.getTime() - k.dateMin.getTime()) / DAY - days)
  const start = new Date(k.dateMin.getTime() + Math.floor(w.rng.next() * span) * DAY)
  return { d1: ymd(start), d2: ymd(new Date(start.getTime() + days * DAY)) }
}

const orderDetail = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'ol-order-detail',
  sql: `SELECT ${tag('ol-order-detail')} o.ORDER_ID, o.ORDER_STATUS, o.ORDER_PURCHASE_TIMESTAMP, i.ORDER_ITEM_ID, p.PRODUCT_CATEGORY_NAME,
                i.PRICE, i.FREIGHT_VALUE, s.SELLER_CITY, s.SELLER_STATE
           FROM ${T(env, 'ORDERS')} o
           JOIN ${T(env, 'ORDER_ITEMS')} i ON i.ORDER_ID = o.ORDER_ID
           JOIN ${T(env, 'PRODUCTS')} p ON p.PRODUCT_ID = i.PRODUCT_ID
           JOIN ${T(env, 'SELLERS')} s ON s.SELLER_ID = i.SELLER_ID
          WHERE o.ORDER_ID = :id`,
  binds: { id: pick(w, keys(env).orderIds) },
})

const customerHistory = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'ol-customer-history',
  sql: `SELECT ${tag('ol-customer-history')} o.ORDER_ID, o.ORDER_PURCHASE_TIMESTAMP, o.ORDER_STATUS,
                SUM(i.PRICE + i.FREIGHT_VALUE) AS TOTAL, COUNT(*) AS ITEMS
           FROM ${T(env, 'CUSTOMERS')} c
           JOIN ${T(env, 'ORDERS')} o ON o.CUSTOMER_ID = c.CUSTOMER_ID
           JOIN ${T(env, 'ORDER_ITEMS')} i ON i.ORDER_ID = o.ORDER_ID
          WHERE c.CUSTOMER_UNIQUE_ID = :u
          GROUP BY o.ORDER_ID, o.ORDER_PURCHASE_TIMESTAMP, o.ORDER_STATUS
          ORDER BY o.ORDER_PURCHASE_TIMESTAMP DESC`,
  binds: { u: pick(w, keys(env).customerUniqueIds) },
})

const geoZip = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'ol-geo-zip',
  sql: `SELECT ${tag('ol-geo-zip')} COUNT(*) AS POINTS, AVG(GEOLOCATION_LAT) AS LAT, AVG(GEOLOCATION_LNG) AS LNG, MIN(GEOLOCATION_CITY) AS CITY
           FROM ${T(env, 'GEOLOCATION')} WHERE GEOLOCATION_ZIP_CODE_PREFIX = :z`,
  binds: { z: pick(w, keys(env).zips) },
})

const categoryReport = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'ol-category-report',
  sql: `SELECT ${tag('ol-category-report')} * FROM (
           SELECT NVL(t.PRODUCT_CATEGORY_NAME_ENGLISH, NVL(p.PRODUCT_CATEGORY_NAME, 'unknown')) AS CATEGORY,
                  COUNT(DISTINCT o.ORDER_ID) AS ORDERS, SUM(i.PRICE) AS REVENUE, ROUND(AVG(i.FREIGHT_VALUE), 2) AS AVG_FREIGHT
             FROM ${T(env, 'ORDERS')} o
             JOIN ${T(env, 'ORDER_ITEMS')} i ON i.ORDER_ID = o.ORDER_ID
             JOIN ${T(env, 'PRODUCTS')} p ON p.PRODUCT_ID = i.PRODUCT_ID
             LEFT JOIN ${T(env, 'CATEGORY_TRANSLATION')} t ON t.PRODUCT_CATEGORY_NAME = p.PRODUCT_CATEGORY_NAME
            WHERE o.ORDER_PURCHASE_TIMESTAMP >= TO_DATE(:d1, 'YYYY-MM-DD') AND o.ORDER_PURCHASE_TIMESTAMP < TO_DATE(:d2, 'YYYY-MM-DD')
            GROUP BY NVL(t.PRODUCT_CATEGORY_NAME_ENGLISH, NVL(p.PRODUCT_CATEGORY_NAME, 'unknown'))
            ORDER BY REVENUE DESC)
          WHERE ROWNUM <= 20`,
  binds: window(env, w, 90),
})

const sellerDashboard = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'ol-seller-dashboard',
  sql: `SELECT ${tag('ol-seller-dashboard')} TRUNC(o.ORDER_PURCHASE_TIMESTAMP, 'MM') AS MONTH, COUNT(DISTINCT o.ORDER_ID) AS ORDERS,
                SUM(i.PRICE) AS REVENUE, SUM(i.FREIGHT_VALUE) AS FREIGHT,
                SUM(CASE WHEN o.ORDER_DELIVERED_CUSTOMER_DATE > o.ORDER_ESTIMATED_DELIVERY_DATE THEN 1 ELSE 0 END) AS LATE_ITEMS
           FROM ${T(env, 'ORDER_ITEMS')} i
           JOIN ${T(env, 'ORDERS')} o ON o.ORDER_ID = i.ORDER_ID
          WHERE i.SELLER_ID = :s
            AND o.ORDER_PURCHASE_TIMESTAMP >= TO_DATE(:d1, 'YYYY-MM-DD') AND o.ORDER_PURCHASE_TIMESTAMP < TO_DATE(:d2, 'YYYY-MM-DD')
          GROUP BY TRUNC(o.ORDER_PURCHASE_TIMESTAMP, 'MM')
          ORDER BY 1`,
  binds: { s: pick(w, keys(env).sellerIds), ...window(env, w, 180) },
})

const deliverySla = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'ol-delivery-sla',
  sql: `SELECT ${tag('ol-delivery-sla')} c.CUSTOMER_STATE, COUNT(*) AS DELIVERED,
                SUM(CASE WHEN o.ORDER_DELIVERED_CUSTOMER_DATE > o.ORDER_ESTIMATED_DELIVERY_DATE THEN 1 ELSE 0 END) AS LATE,
                ROUND(AVG(o.ORDER_DELIVERED_CUSTOMER_DATE - o.ORDER_PURCHASE_TIMESTAMP), 1) AS AVG_DAYS
           FROM ${T(env, 'ORDERS')} o
           JOIN ${T(env, 'CUSTOMERS')} c ON c.CUSTOMER_ID = o.CUSTOMER_ID
          WHERE o.ORDER_STATUS = 'delivered'
            AND o.ORDER_PURCHASE_TIMESTAMP >= TO_DATE(:d1, 'YYYY-MM-DD') AND o.ORDER_PURCHASE_TIMESTAMP < TO_DATE(:d2, 'YYYY-MM-DD')
          GROUP BY c.CUSTOMER_STATE
          ORDER BY LATE DESC`,
  binds: window(env, w, 60),
})

const reviewSearch = (env: ScenarioEnv, w: WorkerState): Op => ({
  kind: 'query',
  label: 'ol-review-search',
  sql: `SELECT ${tag('ol-review-search')} COUNT(*) AS REVIEWS, ROUND(AVG(REVIEW_SCORE), 2) AS AVG_SCORE
           FROM ${T(env, 'ORDER_REVIEWS')}
          WHERE REVIEW_SCORE <= :sc AND LOWER(REVIEW_COMMENT_MESSAGE) LIKE :w
            AND REVIEW_CREATION_DATE >= TO_DATE(:d1, 'YYYY-MM-DD') AND REVIEW_CREATION_DATE < TO_DATE(:d2, 'YYYY-MM-DD')`,
  binds: { sc: 1 + Math.floor(w.rng.next() * 3), w: pick(w, WORDS), ...window(env, w, 120) },
})

const base = { requiresSchema: true, writes: false, dataset: 'olist' as const, defaultPrefix: 'OL_' }

export const OLIST_SCENARIOS: Scenario[] = [
  {
    ...base, id: 'ol-order-detail', no: 19, name: 'Olist · order detail page', category: 'read', defaultConcurrency: 8,
    description: 'Order by primary key joined to its items, products and sellers — the typical order page of a shop.',
    next: orderDetail,
  },
  {
    ...base, id: 'ol-customer-history', no: 20, name: 'Olist · customer order history', category: 'read', defaultConcurrency: 8,
    description: 'All orders of one real customer (CUSTOMER_UNIQUE_ID index → orders → items), grouped per order.',
    next: customerHistory,
  },
  {
    ...base, id: 'ol-geo-zip', no: 21, name: 'Olist · zip code lookup (1M rows)', category: 'read', defaultConcurrency: 8,
    description: 'Aggregate coordinates of one zip prefix in the 1M-row geolocation table via its index; skewed (SP zips have thousands of points).',
    next: geoZip,
  },
  {
    ...base, id: 'ol-seller-dashboard', no: 22, name: 'Olist · seller dashboard', category: 'analytic', defaultConcurrency: 4,
    description: 'Monthly orders, revenue, freight and late items of one seller over a random 6-month window.',
    next: sellerDashboard,
  },
  {
    ...base, id: 'ol-category-report', no: 23, name: 'Olist · category revenue report', category: 'analytic', defaultConcurrency: 2,
    description: 'Top 20 categories by revenue in a random 90-day window (4-table join, GROUP BY, translation outer join).',
    next: categoryReport,
  },
  {
    ...base, id: 'ol-delivery-sla', no: 24, name: 'Olist · delivery SLA by state', category: 'analytic', defaultConcurrency: 2,
    description: 'Delivered vs late orders and average delivery days per customer state for a random 60-day window.',
    next: deliverySla,
  },
  {
    ...base, id: 'ol-review-search', no: 25, name: 'Olist · review text search', category: 'analytic', defaultConcurrency: 2,
    description: "Low-score reviews whose comment contains a Portuguese keyword (LIKE '%…%') — no index can help: a full scan.",
    next: reviewSearch,
  },
  {
    ...base, id: 'ol-mixed', no: 26, name: 'Olist · storefront mix', category: 'mixed', defaultConcurrency: 16,
    description: 'Weighted read mix of a storefront: 55% order detail, 25% customer history, 15% zip lookup, 5% category report.',
    next: (env, w) => {
      const r = w.rng.next()
      if (r < 0.55) return orderDetail(env, w)
      if (r < 0.8) return customerHistory(env, w)
      if (r < 0.95) return geoZip(env, w)
      return categoryReport(env, w)
    },
  },
]

/** Loads a sample of real keys and the order date range; fails clearly if the bundle is not imported. */
export async function loadOlistKeys(conn: Connection, S: string, P: string): Promise<OlistKeys> {
  const t = (k: string) => `${S}.${P}${k}`
  const exists = await rows<{ N: number }>(conn, `SELECT COUNT(*) AS "N" FROM ALL_TABLES WHERE OWNER = :o AND TABLE_NAME IN (:a, :b, :c)`, {
    o: S,
    a: `${P}ORDERS`,
    b: `${P}ORDER_ITEMS`,
    c: `${P}GEOLOCATION`,
  })
  if (Number(exists[0]?.N ?? 0) < 3) {
    throw new Error(`Olist tables ${S}.${P}ORDERS / ORDER_ITEMS / GEOLOCATION not found. Import the Olist bundle in Dataset Sources first (or set the matching prefix).`)
  }
  const col = async (sql: string) => (await rows<{ V: string }>(conn, sql)).map((r) => r.V)
  const orderIds = await col(`SELECT ORDER_ID AS "V" FROM (SELECT ORDER_ID FROM ${t('ORDERS')} SAMPLE (30)) WHERE ROWNUM <= 20000`)
  const customerUniqueIds = await col(`SELECT CUSTOMER_UNIQUE_ID AS "V" FROM (SELECT CUSTOMER_UNIQUE_ID FROM ${t('CUSTOMERS')} SAMPLE (30)) WHERE ROWNUM <= 20000`)
  const sellerIds = await col(`SELECT SELLER_ID AS "V" FROM ${t('SELLERS')}`)
  const zips = await col(`SELECT DISTINCT GEOLOCATION_ZIP_CODE_PREFIX AS "V" FROM ${t('GEOLOCATION')}`)
  const range = (await rows<{ A: Date; B: Date }>(conn, `SELECT MIN(ORDER_PURCHASE_TIMESTAMP) AS "A", MAX(ORDER_PURCHASE_TIMESTAMP) AS "B" FROM ${t('ORDERS')}`))[0]
  if (!orderIds.length || !customerUniqueIds.length || !sellerIds.length || !zips.length || !range?.A) {
    throw new Error(`Olist tables under ${S}.${P}* are empty — import the bundle again.`)
  }
  return { orderIds, customerUniqueIds, sellerIds, zips, dateMin: new Date(range.A), dateMax: new Date(range.B) }
}

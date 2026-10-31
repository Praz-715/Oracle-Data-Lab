import { z } from 'zod'
import type { QualityCheckResult } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { oracleErrorInfo } from '../database/errors'
import { ident, rows } from '../database/query'
import { createJob, registerExecutor, type JobContext } from '../jobs/runner'
import { getProfile } from './profiles'

export interface QualityCheckDef {
  id: string
  category: QualityCheckResult['category']
  title: string
  description: string
  /** Returns a single COUNT(*) query; `T(name)` qualifies tables, `J(alias)` adds the optional job filter. */
  sql: (T: (k: string) => string, J: (alias: string) => string) => string
  requiresLobs?: boolean
}

const orphan = (child: string, alias: string, cols: [string, string][], parent: string): QualityCheckDef['sql'] =>
  (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T(child)} ${alias} WHERE ${cols.map(([c]) => `${alias}.${c} IS NOT NULL`).join(' AND ')} ${J(alias)}
       AND NOT EXISTS (SELECT 1 FROM ${T(parent)} p WHERE ${cols.map(([c, pc]) => `p.${pc} = ${alias}.${c}`).join(' AND ')})`

export const QUALITY_CHECKS: QualityCheckDef[] = [
  { id: 'orphan-orders-customers', category: 'integrity', title: 'Orders → customers', description: 'Every order references an existing customer.', sql: orphan('ORDERS', 'o', [['CUSTOMER_ID', 'CUSTOMER_ID']], 'CUSTOMERS') },
  { id: 'orphan-items-orders', category: 'integrity', title: 'Order items → orders', description: 'Every order line belongs to an existing order.', sql: orphan('ORDER_ITEMS', 'i', [['ORDER_ID', 'ORDER_ID']], 'ORDERS') },
  { id: 'orphan-items-products', category: 'integrity', title: 'Order items → products', description: 'Every order line references an existing product.', sql: orphan('ORDER_ITEMS', 'i', [['PRODUCT_ID', 'PRODUCT_ID']], 'PRODUCTS') },
  { id: 'orphan-payments-orders', category: 'integrity', title: 'Payments → orders', description: 'Every payment belongs to an existing order.', sql: orphan('PAYMENTS', 'x', [['ORDER_ID', 'ORDER_ID']], 'ORDERS') },
  { id: 'orphan-shipments-orders', category: 'integrity', title: 'Shipments → orders', description: 'Every shipment belongs to an existing order.', sql: orphan('SHIPMENTS', 'x', [['ORDER_ID', 'ORDER_ID']], 'ORDERS') },
  { id: 'orphan-returns-items', category: 'integrity', title: 'Returns → order items', description: 'Every return references an existing order line.', sql: orphan('RETURNS', 'x', [['ORDER_ID', 'ORDER_ID'], ['LINE_NO', 'LINE_NO']], 'ORDER_ITEMS') },
  { id: 'orphan-movements-inventory', category: 'integrity', title: 'Movements → inventory', description: 'Every stock movement belongs to an inventory position.', sql: orphan('INVENTORY_MOVEMENTS', 'x', [['PRODUCT_ID', 'PRODUCT_ID'], ['WAREHOUSE_ID', 'WAREHOUSE_ID']], 'INVENTORY') },
  { id: 'orphan-products-suppliers', category: 'integrity', title: 'Products → suppliers', description: 'Every product references an existing supplier.', sql: orphan('PRODUCTS', 'x', [['SUPPLIER_ID', 'SUPPLIER_ID']], 'SUPPLIERS') },

  { id: 'dup-customer-email', category: 'duplicates', title: 'Duplicate customer emails', description: 'Case-insensitive email duplicates.', sql: (T, J) => `SELECT COUNT(*) AS "n" FROM (SELECT LOWER(c.EMAIL) FROM ${T('CUSTOMERS')} c WHERE 1 = 1 ${J('c')} GROUP BY LOWER(c.EMAIL) HAVING COUNT(*) > 1)` },
  { id: 'dup-product-sku', category: 'duplicates', title: 'Duplicate SKUs', description: 'SKU should be unique per product.', sql: (T, J) => `SELECT COUNT(*) AS "n" FROM (SELECT p.SKU FROM ${T('PRODUCTS')} p WHERE 1 = 1 ${J('p')} GROUP BY p.SKU HAVING COUNT(*) > 1)` },
  { id: 'dup-order-no', category: 'duplicates', title: 'Duplicate order numbers', description: 'ORDER_NO should be unique.', sql: (T, J) => `SELECT COUNT(*) AS "n" FROM (SELECT o.ORDER_NO FROM ${T('ORDERS')} o WHERE 1 = 1 ${J('o')} GROUP BY o.ORDER_NO HAVING COUNT(*) > 1)` },

  { id: 'null-required', category: 'nulls', title: 'Required values missing', description: 'NULL email, order date, customer or unit price.', sql: (T, J) =>
    `SELECT (SELECT COUNT(*) FROM ${T('CUSTOMERS')} c WHERE c.EMAIL IS NULL ${J('c')})
          + (SELECT COUNT(*) FROM ${T('ORDERS')} o WHERE (o.ORDER_DATE IS NULL OR o.CUSTOMER_ID IS NULL) ${J('o')})
          + (SELECT COUNT(*) FROM ${T('ORDER_ITEMS')} i WHERE i.UNIT_PRICE IS NULL ${J('i')}) AS "n" FROM DUAL` },

  { id: 'rule-order-has-items', category: 'business-rule', title: 'Orders have at least one item', description: 'No order without order lines.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('ORDERS')} o WHERE 1 = 1 ${J('o')} AND NOT EXISTS (SELECT 1 FROM ${T('ORDER_ITEMS')} i WHERE i.ORDER_ID = o.ORDER_ID)` },
  { id: 'rule-price-range', category: 'business-rule', title: 'Item price within product range', description: 'UNIT_PRICE between MIN_PRICE and MAX_PRICE of the product.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('ORDER_ITEMS')} i JOIN ${T('PRODUCTS')} p ON p.PRODUCT_ID = i.PRODUCT_ID
      WHERE (i.UNIT_PRICE < p.MIN_PRICE OR i.UNIT_PRICE > p.MAX_PRICE) ${J('i')}` },
  { id: 'rule-line-total', category: 'business-rule', title: 'Line totals', description: 'LINE_TOTAL = QUANTITY × UNIT_PRICE × (1 − DISCOUNT_PCT), ±0.01.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('ORDER_ITEMS')} i WHERE ABS(i.LINE_TOTAL - i.QUANTITY * i.UNIT_PRICE * (1 - i.DISCOUNT_PCT)) > 0.01 ${J('i')}` },
  { id: 'rule-payment-total', category: 'business-rule', title: 'Payments match order total', description: 'Captured payments sum to ORDER_TOTAL for delivered/returned orders.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('ORDERS')} o
      WHERE o.STATUS IN ('DELIVERED', 'RETURNED') ${J('o')}
        AND o.ORDER_TOTAL <> (SELECT NVL(SUM(p.AMOUNT), 0) FROM ${T('PAYMENTS')} p WHERE p.ORDER_ID = o.ORDER_ID AND p.STATUS = 'CAPTURED')` },
  { id: 'rule-ship-after-order', category: 'business-rule', title: 'Shipping not before order date', description: 'SHIPPED_DATE ≥ ORDER_DATE.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('SHIPMENTS')} s JOIN ${T('ORDERS')} o ON o.ORDER_ID = s.ORDER_ID WHERE s.SHIPPED_DATE < o.ORDER_DATE ${J('s')}` },
  { id: 'rule-delivery-after-ship', category: 'business-rule', title: 'Delivery after shipping', description: 'DELIVERED_DATE ≥ SHIPPED_DATE.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('SHIPMENTS')} s WHERE s.DELIVERED_DATE < s.SHIPPED_DATE ${J('s')}` },
  { id: 'rule-return-qty', category: 'business-rule', title: 'Return ≤ purchased quantity', description: 'Total returned quantity per line never exceeds the purchased quantity.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM (SELECT r.ORDER_ID, r.LINE_NO, SUM(r.RETURN_QTY) AS q FROM ${T('RETURNS')} r WHERE 1 = 1 ${J('r')} GROUP BY r.ORDER_ID, r.LINE_NO) x
      JOIN ${T('ORDER_ITEMS')} i ON i.ORDER_ID = x.ORDER_ID AND i.LINE_NO = x.LINE_NO WHERE x.q > i.QUANTITY` },
  { id: 'rule-inventory-balance', category: 'business-rule', title: 'Inventory = sum of movements', description: 'QTY_ON_HAND equals the signed sum of movements per product/warehouse.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('INVENTORY')} inv
      LEFT JOIN (SELECT PRODUCT_ID, WAREHOUSE_ID, SUM(QUANTITY) AS q FROM ${T('INVENTORY_MOVEMENTS')} GROUP BY PRODUCT_ID, WAREHOUSE_ID) m
        ON m.PRODUCT_ID = inv.PRODUCT_ID AND m.WAREHOUSE_ID = inv.WAREHOUSE_ID
      WHERE inv.QTY_ON_HAND <> NVL(m.q, 0) ${J('inv')}` },
  { id: 'rule-signup-before-order', category: 'business-rule', title: 'Customer signed up before ordering', description: 'ORDER_DATE ≥ customer SIGNUP_DATE.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('ORDERS')} o JOIN ${T('CUSTOMERS')} c ON c.CUSTOMER_ID = o.CUSTOMER_ID WHERE TRUNC(o.ORDER_DATE) < c.SIGNUP_DATE ${J('o')}` },

  { id: 'agg-subtotal', category: 'aggregate', title: 'Order subtotal = Σ line totals', description: 'SUBTOTAL equals the sum of its order lines.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('ORDERS')} o JOIN (SELECT ORDER_ID, SUM(LINE_TOTAL) AS s, COUNT(*) AS c FROM ${T('ORDER_ITEMS')} GROUP BY ORDER_ID) i
        ON i.ORDER_ID = o.ORDER_ID WHERE o.SUBTOTAL <> i.s ${J('o')}` },
  { id: 'agg-order-total', category: 'aggregate', title: 'Order total = subtotal + shipping + tax', description: 'ORDER_TOTAL reconciles with its components.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('ORDERS')} o WHERE o.ORDER_TOTAL <> o.SUBTOTAL + o.SHIPPING_FEE + o.TAX_TOTAL ${J('o')}` },
  { id: 'agg-items-count', category: 'aggregate', title: 'ITEMS_COUNT = number of lines', description: 'Denormalized line count matches ORDER_ITEMS.', sql: (T, J) =>
    `SELECT COUNT(*) AS "n" FROM ${T('ORDERS')} o JOIN (SELECT ORDER_ID, COUNT(*) AS c FROM ${T('ORDER_ITEMS')} GROUP BY ORDER_ID) i
        ON i.ORDER_ID = o.ORDER_ID WHERE o.ITEMS_COUNT <> i.c ${J('o')}` },
]

export const qualityRequestSchema = z.object({
  profileId: z.string().min(1),
  schema: z.string().trim().toUpperCase(),
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,7}$/).default('DL_'),
  checks: z.array(z.string()).optional(),
  /** Restrict to rows created by one generation job (DL_JOB_ID). */
  jobFilter: z.string().uuid().optional(),
})
type QualityRequest = z.infer<typeof qualityRequestSchema>

export async function startQuality(input: QualityRequest) {
  const profile = await getProfile(input.profileId)
  const schema = ident(input.schema, 'schema')
  const ids = input.checks?.length ? input.checks : QUALITY_CHECKS.map((c) => c.id)
  return createJob({
    type: 'quality',
    profileId: profile.id,
    title: `Validate ${schema}.${input.prefix}* (${ids.length} checks${input.jobFilter ? ', job-scoped' : ''})`,
    config: { ...input, schema, checks: ids },
  })
}

async function qualityExecutor(ctx: JobContext<QualityRequest & { checks: string[] }>) {
  const cfg = ctx.job.config
  const S = cfg.schema
  const P = cfg.prefix
  const T = (k: string) => `${S}.${P}${k}`
  const J = (alias: string) => (cfg.jobFilter ? `AND ${alias}.DL_JOB_ID = :job` : '')
  const defs = QUALITY_CHECKS.filter((c) => cfg.checks.includes(c.id))
  const results: QualityCheckResult[] = []
  ctx.progress({ phase: 'validating', total: defs.length, done: 0, unit: 'checks' })
  await withConnection(
    ctx.job.profileId,
    async (conn) => {
      for (const def of defs) {
        ctx.throwIfCancelled()
        const sql = def.sql(T, J)
        const t0 = performance.now()
        try {
          const r = await rows<{ n: number }>(conn, sql, cfg.jobFilter && sql.includes(':job') ? { job: cfg.jobFilter } : {})
          const n = Number(r[0]?.n ?? 0)
          results.push({ ...pick(def), status: n === 0 ? 'pass' : 'fail', violations: n, sql, elapsedMs: Math.round(performance.now() - t0) })
          ctx.log(n === 0 ? 'info' : 'warn', `${def.title}: ${n === 0 ? 'pass' : `${n} violation(s)`}`)
        } catch (err) {
          const info = oracleErrorInfo(err)
          results.push({ ...pick(def), status: 'error', violations: null, sql, elapsedMs: Math.round(performance.now() - t0), error: `${info.code}: ${info.message}` })
          ctx.log('error', `${def.title}: ${info.code} ${info.message}`)
        }
        ctx.progress({ done: results.length, message: def.title })
      }
    },
    { action: 'quality', callTimeoutMs: 1800000 },
  )
  const summary = results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})
  return { schema: S, prefix: P, jobFilter: cfg.jobFilter ?? null, summary, results }
}

function pick(def: QualityCheckDef) {
  return { id: def.id, category: def.category, title: def.title, description: def.description }
}

registerExecutor('quality', qualityExecutor as any)

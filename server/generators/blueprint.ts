// The "Retail Commerce" blueprint: a relational model with realistic constraints that the DDL
// generator, storage estimator, data generator and quality validator all share.

export interface ColumnDef {
  name: string
  type: string
  nullable?: boolean
  /** Average stored bytes, used for storage estimates. */
  avgBytes: number
  lob?: 'CLOB' | 'BLOB'
}

export interface TableDef {
  /** Table name without prefix. */
  key: string
  /** Short alias used in constraint/index names (keeps names within 30 chars for 11g/12.1). */
  alias: string
  comment: string
  columns: ColumnDef[]
  pk: string[]
  uniques?: { suffix: string; cols: string[] }[]
  checks?: { suffix: string; expr: string }[]
  fks?: { suffix: string; cols: string[]; ref: string; refCols: string[] }[]
  indexes?: { suffix: string; cols: string[]; local?: boolean; compress?: number }[]
  /** Reference data shared by all generation jobs. */
  reference?: boolean
  /** Only created when LOB tables are enabled. */
  lobTable?: boolean
  sequence?: boolean
  kind: 'reference' | 'dimension' | 'fact' | 'log' | 'bench' | 'extension'
}

const JOB: ColumnDef = { name: 'DL_JOB_ID', type: 'VARCHAR2(36)', nullable: true, avgBytes: 37 }
const num = (name: string, p = 10, nullable = false): ColumnDef => ({ name, type: `NUMBER(${p})`, nullable, avgBytes: 5 })
const money = (name: string, nullable = false): ColumnDef => ({ name, type: 'NUMBER(16,2)', nullable, avgBytes: 7 })
const vc = (name: string, len: number, avg: number, nullable = false): ColumnDef => ({ name, type: `VARCHAR2(${len})`, nullable, avgBytes: avg })
const date = (name: string, nullable = false): ColumnDef => ({ name, type: 'DATE', nullable, avgBytes: 8 })
const ts = (name: string, nullable = false): ColumnDef => ({ name, type: 'TIMESTAMP', nullable, avgBytes: 11 })
const inList = (col: string, values: readonly string[]) => `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`

export const ORDER_STATUS = ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'] as const

export const CORE_TABLES: TableDef[] = [
  {
    key: 'REGIONS', alias: 'REG', kind: 'reference', reference: true, sequence: true,
    comment: 'Sales regions (reference data).',
    columns: [num('REGION_ID'), vc('REGION_CODE', 10, 6), vc('REGION_NAME', 60, 14), { name: 'COUNTRY_CODE', type: 'CHAR(2)', avgBytes: 2 }, { name: 'POPULATION_WEIGHT', type: 'NUMBER(6,2)', avgBytes: 3 }, JOB],
    pk: ['REGION_ID'],
    uniques: [{ suffix: 'CODE_UK', cols: ['REGION_CODE'] }],
  },
  {
    key: 'CATEGORIES', alias: 'CAT', kind: 'reference', reference: true, sequence: true,
    comment: 'Two-level product category tree (reference data).',
    columns: [num('CATEGORY_ID'), num('PARENT_CATEGORY_ID', 10, true), vc('CATEGORY_NAME', 60, 12), { name: 'MARGIN_PCT', type: 'NUMBER(5,4)', avgBytes: 3 }, JOB],
    pk: ['CATEGORY_ID'],
    uniques: [{ suffix: 'NAME_UK', cols: ['CATEGORY_NAME'] }],
    checks: [{ suffix: 'MARGIN_CK', expr: 'MARGIN_PCT BETWEEN 0 AND 1' }],
    fks: [{ suffix: 'PARENT_FK', cols: ['PARENT_CATEGORY_ID'], ref: 'CATEGORIES', refCols: ['CATEGORY_ID'] }],
    indexes: [{ suffix: 'PARENT_IX', cols: ['PARENT_CATEGORY_ID'] }],
  },
  {
    key: 'WAREHOUSES', alias: 'WH', kind: 'reference', reference: true, sequence: true,
    comment: 'Fulfilment warehouses (reference data).',
    columns: [num('WAREHOUSE_ID'), vc('WAREHOUSE_CODE', 12, 7), vc('WAREHOUSE_NAME', 80, 24), num('REGION_ID'), num('CAPACITY_UNITS', 12), date('OPENED_DATE'), JOB],
    pk: ['WAREHOUSE_ID'],
    uniques: [{ suffix: 'CODE_UK', cols: ['WAREHOUSE_CODE'] }],
    checks: [{ suffix: 'CAP_CK', expr: 'CAPACITY_UNITS > 0' }],
    fks: [{ suffix: 'REGION_FK', cols: ['REGION_ID'], ref: 'REGIONS', refCols: ['REGION_ID'] }],
    indexes: [{ suffix: 'REGION_IX', cols: ['REGION_ID'] }],
  },
  {
    key: 'SUPPLIERS', alias: 'SUP', kind: 'dimension', sequence: true,
    comment: 'Product suppliers.',
    columns: [num('SUPPLIER_ID'), vc('SUPPLIER_CODE', 16, 10), vc('SUPPLIER_NAME', 120, 28), num('REGION_ID'), { name: 'RATING', type: 'NUMBER(2,1)', avgBytes: 2 }, vc('STATUS', 12, 6), ts('CREATED_AT'), JOB],
    pk: ['SUPPLIER_ID'],
    uniques: [{ suffix: 'CODE_UK', cols: ['SUPPLIER_CODE'] }],
    checks: [
      { suffix: 'RATING_CK', expr: 'RATING BETWEEN 1 AND 5' },
      { suffix: 'STATUS_CK', expr: inList('STATUS', ['ACTIVE', 'INACTIVE']) },
    ],
    fks: [{ suffix: 'REGION_FK', cols: ['REGION_ID'], ref: 'REGIONS', refCols: ['REGION_ID'] }],
    indexes: [{ suffix: 'REGION_IX', cols: ['REGION_ID'] }],
  },
  {
    key: 'PRODUCTS', alias: 'PRD', kind: 'dimension', sequence: true,
    comment: 'Product catalog with an allowed selling price range.',
    columns: [
      num('PRODUCT_ID'), vc('SKU', 24, 12), vc('PRODUCT_NAME', 150, 30), num('CATEGORY_ID'), num('SUPPLIER_ID'),
      money('LIST_PRICE'), money('MIN_PRICE'), money('MAX_PRICE'), money('UNIT_COST'), { name: 'WEIGHT_KG', type: 'NUMBER(8,3)', avgBytes: 4 },
      vc('STATUS', 12, 6), date('LAUNCHED_DATE'), ts('CREATED_AT'), JOB,
    ],
    pk: ['PRODUCT_ID'],
    uniques: [{ suffix: 'SKU_UK', cols: ['SKU'] }],
    checks: [
      { suffix: 'PRICE_CK', expr: 'MIN_PRICE > 0 AND MIN_PRICE <= LIST_PRICE AND LIST_PRICE <= MAX_PRICE' },
      { suffix: 'COST_CK', expr: 'UNIT_COST >= 0' },
      { suffix: 'STATUS_CK', expr: inList('STATUS', ['ACTIVE', 'DISCONTINUED']) },
    ],
    fks: [
      { suffix: 'CAT_FK', cols: ['CATEGORY_ID'], ref: 'CATEGORIES', refCols: ['CATEGORY_ID'] },
      { suffix: 'SUP_FK', cols: ['SUPPLIER_ID'], ref: 'SUPPLIERS', refCols: ['SUPPLIER_ID'] },
    ],
    indexes: [
      { suffix: 'CAT_IX', cols: ['CATEGORY_ID', 'STATUS'], compress: 1 },
      { suffix: 'SUP_IX', cols: ['SUPPLIER_ID'] },
    ],
  },
  {
    key: 'CUSTOMERS', alias: 'CUS', kind: 'dimension', sequence: true,
    comment: 'Synthetic customers (no real personal data).',
    columns: [
      num('CUSTOMER_ID'), vc('CUSTOMER_CODE', 16, 11), vc('FIRST_NAME', 60, 6), vc('LAST_NAME', 60, 8), vc('EMAIL', 160, 30),
      vc('PHONE', 24, 16), vc('SEGMENT', 12, 8), num('REGION_ID'), vc('CITY', 60, 10), date('SIGNUP_DATE'), vc('STATUS', 12, 6),
      vc('LOYALTY_TIER', 10, 5), money('CREDIT_LIMIT'), ts('CREATED_AT'), ts('UPDATED_AT', true), JOB,
    ],
    pk: ['CUSTOMER_ID'],
    uniques: [
      { suffix: 'CODE_UK', cols: ['CUSTOMER_CODE'] },
      { suffix: 'EMAIL_UK', cols: ['EMAIL'] },
    ],
    checks: [
      { suffix: 'SEG_CK', expr: inList('SEGMENT', ['CONSUMER', 'SMB', 'CORPORATE']) },
      { suffix: 'STATUS_CK', expr: inList('STATUS', ['ACTIVE', 'INACTIVE', 'SUSPENDED']) },
      { suffix: 'TIER_CK', expr: inList('LOYALTY_TIER', ['BASIC', 'SILVER', 'GOLD', 'PLATINUM']) },
      { suffix: 'CREDIT_CK', expr: 'CREDIT_LIMIT >= 0' },
    ],
    fks: [{ suffix: 'REGION_FK', cols: ['REGION_ID'], ref: 'REGIONS', refCols: ['REGION_ID'] }],
    indexes: [
      { suffix: 'REGION_IX', cols: ['REGION_ID', 'SEGMENT'], compress: 1 },
      { suffix: 'SIGNUP_IX', cols: ['SIGNUP_DATE'] },
      { suffix: 'NAME_IX', cols: ['LAST_NAME', 'FIRST_NAME'] },
    ],
  },
  {
    key: 'INVENTORY', alias: 'INV', kind: 'dimension',
    comment: 'Stock on hand per product and warehouse; equals the sum of its movements.',
    columns: [num('PRODUCT_ID'), num('WAREHOUSE_ID'), num('QTY_ON_HAND', 12), num('REORDER_LEVEL'), date('LAST_MOVEMENT_AT'), JOB],
    pk: ['PRODUCT_ID', 'WAREHOUSE_ID'],
    checks: [{ suffix: 'QTY_CK', expr: 'QTY_ON_HAND >= 0' }],
    fks: [
      { suffix: 'PRD_FK', cols: ['PRODUCT_ID'], ref: 'PRODUCTS', refCols: ['PRODUCT_ID'] },
      { suffix: 'WH_FK', cols: ['WAREHOUSE_ID'], ref: 'WAREHOUSES', refCols: ['WAREHOUSE_ID'] },
    ],
    indexes: [{ suffix: 'WH_IX', cols: ['WAREHOUSE_ID'] }],
  },
  {
    key: 'INVENTORY_MOVEMENTS', alias: 'INVM', kind: 'fact', sequence: true,
    comment: 'Signed stock movements; running sum per product/warehouse never goes negative.',
    columns: [num('MOVEMENT_ID', 14), num('PRODUCT_ID'), num('WAREHOUSE_ID'), vc('MOVEMENT_TYPE', 16, 7), num('QUANTITY'), date('MOVEMENT_DATE'), vc('REFERENCE', 40, 14, true), JOB],
    pk: ['MOVEMENT_ID'],
    checks: [
      { suffix: 'TYPE_CK', expr: inList('MOVEMENT_TYPE', ['RECEIPT', 'SALE', 'ADJUSTMENT', 'RETURN', 'TRANSFER_IN', 'TRANSFER_OUT']) },
      { suffix: 'QTY_CK', expr: 'QUANTITY <> 0' },
    ],
    fks: [{ suffix: 'INV_FK', cols: ['PRODUCT_ID', 'WAREHOUSE_ID'], ref: 'INVENTORY', refCols: ['PRODUCT_ID', 'WAREHOUSE_ID'] }],
    indexes: [{ suffix: 'INV_IX', cols: ['PRODUCT_ID', 'WAREHOUSE_ID', 'MOVEMENT_DATE'], compress: 2 }],
  },
  {
    key: 'ORDERS', alias: 'ORD', kind: 'fact', sequence: true,
    comment: 'Sales orders. Partitioned by ORDER_DATE when partitioning is enabled.',
    columns: [
      num('ORDER_ID', 14), vc('ORDER_NO', 20, 16), num('CUSTOMER_ID'), date('ORDER_DATE'), vc('STATUS', 12, 9), vc('CHANNEL', 12, 6),
      num('WAREHOUSE_ID'), { name: 'CURRENCY_CODE', type: 'CHAR(3)', avgBytes: 3 }, num('ITEMS_COUNT', 4), money('SUBTOTAL'),
      money('DISCOUNT_TOTAL'), { name: 'SHIPPING_FEE', type: 'NUMBER(12,2)', avgBytes: 5 }, money('TAX_TOTAL'), money('ORDER_TOTAL'), ts('CREATED_AT'), JOB,
    ],
    pk: ['ORDER_ID'],
    uniques: [{ suffix: 'NO_UK', cols: ['ORDER_NO'] }],
    checks: [
      { suffix: 'STATUS_CK', expr: inList('STATUS', ORDER_STATUS) },
      { suffix: 'CHANNEL_CK', expr: inList('CHANNEL', ['WEB', 'MOBILE', 'STORE', 'MARKETPLACE']) },
      { suffix: 'TOTAL_CK', expr: 'ORDER_TOTAL >= 0 AND SUBTOTAL >= 0' },
    ],
    fks: [
      { suffix: 'CUS_FK', cols: ['CUSTOMER_ID'], ref: 'CUSTOMERS', refCols: ['CUSTOMER_ID'] },
      { suffix: 'WH_FK', cols: ['WAREHOUSE_ID'], ref: 'WAREHOUSES', refCols: ['WAREHOUSE_ID'] },
    ],
    indexes: [
      { suffix: 'CUS_DATE_IX', cols: ['CUSTOMER_ID', 'ORDER_DATE'], local: true, compress: 1 },
      { suffix: 'DATE_IX', cols: ['ORDER_DATE'], local: true },
      { suffix: 'WH_IX', cols: ['WAREHOUSE_ID'], local: true },
    ],
  },
  {
    key: 'ORDER_ITEMS', alias: 'OIT', kind: 'fact',
    comment: 'Order lines. Unit price always lies within the product price range.',
    columns: [
      num('ORDER_ID', 14), num('LINE_NO', 4), num('PRODUCT_ID'), num('QUANTITY', 8), { name: 'UNIT_PRICE', type: 'NUMBER(14,2)', avgBytes: 6 },
      { name: 'DISCOUNT_PCT', type: 'NUMBER(5,4)', avgBytes: 3 }, money('LINE_TOTAL'), JOB,
    ],
    pk: ['ORDER_ID', 'LINE_NO'],
    checks: [
      { suffix: 'QTY_CK', expr: 'QUANTITY > 0' },
      { suffix: 'PRICE_CK', expr: 'UNIT_PRICE > 0' },
      { suffix: 'DISC_CK', expr: 'DISCOUNT_PCT BETWEEN 0 AND 0.9' },
    ],
    fks: [
      { suffix: 'ORD_FK', cols: ['ORDER_ID'], ref: 'ORDERS', refCols: ['ORDER_ID'] },
      { suffix: 'PRD_FK', cols: ['PRODUCT_ID'], ref: 'PRODUCTS', refCols: ['PRODUCT_ID'] },
    ],
    indexes: [{ suffix: 'PRD_IX', cols: ['PRODUCT_ID', 'ORDER_ID'] }],
  },
  {
    key: 'PAYMENTS', alias: 'PAY', kind: 'fact', sequence: true,
    comment: 'Payments. Captured amounts sum to the order total for fulfilled orders.',
    columns: [num('PAYMENT_ID', 14), num('ORDER_ID', 14), num('PAYMENT_SEQ', 3), vc('PAYMENT_METHOD', 16, 7), money('AMOUNT'), vc('STATUS', 12, 8), ts('PAID_AT'), JOB],
    pk: ['PAYMENT_ID'],
    uniques: [{ suffix: 'ORD_SEQ_UK', cols: ['ORDER_ID', 'PAYMENT_SEQ'] }],
    checks: [
      { suffix: 'AMT_CK', expr: 'AMOUNT >= 0' },
      { suffix: 'METHOD_CK', expr: inList('PAYMENT_METHOD', ['CARD', 'BANK_TRANSFER', 'EWALLET', 'COD', 'PAYLATER']) },
      { suffix: 'STATUS_CK', expr: inList('STATUS', ['AUTHORIZED', 'CAPTURED', 'REFUNDED', 'FAILED']) },
    ],
    fks: [{ suffix: 'ORD_FK', cols: ['ORDER_ID'], ref: 'ORDERS', refCols: ['ORDER_ID'] }],
  },
  {
    key: 'SHIPMENTS', alias: 'SHP', kind: 'fact', sequence: true,
    comment: 'Shipments. Never shipped before the order date; delivered after shipped.',
    columns: [num('SHIPMENT_ID', 14), num('ORDER_ID', 14), vc('CARRIER', 30, 6), vc('TRACKING_NO', 30, 14), date('SHIPPED_DATE'), date('DELIVERED_DATE', true), vc('STATUS', 12, 9), JOB],
    pk: ['SHIPMENT_ID'],
    uniques: [
      { suffix: 'ORD_UK', cols: ['ORDER_ID'] },
      { suffix: 'TRACK_UK', cols: ['TRACKING_NO'] },
    ],
    checks: [
      { suffix: 'DATES_CK', expr: 'DELIVERED_DATE IS NULL OR DELIVERED_DATE >= SHIPPED_DATE' },
      { suffix: 'STATUS_CK', expr: inList('STATUS', ['IN_TRANSIT', 'DELIVERED']) },
    ],
    fks: [{ suffix: 'ORD_FK', cols: ['ORDER_ID'], ref: 'ORDERS', refCols: ['ORDER_ID'] }],
  },
  {
    key: 'RETURNS', alias: 'RET', kind: 'fact', sequence: true,
    comment: 'Returned order lines. Return quantity never exceeds purchased quantity.',
    columns: [num('RETURN_ID', 14), num('ORDER_ID', 14), num('LINE_NO', 4), num('RETURN_QTY', 8), vc('REASON', 20, 10), date('RETURN_DATE'), money('REFUND_AMOUNT'), vc('STATUS', 12, 8), JOB],
    pk: ['RETURN_ID'],
    checks: [
      { suffix: 'QTY_CK', expr: 'RETURN_QTY > 0' },
      { suffix: 'REASON_CK', expr: inList('REASON', ['DAMAGED', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'SIZE_ISSUE', 'CHANGED_MIND']) },
      { suffix: 'STATUS_CK', expr: inList('STATUS', ['REQUESTED', 'APPROVED', 'REFUNDED', 'REJECTED']) },
    ],
    fks: [{ suffix: 'OIT_FK', cols: ['ORDER_ID', 'LINE_NO'], ref: 'ORDER_ITEMS', refCols: ['ORDER_ID', 'LINE_NO'] }],
    indexes: [{ suffix: 'OIT_IX', cols: ['ORDER_ID', 'LINE_NO'] }],
  },
  {
    key: 'PRODUCT_REVIEWS', alias: 'REV', kind: 'fact', lobTable: true, sequence: true,
    comment: 'Product reviews with CLOB bodies.',
    columns: [num('REVIEW_ID', 14), num('PRODUCT_ID'), num('CUSTOMER_ID'), num('RATING', 1), date('REVIEW_DATE'), vc('TITLE', 120, 24), { name: 'BODY', type: 'CLOB', avgBytes: 600, lob: 'CLOB' }, JOB],
    pk: ['REVIEW_ID'],
    checks: [{ suffix: 'RATING_CK', expr: 'RATING BETWEEN 1 AND 5' }],
    fks: [
      { suffix: 'PRD_FK', cols: ['PRODUCT_ID'], ref: 'PRODUCTS', refCols: ['PRODUCT_ID'] },
      { suffix: 'CUS_FK', cols: ['CUSTOMER_ID'], ref: 'CUSTOMERS', refCols: ['CUSTOMER_ID'] },
    ],
    indexes: [
      { suffix: 'PRD_IX', cols: ['PRODUCT_ID', 'RATING'] },
      { suffix: 'CUS_IX', cols: ['CUSTOMER_ID'] },
    ],
  },
  {
    key: 'PRODUCT_IMAGES', alias: 'IMG', kind: 'dimension', lobTable: true, sequence: true,
    comment: 'Synthetic binary product images (BLOB).',
    columns: [num('IMAGE_ID', 14), num('PRODUCT_ID'), num('IMAGE_SEQ', 2), vc('MIME_TYPE', 40, 9), num('BYTE_SIZE'), { name: 'IMAGE_DATA', type: 'BLOB', avgBytes: 1200, lob: 'BLOB' }, JOB],
    pk: ['IMAGE_ID'],
    uniques: [{ suffix: 'PRD_SEQ_UK', cols: ['PRODUCT_ID', 'IMAGE_SEQ'] }],
    fks: [{ suffix: 'PRD_FK', cols: ['PRODUCT_ID'], ref: 'PRODUCTS', refCols: ['PRODUCT_ID'] }],
  },
  {
    key: 'ORDER_STATUS_LOG', alias: 'OSL', kind: 'log', sequence: true,
    comment: 'Order status changes, written by trigger.',
    columns: [num('LOG_ID', 14), num('ORDER_ID', 14), vc('OLD_STATUS', 12, 9, true), vc('NEW_STATUS', 12, 9), ts('CHANGED_AT'), vc('CHANGED_BY', 128, 10)],
    pk: ['LOG_ID'],
    indexes: [{ suffix: 'ORD_IX', cols: ['ORDER_ID'] }],
  },
  {
    key: 'BENCH_EVENTS', alias: 'BEV', kind: 'bench', sequence: true,
    comment: 'Scratch table for write benchmarks; rows are tagged with the benchmark run id.',
    columns: [num('EVENT_ID', 14), vc('RUN_ID', 36, 36), num('WORKER_NO', 4), ts('EVENT_TS'), num('CUSTOMER_ID', 10, true), num('PRODUCT_ID', 10, true), money('AMOUNT', true), vc('PAYLOAD', 200, 60, true)],
    pk: ['EVENT_ID'],
    indexes: [{ suffix: 'RUN_IX', cols: ['RUN_ID', 'WORKER_NO'], compress: 1 }],
  },
]

export type ExtensionKind = 'customer_attr' | 'product_metric' | 'order_event'
const EXT_KINDS: ExtensionKind[] = ['customer_attr', 'product_metric', 'order_event']

export function extensionKind(n: number): ExtensionKind {
  return EXT_KINDS[(n - 1) % EXT_KINDS.length]!
}

/** Extension tables let a schema scale to hundreds of related tables (EXT_001 ... EXT_n). */
export function extensionTable(n: number): TableDef {
  const no = String(n).padStart(3, '0')
  const kind = extensionKind(n)
  const base = { key: `EXT_${no}`, alias: `X${no}`, kind: 'extension' as const, sequence: false }
  if (kind === 'customer_attr') {
    return {
      ...base,
      comment: `Extension ${no}: customer attributes (key/value with validity).`,
      columns: [num('EXT_ID', 14), num('CUSTOMER_ID'), vc('ATTR_KEY', 40, 12), vc('ATTR_VALUE', 200, 20, true), date('VALID_FROM'), JOB],
      pk: ['EXT_ID'],
      fks: [{ suffix: 'CUS_FK', cols: ['CUSTOMER_ID'], ref: 'CUSTOMERS', refCols: ['CUSTOMER_ID'] }],
      indexes: [{ suffix: 'CUS_IX', cols: ['CUSTOMER_ID', 'ATTR_KEY'] }],
    }
  }
  if (kind === 'product_metric') {
    return {
      ...base,
      comment: `Extension ${no}: daily product funnel metrics.`,
      columns: [num('EXT_ID', 14), num('PRODUCT_ID'), date('METRIC_DATE'), num('VIEWS', 12), num('ADD_TO_CART', 12), num('CONVERSIONS', 12), JOB],
      pk: ['EXT_ID'],
      checks: [{ suffix: 'FUNNEL_CK', expr: 'VIEWS >= ADD_TO_CART AND ADD_TO_CART >= CONVERSIONS AND CONVERSIONS >= 0' }],
      fks: [{ suffix: 'PRD_FK', cols: ['PRODUCT_ID'], ref: 'PRODUCTS', refCols: ['PRODUCT_ID'] }],
      indexes: [{ suffix: 'PRD_IX', cols: ['PRODUCT_ID', 'METRIC_DATE'] }],
    }
  }
  return {
    ...base,
    comment: `Extension ${no}: order lifecycle events.`,
    columns: [num('EXT_ID', 14), num('ORDER_ID', 14), vc('EVENT_TYPE', 30, 12), ts('EVENT_TS'), vc('NOTE', 200, 24, true), JOB],
    pk: ['EXT_ID'],
    fks: [{ suffix: 'ORD_FK', cols: ['ORDER_ID'], ref: 'ORDERS', refCols: ['ORDER_ID'] }],
    indexes: [{ suffix: 'ORD_IX', cols: ['ORDER_ID', 'EVENT_TYPE'] }],
  }
}

export function blueprintTables(opts: { includeLobs: boolean; extensionTables: number }): TableDef[] {
  const core = CORE_TABLES.filter((t) => opts.includeLobs || !t.lobTable)
  const ext = Array.from({ length: opts.extensionTables }, (_, i) => extensionTable(i + 1))
  return [...core, ...ext]
}

export function tableByKey(key: string): TableDef {
  const core = CORE_TABLES.find((t) => t.key === key)
  if (core) return core
  const m = /^EXT_(\d{3})$/.exec(key)
  if (m) return extensionTable(Number(m[1]))
  throw new Error(`Unknown blueprint table ${key}`)
}

export function seqName(prefix: string, t: TableDef): string {
  return `${prefix}${t.alias}_SEQ`
}

/** One sequence shared by all extension tables. */
export function extSeqName(prefix: string): string {
  return `${prefix}EXT_SEQ`
}

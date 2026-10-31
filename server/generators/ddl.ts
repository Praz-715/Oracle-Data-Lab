import type { PlannedStatement, SchemaOptions } from '../../shared/types/lab'
import { blueprintTables, extSeqName, seqName, type TableDef } from './blueprint'

export interface DdlContext {
  schema: string
  versionMajor: number
  /** null = unknown (V$OPTION not visible). */
  partitioningAvailable: boolean | null
  /** Used for range partition boundaries; defaults to today. */
  today?: string
}

export interface DdlResult {
  statements: PlannedStatement[]
  warnings: string[]
  effectiveOptions: SchemaOptions
}

const IDENT = /^[A-Z][A-Z0-9_$#]*$/

export function validatePrefix(prefix: string): string {
  const p = prefix.toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{0,7}$/.test(p)) throw new Error('Prefix must be 1-8 chars: letter then letters/digits/underscore')
  return p
}

function monthStart(iso: string): Date {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, 1))
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function buildSchemaDdl(optsIn: SchemaOptions, ctx: DdlContext): DdlResult {
  const warnings: string[] = []
  const opts: SchemaOptions = { ...optsIn, prefix: validatePrefix(optsIn.prefix) }
  const S = ctx.schema.toUpperCase()
  if (!IDENT.test(S)) throw new Error('Invalid schema name')
  const P = opts.prefix
  const q = (name: string) => `${S}.${name}`
  const T = (t: TableDef | string) => q(`${P}${typeof t === 'string' ? t : t.key}`)
  const ts = opts.tablespace ? ` TABLESPACE ${opts.tablespace.toUpperCase()}` : ''
  if (opts.tablespace && !IDENT.test(opts.tablespace.toUpperCase())) throw new Error('Invalid tablespace name')

  if (opts.partitioning !== 'none' && ctx.partitioningAvailable === false) {
    warnings.push('Partitioning option is not enabled on this database (V$OPTION). Tables will be created without partitioning.')
    opts.partitioning = 'none'
  } else if (opts.partitioning !== 'none' && ctx.partitioningAvailable === null) {
    warnings.push('Could not verify the Partitioning option (V$OPTION not visible). Partitioned DDL may fail with ORA-00439.')
  }
  if (opts.partitioning === 'interval' && ctx.versionMajor > 0 && ctx.versionMajor < 11) {
    warnings.push('Interval partitioning requires Oracle 11g or later; falling back to range partitioning.')
    opts.partitioning = 'range'
  }
  if (opts.compression) {
    warnings.push('Basic table compression requires Enterprise Edition; those statements are optional and will be skipped if rejected.')
  }
  const maxTables = 1000
  if (opts.extensionTables > maxTables) throw new Error(`At most ${maxTables} extension tables`)

  const tables = blueprintTables({ includeLobs: opts.includeLobs, extensionTables: opts.extensionTables })
  const out: PlannedStatement[] = []
  const add = (objectType: string, objectName: string, sql: string, extra: Partial<PlannedStatement> = {}) =>
    out.push({ seq: out.length + 1, objectType, objectName, sql, ...extra })

  // Sequences (CACHE keeps sequence-based inserts fast under concurrency).
  for (const t of tables.filter((t) => t.sequence)) {
    add('SEQUENCE', `${P}${t.alias}_SEQ`, `CREATE SEQUENCE ${q(seqName(P, t))} START WITH 1 INCREMENT BY 1 CACHE 1000 NOCYCLE`)
  }
  if (opts.extensionTables > 0) {
    add('SEQUENCE', extSeqName(P), `CREATE SEQUENCE ${q(extSeqName(P))} START WITH 1 INCREMENT BY 1 CACHE 1000 NOCYCLE`)
  }

  // Tables with inline PK / UK / CHECK constraints. Foreign keys are added afterwards.
  const historyStart = monthStart(opts.historyStart)
  const today = ctx.today ?? new Date().toISOString().slice(0, 10)
  for (const t of tables) {
    const cols = t.columns.map((c) => `  ${c.name.padEnd(22)} ${c.type}${c.nullable ? '' : ' NOT NULL'}`)
    const cons: string[] = [`  CONSTRAINT ${P}${t.alias}_PK PRIMARY KEY (${t.pk.join(', ')})`]
    for (const u of t.uniques ?? []) cons.push(`  CONSTRAINT ${P}${t.alias}_${u.suffix} UNIQUE (${u.cols.join(', ')})`)
    for (const c of t.checks ?? []) cons.push(`  CONSTRAINT ${P}${t.alias}_${c.suffix} CHECK (${c.expr})`)
    let physical = ts
    let note: string | undefined
    if (t.key === 'ORDERS' && opts.partitioning !== 'none') {
      physical += `\n${ordersPartitionClause(opts.partitioning, historyStart, today)}`
      note = `${opts.partitioning} partitioning`
    } else if (t.key === 'ORDER_ITEMS' && opts.partitioning !== 'none') {
      physical += `\nPARTITION BY HASH (ORDER_ID) PARTITIONS 8`
      note = 'hash partitioning'
    }
    if (opts.compression && (t.kind === 'log' || t.kind === 'extension' || t.key === 'INVENTORY_MOVEMENTS')) {
      physical += ' COMPRESS'
      note = note ? `${note}, compressed` : 'basic compression'
    }
    add('TABLE', `${P}${t.key}`, `CREATE TABLE ${T(t)} (\n${[...cols, ...cons].join(',\n')}\n)${physical}`, {
      note,
      optional: false,
    })
    add('COMMENT', `${P}${t.key}`, `COMMENT ON TABLE ${T(t)} IS '${t.comment.replace(/'/g, "''")}'`)
  }

  // Foreign keys + supporting indexes (unindexed FKs cause lock escalation on parent DML).
  for (const t of tables) {
    for (const fk of t.fks ?? []) {
      add(
        'CONSTRAINT',
        `${P}${t.alias}_${fk.suffix}`,
        `ALTER TABLE ${T(t)} ADD CONSTRAINT ${P}${t.alias}_${fk.suffix} FOREIGN KEY (${fk.cols.join(', ')}) REFERENCES ${T(fk.ref)} (${fk.refCols.join(', ')})`,
      )
    }
  }
  for (const t of tables) {
    const partitioned = opts.partitioning !== 'none' && (t.key === 'ORDERS' || t.key === 'ORDER_ITEMS')
    for (const ix of t.indexes ?? []) {
      const local = partitioned && ix.local && t.key === 'ORDERS' ? ' LOCAL' : ''
      const comp = ix.compress && opts.compression ? ` COMPRESS ${ix.compress}` : ''
      add('INDEX', `${P}${t.alias}_${ix.suffix}`, `CREATE INDEX ${q(`${P}${t.alias}_${ix.suffix}`)} ON ${T(t)} (${ix.cols.join(', ')})${comp}${ts}${local}`, {
        note: local ? 'local partitioned index' : undefined,
      })
    }
  }

  // Views
  add('VIEW', `${P}V_ORDER_SUMMARY`, `CREATE OR REPLACE VIEW ${q(`${P}V_ORDER_SUMMARY`)} AS
SELECT o.order_id, o.order_no, o.order_date, o.status, o.channel, o.items_count, o.order_total,
       c.customer_id, c.first_name || ' ' || c.last_name AS customer_name, c.segment, r.region_name
  FROM ${T('ORDERS')} o
  JOIN ${T('CUSTOMERS')} c ON c.customer_id = o.customer_id
  JOIN ${T('REGIONS')} r ON r.region_id = c.region_id`)
  add('VIEW', `${P}V_PRODUCT_SALES`, `CREATE OR REPLACE VIEW ${q(`${P}V_PRODUCT_SALES`)} AS
SELECT p.product_id, p.sku, p.product_name, cat.category_name,
       COUNT(*) AS order_lines, SUM(i.quantity) AS units_sold, SUM(i.line_total) AS revenue
  FROM ${T('ORDER_ITEMS')} i
  JOIN ${T('PRODUCTS')} p ON p.product_id = i.product_id
  JOIN ${T('CATEGORIES')} cat ON cat.category_id = p.category_id
 GROUP BY p.product_id, p.sku, p.product_name, cat.category_name`)
  add('VIEW', `${P}V_INVENTORY_STATUS`, `CREATE OR REPLACE VIEW ${q(`${P}V_INVENTORY_STATUS`)} AS
SELECT inv.product_id, p.sku, inv.warehouse_id, w.warehouse_code, inv.qty_on_hand, inv.reorder_level,
       CASE WHEN inv.qty_on_hand <= inv.reorder_level THEN 'REORDER' ELSE 'OK' END AS stock_flag
  FROM ${T('INVENTORY')} inv
  JOIN ${T('PRODUCTS')} p ON p.product_id = inv.product_id
  JOIN ${T('WAREHOUSES')} w ON w.warehouse_id = inv.warehouse_id`)
  add('VIEW', `${P}V_CUSTOMER_360`, `CREATE OR REPLACE VIEW ${q(`${P}V_CUSTOMER_360`)} AS
SELECT c.customer_id, c.customer_code, c.segment, c.loyalty_tier, c.signup_date,
       COUNT(o.order_id) AS orders_cnt, NVL(SUM(o.order_total), 0) AS lifetime_value, MAX(o.order_date) AS last_order_date
  FROM ${T('CUSTOMERS')} c
  LEFT JOIN ${T('ORDERS')} o ON o.customer_id = c.customer_id AND o.status <> 'CANCELLED'
 GROUP BY c.customer_id, c.customer_code, c.segment, c.loyalty_tier, c.signup_date`)

  // Materialized views (complete refresh on demand; built deferred so creation is cheap).
  if (opts.includeMaterializedViews) {
    const mvComp = opts.compression ? ' COMPRESS' : ''
    add('MATERIALIZED VIEW', `${P}MV_DAILY_SALES`, `CREATE MATERIALIZED VIEW ${q(`${P}MV_DAILY_SALES`)}${mvComp}${ts}
BUILD DEFERRED REFRESH COMPLETE ON DEMAND AS
SELECT TRUNC(order_date) AS sales_day, channel, COUNT(*) AS orders_cnt, SUM(order_total) AS revenue
  FROM ${T('ORDERS')}
 WHERE status <> 'CANCELLED'
 GROUP BY TRUNC(order_date), channel`, { optional: true, note: 'requires CREATE MATERIALIZED VIEW' })
    add('MATERIALIZED VIEW', `${P}MV_CATEGORY_MONTHLY`, `CREATE MATERIALIZED VIEW ${q(`${P}MV_CATEGORY_MONTHLY`)}${mvComp}${ts}
BUILD DEFERRED REFRESH COMPLETE ON DEMAND AS
SELECT TRUNC(o.order_date, 'MM') AS sales_month, p.category_id, SUM(i.quantity) AS units, SUM(i.line_total) AS revenue
  FROM ${T('ORDERS')} o
  JOIN ${T('ORDER_ITEMS')} i ON i.order_id = o.order_id
  JOIN ${T('PRODUCTS')} p ON p.product_id = i.product_id
 GROUP BY TRUNC(o.order_date, 'MM'), p.category_id`, { optional: true, note: 'requires CREATE MATERIALIZED VIEW' })
  }

  if (opts.includeSynonyms) {
    add('SYNONYM', `${P}SALES`, `CREATE OR REPLACE SYNONYM ${q(`${P}SALES`)} FOR ${T('ORDERS')}`, { optional: true, note: 'requires CREATE SYNONYM' })
    add('SYNONYM', `${P}CLIENTS`, `CREATE OR REPLACE SYNONYM ${q(`${P}CLIENTS`)} FOR ${T('CUSTOMERS')}`, { optional: true, note: 'requires CREATE SYNONYM' })
  }

  if (opts.includePlsql) {
    const pkg = `${P}LAB_PKG`
    add('FUNCTION', `${P}FMT_ORDER_NO`, `CREATE OR REPLACE FUNCTION ${q(`${P}FMT_ORDER_NO`)}(p_order_id IN NUMBER, p_order_date IN DATE)
RETURN VARCHAR2 DETERMINISTIC IS
BEGIN
  RETURN 'SO' || TO_CHAR(p_order_date, 'YYMM') || LPAD(TO_CHAR(p_order_id), 10, '0');
END;`)
    add('PACKAGE', pkg, `CREATE OR REPLACE PACKAGE ${q(pkg)} AS
  FUNCTION order_total(p_order_id IN NUMBER) RETURN NUMBER;
  FUNCTION customer_lifetime_value(p_customer_id IN NUMBER) RETURN NUMBER;
  PROCEDURE touch_customers(p_limit IN PLS_INTEGER, p_updated OUT PLS_INTEGER);
  PROCEDURE purge_bench_run(p_run_id IN VARCHAR2, p_deleted OUT PLS_INTEGER);
END ${pkg};`)
    add('PACKAGE BODY', pkg, `CREATE OR REPLACE PACKAGE BODY ${q(pkg)} AS
  FUNCTION order_total(p_order_id IN NUMBER) RETURN NUMBER IS
    v_total NUMBER;
  BEGIN
    SELECT NVL(SUM(line_total), 0) INTO v_total FROM ${T('ORDER_ITEMS')} WHERE order_id = p_order_id;
    RETURN v_total;
  END order_total;

  FUNCTION customer_lifetime_value(p_customer_id IN NUMBER) RETURN NUMBER IS
    v_total NUMBER;
  BEGIN
    SELECT NVL(SUM(order_total), 0) INTO v_total FROM ${T('ORDERS')}
     WHERE customer_id = p_customer_id AND status <> 'CANCELLED';
    RETURN v_total;
  END customer_lifetime_value;

  -- PL/SQL bulk processing demo: BULK COLLECT + FORALL.
  PROCEDURE touch_customers(p_limit IN PLS_INTEGER, p_updated OUT PLS_INTEGER) IS
    TYPE t_ids IS TABLE OF ${T('CUSTOMERS')}.customer_id%TYPE;
    v_ids t_ids;
  BEGIN
    SELECT customer_id BULK COLLECT INTO v_ids FROM ${T('CUSTOMERS')} WHERE ROWNUM <= p_limit;
    FORALL i IN 1 .. v_ids.COUNT
      UPDATE ${T('CUSTOMERS')} SET updated_at = SYSTIMESTAMP WHERE customer_id = v_ids(i);
    p_updated := SQL%ROWCOUNT;
  END touch_customers;

  PROCEDURE purge_bench_run(p_run_id IN VARCHAR2, p_deleted OUT PLS_INTEGER) IS
  BEGIN
    DELETE FROM ${T('BENCH_EVENTS')} WHERE run_id = p_run_id;
    p_deleted := SQL%ROWCOUNT;
  END purge_bench_run;
END ${pkg};`)
    const refreshBody = opts.includeMaterializedViews
      ? `  DBMS_MVIEW.REFRESH('${q(`${P}MV_DAILY_SALES`)},${q(`${P}MV_CATEGORY_MONTHLY`)}', 'CC');`
      : '  NULL; -- materialized views were not created'
    add('PROCEDURE', `${P}REFRESH_SUMMARIES`, `CREATE OR REPLACE PROCEDURE ${q(`${P}REFRESH_SUMMARIES`)} IS
BEGIN
${refreshBody}
END;`)
    add('TRIGGER', `${P}CUS_BU_TRG`, `CREATE OR REPLACE TRIGGER ${q(`${P}CUS_BU_TRG`)}
BEFORE UPDATE ON ${T('CUSTOMERS')}
FOR EACH ROW
BEGIN
  :NEW.updated_at := SYSTIMESTAMP;
END;`)
    add('TRIGGER', `${P}ORD_AU_TRG`, `CREATE OR REPLACE TRIGGER ${q(`${P}ORD_AU_TRG`)}
AFTER UPDATE OF status ON ${T('ORDERS')}
FOR EACH ROW
WHEN (NEW.status <> OLD.status)
BEGIN
  INSERT INTO ${T('ORDER_STATUS_LOG')} (log_id, order_id, old_status, new_status, changed_at, changed_by)
  VALUES (${q(`${P}OSL_SEQ`)}.NEXTVAL, :NEW.order_id, :OLD.status, :NEW.status, SYSTIMESTAMP, SYS_CONTEXT('USERENV', 'SESSION_USER'));
END;`)
  }

  return { statements: out, warnings, effectiveOptions: opts }
}

function ordersPartitionClause(kind: SchemaOptions['partitioning'], historyStart: Date, today: string): string {
  if (kind === 'interval') {
    return `PARTITION BY RANGE (ORDER_DATE) INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))\n(PARTITION P_INITIAL VALUES LESS THAN (DATE '${ymd(historyStart)}'))`
  }
  if (kind === 'range') {
    const parts: string[] = [`  PARTITION P_HIST VALUES LESS THAN (DATE '${ymd(historyStart)}')`]
    const end = addMonths(monthStart(today), 4)
    let d = historyStart
    let guard = 0
    while (d < end && guard++ < 600) {
      const next = addMonths(d, 1)
      parts.push(`  PARTITION P_${ymd(d).slice(0, 7).replace('-', '')} VALUES LESS THAN (DATE '${ymd(next)}')`)
      d = next
    }
    parts.push('  PARTITION P_MAX VALUES LESS THAN (MAXVALUE)')
    return `PARTITION BY RANGE (ORDER_DATE) (\n${parts.join(',\n')}\n)`
  }
  if (kind === 'list') {
    return `PARTITION BY LIST (CHANNEL) (
  PARTITION P_WEB VALUES ('WEB'),
  PARTITION P_MOBILE VALUES ('MOBILE'),
  PARTITION P_STORE VALUES ('STORE'),
  PARTITION P_MARKETPLACE VALUES ('MARKETPLACE'),
  PARTITION P_OTHER VALUES (DEFAULT)
)`
  }
  return 'PARTITION BY HASH (ORDER_ID) PARTITIONS 16'
}

/** Statements that remove every object this blueprint can create (used by Cleanup, never automatic). */
export function dropOrder(objectType: string): number {
  const order = ['TRIGGER', 'MATERIALIZED VIEW', 'SYNONYM', 'VIEW', 'PACKAGE BODY', 'PACKAGE', 'PROCEDURE', 'FUNCTION', 'TABLE', 'SEQUENCE']
  const i = order.indexOf(objectType)
  return i < 0 ? order.length : i
}

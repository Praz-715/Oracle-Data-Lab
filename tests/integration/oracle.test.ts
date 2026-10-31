import oracledb from 'oracledb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSchemaDdl } from '../../server/generators/ddl'
import { DataModel, buildRefData, categoryRows, deriveCounts, regionRows, warehouseRows } from '../../server/generators/model'

// Runs the real DDL and a small generated dataset against a DISPOSABLE test schema, then checks a
// few business rules in SQL. Configure ODL_TEST_CONNECT_STRING / ODL_TEST_USER / ODL_TEST_PASSWORD.
// Uses prefix ZT_ and drops everything it created afterwards.

const cs = process.env.ODL_TEST_CONNECT_STRING
const user = process.env.ODL_TEST_USER
const password = process.env.ODL_TEST_PASSWORD
const P = 'ZT_'

describe.skipIf(!cs || !user || !password)('Oracle integration', () => {
  let conn: oracledb.Connection
  let schema = ''

  beforeAll(async () => {
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT
    conn = await oracledb.getConnection({ connectString: cs, user, password })
    schema = String((await conn.execute<{ S: string }>(`SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL`)).rows![0]!.S)
  })

  afterAll(async () => {
    if (!conn) return
    const objs = await conn.execute<{ N: string; T: string }>(
      `SELECT OBJECT_NAME AS N, OBJECT_TYPE AS T FROM USER_OBJECTS WHERE OBJECT_NAME LIKE 'ZT\\_%' ESCAPE '\\'
        AND OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','SYNONYM','PACKAGE','PROCEDURE','FUNCTION')`,
    )
    for (const o of objs.rows ?? []) {
      const sql = o.T === 'TABLE' ? `DROP TABLE ${o.N} CASCADE CONSTRAINTS PURGE` : `DROP ${o.T} ${o.N}`
      await conn.execute(sql).catch(() => {})
    }
    await conn.close()
  })

  it('creates the blueprint schema', async () => {
    const major = Math.floor((conn.oracleServerVersion ?? 0) / 100000000)
    const { statements } = buildSchemaDdl(
      { prefix: P, partitioning: 'none', includeLobs: true, includePlsql: true, includeMaterializedViews: false, includeSynonyms: false, compression: false, extensionTables: 1, historyStart: '2024-01-01' },
      { schema, versionMajor: major, partitioningAvailable: null },
    )
    for (const s of statements) await conn.execute(s.sql)
    const r = await conn.execute<{ N: number }>(`SELECT COUNT(*) AS N FROM USER_OBJECTS WHERE OBJECT_NAME LIKE 'ZT\\_%' ESCAPE '\\' AND STATUS = 'INVALID'`)
    expect(r.rows![0]!.N).toBe(0)
  })

  it('loads a generated dataset that satisfies the business rules', async () => {
    const regions = regionRows('it', 1).map((r) => ({ id: r[0] as number, code: r[1] as string }))
    const cats = categoryRows('it', 100).map((r) => ({ id: r[0] as number, name: r[2] as string, parentId: r[1] as number | null }))
    const whRows = warehouseRows('it', 500, new Map(regions.map((r) => [r.code, r.id])))
    const counts = deriveCounts(2000, 1, 100)
    const model = new DataModel({
      seed: 7, jobId: 'it', includeLobs: true, historyStart: '2024-01-01', historyEnd: '2025-06-30', counts,
      bases: { region: 1, category: 100, warehouse: 500, supplier: 1000, product: 10_000, customer: 100_000, order: 1_000_000, payment: 5_000_000, shipment: 9_000_000, return: 20_000_000, movement: 50_000_000, review: 80_000_000, image: 90_000_000, ext: 95_000_000 },
      refs: buildRefData(regions, cats, whRows.map((r) => ({ id: r[0] as number, regionId: r[3] as number }))),
    })
    const ins = async (t: string, rows: unknown[][]) => {
      if (!rows.length) return
      const n = rows[0]!.length
      await conn.executeMany(`INSERT INTO ${P}${t} VALUES (${Array.from({ length: n }, (_, i) => `:${i + 1}`).join(',')})`, rows as any[])
    }
    await ins('REGIONS', regionRows('it', 1))
    await ins('CATEGORIES', categoryRows('it', 100))
    await ins('WAREHOUSES', whRows)
    await ins('SUPPLIERS', model.supplierRows(0, counts.suppliers))
    await ins('PRODUCTS', model.productRows(0, counts.products))
    const inv = model.inventoryRows(0, counts.products)
    await ins('INVENTORY', inv.inventory)
    await ins('INVENTORY_MOVEMENTS', inv.movements)
    await ins('CUSTOMERS', model.customerRows(0, counts.customers))
    const o = model.orderBatch(0, counts.orders)
    await ins('ORDERS', o.orders)
    await ins('ORDER_ITEMS', o.items)
    await ins('PAYMENTS', o.payments)
    await ins('SHIPMENTS', o.shipments)
    await ins('RETURNS', o.returns)
    await conn.commit()

    const one = async (sql: string) => Number((await conn.execute<{ N: number }>(sql)).rows![0]!.N)
    expect(await one(`SELECT COUNT(*) AS N FROM ${P}ORDERS o WHERE o.SUBTOTAL <> (SELECT SUM(LINE_TOTAL) FROM ${P}ORDER_ITEMS i WHERE i.ORDER_ID = o.ORDER_ID)`)).toBe(0)
    expect(await one(`SELECT COUNT(*) AS N FROM ${P}SHIPMENTS s JOIN ${P}ORDERS o ON o.ORDER_ID = s.ORDER_ID WHERE s.SHIPPED_DATE < o.ORDER_DATE`)).toBe(0)
    expect(await one(`SELECT COUNT(*) AS N FROM ${P}INVENTORY v WHERE v.QTY_ON_HAND <> (SELECT SUM(QUANTITY) FROM ${P}INVENTORY_MOVEMENTS m WHERE m.PRODUCT_ID = v.PRODUCT_ID AND m.WAREHOUSE_ID = v.WAREHOUSE_ID)`)).toBe(0)
  })
})

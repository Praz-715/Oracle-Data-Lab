import { describe, expect, it } from 'vitest'
import { aliasOf, buildAdvice, classify, splitConjuncts, uses, type PlanRow, type TableInfo } from '../../server/tuning/advisor'

const row = (p: Partial<PlanRow> & Pick<PlanRow, 'id' | 'operation'>): PlanRow => ({ parentId: null, options: null, owner: null, object: null, alias: null, cost: null, cardinality: null, access: null, filter: null, ...p })
const info = (table: string, rows: number, ndv: Record<string, number>, indexes: TableInfo['indexes'] = []): [string, TableInfo] => [`LAB.${table}`, { owner: 'LAB', table, rows, ndv, indexes }]

describe('predicate parsing', () => {
  it('splits top-level AND only', () => {
    expect(splitConjuncts(`"O"."A"='x AND y' AND ("O"."B"=1 OR "O"."B"=2) AND "O"."C">=TO_DATE(:D1,'YYYY-MM-DD')`)).toEqual([
      `"O"."A"='x AND y'`,
      `"O"."B"=1 OR "O"."B"=2`,
      `"O"."C">=TO_DATE(:D1,'YYYY-MM-DD')`,
    ])
  })

  it('classifies equality, ranges, IN lists, LIKE, NULL and negations', () => {
    expect(classify(`"O"."ORDER_STATUS"='delivered'`, 'O')).toEqual([expect.objectContaining({ column: 'ORDER_STATUS', kind: 'eq' })])
    expect(classify(`"O"."TS">=TO_DATE(:D1,'YYYY-MM-DD')`, 'O')[0]!.kind).toBe('range')
    expect(classify(`:B1<="O"."TS"`, 'O')[0]!.kind).toBe('range')
    expect(classify(`"C"."STATE"='SP' OR "C"."STATE"='RJ'`, 'C')).toEqual([expect.objectContaining({ column: 'STATE', kind: 'in' })])
    expect(classify(`"P"."NAME" LIKE 'abc%'`, 'P')[0]!.kind).toBe('like-prefix')
    expect(classify(`"P"."NAME" LIKE '%abc'`, 'P')[0]!.kind).toBe('like-wild')
    expect(classify(`"P"."NAME" IS NULL`, 'P')[0]!.kind).toBe('null')
    expect(classify(`"P"."NAME"<>'x'`, 'P')[0]!.kind).toBe('neq')
    expect(classify(`"STATUS"='X'`, 'ORDERS')[0]).toMatchObject({ column: 'STATUS', kind: 'eq' })
  })

  it('detects functions, implicit conversions and joins', () => {
    expect(classify(`LOWER("R"."MSG") LIKE :W`, 'R')[0]).toMatchObject({ kind: 'function', fn: 'LOWER' })
    expect(classify(`INTERNAL_FUNCTION("O"."TS")>=:B1`, 'O')[0]).toMatchObject({ kind: 'implicit' })
    expect(classify(`TRUNC(INTERNAL_FUNCTION("O"."TS"))=TO_DATE(' 2018-01-15 00:00:00', 'syyyy-mm-dd hh24:mi:ss')`, 'O')[0]).toMatchObject({ kind: 'function', fn: 'TRUNC' })
    expect(classify(`"I"."ORDER_ID"="O"."ORDER_ID"`, 'I')).toEqual([expect.objectContaining({ column: 'ORDER_ID', kind: 'join' })])
    expect(classify(`"I"."ORDER_ID"="O"."ORDER_ID"`, 'X')).toEqual([])
    expect(aliasOf('"O"@"SEL$1"', 'ORDERS')).toBe('O')
    expect(aliasOf(null, 'ORDERS')).toBe('ORDERS')
  })
})

describe('index candidates', () => {
  const tables = new Map([
    info('OL_ORDERS', 99_441, { ORDER_STATUS: 8, ORDER_PURCHASE_TIMESTAMP: 98_000, CUSTOMER_ID: 99_441 }, [{ name: 'OL_ORDERS_PK', columns: ['ORDER_ID'] }]),
    info('OL_ORDER_ITEMS', 112_650, { ORDER_ID: 98_666 }, [{ name: 'OL_ORDER_ITEMS_PK', columns: ['ORDER_ID', 'ORDER_ITEM_ID'] }]),
    info('OL_REVIEWS', 99_224, { MSG: 36_000 }),
    info('OL_TINY', 71, { NAME: 71 }),
    info('OL_GEO', 1_000_163, { ZIP: 19_000 }),
  ])

  it('suggests a selective filter index with equality columns first, then the range column', () => {
    const plan = [
      row({ id: 0, operation: 'SELECT STATEMENT', cost: 900 }),
      row({ id: 1, parentId: 0, operation: 'TABLE ACCESS', options: 'FULL', owner: 'LAB', object: 'OL_ORDERS', alias: 'O@SEL$1', cost: 880, cardinality: 120,
        filter: `"O"."ORDER_PURCHASE_TIMESTAMP">=TO_DATE(:D1,'YYYY-MM-DD') AND "O"."ORDER_PURCHASE_TIMESTAMP"<TO_DATE(:D2,'YYYY-MM-DD') AND "O"."ORDER_STATUS"='canceled'` }),
    ]
    const a = buildAdvice(plan, tables)
    expect(a.fullScans).toHaveLength(1)
    expect(a.candidates[0]).toMatchObject({ table: 'OL_ORDERS', columns: ['ORDER_STATUS', 'ORDER_PURCHASE_TIMESTAMP'], kind: 'filter', coveredBy: null })
    expect(a.candidates[0]!.ddl).toBe('CREATE INDEX LAB.OL_ORDERS_ORDER_ST_IX ON LAB.OL_ORDERS (ORDER_STATUS, ORDER_PURCHASE_TIMESTAMP)')
  })

  it('skips small tables and unselective filters, and explains why', () => {
    const plan = [
      row({ id: 1, operation: 'TABLE ACCESS', options: 'FULL', owner: 'LAB', object: 'OL_TINY', alias: 'T@SEL$1', cardinality: 1, filter: `"T"."NAME"='x'` }),
      row({ id: 2, operation: 'TABLE ACCESS', options: 'FULL', owner: 'LAB', object: 'OL_ORDERS', alias: 'O@SEL$1', cardinality: 96_000, filter: `"O"."ORDER_STATUS"='delivered'` }),
    ]
    const a = buildAdvice(plan, tables)
    expect(a.candidates).toEqual([])
    expect(a.notes.map((n) => n.text).join(' ')).toMatch(/only 71 rows.*keeps ~96\.5%/s)
  })

  it('judges the indexable part alone when other predicates on the table cannot use an index', () => {
    const t = new Map([info('OL_REVIEWS', 99_224, { MSG: 36_000, SCORE: 5 })])
    const plan = [
      row({ id: 1, operation: 'TABLE ACCESS', options: 'FULL', owner: 'LAB', object: 'OL_REVIEWS', alias: 'R@SEL$1', cardinality: 992, filter: `LOWER("R"."MSG") LIKE '%atraso%' AND "R"."SCORE"=1` }),
    ]
    const a = buildAdvice(plan, t)
    expect(a.candidates).toEqual([])
    expect(a.notes.map((n) => n.text).join(' ')).toContain('keeps ~20.0%')
  })

  it('turns index-defeating predicates into notes', () => {
    const plan = [
      row({ id: 1, operation: 'TABLE ACCESS', options: 'FULL', owner: 'LAB', object: 'OL_REVIEWS', alias: 'R@SEL$1', cardinality: 50, filter: `LOWER("R"."MSG") LIKE :W AND "R"."MSG" LIKE '%atraso%'` }),
      row({ id: 2, operation: 'TABLE ACCESS', options: 'FULL', owner: 'LAB', object: 'OL_ORDERS', alias: 'O@SEL$1', cardinality: 50, filter: `INTERNAL_FUNCTION("O"."ORDER_PURCHASE_TIMESTAMP")>=:B1` }),
    ]
    const a = buildAdvice(plan, tables)
    expect(a.candidates).toEqual([])
    const text = a.notes.map((n) => n.text).join(' ')
    expect(text).toContain('LOWER(MSG)')
    expect(text).toContain('leading wildcard')
    expect(text).toContain('Implicit datatype conversion')
  })

  it('suggests a join index for a big table probed by a small row source, unless an index already leads with it', () => {
    const plan = [
      row({ id: 1, operation: 'HASH JOIN', access: `"G"."ZIP"="C"."ZIP"`, cardinality: 40 }),
      row({ id: 2, parentId: 1, operation: 'TABLE ACCESS', options: 'BY INDEX ROWID', owner: 'LAB', object: 'OL_ORDERS', alias: 'C@SEL$1', cardinality: 3 }),
      row({ id: 3, parentId: 1, operation: 'TABLE ACCESS', options: 'FULL', owner: 'LAB', object: 'OL_GEO', alias: 'G@SEL$1', cost: 1500, cardinality: 1_000_163 }),
      row({ id: 4, operation: 'HASH JOIN', access: `"I"."ORDER_ID"="O"."ORDER_ID"` }),
      row({ id: 5, parentId: 4, operation: 'TABLE ACCESS', options: 'BY INDEX ROWID', owner: 'LAB', object: 'OL_ORDERS', alias: 'O@SEL$1', cardinality: 10 }),
      row({ id: 6, parentId: 4, operation: 'TABLE ACCESS', options: 'FULL', owner: 'LAB', object: 'OL_ORDER_ITEMS', alias: 'I@SEL$1', cost: 300, cardinality: 112_650 }),
    ]
    const a = buildAdvice(plan, tables)
    expect(a.candidates.map((c) => [c.table, c.columns, c.kind, c.coveredBy])).toEqual([
      ['OL_GEO', ['ZIP'], 'join', null],
      ['OL_ORDER_ITEMS', ['ORDER_ID'], 'join', 'OL_ORDER_ITEMS_PK'],
    ])
    expect(uses(`"I"."ORDER_ID"="O"."ORDER_ID"`, 'I')[0]!.kind).toBe('join')
  })
})

import { describe, expect, it } from 'vitest'
import { tableByKey } from '../../server/generators/blueprint'
import {
  DataModel,
  MAX_LINES,
  buildRefData,
  categoryRows,
  deriveCounts,
  regionRows,
  warehouseRows,
  type IdBases,
} from '../../server/generators/model'
import { DayDistribution, Rng, hash32, scatter } from '../../server/generators/prng'

function makeModel(orders = 3000, seed = 42) {
  const regions = regionRows('job', 1).map((r) => ({ id: r[0] as number, code: r[1] as string }))
  const cats = categoryRows('job', 100).map((r) => ({ id: r[0] as number, name: r[2] as string, parentId: r[1] as number | null }))
  const wh = warehouseRows('job', 500, new Map(regions.map((r) => [r.code, r.id]))).map((r) => ({ id: r[0] as number, regionId: r[3] as number }))
  const counts = deriveCounts(orders, 3, 200)
  const bases: IdBases = {
    region: 1, category: 100, warehouse: 500, supplier: 1000, product: 10_000, customer: 100_000, order: 1_000_000,
    payment: 5_000_000, shipment: 9_000_000, return: 20_000_000, movement: 50_000_000, review: 80_000_000, image: 90_000_000, ext: 95_000_000,
  }
  return new DataModel({
    seed,
    jobId: '00000000-0000-4000-8000-000000000000',
    includeLobs: true,
    historyStart: '2023-01-01',
    historyEnd: '2025-12-31',
    counts,
    bases,
    refs: buildRefData(regions, cats, wh),
  })
}

describe('prng', () => {
  it('is deterministic per (seed, stream, index)', () => {
    const a = new Rng(hash32(1, 'x', 5))
    const b = new Rng(hash32(1, 'x', 5))
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()])
    expect(hash32(1, 'x', 5)).not.toBe(hash32(1, 'x', 6))
  })

  it('zipf stays in range and favours low indexes', () => {
    const r = new Rng(7)
    const hits = new Array(100).fill(0)
    for (let i = 0; i < 20000; i++) {
      const v = r.zipf(100, 0.7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(100)
      hits[v]++
    }
    expect(hits[0]).toBeGreaterThan(hits[99])
  })

  it('scatter is a permutation', () => {
    const n = 997
    const seen = new Set(Array.from({ length: n }, (_, i) => scatter(i, n, 3)))
    expect(seen.size).toBe(n)
  })

  it('day distribution quantile is monotone and covers the range', () => {
    const d = new DayDistribution(100, 200, (x) => (x % 7 === 0 ? 3 : 1))
    let prev = -1
    for (let i = 0; i < 1000; i++) {
      const q = d.quantile(i / 1000).day
      expect(q).toBeGreaterThanOrEqual(prev)
      prev = q
    }
    expect(d.quantile(0).day).toBe(100)
    expect(d.quantile(0.9999999).day).toBe(200)
  })
})

describe('data model', () => {
  const model = makeModel()
  const batch = model.orderBatch(0, 3000)

  it('rows match blueprint column counts', () => {
    const check = (key: string, rows: unknown[][]) => {
      const n = tableByKey(key).columns.length
      for (const r of rows) expect(r.length).toBe(n)
    }
    check('SUPPLIERS', model.supplierRows(0, 20))
    check('PRODUCTS', model.productRows(0, 50))
    check('CUSTOMERS', model.customerRows(0, 50))
    check('PRODUCT_IMAGES', model.imageRows(0, 10))
    const inv = model.inventoryRows(0, 30)
    check('INVENTORY', inv.inventory)
    check('INVENTORY_MOVEMENTS', inv.movements)
    check('ORDERS', batch.orders)
    check('ORDER_ITEMS', batch.items)
    check('PAYMENTS', batch.payments)
    check('SHIPMENTS', batch.shipments)
    check('RETURNS', batch.returns)
    check('PRODUCT_REVIEWS', batch.reviews)
    for (let n = 1; n <= 3; n++) check(`EXT_${String(n).padStart(3, '0')}`, model.extensionRows(n, 0, 20))
  })

  it('is deterministic and resumable at any batch boundary', () => {
    const again = makeModel()
    const whole = again.orderBatch(0, 1000).orders
    const split = [...again.orderBatch(0, 400).orders, ...again.orderBatch(400, 1000).orders]
    expect(split).toEqual(whole)
  })

  it('order dates are monotone with order ids and within the window', () => {
    let prev = 0
    for (const o of batch.orders) {
      const t = (o[3] as Date).getTime()
      expect(t).toBeGreaterThanOrEqual(prev)
      prev = t
    }
    expect((batch.orders[0]![3] as Date).getFullYear()).toBe(2023)
  })

  it('order totals reconcile with lines, shipping and tax', () => {
    const lineSum = new Map<number, number>()
    for (const i of batch.items) lineSum.set(i[0] as number, (lineSum.get(i[0] as number) ?? 0) + Math.round((i[6] as number) * 100))
    for (const o of batch.orders) {
      const sub = Math.round((o[9] as number) * 100)
      expect(sub).toBe(lineSum.get(o[0] as number))
      const total = Math.round((o[13] as number) * 100)
      expect(total).toBe(sub + Math.round((o[11] as number) * 100) + Math.round((o[12] as number) * 100))
      expect(o[8]).toBe(batch.items.filter((i) => i[0] === o[0]).length)
    }
  })

  it('captured payments equal the order total for fulfilled orders', () => {
    const paid = new Map<number, number>()
    for (const p of batch.payments) if (p[5] === 'CAPTURED') paid.set(p[1] as number, (paid.get(p[1] as number) ?? 0) + Math.round((p[4] as number) * 100))
    for (const o of batch.orders) {
      if (o[4] === 'DELIVERED' || o[4] === 'RETURNED') expect(paid.get(o[0] as number)).toBe(Math.round((o[13] as number) * 100))
    }
  })

  it('shipments never precede the order and returns never exceed purchased quantity', () => {
    const orderDate = new Map(batch.orders.map((o) => [o[0] as number, (o[3] as Date).getTime()]))
    for (const s of batch.shipments) {
      expect((s[4] as Date).getTime()).toBeGreaterThanOrEqual(orderDate.get(s[1] as number)!)
      if (s[5]) expect((s[5] as Date).getTime()).toBeGreaterThanOrEqual((s[4] as Date).getTime())
    }
    const qty = new Map(batch.items.map((i) => [`${i[0]}:${i[1]}`, i[3] as number]))
    for (const r of batch.returns) {
      expect(r[3] as number).toBeLessThanOrEqual(qty.get(`${r[1]}:${r[2]}`)!)
      expect(r[0] as number).toBeLessThan(model.b.return + 3000 * MAX_LINES)
    }
  })

  it('inventory on hand equals the sum of movements and never goes negative', () => {
    const { inventory, movements } = model.inventoryRows(0, 200)
    const sums = new Map<string, number[]>()
    for (const m of movements) {
      const k = `${m[1]}:${m[2]}`
      sums.set(k, [...(sums.get(k) ?? []), m[4] as number])
    }
    for (const inv of inventory) {
      const seq = sums.get(`${inv[0]}:${inv[1]}`)!
      let bal = 0
      for (const q of seq) {
        expect(q).not.toBe(0)
        bal += q
        expect(bal).toBeGreaterThanOrEqual(0)
      }
      expect(bal).toBe(inv[2])
    }
  })

  it('unit prices stay within the product price range', () => {
    const products = model.productRows(0, model.c.products)
    const range = new Map(products.map((p) => [p[0] as number, [p[6] as number, p[7] as number]]))
    for (const i of batch.items) {
      const [min, max] = range.get(i[2] as number)!
      expect(i[4] as number).toBeGreaterThanOrEqual(min!)
      expect(i[4] as number).toBeLessThanOrEqual(max!)
    }
  })

  it('customers ordered only after signing up', () => {
    const customers = model.customerRows(0, model.c.customers)
    const signup = new Map(customers.map((c) => [c[0] as number, (c[9] as Date).getTime()]))
    for (const o of batch.orders) {
      const d = o[3] as Date
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      expect(day).toBeGreaterThanOrEqual(signup.get(o[2] as number)!)
    }
  })

  it('uses only reserved example domains for emails', () => {
    for (const c of model.customerRows(0, 200)) expect(String(c[4])).toMatch(/@example\.(com|net|org)$/)
  })
})

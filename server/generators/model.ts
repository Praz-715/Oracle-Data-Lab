// Deterministic row model for the Retail Commerce blueprint. Produces positional rows whose column
// order matches blueprint.ts. Money is computed in integer cents so totals reconcile exactly.

import { extensionKind } from './blueprint'
import type {
  Rng} from './prng';
import {
  Choice,
  DayDistribution,
  dayWeight,
  isoOfDay,
  localDate,
  rowRng,
  scatter,
} from './prng'
import * as V from './vocab'

export interface IdBases {
  region: number
  category: number
  warehouse: number
  supplier: number
  product: number
  customer: number
  order: number
  payment: number
  shipment: number
  return: number
  movement: number
  review: number
  image: number
  ext: number
}

export interface RefData {
  regions: { id: number; code: string; weight: number; cities: string[] }[]
  leafCategories: { id: number; name: string; priceMedian: number; margin: number; weight: number }[]
  warehouses: { id: number; regionId: number }[]
}

export interface Counts {
  suppliers: number
  products: number
  customers: number
  orders: number
  extTables: number
  extRows: number
}

export interface ModelConfig {
  seed: number
  jobId: string
  includeLobs: boolean
  historyStart: string
  historyEnd: string
  counts: Counts
  bases: IdBases
  refs: RefData
}

/** Upper bounds used to reserve id ranges (ids are derived from row indexes, so gaps are expected). */
export const MAX_LINES = 6
export const MAX_PAYMENTS = 2
export const MAX_STOCK_SLOTS = 5
export const MAX_MOVEMENTS = 16
export const MAX_IMAGES = 3

export function deriveCounts(orders: number, extTables: number, extRows: number): Counts {
  const products = Math.round(Math.min(50_000, Math.max(500, orders / 200)))
  return {
    orders,
    customers: Math.round(Math.max(1_000, orders / 8)),
    products,
    suppliers: Math.round(Math.min(2_000, Math.max(20, products / 25))),
    extTables,
    extRows,
  }
}

/** How many ids each sequence must hand out for a job of this size. */
export function idDemand(c: Counts, includeLobs: boolean): Record<keyof IdBases, number> {
  return {
    region: V.REGIONS.length,
    category: V.CATEGORIES.reduce((n, p) => n + 1 + p.children.length, 0),
    warehouse: warehouseRegionCodes().length,
    supplier: c.suppliers,
    product: c.products,
    customer: c.customers,
    order: c.orders,
    payment: c.orders * MAX_PAYMENTS,
    shipment: c.orders,
    return: c.orders * MAX_LINES,
    movement: c.products * MAX_STOCK_SLOTS * MAX_MOVEMENTS,
    review: includeLobs ? c.orders : 0,
    image: includeLobs ? c.products * MAX_IMAGES : 0,
    ext: c.extTables * c.extRows,
  }
}

/** Expected (not exact) row counts, used for progress totals and storage estimates. */
export function expectedRows(c: Counts, includeLobs: boolean): Record<string, number> {
  const inventory = Math.round(c.products * 3)
  const r: Record<string, number> = {
    REGIONS: V.REGIONS.length,
    CATEGORIES: V.CATEGORIES.reduce((n, p) => n + 1 + p.children.length, 0),
    WAREHOUSES: warehouseRegionCodes().length,
    SUPPLIERS: c.suppliers,
    PRODUCTS: c.products,
    CUSTOMERS: c.customers,
    INVENTORY: inventory,
    INVENTORY_MOVEMENTS: Math.round(inventory * 10.5),
    ORDERS: c.orders,
    ORDER_ITEMS: Math.round(c.orders * 2.44),
    PAYMENTS: Math.round(c.orders * 1.05),
    SHIPMENTS: Math.round(c.orders * 0.93),
    RETURNS: Math.round(c.orders * 0.06),
  }
  if (includeLobs) {
    r.PRODUCT_REVIEWS = Math.round(c.orders * 0.04)
    r.PRODUCT_IMAGES = c.products * 2
  }
  for (let n = 1; n <= c.extTables; n++) r[`EXT_${String(n).padStart(3, '0')}`] = c.extRows
  return r
}

/** Regions that host a warehouse: the most populous ones. */
export function warehouseRegionCodes(): string[] {
  return [...V.REGIONS].sort((a, b) => b.weight - a.weight).slice(0, 12).map((r) => r.code)
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

// Reference tables are inserted once per schema (only when empty) and shared by later jobs.

export function regionRows(jobId: string, base: number): unknown[][] {
  return V.REGIONS.map((r, i) => [base + i, r.code, r.name, r.country, r.weight, jobId])
}

export function categoryRows(jobId: string, base: number): unknown[][] {
  const out: unknown[][] = []
  let cid = base
  for (const p of V.CATEGORIES) {
    const parentId = cid++
    out.push([parentId, null, p.name, p.margin, jobId])
    for (const child of p.children) out.push([cid++, parentId, child, p.margin, jobId])
  }
  return out
}

/** Warehouses for the most populous regions present in the database. */
export function warehouseRows(jobId: string, base: number, regionIdByCode: Map<string, number>): unknown[][] {
  return warehouseRegionCodes()
    .filter((code) => regionIdByCode.has(code))
    .map((code, i) => {
      const rng = rowRng(7, 'wh', i)
      return [
        base + i,
        `WH-${code}`,
        `${V.REGIONS.find((r) => r.code === code)!.cities[0]} Fulfilment Center`,
        regionIdByCode.get(code)!,
        rng.int(40, 400) * 1000,
        localDate(rng.int(16_000, 18_000)),
        jobId,
      ]
    })
}

/** Builds RefData from rows read back from the database (works for existing reference data too). */
export function buildRefData(
  regions: { id: number; code: string }[],
  categories: { id: number; name: string; parentId: number | null }[],
  warehouses: { id: number; regionId: number }[],
): RefData {
  const vocabRegion = new Map(V.REGIONS.map((r) => [r.code, r]))
  const parentById = new Map(categories.filter((c) => c.parentId == null).map((c) => [c.id, c.name]))
  const vocabCat = new Map(V.CATEGORIES.map((c) => [c.name, c]))
  const leaves = categories.filter((c) => c.parentId != null)
  return {
    regions: regions.map((r) => ({
      id: r.id,
      code: r.code,
      weight: vocabRegion.get(r.code)?.weight ?? 1,
      cities: vocabRegion.get(r.code)?.cities ?? ['City'],
    })),
    leafCategories: leaves.map((c) => {
      const parent = vocabCat.get(parentById.get(c.parentId!) ?? '')
      return {
        id: c.id,
        name: c.name,
        priceMedian: parent?.priceMedian ?? 100_000,
        margin: parent?.margin ?? 0.25,
        weight: (parent?.weight ?? 5) / (parent?.children.length ?? 4),
      }
    }),
    warehouses,
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const cents = (c: number) => c / 100
const pad = (n: number, w: number) => String(n).padStart(w, '0')

export class DataModel {
  readonly c: Counts
  readonly b: IdBases
  private readonly startDay: number
  private readonly endDay: number
  private readonly orderDays: DayDistribution
  private readonly signupDays: DayDistribution
  private readonly launchDays: DayDistribution
  private readonly regionChoice: Choice<number>
  private readonly categoryChoice: Choice<number>
  private readonly whByRegion: number[][]
  private readonly hourCum: number[]
  // Per-row caches so order generation does not regenerate dimension rows.
  private readonly custRegion: Uint16Array
  private readonly prodList: Float64Array
  private readonly prodMin: Float64Array
  private readonly prodMax: Float64Array

  constructor(readonly cfg: ModelConfig) {
    this.c = cfg.counts
    this.b = cfg.bases
    this.startDay = dayNum(cfg.historyStart)
    this.endDay = Math.max(this.startDay + 1, dayNum(cfg.historyEnd))
    const s = this.startDay
    const e = this.endDay
    this.orderDays = new DayDistribution(s, e, (d) => dayWeight(d, s, e))
    // 40% of customers signed up during the two years before the history window.
    let post = 0
    for (let d = s; d <= e; d++) post += dayWeight(d, s, e, 0.35)
    const pre = (post * (0.4 / 0.6)) / 730
    this.signupDays = new DayDistribution(s - 730, e, (d) => (d < s ? pre : dayWeight(d, s, e, 0.35)))
    // 70% of products launched before the history window.
    const preLaunch = ((e - s + 1) * (0.7 / 0.3)) / 1095
    this.launchDays = new DayDistribution(s - 1095, e, (d) => (d < s ? preLaunch : 1))

    const refs = cfg.refs
    if (!refs.regions.length || !refs.leafCategories.length || !refs.warehouses.length) {
      throw new Error('Reference data (regions, categories, warehouses) is missing')
    }
    this.regionChoice = new Choice(
      refs.regions.map((_, i) => i),
      refs.regions.map((r) => r.weight),
    )
    this.categoryChoice = new Choice(
      refs.leafCategories.map((_, i) => i),
      refs.leafCategories.map((c) => c.weight),
    )
    this.whByRegion = refs.regions.map((r) =>
      refs.warehouses.map((w, i) => (w.regionId === r.id ? i : -1)).filter((i) => i >= 0),
    )
    const hours = [0.3, 0.2, 0.12, 0.1, 0.1, 0.18, 0.4, 0.7, 0.9, 1.0, 1.05, 1.15, 1.3, 1.2, 1.05, 1.0, 1.0, 1.1, 1.3, 1.6, 1.75, 1.7, 1.2, 0.6]
    const tot = hours.reduce((a, b) => a + b, 0)
    let acc = 0
    this.hourCum = hours.map((h) => (acc += h / tot))

    this.custRegion = new Uint16Array(this.c.customers)
    for (let j = 0; j < this.c.customers; j++) this.custRegion[j] = this.regionChoice.sample(rowRng(cfg.seed, 'cus', j))
    this.prodList = new Float64Array(this.c.products)
    this.prodMin = new Float64Array(this.c.products)
    this.prodMax = new Float64Array(this.c.products)
    for (let p = 0; p < this.c.products; p++) {
      const a = this.productAttrs(p)
      this.prodList[p] = a.listC
      this.prodMin[p] = a.minC
      this.prodMax[p] = a.maxC
    }
  }

  // --- dimensions -----------------------------------------------------------

  supplierRows(from: number, to: number): unknown[][] {
    const out: unknown[][] = []
    for (let s = from; s < to; s++) {
      const rng = rowRng(this.cfg.seed, 'sup', s)
      const id = this.b.supplier + s
      const region = this.cfg.refs.regions[this.regionChoice.sample(rng)]!
      const name = `PT ${rng.pick(V.SUPPLIER_WORDS)} ${rng.pick(V.SUPPLIER_WORDS)} ${rng.pick(V.SUPPLIER_SUFFIX)} ${pad(id % 10000, 4)}`
      const rating = Math.round(Math.min(5, Math.max(1, rng.normal(4.1, 0.5))) * 10) / 10
      out.push([id, `SUP${pad(id, 9)}`, name, region.id, rating, rng.bool(0.94) ? 'ACTIVE' : 'INACTIVE', localDate(this.startDay - rng.int(30, 1500), rng.int(28800, 64800)), this.cfg.jobId])
    }
    return out
  }

  private productAttrs(p: number) {
    const rng = rowRng(this.cfg.seed, 'prd', p)
    const cat = this.cfg.refs.leafCategories[this.categoryChoice.sample(rng)]!
    const listC = Math.max(100_000, Math.round(rng.logNormal(cat.priceMedian, 0.55) / 100) * 10_000)
    const minC = Math.round(listC * 0.82)
    const maxC = Math.round(listC * 1.18)
    return { rng, cat, listC, minC, maxC }
  }

  productLaunchDay(p: number): number {
    return this.launchDays.quantile((p + 0.5) / this.c.products).day
  }

  productRows(from: number, to: number): unknown[][] {
    const out: unknown[][] = []
    for (let p = from; p < to; p++) {
      const { rng, cat, listC, minC, maxC } = this.productAttrs(p)
      const id = this.b.product + p
      const noun = rng.pick(V.PRODUCT_NOUNS[cat.name] ?? ['Item'])
      const name = `${rng.pick(V.PRODUCT_ADJECTIVES)} ${noun} ${String.fromCharCode(65 + rng.int(0, 25))}${rng.int(10, 990)}`
      const supplier = this.b.supplier + scatter(rng.zipf(this.c.suppliers, 0.6), this.c.suppliers, 11)
      const costC = Math.round(listC * (1 - cat.margin * rng.float(0.8, 1.2)))
      const launch = this.productLaunchDay(p)
      out.push([
        id, `SKU-${pad(id, 10)}`, name, cat.id, supplier, cents(listC), cents(minC), cents(maxC), cents(Math.max(0, costC)),
        Math.round(rng.logNormal(0.8, 0.9) * 1000) / 1000, rng.bool(0.92) ? 'ACTIVE' : 'DISCONTINUED',
        localDate(launch), localDate(launch, rng.int(28800, 64800)), this.cfg.jobId,
      ])
    }
    return out
  }

  imageRows(from: number, to: number): unknown[][] {
    const out: unknown[][] = []
    for (let p = from; p < to; p++) {
      const rng = rowRng(this.cfg.seed, 'img', p)
      const n = rng.int(1, MAX_IMAGES)
      for (let k = 0; k < n; k++) {
        const size = rng.int(400, 1900)
        const buf = Buffer.alloc(size)
        // PNG signature followed by deterministic noise: a valid-looking binary payload.
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
        for (let i = 8; i < size; i++) buf[i] = Math.floor(rng.next() * 256)
        out.push([this.b.image + p * MAX_IMAGES + k, this.b.product + p, k + 1, 'image/png', size, buf, this.cfg.jobId])
      }
    }
    return out
  }

  /** Inventory rows and their movements. The running balance never goes negative and ends at QTY_ON_HAND. */
  inventoryRows(from: number, to: number): { inventory: unknown[][]; movements: unknown[][] } {
    const inventory: unknown[][] = []
    const movements: unknown[][] = []
    const W = this.cfg.refs.warehouses.length
    for (let p = from; p < to; p++) {
      const rng = rowRng(this.cfg.seed, 'inv', p)
      const slots = Math.min(W, rng.int(1, MAX_STOCK_SLOTS))
      const first = scatter(p, W, 3)
      const launch = Math.max(this.productLaunchDay(p), this.startDay - 60)
      for (let slot = 0; slot < slots; slot++) {
        const wh = this.cfg.refs.warehouses[(first + slot) % W]!
        const k = rng.int(4, MAX_MOVEMENTS - 1)
        const span = Math.max(1, this.endDay - launch)
        let balance = 0
        let day = launch
        let lastDate = localDate(day)
        for (let m = 0; m < k; m++) {
          let type: string
          let qty: number
          if (m === 0) {
            type = 'RECEIPT'
            qty = rng.int(50, 600)
          } else {
            const r = rng.next()
            if (r < 0.55 && balance > 0) {
              type = 'SALE'
              qty = -rng.int(1, Math.min(balance, 40))
            } else if (r < 0.62 && balance > 0) {
              type = 'TRANSFER_OUT'
              qty = -rng.int(1, Math.min(balance, 30))
            } else if (r < 0.68) {
              type = 'TRANSFER_IN'
              qty = rng.int(5, 60)
            } else if (r < 0.76) {
              type = 'RETURN'
              qty = rng.int(1, 3)
            } else if (r < 0.84 && balance > 5) {
              type = 'ADJUSTMENT'
              qty = rng.bool(0.5) ? rng.int(1, 5) : -rng.int(1, 5)
            } else {
              type = 'RECEIPT'
              qty = rng.int(50, 400)
            }
          }
          balance += qty
          day = Math.min(this.endDay, day + Math.max(0, Math.round((span / k) * rng.float(0.3, 1.7))))
          lastDate = localDate(day, rng.int(25200, 75600))
          const id = this.b.movement + (p * MAX_STOCK_SLOTS + slot) * MAX_MOVEMENTS + m
          movements.push([id, this.b.product + p, wh.id, type, qty, lastDate, `MV-${pad(id, 12)}`, this.cfg.jobId])
        }
        inventory.push([this.b.product + p, wh.id, balance, rng.int(10, 60), lastDate, this.cfg.jobId])
      }
    }
    return { inventory, movements }
  }

  customerRows(from: number, to: number): unknown[][] {
    const out: unknown[][] = []
    for (let j = from; j < to; j++) {
      const rng = rowRng(this.cfg.seed, 'cus', j)
      const region = this.cfg.refs.regions[this.regionChoice.sample(rng)]!
      const id = this.b.customer + j
      const first = rng.pick(V.FIRST_NAMES)
      const last = rng.pick(V.LAST_NAMES)
      const domain = rng.pick(['example.com', 'example.net', 'example.org'])
      const segment = rng.weighted(V.SEGMENTS, [82, 95, 100])
      const signup = this.signupDays.quantile((j + 0.5) / this.c.customers).day
      const tenureYears = (this.endDay - signup) / 365
      const tier = tenureYears > 2.5 && rng.bool(0.4) ? rng.weighted(V.LOYALTY_TIERS, [0, 40, 80, 100]) : rng.weighted(V.LOYALTY_TIERS, [70, 90, 98, 100])
      const credit = segment === 'CORPORATE' ? rng.int(50, 500) * 1_000_000 : segment === 'SMB' ? rng.int(10, 100) * 1_000_000 : rng.int(1, 20) * 500_000
      out.push([
        id, `CUS${pad(id, 10)}`, first, last, `${first}.${last}.${id}@${domain}`.toLowerCase(),
        `+62-21-555-${pad(id % 100_000_000, 8)}`, segment, region.id, rng.pick(region.cities), localDate(signup),
        rng.weighted(['ACTIVE', 'INACTIVE', 'SUSPENDED'], [93, 99, 100]), tier, credit,
        localDate(signup, rng.int(21600, 79200)), null, this.cfg.jobId,
      ])
    }
    return out
  }

  // --- facts ----------------------------------------------------------------

  private intradaySeconds(frac: number): number {
    const cum = this.hourCum
    let h = 0
    while (h < 23 && cum[h]! < frac) h++
    const prev = h === 0 ? 0 : cum[h - 1]!
    const within = (frac - prev) / Math.max(1e-9, cum[h]! - prev)
    return h * 3600 + Math.floor(Math.min(0.9999, Math.max(0, within)) * 3600)
  }

  /** Customers who signed up on or before `day`; low indexes are long-tenured, high-frequency buyers. */
  private pickCustomer(rng: Rng, day: number): number {
    const eligible = Math.max(1, Math.min(this.c.customers, Math.ceil(this.c.customers * this.signupDays.cdfAt(day) - 0.5)))
    return rng.bool(0.7) ? rng.zipf(eligible, 0.5) : rng.int(0, eligible - 1)
  }

  private pickProduct(rng: Rng, day: number): number {
    const launched = Math.max(1, Math.min(this.c.products, Math.ceil(this.c.products * this.launchDays.cdfAt(day) - 0.5)))
    return rng.zipf(launched, 0.7)
  }

  orderBatch(from: number, to: number) {
    const orders: unknown[][] = []
    const items: unknown[][] = []
    const payments: unknown[][] = []
    const shipments: unknown[][] = []
    const returns: unknown[][] = []
    const reviews: unknown[][] = []
    const N = this.c.orders
    const job = this.cfg.jobId

    for (let i = from; i < to; i++) {
      const rng = rowRng(this.cfg.seed, 'ord', i)
      const { day, frac } = this.orderDays.quantile((i + rng.next()) / N)
      const secs = this.intradaySeconds(frac)
      const orderDate = localDate(day, secs)
      const orderId = this.b.order + i
      const ymCode = isoOfDay(day).slice(2, 7).replace('-', '')
      const cj = this.pickCustomer(rng, day)
      const regionIdx = this.custRegion[cj]!
      const years = (day - this.startDay) / 365
      const channel = rng.weighted(V.CHANNELS, cumulative4(30, 42 + 8 * years, 10, 18))
      const whs = this.whByRegion[regionIdx]!
      const whIdx = whs.length ? whs[rng.int(0, whs.length - 1)]! : scatter(regionIdx, this.cfg.refs.warehouses.length)
      const warehouseId = this.cfg.refs.warehouses[whIdx]!.id
      const campaign = dayWeight(day, this.startDay, this.endDay, 0) > 1.6

      // Lines
      const nLines = rng.weighted([1, 2, 3, 4, 5, 6], [35, 60, 78, 88, 95, 100])
      const used = new Set<number>()
      let subtotalC = 0
      let discountC = 0
      const lines: { line: number; qty: number; unitC: number; disc: number; totalC: number; product: number }[] = []
      for (let l = 1; l <= nLines; l++) {
        let p = this.pickProduct(rng, day)
        for (let tries = 0; used.has(p) && tries < 6; tries++) p = this.pickProduct(rng, day)
        if (used.has(p)) continue
        used.add(p)
        const qty = rng.weighted([1, 2, 3, 4, 5], [62, 86, 94, 98, 100])
        const factor = campaign ? rng.float(0.84, 0.95) : rng.float(0.95, 1.08)
        const unitC = Math.min(this.prodMax[p]!, Math.max(this.prodMin[p]!, Math.round(this.prodList[p]! * factor)))
        const disc = rng.bool(0.75) ? 0 : rng.pick([0.05, 0.1, 0.15, 0.2])
        const grossC = qty * unitC
        const discC = Math.round(grossC * disc)
        const totalC = grossC - discC
        subtotalC += totalC
        discountC += discC
        lines.push({ line: lines.length + 1, qty, unitC, disc, totalC, product: p })
      }
      const shippingC = subtotalC >= 25_000_000 ? 0 : [900_000, 1_200_000, 1_500_000, 1_800_000][regionIdx % 4]!
      const taxC = Math.round(subtotalC * 0.11)
      const totalC = subtotalC + shippingC + taxC

      // Status by age, then make shipments/returns consistent with it.
      const age = this.endDay - day
      let status: string
      if (rng.bool(0.045)) status = 'CANCELLED'
      else if (age <= 1) status = rng.bool(0.6) ? 'PENDING' : 'PROCESSING'
      else if (age <= 3) status = rng.bool(0.35) ? 'PROCESSING' : 'SHIPPED'
      else if (age <= 10) status = rng.bool(0.4) ? 'SHIPPED' : 'DELIVERED'
      else status = 'DELIVERED'

      let deliveredDay: number | null = null
      if (status === 'SHIPPED' || status === 'DELIVERED') {
        const shipDay = day + rng.weighted([0, 1, 2, 3], [45, 80, 95, 100])
        if (shipDay > this.endDay) {
          status = 'PROCESSING'
        } else {
          const shipSecs = shipDay === day ? Math.min(86399, secs + rng.int(1800, 14400)) : rng.int(28800, 72000)
          let delivered: Date | null = null
          if (status === 'DELIVERED') {
            const dd = shipDay + rng.int(1, 6)
            if (dd > this.endDay) status = 'SHIPPED'
            else {
              deliveredDay = dd
              delivered = localDate(dd, rng.int(32400, 75600))
            }
          }
          const shipmentId = this.b.shipment + i
          const carrier = rng.pick(V.CARRIERS)
          shipments.push([
            shipmentId, orderId, carrier, `TRK${pad(shipmentId, 14)}`, localDate(shipDay, shipSecs), delivered,
            delivered ? 'DELIVERED' : 'IN_TRANSIT', job,
          ])
        }
      }

      let returned = false
      if (status === 'DELIVERED' && deliveredDay != null) {
        for (const ln of lines) {
          if (!rng.bool(0.03)) continue
          const rd = deliveredDay + rng.int(1, 14)
          if (rd > this.endDay) continue
          const rq = rng.int(1, ln.qty)
          const refundC = Math.round(rq * ln.unitC * (1 - ln.disc))
          const rStatus = this.endDay - rd > 21 ? (rng.bool(0.9) ? 'REFUNDED' : 'REJECTED') : rng.bool(0.5) ? 'REQUESTED' : 'APPROVED'
          returns.push([
            this.b.return + i * MAX_LINES + (ln.line - 1), orderId, ln.line, rq,
            rng.weighted(V.RETURN_REASONS, [30, 45, 70, 88, 100]), localDate(rd, rng.int(28800, 72000)), cents(refundC), rStatus, job,
          ])
          returned = true
        }
        if (returned) status = 'RETURNED'
      }

      // Payments: fulfilled orders are fully captured; split payments reconcile to the cent.
      const method = rng.weighted(V.PAYMENT_METHODS, [18, 42, 74, 88, 100])
      const paidAt = new Date(orderDate.getTime() + rng.int(60, 3600) * 1000)
      const payId = (seq: number) => this.b.payment + i * MAX_PAYMENTS + (seq - 1)
      if (status === 'CANCELLED') {
        if (rng.bool(0.5)) payments.push([payId(1), orderId, 1, method, cents(totalC), rng.bool(0.7) ? 'REFUNDED' : 'FAILED', paidAt, job])
      } else {
        const payStatus = status === 'PENDING' || (method === 'COD' && (status === 'PROCESSING' || status === 'SHIPPED')) ? 'AUTHORIZED' : 'CAPTURED'
        if (method !== 'COD' && rng.bool(0.07) && totalC > 1000) {
          const firstC = Math.round(totalC * rng.float(0.3, 0.7))
          payments.push([payId(1), orderId, 1, method, cents(firstC), payStatus, paidAt, job])
          payments.push([payId(2), orderId, 2, rng.pick(V.PAYMENT_METHODS.filter((m) => m !== 'COD')), cents(totalC - firstC), payStatus, new Date(paidAt.getTime() + 120_000), job])
        } else {
          payments.push([payId(1), orderId, 1, method, cents(totalC), payStatus, paidAt, job])
        }
      }

      for (const ln of lines) {
        items.push([orderId, ln.line, this.b.product + ln.product, ln.qty, cents(ln.unitC), ln.disc, cents(ln.totalC), job])
      }
      orders.push([
        orderId, `SO${ymCode}${pad(orderId, 10)}`, this.b.customer + cj, orderDate, status, channel, warehouseId, 'IDR', lines.length,
        cents(subtotalC), cents(discountC), cents(shippingC), cents(taxC), cents(totalC), orderDate, job,
      ])

      if (this.cfg.includeLobs && deliveredDay != null && rng.bool(0.05)) {
        const rd = Math.min(this.endDay, deliveredDay + rng.int(1, 20))
        const rating = rng.weighted([1, 2, 3, 4, 5], [4, 9, 22, 55, 100])
        const sentences = [rng.pick(V.REVIEW_OPENERS)]
        const n = rng.int(2, 7)
        for (let s = 0; s < n; s++) sentences.push(rng.pick(V.REVIEW_DETAILS))
        sentences.push(rng.pick(V.REVIEW_CLOSERS))
        reviews.push([
          this.b.review + i, this.b.product + lines[0]!.product, this.b.customer + cj, rating, localDate(rd),
          `${['Poor', 'Fair', 'Okay', 'Good', 'Excellent'][rating - 1]} purchase`, sentences.join(' ').slice(0, 3900), job,
        ])
      }
    }
    return { orders, items, payments, shipments, returns, reviews }
  }

  extensionRows(tableNo: number, from: number, to: number): unknown[][] {
    const kind = extensionKind(tableNo)
    const out: unknown[][] = []
    const R = this.c.extRows
    for (let r = from; r < to; r++) {
      const rng = rowRng(this.cfg.seed, `x${tableNo}`, r)
      const id = this.b.ext + (tableNo - 1) * R + r
      const day = rng.int(this.startDay, this.endDay)
      if (kind === 'customer_attr') {
        const key = rng.pick(['preferred_channel', 'newsletter_opt_in', 'favorite_category', 'device_os', 'language', 'referral_source'])
        const value =
          key === 'newsletter_opt_in' ? (rng.bool(0.4) ? 'Y' : 'N')
          : key === 'preferred_channel' ? rng.pick(V.CHANNELS)
          : key === 'favorite_category' ? rng.pick(this.cfg.refs.leafCategories).name
          : key === 'device_os' ? rng.pick(['android', 'ios', 'windows', 'macos'])
          : key === 'language' ? rng.pick(['id', 'en'])
          : rng.pick(['search', 'social', 'friend', 'campaign'])
        out.push([id, this.b.customer + rng.int(0, this.c.customers - 1), key, value, localDate(day), this.cfg.jobId])
      } else if (kind === 'product_metric') {
        const views = Math.round(rng.logNormal(300, 1.1))
        const atc = Math.round(views * rng.float(0.02, 0.15))
        const conv = Math.round(atc * rng.float(0.1, 0.6))
        out.push([id, this.b.product + rng.zipf(this.c.products, 0.7), localDate(day), views, atc, conv, this.cfg.jobId])
      } else {
        const ev = rng.pick(['CREATED', 'PAID', 'PACKED', 'SHIPPED', 'DELIVERED', 'REVIEW_REQUESTED'])
        out.push([id, this.b.order + rng.int(0, this.c.orders - 1), ev, localDate(day, rng.int(0, 86399)), `event ${ev.toLowerCase()} #${r}`, this.cfg.jobId])
      }
    }
    return out
  }
}

function dayNum(iso: string): number {
  return Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000)
}

function cumulative4(a: number, b: number, c: number, d: number): number[] {
  return [a, a + b, a + b + c, a + b + c + d]
}


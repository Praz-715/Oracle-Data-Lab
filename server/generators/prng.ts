// Deterministic pseudo-random utilities. Every generated row is derived from (seed, stream, index),
// so a resumed job regenerates exactly the same rows it would have produced uninterrupted.

/** 32-bit FNV-1a hash over the given parts, finished with a murmur-style avalanche. */
export function hash32(...parts: (string | number)[]): number {
  let h = 0x811c9dc5
  for (const part of parts) {
    const s = String(part)
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h ^= 0x1f
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

export class Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  /** mulberry32 — fast, good enough statistical quality for synthetic data. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  bool(p: number): boolean {
    return this.next() < p
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!
  }

  /** Picks using a pre-built cumulative weight table (see `cumulative`). */
  weighted<T>(items: readonly T[], cum: readonly number[]): T {
    const r = this.next() * cum[cum.length - 1]!
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid]! > r) hi = mid
      else lo = mid + 1
    }
    return items[lo]!
  }

  normal(mean = 0, sd = 1): number {
    const u = Math.max(this.next(), 1e-12)
    const v = this.next()
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  logNormal(median: number, sigma: number): number {
    return median * Math.exp(this.normal(0, sigma))
  }

  /**
   * Bounded power-law (Zipf-like) index in [0, n). Low indices are far more likely, which models
   * popular products and loyal repeat customers. O(1) via inverse CDF of a continuous Pareto.
   */
  zipf(n: number, s = 1.1): number {
    if (n <= 1) return 0
    const u = this.next()
    const a = 1 - s
    const x = Math.pow((Math.pow(n + 1, a) - 1) * u + 1, 1 / a)
    return Math.min(n - 1, Math.max(0, Math.floor(x) - 1))
  }
}

export function rowRng(seed: number, stream: string, index: number): Rng {
  return new Rng(hash32(seed, stream, index))
}

export function cumulative(weights: readonly number[]): number[] {
  const out: number[] = []
  let acc = 0
  for (const w of weights) {
    acc += w
    out.push(acc)
  }
  return out
}

/** A weighted choice table built once and sampled many times. */
export class Choice<T> {
  readonly cum: number[]
  constructor(
    readonly items: readonly T[],
    weights: readonly number[],
  ) {
    this.cum = cumulative(weights)
  }

  sample(rng: Rng): T {
    return rng.weighted(this.items, this.cum)
  }
}

/**
 * Scatters index i over [0, n) with a multiplicative permutation so "popular" (low zipf) indices are
 * spread across the id range instead of clustering at the start.
 */
export function scatter(i: number, n: number, salt = 0): number {
  if (n <= 1) return 0
  const prime = 2654435761
  return Number((BigInt(i) * BigInt(prime) + BigInt(salt)) % BigInt(n))
}

// ---------------------------------------------------------------------------
// Calendar distribution: seasonality + weekday + growth trend + campaign days.
// ---------------------------------------------------------------------------

const DAY_MS = 86400000

export function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  return Math.floor(Date.UTC(y!, m! - 1, d!) / DAY_MS)
}

export function isoOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

/** Builds a local-time Date (what Oracle DATE binds use) for a day number plus seconds of day. */
export function localDate(day: number, secondsOfDay = 0): Date {
  const u = new Date(day * DAY_MS)
  const s = Math.max(0, Math.min(86399, Math.floor(secondsOfDay)))
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60)
}

// Retail-style monthly seasonality (Jan..Dec): mid-year dip, strong Q4 with 11.11 / 12.12 campaigns.
const MONTH_WEIGHT = [0.88, 0.84, 0.95, 0.97, 1.0, 0.98, 1.02, 1.0, 1.04, 1.08, 1.32, 1.45]
// Sunday..Saturday
const WEEKDAY_WEIGHT = [1.12, 0.92, 0.94, 0.96, 1.0, 1.08, 1.18]

export function dayWeight(day: number, startDay: number, endDay: number, growthPerYear = 0.25): number {
  const d = new Date(day * DAY_MS)
  const month = d.getUTCMonth()
  const dom = d.getUTCDate()
  let w = MONTH_WEIGHT[month]! * WEEKDAY_WEIGHT[d.getUTCDay()]!
  // Campaign spikes: double dates (11.11, 12.12, ...) and payday at month end.
  if (dom === month + 1) w *= month >= 8 ? 2.6 : 1.5
  if (dom >= 25 || dom <= 1) w *= 1.12
  const years = (day - startDay) / 365
  w *= 1 + growthPerYear * Math.max(0, years)
  return endDay > startDay ? w : 1
}

/** Discrete distribution over consecutive days with an inverse CDF (quantile). */
export class DayDistribution {
  readonly startDay: number
  readonly days: number
  private readonly cdf: Float64Array

  constructor(startDay: number, endDay: number, weight: (day: number) => number) {
    this.startDay = startDay
    this.days = Math.max(1, endDay - startDay + 1)
    this.cdf = new Float64Array(this.days)
    let acc = 0
    for (let i = 0; i < this.days; i++) {
      acc += Math.max(0, weight(startDay + i))
      this.cdf[i] = acc
    }
    for (let i = 0; i < this.days; i++) this.cdf[i]! /= acc
  }

  /** u in [0,1) -> { day, frac } where frac is the position inside that day. */
  quantile(u: number): { day: number; frac: number } {
    const x = Math.min(Math.max(u, 0), 0.999999999)
    let lo = 0
    let hi = this.days - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.cdf[mid]! > x) hi = mid
      else lo = mid + 1
    }
    const prev = lo === 0 ? 0 : this.cdf[lo - 1]!
    const span = this.cdf[lo]! - prev
    return { day: this.startDay + lo, frac: span > 0 ? (x - prev) / span : 0 }
  }

  /** Fraction of mass on or before the given day. */
  cdfAt(day: number): number {
    const i = day - this.startDay
    if (i < 0) return 0
    if (i >= this.days) return 1
    return this.cdf[i]!
  }
}

/** Intraday arrival curve: quiet nights, lunch bump, evening peak. Returns seconds of day. */
const HOUR_WEIGHT = [0.3, 0.2, 0.12, 0.1, 0.1, 0.18, 0.4, 0.7, 0.9, 1.0, 1.05, 1.15, 1.3, 1.2, 1.05, 1.0, 1.0, 1.1, 1.3, 1.6, 1.75, 1.7, 1.2, 0.6]
const HOUR_CHOICE = new Choice(
  HOUR_WEIGHT.map((_, i) => i),
  HOUR_WEIGHT,
)

export function timeOfDay(rng: Rng): number {
  return HOUR_CHOICE.sample(rng) * 3600 + rng.int(0, 3599)
}

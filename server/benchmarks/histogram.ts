import type { LatencySummary } from '../../shared/types/lab'

/**
 * Log-bucketed latency histogram: constant memory regardless of operation count,
 * ~1% relative error on percentiles, from 1 µs to ~10 minutes.
 */
export class LatencyHistogram {
  private static readonly MIN_MS = 0.001
  private static readonly GROWTH = 1.02
  private static readonly LOG_GROWTH = Math.log(LatencyHistogram.GROWTH)
  private static readonly BUCKETS = Math.ceil(Math.log(600_000 / LatencyHistogram.MIN_MS) / LatencyHistogram.LOG_GROWTH) + 1

  private readonly counts = new Float64Array(LatencyHistogram.BUCKETS)
  count = 0
  sum = 0
  min = Infinity
  max = 0

  record(ms: number) {
    const v = Math.max(ms, LatencyHistogram.MIN_MS)
    const i = Math.min(
      LatencyHistogram.BUCKETS - 1,
      Math.floor(Math.log(v / LatencyHistogram.MIN_MS) / LatencyHistogram.LOG_GROWTH),
    )
    this.counts[i]!++
    this.count++
    this.sum += ms
    if (ms < this.min) this.min = ms
    if (ms > this.max) this.max = ms
  }

  merge(other: LatencyHistogram) {
    for (let i = 0; i < this.counts.length; i++) this.counts[i]! += other.counts[i]!
    this.count += other.count
    this.sum += other.sum
    this.min = Math.min(this.min, other.min)
    this.max = Math.max(this.max, other.max)
  }

  percentile(p: number): number {
    if (!this.count) return 0
    const target = Math.ceil((p / 100) * this.count)
    let acc = 0
    for (let i = 0; i < this.counts.length; i++) {
      acc += this.counts[i]!
      if (acc >= target) {
        // Geometric midpoint of the bucket, clamped to observed extremes.
        const lo = LatencyHistogram.MIN_MS * Math.pow(LatencyHistogram.GROWTH, i)
        const mid = lo * Math.sqrt(LatencyHistogram.GROWTH)
        return Math.min(this.max, Math.max(this.min, mid))
      }
    }
    return this.max
  }

  summary(): LatencySummary {
    const r = (x: number) => Math.round(x * 1000) / 1000
    return {
      count: this.count,
      avgMs: r(this.count ? this.sum / this.count : 0),
      minMs: r(this.count ? this.min : 0),
      maxMs: r(this.max),
      p50Ms: r(this.percentile(50)),
      p95Ms: r(this.percentile(95)),
      p99Ms: r(this.percentile(99)),
    }
  }

  reset() {
    this.counts.fill(0)
    this.count = 0
    this.sum = 0
    this.min = Infinity
    this.max = 0
  }
}

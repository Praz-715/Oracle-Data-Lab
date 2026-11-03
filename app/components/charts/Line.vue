<script setup lang="ts">
/**
 * Time/sequence line chart: single y-axis, 2px lines, recessive grid, crosshair + tooltip on hover.
 * Series colors follow a fixed slot order (`slot`), never their rank, so filters don't repaint.
 */
export interface LineSeries {
  name: string
  slot?: number
  points: { x: number; y: number | null }[]
}

const props = defineProps<{
  series: LineSeries[]
  height?: number
  yFormat?: (v: number) => string
  xFormat?: (v: number) => string
  yMin?: number
  area?: boolean
  ariaLabel?: string
}>()

const root = ref<HTMLElement | null>(null)
const width = ref(600)
let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver((e) => (width.value = Math.max(240, e[0]!.contentRect.width)))
  if (root.value) ro.observe(root.value)
})
onBeforeUnmount(() => ro?.disconnect())

const H = computed(() => props.height ?? 200)
const pad = { l: 56, r: 12, t: 10, b: 24 }
const fy = (v: number) => (props.yFormat ? props.yFormat(v) : fmtCompact(v))
const fx = (v: number) => (props.xFormat ? props.xFormat(v) : new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))

const all = computed(() => props.series.flatMap((s) => s.points.filter((p) => p.y != null)) as { x: number; y: number }[])
const xDomain = computed(() => {
  const xs = all.value.map((p) => p.x)
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  return xs.length ? [lo, hi === lo ? lo + 1 : hi] : [0, 1]
})
function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p
}
const yDomain = computed(() => {
  const ys = all.value.map((p) => p.y)
  const lo = props.yMin ?? Math.min(0, ...ys)
  // A flat series (e.g. all zero) still gets a readable 0..1 axis instead of a 1e-9 range.
  const top = ys.length ? Math.max(...ys) : lo
  const hi = niceMax(top > lo ? top : lo + 1)
  return [lo, hi]
})
const sx = (x: number) => pad.l + ((x - xDomain.value[0]!) / (xDomain.value[1]! - xDomain.value[0]!)) * (width.value - pad.l - pad.r)
const sy = (y: number) => pad.t + (1 - (y - yDomain.value[0]!) / (yDomain.value[1]! - yDomain.value[0]!)) * (H.value - pad.t - pad.b)

const yTicks = computed(() => Array.from({ length: 5 }, (_, i) => yDomain.value[0]! + ((yDomain.value[1]! - yDomain.value[0]!) * i) / 4))
const xTicks = computed(() => {
  const n = Math.max(2, Math.min(6, Math.floor(width.value / 120)))
  return Array.from({ length: n }, (_, i) => xDomain.value[0]! + ((xDomain.value[1]! - xDomain.value[0]!) * i) / (n - 1))
})

function path(s: LineSeries) {
  let d = ''
  let pen = false
  for (const p of s.points) {
    if (p.y == null) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`
    pen = true
  }
  return d
}
function areaPath(s: LineSeries) {
  const pts = s.points.filter((p) => p.y != null) as { x: number; y: number }[]
  if (pts.length < 2) return ''
  const base = sy(Math.max(yDomain.value[0]!, 0))
  return `M${sx(pts[0]!.x)},${base}` + pts.map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('') + `L${sx(pts[pts.length - 1]!.x)},${base}Z`
}
const color = (s: LineSeries, i: number) => `var(--chart-${((s.slot ?? i) % 6) + 1})`

const hoverX = ref<number | null>(null)
function onMove(e: PointerEvent) {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  const px = e.clientX - rect.left
  const xs = [...new Set(all.value.map((p) => p.x))]
  if (!xs.length) return
  let best = xs[0]!
  for (const x of xs) if (Math.abs(sx(x) - px) < Math.abs(sx(best) - px)) best = x
  hoverX.value = best
}
const hoverRows = computed(() =>
  hoverX.value == null
    ? []
    : props.series.map((s, i) => ({ name: s.name, color: color(s, i), y: s.points.find((p) => p.x === hoverX.value)?.y ?? null })),
)
const tipLeft = computed(() => (hoverX.value == null ? 0 : Math.min(width.value - 180, Math.max(0, sx(hoverX.value) + 10))))
</script>

<template>
  <div ref="root" class="line-chart">
    <div v-if="series.length > 1" class="legend">
      <span v-for="(s, i) in series" :key="s.name" class="key"><i :style="{ background: color(s, i) }" />{{ s.name }}</span>
    </div>
    <div v-if="!all.length" class="empty" :style="{ height: `${H}px` }">No samples yet.</div>
    <div v-else class="plot">
      <svg
        :width="width"
        :height="H"
        role="img"
        :aria-label="ariaLabel ?? series.map((s) => s.name).join(', ')"
        @pointermove="onMove"
        @pointerleave="hoverX = null"
      >
        <g class="grid">
          <line v-for="t in yTicks" :key="t" :x1="pad.l" :x2="width - pad.r" :y1="sy(t)" :y2="sy(t)" />
        </g>
        <g class="axis">
          <text v-for="t in yTicks" :key="`y${t}`" :x="pad.l - 6" :y="sy(t) + 4" text-anchor="end">{{ fy(t) }}</text>
          <text v-for="t in xTicks" :key="`x${t}`" :x="sx(t)" :y="H - 6" text-anchor="middle">{{ fx(t) }}</text>
        </g>
        <template v-for="(s, i) in series" :key="s.name">
          <path v-if="area" :d="areaPath(s)" :fill="color(s, i)" opacity="0.12" />
          <path :d="path(s)" fill="none" :stroke="color(s, i)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        </template>
        <g v-if="hoverX != null">
          <line class="cross" :x1="sx(hoverX)" :x2="sx(hoverX)" :y1="pad.t" :y2="H - pad.b" />
          <template v-for="r in hoverRows" :key="r.name">
            <circle v-if="r.y != null" :cx="sx(hoverX)" :cy="sy(r.y)" r="4" :fill="r.color" stroke="var(--bg-elev)" stroke-width="2" />
          </template>
        </g>
      </svg>
      <div v-if="hoverX != null" class="tip" :style="{ left: `${tipLeft}px` }">
        <div class="tip-x">{{ fx(hoverX) }}</div>
        <div v-for="r in hoverRows" :key="r.name" class="tip-row">
          <i :style="{ background: r.color }" />
          <span>{{ r.name }}</span>
          <strong class="num">{{ r.y == null ? '—' : fy(r.y) }}</strong>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.line-chart {
  width: 100%;
  min-width: 0;
}
.plot {
  position: relative;
}
svg {
  display: block;
  touch-action: none;
}
.grid line {
  stroke: var(--chart-grid);
  stroke-width: 1;
}
.axis text {
  fill: var(--text-3);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.cross {
  stroke: var(--border-strong);
  stroke-dasharray: 3 3;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.key {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.key i,
.tip-row i {
  width: 10px;
  height: 3px;
  border-radius: 2px;
  display: inline-block;
}
.tip {
  position: absolute;
  top: 4px;
  min-width: 160px;
  pointer-events: none;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  padding: 6px 8px;
  font-size: 12px;
}
.tip-x {
  color: var(--text-3);
  margin-bottom: 2px;
}
.tip-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tip-row span {
  flex: 1;
  color: var(--text-2);
}
.empty {
  display: grid;
  place-items: center;
  color: var(--text-3);
  font-size: 13px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}
</style>

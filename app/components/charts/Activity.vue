<script setup lang="ts">
import type { ActivityClass } from '~~/shared/types/lab'

/**
 * Average active sessions over time, stacked by wait class (the classic "top activity" view).
 * Stack order and colors are fixed (validated for light/dark and color-vision deficiencies), so a
 * class never changes color between runs. Legend always shown; hover gives exact values per class.
 */
const props = defineProps<{
  series: { t: number; v: Record<ActivityClass, number> }[]
  height?: number
  xFormat?: (t: number) => string
  /** Optional reference line, e.g. the number of DB CPUs. */
  cpuLine?: number | null
  ariaLabel?: string
}>()

const CLASSES: { k: ActivityClass; color: string }[] = [
  { k: 'CPU', color: 'var(--chart-3)' },
  { k: 'Commit', color: 'var(--chart-2)' },
  { k: 'User I/O', color: 'var(--chart-1)' },
  { k: 'Concurrency', color: 'var(--chart-5)' },
  { k: 'Application', color: 'var(--chart-4)' },
  { k: 'Other', color: 'var(--chart-6)' },
]

const root = ref<HTMLElement | null>(null)
const width = ref(600)
let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver((e) => (width.value = Math.max(240, e[0]!.contentRect.width)))
  if (root.value) ro.observe(root.value)
})
onBeforeUnmount(() => ro?.disconnect())

const H = computed(() => props.height ?? 200)
const pad = { l: 40, r: 12, t: 10, b: 24 }
const fx = (t: number) => (props.xFormat ? props.xFormat(t) : `${t}s`)
const totals = computed(() => props.series.map((p) => CLASSES.reduce((a, c) => a + (p.v[c.k] ?? 0), 0)))
const present = computed(() => CLASSES.filter((c) => props.series.some((p) => (p.v[c.k] ?? 0) > 0)))

function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p
}
const yMax = computed(() => niceMax(Math.max(0.5, ...totals.value, props.cpuLine ?? 0)))
const xMin = computed(() => props.series[0]?.t ?? 0)
const xMax = computed(() => {
  const last = props.series[props.series.length - 1]?.t ?? 1
  return last === xMin.value ? xMin.value + 1 : last
})
const sx = (t: number) => pad.l + ((t - xMin.value) / (xMax.value - xMin.value)) * (width.value - pad.l - pad.r)
const sy = (v: number) => pad.t + (1 - v / yMax.value) * (H.value - pad.t - pad.b)
const yTicks = computed(() => Array.from({ length: 5 }, (_, i) => (yMax.value * i) / 4))
const xTicks = computed(() => {
  const n = Math.max(2, Math.min(6, Math.floor(width.value / 110)))
  return Array.from({ length: n }, (_, i) => xMin.value + ((xMax.value - xMin.value) * i) / (n - 1))
})

/** Stacked band paths, bottom class first. */
const bands = computed(() => {
  const acc = props.series.map(() => 0)
  return CLASSES.map((c) => {
    const lower = [...acc]
    props.series.forEach((p, i) => (acc[i]! += p.v[c.k] ?? 0))
    const upper = [...acc]
    if (!props.series.length || upper.every((u, i) => u === lower[i])) return { ...c, d: '' }
    const top = props.series.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(upper[i]!).toFixed(1)}`).join('')
    const bottom = props.series
      .map((p, i) => ({ p, i }))
      .reverse()
      .map(({ p, i }) => `L${sx(p.t).toFixed(1)},${sy(lower[i]!).toFixed(1)}`)
      .join('')
    return { ...c, d: `${top}${bottom}Z` }
  })
})

const hover = ref<number | null>(null)
function onMove(e: PointerEvent) {
  if (!props.series.length) return
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  const px = e.clientX - rect.left
  let best = 0
  props.series.forEach((p, i) => {
    if (Math.abs(sx(p.t) - px) < Math.abs(sx(props.series[best]!.t) - px)) best = i
  })
  hover.value = best
}
const tipLeft = computed(() => (hover.value == null ? 0 : Math.min(width.value - 190, Math.max(0, sx(props.series[hover.value]!.t) + 10))))
const fv = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(2))
</script>

<template>
  <div ref="root" class="activity-chart">
    <div class="legend">
      <span v-for="c in present.length ? present : CLASSES.slice(0, 1)" :key="c.k" class="key"><i :style="{ background: c.color }" />{{ c.k }}</span>
      <span v-if="cpuLine" class="key"><i class="dash" />{{ cpuLine }} CPUs</span>
    </div>
    <div v-if="!series.length" class="empty" :style="{ height: `${H}px` }">No active sessions sampled yet.</div>
    <div v-else class="plot">
      <svg :width="width" :height="H" role="img" :aria-label="ariaLabel ?? 'Average active sessions by wait class'" @pointermove="onMove" @pointerleave="hover = null">
        <g class="grid">
          <line v-for="t in yTicks" :key="t" :x1="pad.l" :x2="width - pad.r" :y1="sy(t)" :y2="sy(t)" />
        </g>
        <g class="axis">
          <text v-for="t in yTicks" :key="`y${t}`" :x="pad.l - 6" :y="sy(t) + 4" text-anchor="end">{{ fv(t) }}</text>
          <text v-for="t in xTicks" :key="`x${t}`" :x="sx(t)" :y="H - 6" text-anchor="middle">{{ fx(Math.round(t)) }}</text>
        </g>
        <path v-for="b in bands" v-show="b.d" :key="b.k" :d="b.d" :fill="b.color" fill-opacity="0.85" stroke="var(--bg-elev)" stroke-width="1" />
        <line v-if="cpuLine" class="cpu" :x1="pad.l" :x2="width - pad.r" :y1="sy(cpuLine)" :y2="sy(cpuLine)" />
        <line v-if="hover != null" class="cross" :x1="sx(series[hover]!.t)" :x2="sx(series[hover]!.t)" :y1="pad.t" :y2="H - pad.b" />
      </svg>
      <div v-if="hover != null" class="tip" :style="{ left: `${tipLeft}px` }">
        <div class="tip-x">{{ fx(series[hover]!.t) }} · <strong>{{ fv(totals[hover]!) }}</strong> active</div>
        <template v-for="c in [...CLASSES].reverse()" :key="c.k">
          <div v-if="(series[hover]!.v[c.k] ?? 0) > 0" class="tip-row">
            <i :style="{ background: c.color }" />
            <span>{{ c.k }}</span>
            <strong class="num">{{ fv(series[hover]!.v[c.k]) }}</strong>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.activity-chart {
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
.cpu {
  stroke: var(--text-2);
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
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
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}
.key i.dash {
  height: 0;
  border-top: 2px dashed var(--text-2);
  border-radius: 0;
}
.tip {
  position: absolute;
  top: 4px;
  min-width: 170px;
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

<script setup lang="ts">
/**
 * Entity-relationship diagram from FK metadata. Tables are layered by FK depth (parents left,
 * children right); edges are drawn child -> parent. Hover a table to highlight its relations.
 */
const props = defineProps<{
  tables: { table: string; numRows: number | null; pk: string[] }[]
  edges: { name: string; from: string; to: string; columns: string }[]
}>()

const BOX_W = 200
const BOX_H = 46
const GAP_X = 70
const GAP_Y = 16

const layout = computed(() => {
  const parents = new Map<string, Set<string>>()
  for (const t of props.tables) parents.set(t.table, new Set())
  for (const e of props.edges) if (e.from !== e.to) parents.get(e.from)?.add(e.to)
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const d = (t: string): number => {
    if (depth.has(t)) return depth.get(t)!
    if (visiting.has(t)) return 0
    visiting.add(t)
    const ps = [...(parents.get(t) ?? [])]
    const v = ps.length ? 1 + Math.max(...ps.map(d)) : 0
    visiting.delete(t)
    depth.set(t, v)
    return v
  }
  props.tables.forEach((t) => d(t.table))
  const cols = new Map<number, string[]>()
  for (const t of props.tables) {
    const k = depth.get(t.table) ?? 0
    cols.set(k, [...(cols.get(k) ?? []), t.table])
  }
  const pos = new Map<string, { x: number; y: number }>()
  let maxRows = 0
  for (const [k, names] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
    names.sort().forEach((n, i) => pos.set(n, { x: 10 + k * (BOX_W + GAP_X), y: 10 + i * (BOX_H + GAP_Y) }))
    maxRows = Math.max(maxRows, names.length)
  }
  const width = 20 + (Math.max(0, ...depth.values()) + 1) * (BOX_W + GAP_X)
  const height = 20 + maxRows * (BOX_H + GAP_Y)
  return { pos, width, height }
})

const hover = ref<string | null>(null)
const related = computed(() => {
  if (!hover.value) return null
  const s = new Set([hover.value])
  for (const e of props.edges) {
    if (e.from === hover.value || e.to === hover.value) {
      s.add(e.from)
      s.add(e.to)
    }
  }
  return s
})

function edgePath(e: { from: string; to: string }) {
  const a = layout.value.pos.get(e.from)
  const b = layout.value.pos.get(e.to)
  if (!a || !b) return ''
  if (e.from === e.to) return `M${a.x + BOX_W},${a.y + 14} c30,0 30,20 0,20`
  const x1 = a.x
  const y1 = a.y + BOX_H / 2
  const x2 = b.x + BOX_W
  const y2 = b.y + BOX_H / 2
  const mx = (x1 + x2) / 2
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
}
</script>

<template>
  <div class="erd-wrap">
    <svg :width="layout.width" :height="layout.height" role="img" :aria-label="`ERD with ${tables.length} tables and ${edges.length} foreign keys`">
      <defs>
        <marker id="erd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--text-3)" />
        </marker>
      </defs>
      <path
        v-for="e in edges"
        :key="e.name"
        :d="edgePath(e)"
        class="edge"
        :class="{ hot: related && related.has(e.from) && related.has(e.to) && (e.from === hover || e.to === hover), faded: related && !(e.from === hover || e.to === hover) }"
        marker-end="url(#erd-arrow)"
      >
        <title>{{ e.from }} ({{ e.columns }}) → {{ e.to }}</title>
      </path>
      <g
        v-for="t in tables"
        :key="t.table"
        class="node"
        :class="{ faded: related && !related.has(t.table), hot: hover === t.table }"
        :transform="`translate(${layout.pos.get(t.table)?.x ?? 0},${layout.pos.get(t.table)?.y ?? 0})`"
        tabindex="0"
        @pointerenter="hover = t.table"
        @pointerleave="hover = null"
        @focus="hover = t.table"
        @blur="hover = null"
      >
        <rect :width="BOX_W" :height="BOX_H" rx="6" />
        <text x="10" y="18" class="name">{{ t.table.length > 26 ? t.table.slice(0, 25) + '…' : t.table }}</text>
        <text x="10" y="35" class="meta">PK {{ t.pk.join(', ') || '—' }} · {{ t.numRows == null ? 'no stats' : fmtCompact(t.numRows) + ' rows' }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.erd-wrap {
  overflow: auto;
  max-height: 640px;
  background: var(--bg-sunken);
  border-radius: var(--radius-sm);
}
.edge {
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.2;
  opacity: 0.6;
}
.edge.hot {
  stroke: var(--accent);
  stroke-width: 2;
  opacity: 1;
}
.edge.faded {
  opacity: 0.12;
}
.node rect {
  fill: var(--bg-elev);
  stroke: var(--border-strong);
}
.node.hot rect {
  stroke: var(--accent);
  stroke-width: 2;
}
.node.faded {
  opacity: 0.35;
}
.node:focus {
  outline: none;
}
.name {
  font: 600 12px var(--font-mono);
  fill: var(--text);
}
.meta {
  font-size: 10.5px;
  fill: var(--text-3);
}
</style>

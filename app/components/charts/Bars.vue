<script setup lang="ts">
/**
 * Horizontal bar chart for magnitude comparisons: one hue (slot), bars anchored at zero with 4px
 * rounded data ends, values direct-labeled in text ink, hover tooltip with the exact value.
 */
const props = defineProps<{
  items: { label: string; value: number | null; sub?: string }[]
  format?: (v: number) => string
  hue?: number
  max?: number
  ariaLabel?: string
}>()
const f = (v: number) => (props.format ? props.format(v) : fmtNum(v))
const max = computed(() => props.max ?? Math.max(1e-9, ...props.items.map((i) => i.value ?? 0)))
const color = computed(() => `var(--chart-${((props.hue ?? 0) % 6) + 1})`)
const hover = ref<number | null>(null)
</script>

<template>
  <div class="bars" role="list" :aria-label="ariaLabel">
    <div v-if="!items.length" class="subtle">No data.</div>
    <div
      v-for="(it, i) in items"
      :key="it.label"
      class="bar-row"
      role="listitem"
      :class="{ dim: hover != null && hover !== i }"
      @pointerenter="hover = i"
      @pointerleave="hover = null"
    >
      <div class="lbl ellipsis" :title="it.label">{{ it.label }}</div>
      <div class="track" :title="`${it.label}: ${it.value == null ? '—' : f(it.value)}${it.sub ? ` · ${it.sub}` : ''}`">
        <div class="fill" :style="{ width: `${Math.max(0.5, ((it.value ?? 0) / max) * 100)}%`, background: color }" />
      </div>
      <div class="val num">
        {{ it.value == null ? '—' : f(it.value) }}<span v-if="it.sub" class="subtle"> · {{ it.sub }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bars {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bar-row {
  display: grid;
  grid-template-columns: minmax(80px, 30%) 1fr auto;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  padding: 2px 0;
  transition: opacity 0.12s;
}
.bar-row.dim {
  opacity: 0.55;
}
.lbl {
  color: var(--text-2);
}
.track {
  height: 14px;
  display: flex;
  align-items: center;
}
.fill {
  height: 10px;
  border-radius: 0 4px 4px 0;
}
.val {
  min-width: 80px;
  text-align: right;
  white-space: nowrap;
}
</style>

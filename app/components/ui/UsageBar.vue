<script setup lang="ts">
const props = defineProps<{ pct: number | null | undefined; warn?: number; bad?: number }>()
const tone = computed(() => pctTone(props.pct, props.warn, props.bad))
</script>

<template>
  <div class="usage" :title="pct == null ? 'unknown' : fmtPct(pct)">
    <div class="track">
      <div class="fill" :class="tone" :style="{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }" />
    </div>
    <span class="num pct">{{ fmtPct(pct) }}</span>
  </div>
</template>

<style scoped>
.usage {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 120px;
}
.track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-sunken);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--ok);
}
.fill.warn { background: var(--warn); }
.fill.bad { background: var(--bad); }
.pct {
  width: 52px;
  text-align: right;
  font-size: 12px;
}
</style>

<script setup lang="ts">
const props = defineProps<{ value?: number | null; tone?: 'ok' | 'warn' | 'bad' | 'info' | ''; label?: string; height?: number }>()
const pct = computed(() => (props.value == null ? null : Math.max(0, Math.min(1, props.value)) * 100))
</script>

<template>
  <div
    class="progress"
    role="progressbar"
    :aria-label="label ?? 'Progress'"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="pct == null ? undefined : Math.round(pct)"
    :style="{ height: `${height ?? 8}px` }"
  >
    <div v-if="pct == null" class="indeterminate" :class="tone" />
    <Motion
      v-else
      as="div"
      class="bar"
      :class="tone"
      :initial="false"
      :animate="{ width: `${pct}%` }"
      :transition="{ type: 'spring', stiffness: 120, damping: 24 }"
    />
  </div>
</template>

<style scoped>
.progress {
  position: relative;
  width: 100%;
  background: var(--bg-sunken);
  border-radius: 999px;
  overflow: hidden;
}
.bar,
.indeterminate {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}
.bar.ok, .indeterminate.ok { background: var(--ok); }
.bar.warn, .indeterminate.warn { background: var(--warn); }
.bar.bad, .indeterminate.bad { background: var(--bad); }
.bar.info, .indeterminate.info { background: var(--info); }
.indeterminate {
  width: 35%;
  animation: slide 1.3s ease-in-out infinite;
}
@keyframes slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}
</style>

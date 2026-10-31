<script setup lang="ts">
defineProps<{
  label: string
  value?: string | number | null
  sub?: string | null
  icon?: string
  tone?: 'ok' | 'warn' | 'bad' | 'info' | ''
  /** Reason the metric cannot be shown; rendered instead of a value. */
  unavailable?: string | null
  loading?: boolean
}>()
</script>

<template>
  <div class="kpi card" :class="tone">
    <div class="label">
      <Icon v-if="icon" :name="icon" size="14" />
      {{ label }}
    </div>
    <div v-if="loading && value == null" class="value muted">…</div>
    <div v-else-if="unavailable" class="value na" :title="unavailable">
      <Icon name="lucide:lock" size="14" /> unavailable
    </div>
    <div v-else class="value num">{{ value ?? '—' }}</div>
    <div v-if="sub && !unavailable" class="sub">{{ sub }}</div>
    <div v-else-if="unavailable" class="sub ellipsis" :title="unavailable">{{ unavailable }}</div>
  </div>
</template>

<style scoped>
.kpi {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-top: 3px solid transparent;
}
.kpi.ok { border-top-color: var(--ok); }
.kpi.warn { border-top-color: var(--warn); }
.kpi.bad { border-top-color: var(--bad); }
.kpi.info { border-top-color: var(--info); }
.label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.value {
  font-size: 21px;
  font-weight: 650;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.value.na {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--na);
  padding: 4px 0;
}
.sub {
  font-size: 12px;
  color: var(--text-2);
}
</style>

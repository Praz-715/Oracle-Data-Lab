<script setup lang="ts">
import type { Panel } from '~~/shared/types/lab'

/**
 * Renders one data panel in a consistent way: loading, request error, "unavailable" (privilege,
 * edition, license or version) with the reason, empty, or the default slot with the data.
 * Unavailable metrics are explained — never replaced with placeholder numbers.
 */
defineSlots<{ default?: (props: { data: any }) => any }>()
const props = defineProps<{
  panel?: Panel<any> | null
  loading?: boolean
  error?: string | null
  emptyText?: string
  isEmpty?: (data: any) => boolean
}>()

const empty = computed(() => {
  if (!props.panel || props.panel.status !== 'ok') return false
  const d = props.panel.data as unknown
  if (props.isEmpty) return props.isEmpty(props.panel.data)
  return d == null || (Array.isArray(d) && d.length === 0)
})
</script>

<template>
  <div class="pv">
    <div v-if="error" class="callout bad" role="alert">
      <Icon name="lucide:circle-x" size="16" />
      <div>{{ error }}</div>
    </div>
    <div v-else-if="!panel && loading" class="state">
      <span class="spinner" aria-hidden="true" /> Loading…
    </div>
    <div v-else-if="panel && panel.status === 'unavailable'" class="callout unavailable">
      <Icon name="lucide:lock" size="16" />
      <div>
        <strong>Unavailable</strong>
        <span v-if="panel.code" class="mono subtle"> {{ panel.code }}</span>
        <div>{{ panel.reason }}</div>
        <div v-if="panel.requires" class="subtle">Requires: {{ panel.requires }}</div>
      </div>
    </div>
    <div v-else-if="empty" class="state">{{ emptyText ?? 'No rows.' }}</div>
    <template v-else-if="panel && panel.status === 'ok'">
      <slot :data="panel.data" />
      <p v-if="panel.note" class="subtle note">{{ panel.note }}</p>
    </template>
  </div>
</template>

<style scoped>
.state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 4px;
  color: var(--text-3);
  font-size: 13px;
}
.unavailable {
  background: var(--na-soft);
  color: var(--text-2);
}
.note {
  margin: 8px 0 0;
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

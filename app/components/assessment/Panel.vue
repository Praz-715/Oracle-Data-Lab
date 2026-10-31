<script setup lang="ts">
import type { Panel } from '~~/shared/types/lab'

/** One assessment panel: card + loading/unavailable states, with the row count in the title for lists. */
defineSlots<{ default?: (props: { data: any }) => any; actions?: () => any }>()
const props = defineProps<{
  title: string
  icon?: string
  panel?: Panel<any> | null
  loading?: boolean
  error?: string | null
  flush?: boolean
  emptyText?: string
  isEmpty?: (data: any) => boolean
  /** Count shown in the title; defaults to the row count when the data is an array. */
  count?: (data: any) => number | null
}>()

const n = computed(() => {
  const p = props.panel
  if (!p || p.status !== 'ok') return null
  if (props.count) return props.count(p.data)
  return Array.isArray(p.data) ? p.data.length : null
})
</script>

<template>
  <UiCard :title="n != null ? `${title} · ${fmtNum(n)}` : title" :icon="icon" :flush="flush" :class="{ 'flush-panel': flush }">
    <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    <UiPanelView :panel="panel" :loading="loading" :error="error" :empty-text="emptyText" :is-empty="isEmpty">
      <template #default="{ data }"><slot :data="data" /></template>
    </UiPanelView>
  </UiCard>
</template>

<style scoped>
.flush-panel :deep(.pv > .callout),
.flush-panel :deep(.pv > .state) {
  margin: 12px 14px;
}
.flush-panel :deep(.pv > .note) {
  padding: 0 14px 12px;
}
</style>

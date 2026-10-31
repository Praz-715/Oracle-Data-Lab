<script setup lang="ts">
const model = defineModel<string>({ required: true })
defineProps<{ tabs: { id: string; label: string; count?: number | null }[] }>()

function onKey(e: KeyboardEvent, tabs: { id: string }[]) {
  const i = tabs.findIndex((t) => t.id === model.value)
  if (e.key === 'ArrowRight') model.value = tabs[(i + 1) % tabs.length]!.id
  else if (e.key === 'ArrowLeft') model.value = tabs[(i - 1 + tabs.length) % tabs.length]!.id
}
</script>

<template>
  <div class="tabs" role="tablist" @keydown="onKey($event, tabs)">
    <button
      v-for="t in tabs"
      :key="t.id"
      role="tab"
      class="tab"
      :aria-selected="model === t.id"
      :tabindex="model === t.id ? 0 : -1"
      @click="model = t.id"
    >
      {{ t.label }}
      <span v-if="t.count != null" class="count">{{ t.count }}</span>
      <Motion v-if="model === t.id" as="span" class="ink" layout-id="tab-ink" :transition="{ duration: 0.18 }" />
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.tab {
  position: relative;
  border: 0;
  background: none;
  padding: 9px 12px;
  font: 500 13px var(--font-sans);
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
}
.tab[aria-selected='true'] {
  color: var(--text);
}
.tab:hover {
  color: var(--text);
}
.count {
  margin-left: 4px;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-sunken);
  color: var(--text-3);
}
.ink {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}
</style>

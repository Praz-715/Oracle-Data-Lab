<script setup lang="ts">
defineProps<{ title: string; summary: string; features: string[]; phase: string }>()
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ title }} <span class="badge plain">planned · {{ phase }}</span></h1>
        <p>{{ summary }}</p>
      </div>
    </div>
    <UiCard title="Not built yet" icon="lucide:hammer">
      <p class="muted">
        This module is on the roadmap and is intentionally <strong>not simulated</strong>: no placeholder data is shown for features
        that do not exist yet.
      </p>
      <ul class="list">
        <li v-for="f in features" :key="f">{{ f }}</li>
      </ul>
    </UiCard>
  </div>
</template>

<style scoped>
.list {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--text-2);
}
.list li {
  margin: 3px 0;
}
</style>

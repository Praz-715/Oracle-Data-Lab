<script setup lang="ts">
defineProps<{ title?: string; icon?: string; flush?: boolean }>()
</script>

<template>
  <section class="card">
    <header v-if="title || $slots.actions" class="card-head">
      <Icon v-if="icon" :name="icon" size="16" class="muted" />
      <h2>{{ title }}</h2>
      <slot name="actions" />
    </header>
    <div class="card-body" :class="{ flush }">
      <slot />
    </div>
  </section>
</template>

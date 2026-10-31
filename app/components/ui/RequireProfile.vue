<script setup lang="ts">
/** Renders the default slot only when a connection profile is selected. */
const props = defineProps<{ writes?: boolean }>()
const { active, loaded, writable, envError } = useActiveProfile()
const blockedForWrites = computed(() => props.writes && active.value && !writable.value)
</script>

<template>
  <div v-if="!loaded" class="callout"><span class="muted">Loading connections…</span></div>
  <div v-else-if="!active" class="callout info">
    <Icon name="lucide:plug" size="16" />
    <div>
      <strong>No connection selected.</strong>
      Add an Oracle connection profile first — credentials stay on the server.
      <NuxtLink to="/connections">Open Connections →</NuxtLink>
    </div>
  </div>
  <template v-else>
    <div v-if="envError" class="callout bad" role="alert">
      <Icon name="lucide:plug-zap" size="16" />
      <div><strong>Cannot connect with “{{ active.name }}”.</strong> {{ envError }}</div>
    </div>
    <div v-if="blockedForWrites" class="callout warn">
      <Icon name="lucide:shield-alert" size="16" />
      <div>
        “{{ active.name }}” is <strong>read-only</strong> or has no authorized schemas. You can review and plan here, but running
        writes requires lab mode and an authorized schema in <NuxtLink to="/connections">Connections</NuxtLink>.
      </div>
    </div>
    <slot :profile="active" />
  </template>
</template>

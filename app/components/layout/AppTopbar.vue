<script setup lang="ts">
import type { JobSummary } from '~~/shared/types/lab'

defineEmits<{ toggleMenu: [] }>()
const { profiles, activeId, active, environment, envError, select } = useActiveProfile()

const running = ref<JobSummary[]>([])
async function loadRunning() {
  try {
    const all = await api<JobSummary[]>('/api/jobs', { query: { limit: 50 } })
    running.value = all.filter((j) => j.status === 'running' || j.status === 'queued')
  } catch {
    running.value = []
  }
}
onMounted(loadRunning)
usePolling(loadRunning, 4000)

const envLabel = computed(() => {
  const e = environment.value
  if (!e) return null
  return [e.serverVersion, e.databaseRole, e.instanceName, e.containerName && e.isCdb ? e.containerName : null].filter(Boolean).join(' · ')
})
</script>

<template>
  <header class="topbar">
    <button class="btn ghost icon menu" aria-label="Open navigation" @click="$emit('toggleMenu')">
      <Icon name="lucide:menu" size="18" />
    </button>

    <label class="profile">
      <span class="sr-only">Active connection</span>
      <Icon name="lucide:database" size="16" class="muted" />
      <select class="input" :value="activeId ?? ''" @change="select(($event.target as HTMLSelectElement).value || null)">
        <option v-if="!profiles.length" value="">No connections yet</option>
        <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </label>
    <span v-if="active" class="badge" :class="active.mode === 'lab' ? 'warn' : 'ok'" :title="active.mode === 'lab' ? 'Writes allowed in authorized schemas' : 'Read-only: no writes from this app'">
      {{ active.mode === 'lab' ? 'lab · writes allowed' : 'read-only' }}
    </span>
    <span v-if="envLabel" class="env subtle ellipsis" :title="environment?.banner">{{ envLabel }}</span>
    <span v-else-if="envError && active" class="badge bad" :title="envError">not connected</span>

    <div class="spacer" />

    <NuxtLink v-if="running.length" to="/jobs" class="jobs">
      <span class="pulse" aria-hidden="true" />
      {{ running.length }} job{{ running.length > 1 ? 's' : '' }} running
    </NuxtLink>
    <LayoutThemeToggle />
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--topbar-h);
  padding: 0 16px;
  background: color-mix(in srgb, var(--bg-elev) 92%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.menu {
  display: none;
}
.profile {
  display: flex;
  align-items: center;
  gap: 8px;
}
.profile select {
  width: 220px;
  font-weight: 500;
}
.env {
  max-width: 420px;
}
.jobs {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--info);
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--info);
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
@media (max-width: 900px) {
  .menu {
    display: inline-flex;
  }
  .profile select {
    width: 150px;
  }
  .env {
    display: none;
  }
}
@media (max-width: 560px) {
  .badge {
    display: none;
  }
}
</style>

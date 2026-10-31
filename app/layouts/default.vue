<script setup lang="ts">
const collapsed = useState('odl-sidebar-collapsed', () => false)
const mobileOpen = ref(false)
const { refresh, activeId, loadEnvironment } = useActiveProfile()
const { push } = useToasts()
const route = useRoute()

onMounted(async () => {
  try {
    collapsed.value = localStorage.getItem('odl-sidebar') === 'collapsed'
  } catch {
    // ignore
  }
  try {
    await refresh()
  } catch (err) {
    push({ tone: 'bad', title: 'Could not load connection profiles', detail: apiErrorMessage(err) })
  }
})

watch(collapsed, (v) => {
  try {
    localStorage.setItem('odl-sidebar', v ? 'collapsed' : 'open')
  } catch {
    // ignore
  }
})
watch(activeId, () => loadEnvironment(), { immediate: true })
watch(() => route.path, () => (mobileOpen.value = false))
</script>

<template>
  <div class="shell" :class="{ collapsed }">
    <a href="#main" class="skip">Skip to content</a>
    <LayoutAppSidebar v-model:collapsed="collapsed" :mobile-open="mobileOpen" @close="mobileOpen = false" />
    <div class="main-col">
      <LayoutAppTopbar @toggle-menu="mobileOpen = !mobileOpen" />
      <main id="main" tabindex="-1">
        <Motion
          :key="route.path"
          as="div"
          :initial="{ opacity: 0, y: 6 }"
          :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.18, ease: 'easeOut' }"
        >
          <slot />
        </Motion>
      </main>
    </div>
    <UiToasts />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
  min-height: 100vh;
  transition: grid-template-columns 0.2s ease;
}
.shell.collapsed {
  grid-template-columns: var(--sidebar-w-collapsed) minmax(0, 1fr);
}
.main-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
main {
  flex: 1;
  outline: none;
}
.skip {
  position: absolute;
  left: -9999px;
  top: 8px;
  z-index: 100;
  background: var(--bg-elev);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
}
.skip:focus {
  left: 8px;
}
@media (max-width: 900px) {
  /* The sidebar becomes an off-canvas drawer: plain block flow avoids an empty stretched grid row. */
  .shell,
  .shell.collapsed {
    display: block;
  }
  .main-col {
    min-height: 100vh;
  }
}
</style>

<script setup lang="ts">
const collapsed = defineModel<boolean>('collapsed', { default: false })
defineProps<{ mobileOpen: boolean }>()
defineEmits<{ close: [] }>()
const route = useRoute()

function isActive(to: string) {
  return to === '/' ? route.path === '/' : route.path.startsWith(to)
}
</script>

<template>
  <div>
    <AnimatePresence>
      <Motion
        v-if="mobileOpen"
        as="div"
        class="scrim"
        :initial="{ opacity: 0 }"
        :animate="{ opacity: 1 }"
        :exit="{ opacity: 0 }"
        @click="$emit('close')"
      />
    </AnimatePresence>
    <aside class="sidebar" :class="{ collapsed, open: mobileOpen }" aria-label="Main navigation">
      <div class="brand">
        <img src="/favicon.svg" alt="" width="26" height="26" >
        <Motion v-if="!collapsed" as="div" class="brand-text" :initial="{ opacity: 0, x: -6 }" :animate="{ opacity: 1, x: 0 }">
          <strong>OracleDB Data Lab</strong>
          <span>testing · benchmark · observability</span>
        </Motion>
      </div>
      <nav>
        <div v-for="group in NAV" :key="group.section" class="group">
          <div v-if="!collapsed" class="section">{{ group.section }}</div>
          <div v-else class="section-rule" />
          <NuxtLink
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            class="item"
            :class="{ active: isActive(item.to), planned: item.planned }"
            :title="collapsed ? item.label + (item.planned ? ' (planned)' : '') : undefined"
            :aria-current="isActive(item.to) ? 'page' : undefined"
          >
            <Icon :name="item.icon" size="17" />
            <span v-if="!collapsed" class="label">{{ item.label }}</span>
            <span v-if="!collapsed && item.planned" class="tag">planned</span>
          </NuxtLink>
        </div>
      </nav>
      <button class="collapse btn ghost sm" :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'" @click="collapsed = !collapsed">
        <Icon :name="collapsed ? 'lucide:panel-left-open' : 'lucide:panel-left-close'" size="16" />
        <span v-if="!collapsed">Collapse</span>
      </button>
    </aside>
  </div>
</template>

<style scoped>
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  overflow: hidden;
  z-index: 30;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--topbar-h);
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  min-width: 0;
}
.brand-text strong {
  font-size: 13.5px;
  white-space: nowrap;
}
.brand-text span {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
nav {
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 16px;
}
.section {
  padding: 12px 10px 4px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
.section-rule {
  height: 1px;
  background: var(--border);
  margin: 8px 6px;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}
.item:hover {
  background: var(--bg-hover);
  color: var(--text);
  text-decoration: none;
}
.item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.item.planned .label {
  color: var(--text-3);
}
.label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--na-soft);
  color: var(--na);
}
.collapsed .item {
  justify-content: center;
  padding: 0;
}
.collapse {
  margin: 8px;
  justify-content: flex-start;
  color: var(--text-3);
}
.collapsed .collapse {
  justify-content: center;
}
.scrim {
  display: none;
}
@media (max-width: 900px) {
  .sidebar,
  .sidebar.collapsed {
    position: fixed;
    left: 0;
    width: var(--sidebar-w);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .sidebar.open {
    transform: none;
    box-shadow: var(--shadow-lg);
  }
  .collapse {
    display: none;
  }
  .scrim {
    display: block;
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 35%);
    z-index: 25;
  }
}
</style>

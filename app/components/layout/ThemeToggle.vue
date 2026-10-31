<script setup lang="ts">
type Theme = 'system' | 'light' | 'dark'
const theme = ref<Theme>('system')

onMounted(() => {
  try {
    const t = localStorage.getItem('odl-theme')
    if (t === 'light' || t === 'dark') theme.value = t
  } catch {
    // ignore
  }
})

function apply(t: Theme) {
  theme.value = t
  const root = document.documentElement
  if (t === 'system') delete root.dataset.theme
  else root.dataset.theme = t
  try {
    if (t === 'system') localStorage.removeItem('odl-theme')
    else localStorage.setItem('odl-theme', t)
  } catch {
    // ignore
  }
}

const order: Theme[] = ['system', 'light', 'dark']
const icon = computed(() => ({ system: 'lucide:monitor', light: 'lucide:sun', dark: 'lucide:moon' })[theme.value])
</script>

<template>
  <button
    class="btn ghost icon"
    :title="`Theme: ${theme}`"
    :aria-label="`Theme: ${theme}. Switch theme`"
    @click="apply(order[(order.indexOf(theme) + 1) % order.length]!)"
  >
    <Icon :name="icon" size="17" />
  </button>
</template>

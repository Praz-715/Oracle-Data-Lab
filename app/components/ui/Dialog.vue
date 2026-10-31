<script setup lang="ts">
const open = defineModel<boolean>({ default: false })
// Boolean props default to false when omitted, so dismissible must default to true explicitly.
const props = withDefaults(defineProps<{ title: string; width?: number; dismissible?: boolean }>(), { width: 560, dismissible: true })
const panel = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null

function close() {
  if (!props.dismissible) return
  open.value = false
}

function onKey(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') close()
  if (e.key === 'Tab' && panel.value) {
    // Keep focus inside the dialog.
    const f = panel.value.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')
    if (!f.length) return
    const first = f[0]!
    const last = f[f.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      last.focus()
      e.preventDefault()
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus()
      e.preventDefault()
    }
  }
}

watch(open, async (v) => {
  if (v) {
    previouslyFocused = document.activeElement as HTMLElement
    await nextTick()
    panel.value?.querySelector<HTMLElement>('input,select,textarea,button.primary,button')?.focus()
  } else {
    previouslyFocused?.focus?.()
  }
})
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <AnimatePresence>
      <Motion v-if="open" key="scrim" as="div" class="scrim" :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }" @click="close" />
      <Motion
        v-if="open"
        key="dialog"
        as="div"
        class="dialog-wrap"
        :initial="{ opacity: 0, y: 16, scale: 0.98 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 8, scale: 0.98 }"
        :transition="{ duration: 0.16 }"
      >
        <div ref="panel" class="dialog card" role="dialog" aria-modal="true" :aria-label="title" :style="{ maxWidth: `${width}px` }">
          <header class="card-head">
            <h2>{{ title }}</h2>
            <button v-if="dismissible" class="btn ghost icon sm" aria-label="Close" @click="close">
              <Icon name="lucide:x" size="15" />
            </button>
          </header>
          <div class="card-body body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="foot">
            <slot name="footer" />
          </footer>
        </div>
      </Motion>
    </AnimatePresence>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgb(10 14 20 / 45%);
  z-index: 100;
}
.dialog-wrap {
  position: fixed;
  inset: 0;
  z-index: 101;
  display: grid;
  place-items: center;
  padding: 16px;
  pointer-events: none;
}
.dialog {
  pointer-events: auto;
  width: 100%;
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
}
.body {
  overflow: auto;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
</style>

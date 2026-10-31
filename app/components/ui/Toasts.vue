<script setup lang="ts">
const { toasts, dismiss } = useToasts()
const icons = { ok: 'lucide:circle-check', warn: 'lucide:triangle-alert', bad: 'lucide:circle-x', info: 'lucide:info' }
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <AnimatePresence>
      <Motion
        v-for="t in toasts"
        :key="t.id"
        as="div"
        class="toast"
        :class="t.tone"
        layout
        :initial="{ opacity: 0, y: 12, scale: 0.98 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, x: 24 }"
        :transition="{ duration: 0.18 }"
      >
        <Icon :name="icons[t.tone]" size="18" class="ic" />
        <div class="body">
          <strong>{{ t.title }}</strong>
          <p v-if="t.detail">{{ t.detail }}</p>
        </div>
        <button class="btn ghost icon sm" aria-label="Dismiss" @click="dismiss(t.id)">
          <Icon name="lucide:x" size="14" />
        </button>
      </Motion>
    </AnimatePresence>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(420px, calc(100vw - 32px));
}
.toast {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 10px 10px 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-left: 3px solid var(--info);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.toast.ok { border-left-color: var(--ok); }
.toast.ok .ic { color: var(--ok); }
.toast.warn { border-left-color: var(--warn); }
.toast.warn .ic { color: var(--warn); }
.toast.bad { border-left-color: var(--bad); }
.toast.bad .ic { color: var(--bad); }
.toast.info .ic { color: var(--info); }
.body {
  flex: 1;
  min-width: 0;
}
.body strong {
  font-size: 13px;
}
.body p {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--text-2);
  word-break: break-word;
}
</style>

<script setup lang="ts">
/**
 * Explicit confirmation for destructive or heavy operations. With `typeToConfirm`, the user must
 * type the given text (usually the schema name) before the action is enabled.
 */
const open = defineModel<boolean>({ default: false })
const props = defineProps<{
  title: string
  confirmLabel?: string
  typeToConfirm?: string
  danger?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{ confirm: [] }>()
const typed = ref('')
watch(open, (v) => v && (typed.value = ''))
const ready = computed(() => !props.typeToConfirm || typed.value.trim().toUpperCase() === props.typeToConfirm.toUpperCase())
</script>

<template>
  <UiDialog v-model="open" :title="title" :width="520">
    <div class="stack">
      <slot />
      <label v-if="typeToConfirm" class="field">
        <span>Type <strong class="mono">{{ typeToConfirm }}</strong> to confirm</span>
        <input v-model="typed" class="input mono" autocomplete="off" spellcheck="false" @keydown.enter="ready && emit('confirm')" >
      </label>
    </div>
    <template #footer>
      <button class="btn" @click="open = false">Cancel</button>
      <button class="btn" :class="danger ? 'danger' : 'primary'" :disabled="!ready || busy" @click="emit('confirm')">
        <Icon v-if="busy" name="lucide:loader-circle" class="spin" size="15" />
        {{ confirmLabel ?? 'Confirm' }}
      </button>
    </template>
  </UiDialog>
</template>

<style scoped>
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

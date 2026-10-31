<script setup lang="ts">
const props = defineProps<{ code: string; maxHeight?: string }>()
const copied = ref(false)
async function copy() {
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    copied.value = false
  }
}
</script>

<template>
  <div class="code-wrap">
    <button class="btn sm copy" :aria-label="copied ? 'Copied' : 'Copy to clipboard'" @click="copy">
      <Icon :name="copied ? 'lucide:check' : 'lucide:copy'" size="13" />
      {{ copied ? 'Copied' : 'Copy' }}
    </button>
    <pre class="code" :style="{ maxHeight }">{{ code }}</pre>
  </div>
</template>

<style scoped>
.code-wrap {
  position: relative;
}
.copy {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
}
</style>

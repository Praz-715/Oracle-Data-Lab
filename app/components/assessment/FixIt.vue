<script setup lang="ts">
import type { AssessmentFinding, Recommendation } from '~~/shared/types/lab'

/**
 * "Fix it" dialog for one health check. The server re-runs the check, reads the facts it needs and
 * returns a script for the DBA — the app itself never executes any of it.
 */
const open = defineModel<boolean>({ default: false })
const props = defineProps<{ profileId: string; finding: Pick<AssessmentFinding, 'id' | 'title'> | null }>()
const { push } = useToasts()

const data = shallowRef<{ finding: AssessmentFinding; recommendation: Recommendation | null; reason: string | null } | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const downloading = ref<'sql' | 'html' | null>(null)

const url = computed(() => (props.finding ? `/api/connections/${props.profileId}/recommendations/${props.finding.id}` : ''))

async function load() {
  if (!props.finding) return
  loading.value = true
  error.value = null
  data.value = null
  try {
    data.value = await api(url.value)
  } catch (err) {
    error.value = apiErrorMessage(err)
  } finally {
    loading.value = false
  }
}
watch(open, (v) => v && load())

async function download(format: 'sql' | 'html') {
  downloading.value = format
  try {
    const name = await downloadFile(`${url.value}?format=${format}`, `fix-${props.finding?.id}.${format}`)
    push({ tone: 'ok', title: 'Downloaded', detail: name })
  } catch (err) {
    push({ tone: 'bad', title: 'Download failed', detail: (err as Error).message })
  } finally {
    downloading.value = null
  }
}
</script>

<template>
  <UiDialog v-model="open" :title="`Fix it — ${finding?.title ?? ''}`" :width="860">
    <div class="stack">
      <div class="callout info">
        <Icon name="lucide:shield-check" size="16" />
        <span><strong>Recommendation only.</strong> The app never runs these steps. Review them, fill in the placeholders and run them yourself, one step at a time.</span>
      </div>
      <p v-if="loading" class="subtle"><span class="spin" aria-hidden="true" /> Re-running the check and reading the facts…</p>
      <div v-else-if="error" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ error }}</div>
      <template v-else-if="data">
        <p class="subtle detail">{{ data.finding.detail }}</p>
        <AssessmentRecommendation v-if="data.recommendation" :rec="data.recommendation" />
        <div v-else class="callout ok"><Icon name="lucide:circle-check" size="16" />{{ data.reason }}</div>
      </template>
    </div>
    <template #footer>
      <button class="btn" :disabled="loading" @click="load"><Icon name="lucide:refresh-cw" size="14" /> Re-check</button>
      <button class="btn" :disabled="!data?.recommendation || !!downloading" @click="download('html')">
        <span v-if="downloading === 'html'" class="spin" aria-hidden="true" /><Icon v-else name="lucide:file-down" size="14" /> HTML
      </button>
      <button class="btn primary" :disabled="!data?.recommendation || !!downloading" @click="download('sql')">
        <span v-if="downloading === 'sql'" class="spin" aria-hidden="true" /><Icon v-else name="lucide:file-code" size="14" /> Download .sql
      </button>
    </template>
  </UiDialog>
</template>

<style scoped>
.detail {
  margin: 0;
}
</style>

<script setup lang="ts">
import type { AssessmentFinding, AssessmentSeverity } from '~~/shared/types/lab'

/**
 * Health-check results. Severity is always shown as icon + label (never color alone).
 * `compact` lists only the first `limit` findings without filters (Summary tab).
 * With `profileId`, open issues get a "Fix it" button (advice only, see AssessmentFixIt).
 */
const props = defineProps<{ findings: AssessmentFinding[]; compact?: boolean; limit?: number; profileId?: string | null }>()

const SEV: Record<AssessmentSeverity, { label: string; tone: string; icon: string }> = {
  critical: { label: 'Critical', tone: 'bad', icon: 'lucide:octagon-alert' },
  warning: { label: 'Warning', tone: 'warn', icon: 'lucide:triangle-alert' },
  info: { label: 'Info', tone: 'info', icon: 'lucide:info' },
  ok: { label: 'OK', tone: 'ok', icon: 'lucide:circle-check' },
  na: { label: 'n/a', tone: '', icon: 'lucide:circle-minus' },
}
const ORDER: AssessmentSeverity[] = ['critical', 'warning', 'info', 'ok', 'na']

const severity = ref<AssessmentSeverity | 'all' | 'issues'>('issues')
const category = ref('')
const categories = computed(() => [...new Set(props.findings.map((f) => f.category))].sort())
const counts = computed(() => Object.fromEntries(ORDER.map((s) => [s, props.findings.filter((f) => f.severity === s).length])) as Record<AssessmentSeverity, number>)

const shown = computed(() => {
  if (props.compact) return props.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning').slice(0, props.limit ?? 6)
  return props.findings.filter(
    (f) =>
      (severity.value === 'all' || (severity.value === 'issues' ? ['critical', 'warning', 'info'].includes(f.severity) : f.severity === severity.value)) &&
      (!category.value || f.category === category.value),
  )
})
const fixing = ref<AssessmentFinding | null>(null)
const fixOpen = ref(false)
function fix(f: AssessmentFinding) {
  fixing.value = f
  fixOpen.value = true
}
const canFix = (f: AssessmentFinding) => !!props.profileId && !props.compact && ['critical', 'warning', 'info'].includes(f.severity)

const open = ref<Set<string>>(new Set())
function toggle(id: string) {
  const s = new Set(open.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  open.value = s
}
</script>

<template>
  <div class="findings">
    <div v-if="!compact" class="row between toolbar">
      <div class="seg" role="group" aria-label="Filter by severity">
        <button :aria-pressed="severity === 'issues'" @click="severity = 'issues'">Issues · {{ counts.critical + counts.warning + counts.info }}</button>
        <button v-for="s in ORDER" :key="s" :aria-pressed="severity === s" @click="severity = s">{{ SEV[s].label }} · {{ counts[s] }}</button>
        <button :aria-pressed="severity === 'all'" @click="severity = 'all'">All · {{ findings.length }}</button>
      </div>
      <select v-model="category" class="input" style="width: 180px" aria-label="Category">
        <option value="">All categories</option>
        <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
      </select>
    </div>

    <p v-if="!shown.length" class="subtle empty">{{ compact ? 'No critical or warning findings.' : 'No findings match this filter.' }}</p>
    <ul class="list">
      <li v-for="f in shown" :key="f.id" class="item" :class="f.severity">
        <span class="badge sev" :class="SEV[f.severity].tone"><Icon :name="SEV[f.severity].icon" size="12" />{{ SEV[f.severity].label }}</span>
        <div class="body">
          <div class="title">
            <strong>{{ f.title }}</strong>
            <span class="subtle">{{ f.category }}</span>
            <button v-if="canFix(f)" class="btn sm fix" @click="fix(f)"><Icon name="lucide:wrench" size="13" /> Fix it</button>
          </div>
          <div class="detail">{{ f.detail }}</div>
          <div v-if="f.recommendation && !compact" class="rec"><Icon name="lucide:corner-down-right" size="12" /> {{ f.recommendation }}</div>
          <template v-if="f.items?.length && !compact">
            <button class="btn ghost sm more" :aria-expanded="open.has(f.id)" @click="toggle(f.id)">
              <Icon :name="open.has(f.id) ? 'lucide:chevron-down' : 'lucide:chevron-right'" size="13" />
              {{ f.severity === 'critical' || f.severity === 'warning' ? `${f.items.length} affected` : `${f.items.length} detail(s)` }}{{ f.items.length >= 25 ? ' (first 25)' : '' }}
            </button>
            <ul v-if="open.has(f.id)" class="items mono">
              <li v-for="it in f.items" :key="it">{{ it }}</li>
            </ul>
          </template>
        </div>
      </li>
    </ul>
    <AssessmentFixIt v-if="profileId" v-model="fixOpen" :profile-id="profileId" :finding="fixing" />
  </div>
</template>

<style scoped>
.toolbar {
  margin-bottom: 12px;
}
.toolbar .seg {
  flex-wrap: wrap;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.item {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 12px;
  padding: 10px 2px;
  border-top: 1px solid var(--border);
}
.item:first-child {
  border-top: 0;
}
.sev {
  justify-self: start;
  align-self: start;
  margin-top: 1px;
}
.sev::before {
  display: none;
}
.title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}
.fix {
  margin-left: auto;
}
.detail {
  color: var(--text-2);
  font-size: 13px;
}
.rec {
  color: var(--text-3);
  font-size: 12.5px;
  margin-top: 2px;
}
.more {
  margin: 4px 0 0 -8px;
}
.items {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-2);
}
.empty {
  padding: 12px 2px;
  margin: 0;
}
@media (max-width: 600px) {
  .item {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>

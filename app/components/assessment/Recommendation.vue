<script setup lang="ts">
import type { FixStep, Recommendation } from '~~/shared/types/lab'

/** One "Fix it" recommendation: why, impact, placeholders, then the steps as copyable scripts. Display only. */
defineProps<{ rec: Recommendation }>()

const KIND: Record<FixStep['kind'], { label: string; icon: string }> = {
  sql: { label: 'SQL', icon: 'lucide:terminal-square' },
  rman: { label: 'RMAN', icon: 'lucide:archive-restore' },
  shell: { label: 'OS shell', icon: 'lucide:square-terminal' },
  check: { label: 'Check · read-only', icon: 'lucide:search-check' },
}
const RISK = { low: 'ok', medium: 'warn', high: 'bad' } as const
</script>

<template>
  <div class="rec">
    <div class="tags">
      <span class="badge" :class="RISK[rec.impact.risk]"><Icon name="lucide:gauge" size="12" />Risk {{ rec.impact.risk }}</span>
      <span class="badge" :class="rec.impact.restart ? 'warn' : 'ok'"><Icon :name="rec.impact.restart ? 'lucide:power' : 'lucide:zap'" size="12" />{{ rec.impact.restart ? 'Restart needed' : 'No restart' }}</span>
      <span v-if="rec.impact.downtime" class="badge warn"><Icon name="lucide:clock-alert" size="12" />Downtime</span>
      <span v-if="rec.impact.enterpriseOnly" class="badge info"><Icon name="lucide:badge-check" size="12" />Enterprise Edition</span>
      <span v-if="rec.guidanceOnly" class="badge"><Icon name="lucide:book-open" size="12" />Guidance only</span>
    </div>

    <p class="why">{{ rec.why }}</p>
    <ul v-if="rec.impact.notes.length" class="notes">
      <li v-for="n in rec.impact.notes" :key="n">{{ n }}</li>
    </ul>

    <div v-if="rec.prerequisites.length" class="block">
      <h4>Before you start</h4>
      <ul class="notes">
        <li v-for="p in rec.prerequisites" :key="p">{{ p }}</li>
      </ul>
    </div>

    <div v-if="rec.placeholders.length" class="callout warn">
      <Icon name="lucide:pencil-line" size="16" />
      <div>
        <strong>Fill in before running</strong>
        <ul class="notes mono">
          <li v-for="p in rec.placeholders" :key="p">{{ p }}</li>
        </ul>
      </div>
    </div>

    <ol v-if="rec.steps.length" class="steps">
      <li v-for="(s, i) in rec.steps" :key="i" class="step">
        <div class="step-head">
          <span class="nr num">{{ i + 1 }}</span>
          <strong>{{ s.title }}</strong>
        </div>
        <div class="step-meta subtle"><Icon :name="KIND[s.kind].icon" size="12" /> {{ KIND[s.kind].label }} · run as {{ s.runAs }}</div>
        <UiCode :code="s.code" max-height="320px" />
      </li>
    </ol>

    <div v-if="rec.verify" class="block">
      <h4><Icon name="lucide:circle-check" size="13" /> Verify — {{ rec.verify.title }}</h4>
      <div class="step-meta subtle">run as {{ rec.verify.runAs }}</div>
      <UiCode :code="rec.verify.code" max-height="220px" />
    </div>
    <div v-if="rec.rollback" class="block">
      <h4><Icon name="lucide:undo-2" size="13" /> Rollback — {{ rec.rollback.title }}</h4>
      <div class="step-meta subtle">run as {{ rec.rollback.runAs }}</div>
      <UiCode :code="rec.rollback.code" max-height="220px" />
    </div>

    <details v-if="rec.basedOn.length" class="based">
      <summary>Based on {{ rec.basedOn.length }} fact(s) read from the database</summary>
      <ul class="notes mono">
        <li v-for="b in rec.basedOn" :key="b">{{ b }}</li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.rec {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tags .badge::before {
  display: none;
}
.why {
  margin: 0;
}
.notes {
  margin: 0;
  padding-left: 18px;
  color: var(--text-2);
  font-size: 13px;
}
.notes.mono {
  font-size: 12px;
  overflow-wrap: anywhere;
}
h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.step-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.nr {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  font-size: 11.5px;
}
.step-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  margin: 2px 0 6px;
}
.based summary {
  cursor: pointer;
  color: var(--text-2);
  font-size: 13px;
}
.based ul {
  margin-top: 6px;
}
</style>

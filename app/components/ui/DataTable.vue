<script setup lang="ts">
export interface Column {
  key: string
  label: string
  num?: boolean
  sortable?: boolean
  mono?: boolean
  width?: string
  /** Format the raw value for display. */
  format?: (v: any, row: any) => string
  /** Badge tone for the cell. */
  tone?: (v: any, row: any) => 'ok' | 'warn' | 'bad' | 'info' | '' | undefined
  maxWidth?: string
}

const props = defineProps<{
  columns: Column[]
  rows: any[]
  rowKey?: string | ((row: any) => string)
  emptyText?: string
  maxHeight?: string
  selectedKey?: string | null
  clickable?: boolean
}>()
const emit = defineEmits<{ rowClick: [row: any] }>()

const sortKey = ref<string | null>(null)
const sortDir = ref<1 | -1>(-1)

function toggleSort(c: Column) {
  if (c.sortable === false) return
  if (sortKey.value === c.key) sortDir.value = sortDir.value === 1 ? -1 : 1
  else {
    sortKey.value = c.key
    sortDir.value = c.num ? -1 : 1
  }
}

const sorted = computed(() => {
  if (!sortKey.value) return props.rows
  const k = sortKey.value
  return [...props.rows].sort((a, b) => {
    const x = a?.[k]
    const y = b?.[k]
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir.value
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sortDir.value
  })
})

function keyOf(row: any, i: number) {
  if (typeof props.rowKey === 'function') return props.rowKey(row)
  if (props.rowKey) return String(row[props.rowKey])
  return String(i)
}

function display(c: Column, row: any) {
  const v = row?.[c.key]
  if (c.format) return c.format(v, row)
  if (v == null) return '—'
  if (c.num && typeof v === 'number') return fmtNum(v, 3)
  return String(v)
}
</script>

<template>
  <div class="table-wrap" :style="{ maxHeight }">
    <table class="data">
      <thead>
        <tr>
          <th
            v-for="c in columns"
            :key="c.key"
            :class="{ num: c.num, sortable: c.sortable !== false }"
            :style="{ width: c.width }"
            :aria-sort="sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : undefined"
            scope="col"
          >
            <button v-if="c.sortable !== false" class="th-btn" @click="toggleSort(c)">
              {{ c.label }}
              <Icon v-if="sortKey === c.key" :name="sortDir === 1 ? 'lucide:arrow-up' : 'lucide:arrow-down'" size="12" />
            </button>
            <template v-else>{{ c.label }}</template>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!rows.length">
          <td :colspan="columns.length" class="empty">{{ emptyText ?? 'No rows.' }}</td>
        </tr>
        <tr
          v-for="(row, i) in sorted"
          :key="keyOf(row, i)"
          :class="{ selected: selectedKey != null && keyOf(row, i) === selectedKey, clickable }"
          :tabindex="clickable ? 0 : undefined"
          @click="clickable && emit('rowClick', row)"
          @keydown.enter="clickable && emit('rowClick', row)"
        >
          <td v-for="c in columns" :key="c.key" :class="{ num: c.num, mono: c.mono }" :style="{ maxWidth: c.maxWidth }">
            <slot :name="`cell-${c.key}`" :row="row" :value="row?.[c.key]">
              <span v-if="c.tone" class="badge" :class="c.tone(row?.[c.key], row)">{{ display(c, row) }}</span>
              <span v-else :class="{ ellipsis: !!c.maxWidth }" :title="c.maxWidth ? display(c, row) : undefined" :style="c.maxWidth ? { display: 'block', maxWidth: c.maxWidth } : undefined">{{ display(c, row) }}</span>
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.th-btn {
  all: unset;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.th-btn:focus-visible {
  outline: 2px solid var(--focus);
}
th.num .th-btn {
  flex-direction: row-reverse;
}
.empty {
  color: var(--text-3);
  text-align: center;
  padding: 18px;
}
tr.clickable {
  cursor: pointer;
}
</style>

<script setup lang="ts">
import type { AssessmentDiff, AssessmentFinding, AssessmentSection, AssessmentSnapshotMeta } from '~~/shared/types/lab'

useHead({ title: 'Database Assessment · OracleDB Data Lab' })
const { activeId } = useActiveProfile()
const { push } = useToasts()

const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'findings', label: 'Health checks' },
  { id: 'parameters', label: 'Parameters' },
  { id: 'spfile', label: 'Parameter file' },
  { id: 'users', label: 'Users' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'security', label: 'Security' },
  { id: 'tablespaces', label: 'Tablespaces' },
  { id: 'objects', label: 'Objects' },
  { id: 'design', label: 'Schema health' },
  { id: 'physical', label: 'Physical' },
  { id: 'instance', label: 'Memory & instance' },
  { id: 'components', label: 'Components & patches' },
] as const
type SectionId = (typeof TABS)[number]['id']

const tab = ref<SectionId | 'history'>('summary')
// Sections load the first time their tab is opened and stay cached until Refresh.
const visited = reactive(new Set<SectionId>(['summary', 'findings']))
watch(tab, (t) => t !== 'history' && visited.add(t))
const base = computed(() => (activeId.value ? `/api/connections/${activeId.value}/assessment` : null))
function section(id: SectionId) {
  return useLoader<AssessmentSection>(() => (base.value && visited.has(id) ? `${base.value}/${id}` : null))
}
const S = Object.fromEntries(TABS.map((t) => [t.id, section(t.id)])) as Record<SectionId, ReturnType<typeof section>>

/** Props for <AssessmentPanel v-bind>: the named panel of a section plus that section's request state. */
function bind(id: SectionId, name: string) {
  return { panel: S[id].data.value?.[name] ?? null, loading: S[id].loading.value, error: S[id].error.value }
}
function okData<T = any>(id: SectionId, name: string): T | null {
  const p = S[id].data.value?.[name]
  return p?.status === 'ok' ? (p.data as T) : null
}
function refresh() {
  for (const id of visited) void S[id].load()
}

const findings = computed(() => okData<AssessmentFinding[]>('findings', 'findings') ?? [])
const issueCount = computed(() => findings.value.filter((f) => f.severity === 'critical' || f.severity === 'warning').length)
const sevCount = (s: AssessmentFinding['severity']) => findings.value.filter((f) => f.severity === s).length
const tabs = computed(() => [
  ...TABS.map((t) => ({ ...t, count: t.id === 'findings' && findings.value.length ? issueCount.value : null })),
  { id: 'history', label: 'History & compare', count: snapshots.data.value?.length || null },
])
const counts = computed(() => okData<Record<string, number | null>>('summary', 'counts'))

// ---- history & compare ----
const historyScope = ref<'profile' | 'all'>('profile')
const snapshots = useLoader<AssessmentSnapshotMeta[]>(() => (historyScope.value === 'all' ? '/api/assessment/snapshots' : activeId.value ? `/api/assessment/snapshots?profileId=${activeId.value}` : null))
const snapLabel = ref('')
const snapping = ref(false)
async function saveSnapshot() {
  if (!activeId.value) return
  snapping.value = true
  try {
    const m = await api<AssessmentSnapshotMeta>('/api/assessment/snapshots', { method: 'POST', body: { profileId: activeId.value, label: snapLabel.value } })
    push({ tone: 'ok', title: 'Snapshot saved', detail: `${m.dbName ?? m.profileName}${m.label ? ` · ${m.label}` : ''}` })
    snapLabel.value = ''
    await snapshots.load()
  } catch (err) {
    push({ tone: 'bad', title: 'Snapshot failed', detail: apiErrorMessage(err) })
  } finally {
    snapping.value = false
  }
}
const picked = ref<string[]>([])
function togglePick(id: string) {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id].slice(-2)
}
/** Older snapshot is A, newer is B. */
const pair = computed(() => {
  const list = (snapshots.data.value ?? []).filter((s) => picked.value.includes(s.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return list.length === 2 ? { a: list[0]!, b: list[1]! } : null
})
const diff = ref<AssessmentDiff | null>(null)
const comparing = ref(false)
async function compare() {
  if (!pair.value) return
  comparing.value = true
  try {
    diff.value = await api<AssessmentDiff>(`/api/assessment/compare?a=${pair.value.a.id}&b=${pair.value.b.id}`)
  } catch (err) {
    push({ tone: 'bad', title: 'Compare failed', detail: apiErrorMessage(err) })
  } finally {
    comparing.value = false
  }
}
const deletingSnap = ref<AssessmentSnapshotMeta | null>(null)
async function deleteSnapshot() {
  const s = deletingSnap.value
  if (!s) return
  try {
    await api(`/api/assessment/snapshots/${s.id}`, { method: 'DELETE' })
    picked.value = picked.value.filter((x) => x !== s.id)
    if (diff.value && (diff.value.a.id === s.id || diff.value.b.id === s.id)) diff.value = null
    await snapshots.load()
  } catch (err) {
    push({ tone: 'bad', title: 'Delete failed', detail: apiErrorMessage(err) })
  } finally {
    deletingSnap.value = null
  }
}
// Trends: snapshots of the active profile, oldest first (separate charts — different units).
const trend = computed(() => (snapshots.data.value ?? []).filter((s) => s.profileId === activeId.value).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
const trendIssues = computed(() => [
  { name: 'Critical', slot: 1, points: trend.value.map((s) => ({ x: Date.parse(s.createdAt), y: s.summary.critical })) },
  { name: 'Warning', slot: 3, points: trend.value.map((s) => ({ x: Date.parse(s.createdAt), y: s.summary.warning })) },
])
const trendSize = computed(() => [{ name: 'Database size', points: trend.value.map((s) => ({ x: Date.parse(s.createdAt), y: s.summary.dbSizeBytes })) }])
const trendInvalid = computed(() => [{ name: 'Invalid objects', slot: 4, points: trend.value.map((s) => ({ x: Date.parse(s.createdAt), y: s.summary.invalid })) }])

// ---- export ----
const exporting = ref<'html' | 'json' | null>(null)
async function exportReport(format: 'html' | 'json') {
  if (!activeId.value) return
  exporting.value = format
  try {
    const res = await fetch(`/api/connections/${activeId.value}/assessment-report?format=${format}`)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.statusMessage || body?.message || `HTTP ${res.status}`)
    }
    const blob = await res.blob()
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `assessment.${format}`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    push({ tone: 'ok', title: 'Assessment report downloaded', detail: name })
  } catch (err) {
    push({ tone: 'bad', title: 'Export failed', detail: (err as Error).message })
  } finally {
    exporting.value = null
  }
}

// ---- filters ----
const paramQuery = ref('')
const paramMode = ref<'all' | 'nondefault' | 'modified' | 'deprecated' | 'hidden'>('nondefault')
const parameters = computed(() => {
  const list = okData<any[]>('parameters', 'parameters') ?? []
  const q = paramQuery.value.trim().toLowerCase()
  return list.filter((p) => {
    if (paramMode.value === 'nondefault' && p.isDefault !== 'FALSE') return false
    if (paramMode.value === 'modified' && p.isModified === 'FALSE') return false
    if (paramMode.value === 'deprecated' && p.deprecated !== 'TRUE') return false
    if (paramMode.value === 'hidden' && !p.name.startsWith('_')) return false
    return !q || p.name.includes(q) || String(p.value ?? '').toLowerCase().includes(q) || String(p.description ?? '').toLowerCase().includes(q)
  })
})

const userMode = ref<'application' | 'all' | 'oracle'>('application')
const userQuery = ref('')
const users = computed(() => {
  const list = okData<any[]>('users', 'users') ?? []
  const q = userQuery.value.trim().toUpperCase()
  return list.filter(
    (u) => (userMode.value === 'all' || (userMode.value === 'application' ? u.oracleMaintained === 'N' : u.oracleMaintained === 'Y')) && (!q || u.username.includes(q)),
  )
})
const roleMode = ref<'application' | 'all'>('application')
const roles = computed(() => (okData<any[]>('security', 'roles') ?? []).filter((r) => roleMode.value === 'all' || r.oracleMaintained !== 'Y'))
const ownerMode = ref<'application' | 'all'>('application')
const owners = computed(() => (okData<any[]>('objects', 'byOwner') ?? []).filter((o) => ownerMode.value === 'all' || o.oracleMaintained === 'N'))
const optionMode = ref<'enabled' | 'all'>('enabled')
const options = computed(() => (okData<any[]>('components', 'options') ?? []).filter((o) => optionMode.value === 'all' || o.enabled === 'TRUE'))

const profileColumns = computed(() => {
  const p = okData<{ profiles: { profile: string }[] }>('profiles', 'profiles')
  return [
    { key: 'resource', label: 'Resource', mono: true },
    { key: 'type', label: 'Type' },
    ...(p?.profiles ?? []).map((x) => ({ key: x.profile, label: x.profile, mono: true })),
  ]
})

// ---- tones ----
const statusTone = (v: string) => (v === 'OPEN' ? 'ok' : /EXPIRED/.test(v ?? '') ? 'bad' : /LOCKED/.test(v ?? '') ? '' : 'warn')
const yesWarn = (v: string) => (v === 'YES' || v === 'Y' || v === 'TRUE' ? 'warn' : '')
const validTone = (v: string) => (v === 'VALID' || v === 'ENABLED' || v === 'SUCCESS' || v === 'ONLINE' ? 'ok' : v === 'OPTION OFF' || v === 'DISABLED' ? '' : 'bad')
const pgaFormat = (v: number, r: any) => (r.unit === 'bytes' ? fmtBytes(v) : r.unit === 'percent' ? fmtPct(v) : fmtNum(v))
const switchSeries = computed(() => {
  const d = okData<{ series: { hour: string; switches: number }[] }>('physical', 'switches')
  return d ? [{ name: 'Log switches', points: d.series.map((s) => ({ x: Date.parse(s.hour), y: s.switches })) }] : []
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Database Assessment</h1>
        <p>Full read-only inventory of the connected database — parameters and parameter file, users, profiles, privileges, tablespaces, objects, physical structure, memory and components — plus {{ findings.length || 'about 35' }} automated health checks.</p>
      </div>
      <div v-if="activeId" class="row">
        <button class="btn" :disabled="[...visited].some((id) => S[id].loading.value)" @click="refresh"><Icon name="lucide:refresh-cw" size="14" /> Refresh</button>
        <button class="btn" :disabled="!!exporting" @click="exportReport('json')">
          <span v-if="exporting === 'json'" class="spin" aria-hidden="true" /><Icon v-else name="lucide:braces" size="14" /> JSON
        </button>
        <button class="btn primary" :disabled="!!exporting" @click="exportReport('html')">
          <span v-if="exporting === 'html'" class="spin" aria-hidden="true" /><Icon v-else name="lucide:file-down" size="14" />
          {{ exporting === 'html' ? 'Collecting all sections…' : 'HTML report' }}
        </button>
      </div>
    </div>

    <UiRequireProfile>
      <div class="stack">
        <UiTabs v-model="tab" :tabs="tabs" />

        <!-- ================= Summary ================= -->
        <template v-if="tab === 'summary'">
          <div v-if="S.summary.error.value" class="callout bad"><Icon name="lucide:circle-x" size="16" />{{ S.summary.error.value }}</div>
          <div class="grid kpis">
            <template v-if="counts">
              <UiKpi label="Users" icon="lucide:users" :value="fmtNum(counts.users)" :sub="`${fmtNum(counts.usersOpen)} open · ${fmtNum(counts.usersLocked)} locked · ${fmtNum(counts.usersApplication)} application`" />
              <UiKpi label="Profiles / roles" icon="lucide:id-card" :value="`${fmtNum(counts.profiles)} / ${fmtNum(counts.roles)}`" sub="password & resource profiles · roles" />
              <UiKpi label="Tablespaces" icon="lucide:hard-drive" :value="fmtNum(counts.tablespaces)" :sub="`${fmtNum(counts.datafiles)} datafiles · ${fmtNum(counts.tempfiles)} tempfiles`" />
              <UiKpi label="Database size" icon="lucide:database" tone="info" :value="fmtBytes((counts.datafileBytes ?? 0) + (counts.tempfileBytes ?? 0))" :sub="`segments ${fmtBytes(counts.segmentBytes)} · application ${fmtBytes(counts.segmentBytesApplication)}`" />
              <UiKpi label="Objects" icon="lucide:boxes" :value="fmtNum(counts.objects)" :sub="`${fmtNum(counts.objectsApplication)} application · ${fmtNum(counts.tables)} tables · ${fmtNum(counts.indexes)} indexes`" />
              <UiKpi label="Invalid objects" icon="lucide:circle-x" :value="fmtNum(counts.objectsInvalid)" :sub="`${fmtNum(counts.objectsApplicationInvalid)} in application schemas`" :tone="counts.objectsInvalid ? 'warn' : 'ok'" />
              <UiKpi label="Parameters" icon="lucide:sliders-horizontal" :value="fmtNum(counts.parametersNonDefault)" :sub="`non-default of ${fmtNum(counts.parameters)} · ${fmtNum(counts.spfileEntries)} SPFILE entries`" />
              <UiKpi label="Redo / control files" icon="lucide:file-stack" :value="`${fmtNum(counts.redoGroups)} / ${fmtNum(counts.controlfiles)}`" :sub="`redo ${fmtBytes(counts.redoBytes)} · ${fmtNum(counts.dbLinks)} DB links · ${fmtNum(counts.directories)} directories`" />
            </template>
            <template v-else>
              <UiKpi v-for="i in 8" :key="i" label="…" :loading="S.summary.loading.value" :unavailable="S.summary.data.value?.counts?.status === 'unavailable' ? S.summary.data.value.counts.reason : null" />
            </template>
          </div>

          <div class="grid two">
            <AssessmentPanel title="Database identity" icon="lucide:fingerprint" v-bind="bind('summary', 'identity')">
              <template #default="{ data }">
                <dl class="kv">
                  <dt>Banner</dt><dd>{{ data.banner }}</dd>
                  <dt>Database</dt><dd>{{ data.dbName }} ({{ data.dbUniqueName }}) · DBID <span class="mono">{{ data.dbid }}</span></dd>
                  <dt>Container</dt><dd>{{ data.container ? `${data.container}${data.cdb === 'YES' ? ' · multitenant (CDB)' : ''}` : 'non-CDB' }}</dd>
                  <dt>Instance</dt><dd>{{ data.instanceName }} on {{ data.hostName }} · {{ data.status }} · version {{ data.version }}</dd>
                  <dt>Platform</dt><dd>{{ data.platform }}</dd>
                  <dt>Role / mode</dt><dd>{{ data.databaseRole }} · {{ data.openMode }} · {{ data.protectionMode }}</dd>
                  <dt>Logging</dt>
                  <dd class="row">
                    <span class="badge" :class="data.logMode === 'ARCHIVELOG' ? 'ok' : 'warn'">{{ data.logMode }}</span>
                    <span class="badge" :class="data.forceLogging === 'YES' ? 'ok' : ''">force logging {{ data.forceLogging }}</span>
                    <span class="badge" :class="data.flashbackOn === 'YES' ? 'ok' : ''">flashback {{ data.flashbackOn }}</span>
                  </dd>
                  <dt>Character set</dt><dd>{{ data.characterSet }} / {{ data.nationalCharacterSet }}</dd>
                  <dt>Created</dt><dd>{{ fmtDate(data.created) }}</dd>
                  <dt>Started</dt><dd>{{ fmtDate(data.startupTime) }} · up {{ fmtDuration(data.uptimeSeconds) }}</dd>
                </dl>
              </template>
            </AssessmentPanel>

            <AssessmentPanel title="Health at a glance" icon="lucide:stethoscope" v-bind="bind('findings', 'findings')" :count="() => null">
              <template #actions>
                <button class="btn sm" @click="tab = 'findings'">All checks <Icon name="lucide:arrow-right" size="13" /></button>
              </template>
              <template #default="{ data }">
                <div class="sev-row">
                  <div class="sev-stat"><span class="badge bad"><Icon name="lucide:octagon-alert" size="12" />Critical</span><strong class="num">{{ sevCount('critical') }}</strong></div>
                  <div class="sev-stat"><span class="badge warn"><Icon name="lucide:triangle-alert" size="12" />Warning</span><strong class="num">{{ sevCount('warning') }}</strong></div>
                  <div class="sev-stat"><span class="badge info"><Icon name="lucide:info" size="12" />Info</span><strong class="num">{{ sevCount('info') }}</strong></div>
                  <div class="sev-stat"><span class="badge ok"><Icon name="lucide:circle-check" size="12" />Passed</span><strong class="num">{{ sevCount('ok') }}<span class="subtle"> / {{ data.length }}</span></strong></div>
                </div>
                <AssessmentFindings :findings="data" compact :limit="6" />
              </template>
            </AssessmentPanel>
          </div>
        </template>

        <!-- ================= Health checks ================= -->
        <AssessmentPanel v-else-if="tab === 'findings'" title="Health checks" icon="lucide:stethoscope" v-bind="bind('findings', 'findings')" :count="() => null">
          <template #default="{ data }"><AssessmentFindings :findings="data" /></template>
        </AssessmentPanel>

        <!-- ================= Parameters ================= -->
        <AssessmentPanel v-else-if="tab === 'parameters'" title="Initialization parameters" icon="lucide:sliders-horizontal" flush v-bind="bind('parameters', 'parameters')">
          <template #actions>
            <div class="seg" role="group" aria-label="Parameter filter">
              <button :aria-pressed="paramMode === 'nondefault'" @click="paramMode = 'nondefault'">Non-default</button>
              <button :aria-pressed="paramMode === 'modified'" @click="paramMode = 'modified'">Modified</button>
              <button :aria-pressed="paramMode === 'deprecated'" @click="paramMode = 'deprecated'">Deprecated</button>
              <button :aria-pressed="paramMode === 'hidden'" @click="paramMode = 'hidden'">Hidden</button>
              <button :aria-pressed="paramMode === 'all'" @click="paramMode = 'all'">All</button>
            </div>
            <input v-model="paramQuery" class="input search" placeholder="Search name, value, description" aria-label="Search parameters" >
          </template>
          <template #default>
            <p class="subtle pad">{{ fmtNum(parameters.length) }} shown</p>
            <UiDataTable
              :columns="[
                { key: 'name', label: 'Parameter', mono: true },
                { key: 'value', label: 'Value', mono: true, maxWidth: '340px' },
                { key: 'type', label: 'Type' },
                { key: 'isDefault', label: 'Default', tone: (v) => (v === 'FALSE' ? 'info' : ''), format: (v) => (v === 'FALSE' ? 'set' : 'default') },
                { key: 'systemModifiable', label: 'ALTER SYSTEM' },
                { key: 'sessionModifiable', label: 'ALTER SESSION' },
                { key: 'pdbModifiable', label: 'PDB' },
                { key: 'deprecated', label: 'Deprecated', tone: (v) => (v === 'TRUE' ? 'warn' : ''), format: (v) => (v === 'TRUE' ? 'yes' : 'no') },
                { key: 'description', label: 'Description', maxWidth: '420px' },
              ]"
              :rows="parameters"
              row-key="name"
              max-height="640px"
              empty-text="No parameters match."
            />
          </template>
        </AssessmentPanel>

        <!-- ================= Parameter file ================= -->
        <template v-else-if="tab === 'spfile'">
          <AssessmentPanel title="Parameter file in use" icon="lucide:file-cog" v-bind="bind('spfile', 'source')">
            <template #default="{ data }">
              <dl class="kv">
                <dt>Mode</dt><dd><span class="badge" :class="data.spfile ? 'ok' : 'warn'">{{ data.mode }}</span></dd>
                <dt>Location</dt><dd class="mono">{{ data.spfile ?? '—' }}</dd>
              </dl>
            </template>
          </AssessmentPanel>
          <div class="grid two">
            <AssessmentPanel title="SPFILE entries (V$SPPARAMETER)" icon="lucide:file-text" v-bind="bind('spfile', 'entries')" :count="(d) => d.entries.length" :is-empty="() => false">
              <template #default="{ data }">
                <UiCode :code="data.pfileText || '(no entries)'" max-height="460px" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Effective non-default parameters (init.ora)" icon="lucide:file-check" v-bind="bind('spfile', 'effective')" :count="(d) => d.entries.length" :is-empty="() => false">
              <template #default="{ data }">
                <UiCode :code="data.pfileText || '(none)'" max-height="460px" />
              </template>
            </AssessmentPanel>
          </div>
        </template>

        <!-- ================= Users ================= -->
        <template v-else-if="tab === 'users'">
          <AssessmentPanel title="Users" icon="lucide:users" flush v-bind="bind('users', 'users')" :count="() => users.length">
            <template #actions>
              <div class="seg" role="group" aria-label="User filter">
                <button :aria-pressed="userMode === 'application'" @click="userMode = 'application'">Application</button>
                <button :aria-pressed="userMode === 'oracle'" @click="userMode = 'oracle'">Oracle-maintained</button>
                <button :aria-pressed="userMode === 'all'" @click="userMode = 'all'">All</button>
              </div>
              <input v-model="userQuery" class="input search" placeholder="Search user" aria-label="Search users" >
            </template>
            <template #default>
              <UiDataTable
                :columns="[
                  { key: 'username', label: 'User', mono: true },
                  { key: 'status', label: 'Status', tone: (v) => statusTone(v) },
                  { key: 'profile', label: 'Profile', mono: true },
                  { key: 'defaultTablespace', label: 'Default TS', mono: true },
                  { key: 'temporaryTablespace', label: 'Temp TS', mono: true },
                  { key: 'authentication', label: 'Auth' },
                  { key: 'hasDba', label: 'DBA', tone: (v) => yesWarn(v) },
                  { key: 'roles', label: 'Roles', num: true },
                  { key: 'sysPrivs', label: 'Sys privs', num: true },
                  { key: 'objects', label: 'Objects', num: true, format: (v) => fmtNum(v) },
                  { key: 'segmentBytes', label: 'Size', num: true, format: (v) => fmtBytes(v) },
                  { key: 'created', label: 'Created', format: (v) => fmtDate(v, false) },
                  { key: 'lastLogin', label: 'Last login', format: (v) => (v ? fmtRelative(v) : 'never / n/a') },
                  { key: 'expiryDate', label: 'Expires', format: (v) => fmtDate(v, false) },
                ]"
                :rows="users"
                row-key="username"
                max-height="560px"
                empty-text="No users match."
              />
            </template>
          </AssessmentPanel>
          <AssessmentPanel title="Tablespace quotas" icon="lucide:gauge" flush v-bind="bind('users', 'quotas')" empty-text="No quotas granted.">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'username', label: 'User', mono: true },
                  { key: 'tablespace', label: 'Tablespace', mono: true },
                  { key: 'usedBytes', label: 'Used', num: true, format: (v) => fmtBytes(v) },
                  { key: 'quota', label: 'Quota' },
                  { key: 'maxBytes', label: 'Max', num: true, format: (v) => (v == null ? '—' : fmtBytes(v)) },
                ]"
                :rows="data"
                :row-key="(r) => `${r.username}:${r.tablespace}`"
                max-height="360px"
              />
            </template>
          </AssessmentPanel>
        </template>

        <!-- ================= Profiles ================= -->
        <template v-else-if="tab === 'profiles'">
          <AssessmentPanel title="Profiles" icon="lucide:id-card" flush v-bind="bind('profiles', 'profiles')" :count="(d) => d.profiles.length">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'profile', label: 'Profile', mono: true },
                  { key: 'users', label: 'Users', num: true },
                  { key: 'openUsers', label: 'Open users', num: true },
                ]"
                :rows="data.profiles"
                row-key="profile"
              />
            </template>
          </AssessmentPanel>
          <AssessmentPanel title="Limits per profile" icon="lucide:table-properties" flush v-bind="bind('profiles', 'profiles')" :count="(d) => d.limits.length">
            <template #default="{ data }">
              <UiDataTable :columns="profileColumns" :rows="data.limits" row-key="resource" max-height="620px" />
            </template>
          </AssessmentPanel>
        </template>

        <!-- ================= Security ================= -->
        <template v-else-if="tab === 'security'">
          <div class="grid two">
            <AssessmentPanel title="Powerful grants to application accounts" icon="lucide:key-round" flush v-bind="bind('security', 'powerful')" empty-text="None — no powerful roles or ANY privileges granted to application accounts.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'grantee', label: 'Grantee', mono: true },
                    { key: 'kind', label: 'Kind' },
                    { key: 'privilege', label: 'Role / privilege', mono: true },
                    { key: 'adminOption', label: 'Admin opt.', tone: (v) => yesWarn(v) },
                  ]"
                  :rows="data"
                  :row-key="(r) => `${r.grantee}:${r.privilege}`"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Accounts with default passwords" icon="lucide:lock-keyhole-open" flush v-bind="bind('security', 'defaultPasswords')" empty-text="None found.">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'username', label: 'User', mono: true }, { key: 'status', label: 'Status', tone: (v) => (v === 'OPEN' ? 'bad' : '') }]" :rows="data" row-key="username" max-height="360px" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="PUBLIC execute on sensitive packages" icon="lucide:globe" flush v-bind="bind('security', 'publicGrants')" empty-text="None.">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'object', label: 'Package', mono: true }, { key: 'owner', label: 'Owner', mono: true }, { key: 'privilege', label: 'Privilege' }]" :rows="data" row-key="object" max-height="360px" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Password file users" icon="lucide:shield-user" flush v-bind="bind('security', 'pwfile')">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'username', label: 'User', mono: true },
                    { key: 'sysdba', label: 'SYSDBA' },
                    { key: 'sysoper', label: 'SYSOPER' },
                    { key: 'sysbackup', label: 'SYSBACKUP' },
                    { key: 'sysdg', label: 'SYSDG' },
                    { key: 'syskm', label: 'SYSKM' },
                  ]"
                  :rows="data"
                  row-key="username"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Database links" icon="lucide:link" flush v-bind="bind('security', 'dbLinks')" empty-text="No database links.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[{ key: 'owner', label: 'Owner', mono: true }, { key: 'dbLink', label: 'Link', mono: true }, { key: 'username', label: 'Remote user', mono: true }, { key: 'host', label: 'Host', mono: true, maxWidth: '280px' }, { key: 'created', label: 'Created', format: (v) => fmtDate(v, false) }]"
                  :rows="data"
                  :row-key="(r) => `${r.owner}:${r.dbLink}`"
                  max-height="320px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Directory objects" icon="lucide:folder-open" flush v-bind="bind('security', 'directories')" empty-text="No directories.">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'directory', label: 'Directory', mono: true }, { key: 'path', label: 'Path', mono: true, maxWidth: '380px' }, { key: 'owner', label: 'Owner', mono: true }]" :rows="data" row-key="directory" max-height="320px" />
              </template>
            </AssessmentPanel>
          </div>
          <AssessmentPanel title="Auditing" icon="lucide:scroll-text" v-bind="bind('security', 'auditing')">
            <template #default="{ data }">
              <dl class="kv">
                <dt>AUDIT_TRAIL</dt><dd class="mono">{{ data.auditTrail ?? '—' }}</dd>
                <dt>Unified auditing only</dt><dd>{{ data.unifiedAuditingOnly ?? 'n/a (pre-12c)' }}</dd>
                <dt>Enabled unified policies</dt><dd>{{ data.enabledPolicies.length }}</dd>
              </dl>
              <UiDataTable
                v-if="data.enabledPolicies.length"
                style="margin-top: 10px"
                :columns="Object.keys(data.enabledPolicies[0]).map((k) => ({ key: k, label: k, mono: true }))"
                :rows="data.enabledPolicies"
                max-height="300px"
              />
            </template>
          </AssessmentPanel>
          <AssessmentPanel title="Roles" icon="lucide:users-round" flush v-bind="bind('security', 'roles')" :count="() => roles.length">
            <template #actions>
              <div class="seg" role="group" aria-label="Role filter">
                <button :aria-pressed="roleMode === 'application'" @click="roleMode = 'application'">Application</button>
                <button :aria-pressed="roleMode === 'all'" @click="roleMode = 'all'">All</button>
              </div>
            </template>
            <template #default>
              <UiDataTable
                :columns="[
                  { key: 'role', label: 'Role', mono: true },
                  { key: 'oracleMaintained', label: 'Oracle', format: (v) => (v === 'Y' ? 'yes' : v === 'N' ? 'no' : '—') },
                  { key: 'common', label: 'Common' },
                  { key: 'passwordRequired', label: 'Password' },
                  { key: 'grantees', label: 'Granted to', num: true },
                  { key: 'sysPrivs', label: 'Sys privs', num: true },
                  { key: 'objectPrivs', label: 'Object privs', num: true, format: (v) => fmtNum(v) },
                ]"
                :rows="roles"
                row-key="role"
                max-height="480px"
                empty-text="No application roles."
              />
            </template>
          </AssessmentPanel>
        </template>

        <!-- ================= Tablespaces ================= -->
        <template v-else-if="tab === 'tablespaces'">
          <AssessmentPanel title="Tablespaces" icon="lucide:hard-drive" flush v-bind="bind('tablespaces', 'tablespaces')">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'name', label: 'Tablespace', mono: true },
                  { key: 'contents', label: 'Contents' },
                  { key: 'status', label: 'Status', tone: (v) => validTone(v) },
                  { key: 'usedPct', label: 'Used of max' },
                  { key: 'usedBytes', label: 'Used', num: true, format: (v) => fmtBytes(v) },
                  { key: 'allocatedBytes', label: 'Allocated', num: true, format: (v) => fmtBytes(v) },
                  { key: 'maxBytes', label: 'Max', num: true, format: (v) => fmtBytes(v) },
                  { key: 'autoextend', label: 'Autoext.' },
                  { key: 'files', label: 'Files', num: true },
                  { key: 'segments', label: 'Segments', num: true, format: (v) => fmtNum(v) },
                  { key: 'defaultForUsers', label: 'Default for users', num: true },
                  { key: 'extentManagement', label: 'Extents' },
                  { key: 'segmentSpaceManagement', label: 'ASSM' },
                  { key: 'bigfile', label: 'Bigfile' },
                  { key: 'blockSize', label: 'Block', num: true },
                  { key: 'logging', label: 'Logging' },
                  { key: 'encrypted', label: 'Encrypted' },
                  { key: 'defaultCompression', label: 'Compression' },
                  { key: 'retention', label: 'Retention' },
                ]"
                :rows="data"
                row-key="name"
              >
                <template #cell-usedPct="{ value }"><UiUsageBar :pct="value" /></template>
              </UiDataTable>
            </template>
          </AssessmentPanel>
          <AssessmentPanel title="Datafiles & tempfiles" icon="lucide:files" flush v-bind="bind('tablespaces', 'datafiles')">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'kind', label: 'Kind' },
                  { key: 'fileId', label: 'ID', num: true },
                  { key: 'fileName', label: 'File', mono: true, maxWidth: '460px' },
                  { key: 'tablespace', label: 'Tablespace', mono: true },
                  { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) },
                  { key: 'maxBytes', label: 'Max', num: true, format: (v) => fmtBytes(v) },
                  { key: 'autoextend', label: 'Autoext.' },
                  { key: 'status', label: 'Status', tone: (v) => (v === 'AVAILABLE' || v === 'ONLINE' ? 'ok' : 'warn') },
                ]"
                :rows="data"
                :row-key="(r) => `${r.kind}:${r.fileId}`"
                max-height="420px"
              />
            </template>
          </AssessmentPanel>
        </template>

        <!-- ================= Objects ================= -->
        <template v-else-if="tab === 'objects'">
          <div class="grid two">
            <AssessmentPanel title="Objects by type (top 12)" icon="lucide:shapes" v-bind="bind('objects', 'byType')" :count="() => null">
              <template #default="{ data }">
                <ChartsBars :items="data.slice(0, 12).map((t: any) => ({ label: t.type, value: t.total, sub: `${fmtNum(t.application)} application · ${fmtNum(t.invalid)} invalid` }))" aria-label="Objects by type" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Object types" icon="lucide:list" flush v-bind="bind('objects', 'byType')">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'type', label: 'Type', mono: true },
                    { key: 'total', label: 'Total', num: true, format: (v) => fmtNum(v) },
                    { key: 'application', label: 'Application', num: true, format: (v) => fmtNum(v) },
                    { key: 'oracle', label: 'Oracle', num: true, format: (v) => fmtNum(v) },
                    { key: 'invalid', label: 'Invalid', num: true },
                  ]"
                  :rows="data"
                  row-key="type"
                  max-height="430px"
                />
              </template>
            </AssessmentPanel>
          </div>
          <AssessmentPanel title="Objects by owner" icon="lucide:folder-tree" flush v-bind="bind('objects', 'byOwner')" :count="() => owners.length">
            <template #actions>
              <div class="seg" role="group" aria-label="Owner filter">
                <button :aria-pressed="ownerMode === 'application'" @click="ownerMode = 'application'">Application</button>
                <button :aria-pressed="ownerMode === 'all'" @click="ownerMode = 'all'">All</button>
              </div>
            </template>
            <template #default>
              <UiDataTable
                :columns="[
                  { key: 'owner', label: 'Owner', mono: true },
                  { key: 'objects', label: 'Objects', num: true, format: (v) => fmtNum(v) },
                  { key: 'tables', label: 'Tables', num: true, format: (v) => fmtNum(v) },
                  { key: 'indexes', label: 'Indexes', num: true, format: (v) => fmtNum(v) },
                  { key: 'views', label: 'Views/MVs', num: true, format: (v) => fmtNum(v) },
                  { key: 'sequences', label: 'Sequences', num: true },
                  { key: 'synonyms', label: 'Synonyms', num: true, format: (v) => fmtNum(v) },
                  { key: 'plsql', label: 'PL/SQL & types', num: true, format: (v) => fmtNum(v) },
                  { key: 'lobs', label: 'LOBs', num: true },
                  { key: 'invalid', label: 'Invalid', num: true },
                  { key: 'segmentBytes', label: 'Size', num: true, format: (v) => fmtBytes(v) },
                ]"
                :rows="owners"
                row-key="owner"
                max-height="480px"
                empty-text="No application schemas own objects."
              />
            </template>
          </AssessmentPanel>
          <div class="grid two">
            <AssessmentPanel title="Invalid objects" icon="lucide:circle-x" flush v-bind="bind('objects', 'invalid')" empty-text="No invalid objects.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'owner', label: 'Owner', mono: true },
                    { key: 'name', label: 'Object', mono: true },
                    { key: 'type', label: 'Type' },
                    { key: 'errors', label: 'Errors', num: true },
                    { key: 'lastDdl', label: 'Last DDL', format: (v) => fmtRelative(v) },
                  ]"
                  :rows="data"
                  :row-key="(r) => `${r.owner}.${r.name}.${r.type}`"
                  max-height="380px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Recycle bin" icon="lucide:trash-2" flush v-bind="bind('objects', 'recyclebin')" empty-text="Recycle bin is empty.">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'owner', label: 'Owner', mono: true }, { key: 'objects', label: 'Objects', num: true }, { key: 'bytes', label: 'Space', num: true, format: (v) => fmtBytes(v) }]" :rows="data" row-key="owner" />
              </template>
            </AssessmentPanel>
          </div>
        </template>

        <!-- ================= Schema health ================= -->
        <template v-else-if="tab === 'design'">
          <p class="subtle">Application schemas only (Oracle-maintained schemas are excluded unless noted).</p>
          <AssessmentPanel title="Missing / stale optimizer statistics" icon="lucide:chart-no-axes-column" flush v-bind="bind('design', 'stats')" empty-text="All application tables have fresh statistics.">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'owner', label: 'Owner', mono: true },
                  { key: 'table', label: 'Table', mono: true },
                  { key: 'state', label: 'State', tone: (v) => (v === 'MISSING' ? 'bad' : 'warn') },
                  { key: 'numRows', label: 'Rows (stats)', num: true, format: (v) => fmtNum(v) },
                  { key: 'lastAnalyzed', label: 'Analyzed', format: (v) => (v ? fmtRelative(v) : 'never') },
                  { key: 'locked', label: 'Locked' },
                ]"
                :rows="data"
                :row-key="(r) => `${r.owner}.${r.table}`"
                max-height="400px"
              />
            </template>
          </AssessmentPanel>
          <div class="grid two">
            <AssessmentPanel title="Unindexed foreign keys" icon="lucide:link-2-off" flush v-bind="bind('design', 'fkNoIndex')" empty-text="Every foreign key has a supporting index.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'owner', label: 'Owner', mono: true },
                    { key: 'table', label: 'Child table', mono: true },
                    { key: 'columns', label: 'FK columns', mono: true },
                    { key: 'refTable', label: 'Parent', mono: true },
                    { key: 'constraint', label: 'Constraint', mono: true },
                  ]"
                  :rows="data"
                  :row-key="(r) => `${r.owner}.${r.constraint}`"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Tables without primary key" icon="lucide:key-square" flush v-bind="bind('design', 'noPk')" empty-text="Every application table has a primary key.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[{ key: 'owner', label: 'Owner', mono: true }, { key: 'table', label: 'Table', mono: true }, { key: 'numRows', label: 'Rows (stats)', num: true, format: (v) => fmtNum(v) }, { key: 'partitioned', label: 'Partitioned' }]"
                  :rows="data"
                  :row-key="(r) => `${r.owner}.${r.table}`"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Unusable indexes (all schemas)" icon="lucide:ban" flush v-bind="bind('design', 'unusable')" empty-text="No unusable indexes.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'owner', label: 'Owner', mono: true },
                    { key: 'index', label: 'Index', mono: true },
                    { key: 'table', label: 'Table', mono: true },
                    { key: 'partition', label: 'Partition', mono: true },
                    { key: 'oracleMaintained', label: 'Oracle', format: (v) => (v === 'Y' ? 'yes' : 'no') },
                  ]"
                  :rows="data"
                  :row-key="(r) => `${r.owner}.${r.index}.${r.partition}`"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Disabled constraints & triggers" icon="lucide:toggle-left" flush v-bind="bind('design', 'disabled')" empty-text="Everything enabled and validated.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'owner', label: 'Owner', mono: true },
                    { key: 'table', label: 'Table', mono: true },
                    { key: 'kind', label: 'Kind' },
                    { key: 'name', label: 'Name', mono: true },
                    { key: 'type', label: 'Type' },
                    { key: 'status', label: 'Status', tone: (v) => (v === 'DISABLED' ? 'warn' : '') },
                    { key: 'validated', label: 'Validated' },
                  ]"
                  :rows="data"
                  :row-key="(r) => `${r.owner}.${r.kind}.${r.name}`"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
          </div>
        </template>

        <!-- ================= Physical ================= -->
        <template v-else-if="tab === 'physical'">
          <div class="grid two">
            <AssessmentPanel title="Control files" icon="lucide:file-lock" flush v-bind="bind('physical', 'controlfiles')">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'name', label: 'File', mono: true, maxWidth: '460px' }, { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) }, { key: 'inRecoveryArea', label: 'In FRA' }]" :rows="data" row-key="name" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Block change tracking" icon="lucide:scan-line" v-bind="bind('physical', 'bct')" :is-empty="() => false" :count="() => null">
              <template #default="{ data }">
                <dl class="kv">
                  <dt>Status</dt><dd><span class="badge" :class="data[0]?.status === 'ENABLED' ? 'ok' : ''">{{ data[0]?.status ?? 'DISABLED' }}</span></dd>
                  <dt>File</dt><dd class="mono">{{ data[0]?.file ?? '—' }}</dd>
                  <dt>Size</dt><dd>{{ fmtBytes(data[0]?.bytes) }}</dd>
                </dl>
              </template>
            </AssessmentPanel>
          </div>
          <AssessmentPanel title="Online redo logs" icon="lucide:file-stack" flush v-bind="bind('physical', 'redo')">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'group', label: 'Group', num: true },
                  { key: 'thread', label: 'Thread', num: true },
                  { key: 'sequence', label: 'Sequence', num: true },
                  { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) },
                  { key: 'members', label: 'Members', num: true },
                  { key: 'status', label: 'Status', tone: (v) => (v === 'CURRENT' ? 'info' : '') },
                  { key: 'archived', label: 'Archived' },
                  { key: 'files', label: 'Member files', mono: true, maxWidth: '520px' },
                ]"
                :rows="data"
                row-key="group"
              />
            </template>
          </AssessmentPanel>
          <AssessmentPanel title="Log switches per hour (last 7 days)" icon="lucide:repeat" v-bind="bind('physical', 'switches')" :is-empty="() => false">
            <template #default="{ data }">
              <ChartsLine :series="switchSeries" :height="200" area :y-format="(v) => fmtNum(v, 1)" :x-format="(v) => fmtDate(new Date(v).toISOString())" aria-label="Log switches per hour" />
              <div class="row stats">
                <span>Total <strong>{{ fmtNum(data.total) }}</strong></span>
                <span>Peak/hour <strong>{{ fmtNum(data.peakPerHour) }}</strong></span>
                <span>Average/hour <strong>{{ fmtNum(data.avgPerHour, 2) }}</strong></span>
              </div>
            </template>
          </AssessmentPanel>
          <div class="grid two">
            <AssessmentPanel title="Archive destinations" icon="lucide:archive" flush v-bind="bind('physical', 'archiveDest')" empty-text="No active archive destinations.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'name', label: 'Destination', mono: true },
                    { key: 'status', label: 'Status', tone: (v) => (v === 'VALID' ? 'ok' : v === 'DEFERRED' ? '' : 'bad') },
                    { key: 'target', label: 'Target' },
                    { key: 'destination', label: 'Location', mono: true, maxWidth: '260px' },
                    { key: 'error', label: 'Error', maxWidth: '220px' },
                  ]"
                  :rows="data"
                  row-key="destId"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Fast recovery area" icon="lucide:life-buoy" v-bind="bind('physical', 'fra')" :is-empty="() => false" :count="() => null">
              <template #default="{ data }">
                <p v-if="!data.destinations.length" class="subtle" style="margin: 0">No fast recovery area configured (DB_RECOVERY_FILE_DEST is empty).</p>
                <template v-else>
                  <div v-for="d in data.destinations" :key="d.name" class="stack-sm">
                    <div class="mono">{{ d.name }}</div>
                    <UiUsageBar :pct="d.limitBytes ? ((d.usedBytes - d.reclaimableBytes) / d.limitBytes) * 100 : null" />
                    <div class="subtle">{{ fmtBytes(d.usedBytes) }} used ({{ fmtBytes(d.reclaimableBytes) }} reclaimable) of {{ fmtBytes(d.limitBytes) }} · {{ fmtNum(d.files) }} files</div>
                  </div>
                  <UiDataTable
                    style="margin-top: 10px"
                    :columns="[{ key: 'fileType', label: 'File type' }, { key: 'pctUsed', label: '% used', num: true }, { key: 'pctReclaimable', label: '% reclaimable', num: true }, { key: 'files', label: 'Files', num: true }]"
                    :rows="data.usage"
                    row-key="fileType"
                  />
                </template>
              </template>
            </AssessmentPanel>
          </div>
        </template>

        <!-- ================= Memory & instance ================= -->
        <template v-else-if="tab === 'instance'">
          <div class="grid two">
            <AssessmentPanel title="SGA components (current size)" icon="lucide:memory-stick" v-bind="bind('instance', 'sgaComponents')">
              <template #default="{ data }">
                <ChartsBars :items="data.map((c: any) => ({ label: c.component, value: c.currentBytes, sub: `min ${fmtBytes(c.minBytes)} · max ${fmtBytes(c.maxBytes)} · ${c.resizeOps} resizes` }))" :format="(v) => fmtBytes(v)" aria-label="SGA components" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="SGA (V$SGAINFO)" icon="lucide:cpu" flush v-bind="bind('instance', 'sga')">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'name', label: 'Area' }, { key: 'bytes', label: 'Size', num: true, format: (v) => fmtBytes(v) }, { key: 'resizeable', label: 'Resizeable' }]" :rows="data" row-key="name" max-height="360px" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="PGA statistics" icon="lucide:layers" flush v-bind="bind('instance', 'pga')">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'name', label: 'Statistic' }, { key: 'value', label: 'Value', num: true, format: (v, r) => pgaFormat(v, r) }, { key: 'unit', label: 'Unit' }]" :rows="data" row-key="name" max-height="360px" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Resource limits" icon="lucide:gauge" flush v-bind="bind('instance', 'resourceLimits')" empty-text="No rows in this container — connect to CDB$ROOT for instance limits.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[{ key: 'resource', label: 'Resource', mono: true }, { key: 'current', label: 'Current', num: true }, { key: 'max', label: 'Peak', num: true }, { key: 'initial', label: 'Initial', num: true }, { key: 'limit', label: 'Limit', num: true }]"
                  :rows="data"
                  row-key="resource"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
          </div>
          <AssessmentPanel title="Pluggable databases" icon="lucide:container" flush v-bind="bind('instance', 'pdbs')">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'conId', label: 'CON_ID', num: true },
                  { key: 'name', label: 'PDB', mono: true },
                  { key: 'openMode', label: 'Open mode', tone: (v) => (v === 'READ WRITE' ? 'ok' : 'info') },
                  { key: 'restricted', label: 'Restricted' },
                  { key: 'totalBytes', label: 'Size', num: true, format: (v) => fmtBytes(v) },
                  { key: 'openTime', label: 'Opened', format: (v) => fmtDate(v) },
                ]"
                :rows="data"
                row-key="conId"
              />
            </template>
          </AssessmentPanel>
          <div class="grid two">
            <AssessmentPanel title="NLS database parameters" icon="lucide:languages" flush v-bind="bind('instance', 'nls')">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'parameter', label: 'Parameter', mono: true }, { key: 'value', label: 'Value', mono: true }]" :rows="data" row-key="parameter" max-height="420px" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Database properties" icon="lucide:settings-2" flush v-bind="bind('instance', 'properties')">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'property', label: 'Property', mono: true }, { key: 'value', label: 'Value', mono: true, maxWidth: '240px' }, { key: 'description', label: 'Description', maxWidth: '300px' }]" :rows="data" row-key="property" max-height="420px" />
              </template>
            </AssessmentPanel>
          </div>
        </template>

        <!-- ================= Components ================= -->
        <template v-else-if="tab === 'components'">
          <AssessmentPanel title="Installed components (DBA_REGISTRY)" icon="lucide:puzzle" flush v-bind="bind('components', 'registry')">
            <template #default="{ data }">
              <UiDataTable
                :columns="[
                  { key: 'id', label: 'ID', mono: true },
                  { key: 'name', label: 'Component' },
                  { key: 'version', label: 'Version', mono: true },
                  { key: 'status', label: 'Status', tone: (v) => validTone(v) },
                  { key: 'schema', label: 'Schema', mono: true },
                  { key: 'modified', label: 'Modified' },
                ]"
                :rows="data"
                row-key="id"
              />
            </template>
          </AssessmentPanel>
          <div class="grid two">
            <AssessmentPanel title="Patches" icon="lucide:bandage" flush v-bind="bind('components', 'patches')" empty-text="No patches recorded.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'patchId', label: 'Patch', mono: true },
                    { key: 'action', label: 'Action' },
                    { key: 'status', label: 'Status', tone: (v) => validTone(v) },
                    { key: 'actionTime', label: 'Applied', format: (v) => fmtDate(v) },
                    { key: 'description', label: 'Description', maxWidth: '320px' },
                  ]"
                  :rows="data"
                  :row-key="(r) => `${r.patchId}:${r.actionTime}`"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Automated maintenance tasks" icon="lucide:calendar-cog" flush v-bind="bind('components', 'autotask')">
              <template #default="{ data }">
                <UiDataTable :columns="[{ key: 'client', label: 'Task' }, { key: 'status', label: 'Status', tone: (v) => (v === 'ENABLED' ? 'ok' : 'warn') }]" :rows="data" row-key="client" />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Application scheduler jobs" icon="lucide:clock" flush v-bind="bind('components', 'jobs')" empty-text="No scheduler jobs in application schemas.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'owner', label: 'Owner', mono: true },
                    { key: 'job', label: 'Job', mono: true },
                    { key: 'enabled', label: 'Enabled' },
                    { key: 'state', label: 'State' },
                    { key: 'lastStart', label: 'Last run', format: (v) => fmtRelative(v) },
                    { key: 'nextRun', label: 'Next run', format: (v) => fmtDate(v) },
                    { key: 'failures', label: 'Failures', num: true },
                  ]"
                  :rows="data"
                  :row-key="(r) => `${r.owner}.${r.job}`"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Failed scheduler runs (7 days)" icon="lucide:calendar-x" flush v-bind="bind('components', 'failedRuns')" empty-text="No failed runs in the last 7 days.">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'start', label: 'Started', format: (v) => fmtDate(v) },
                    { key: 'owner', label: 'Owner', mono: true },
                    { key: 'job', label: 'Job', mono: true },
                    { key: 'status', label: 'Status', tone: () => 'bad' },
                    { key: 'error', label: 'ORA-', num: true },
                    { key: 'info', label: 'Info', maxWidth: '260px' },
                  ]"
                  :rows="data"
                  :row-key="(r) => `${r.owner}.${r.job}.${r.start}`"
                  max-height="360px"
                />
              </template>
            </AssessmentPanel>
          </div>
          <div class="grid two">
            <AssessmentPanel title="Feature usage" icon="lucide:sparkles" flush v-bind="bind('components', 'features')" empty-text="No feature usage recorded in this container yet (sampled about weekly).">
              <template #default="{ data }">
                <UiDataTable
                  :columns="[
                    { key: 'feature', label: 'Feature' },
                    { key: 'detectedUsages', label: 'Usages', num: true },
                    { key: 'currentlyUsed', label: 'In use', tone: (v) => (v === 'TRUE' ? 'info' : '') },
                    { key: 'lastUsed', label: 'Last used', format: (v) => fmtDate(v, false) },
                  ]"
                  :rows="data"
                  row-key="feature"
                  max-height="420px"
                />
              </template>
            </AssessmentPanel>
            <AssessmentPanel title="Options (V$OPTION)" icon="lucide:toggle-right" flush v-bind="bind('components', 'options')" :count="() => options.length">
              <template #actions>
                <div class="seg" role="group" aria-label="Option filter">
                  <button :aria-pressed="optionMode === 'enabled'" @click="optionMode = 'enabled'">Enabled</button>
                  <button :aria-pressed="optionMode === 'all'" @click="optionMode = 'all'">All</button>
                </div>
              </template>
              <template #default>
                <UiDataTable :columns="[{ key: 'option', label: 'Option' }, { key: 'enabled', label: 'Enabled', tone: (v) => (v === 'TRUE' ? 'ok' : '') }]" :rows="options" row-key="option" max-height="420px" />
              </template>
            </AssessmentPanel>
          </div>
        </template>

        <!-- ================= History & compare ================= -->
        <template v-else-if="tab === 'history'">
          <UiCard title="Snapshots" icon="lucide:history" flush>
            <template #actions>
              <div class="seg" role="group" aria-label="Snapshot scope">
                <button :aria-pressed="historyScope === 'profile'" @click="historyScope = 'profile'">This connection</button>
                <button :aria-pressed="historyScope === 'all'" @click="historyScope = 'all'">All connections</button>
              </div>
              <input v-model="snapLabel" class="input snap-label" maxlength="120" placeholder="Label, e.g. before patch" @keydown.enter="saveSnapshot" >
              <button class="btn sm primary" :disabled="snapping || !activeId" @click="saveSnapshot">
                <Icon :name="snapping ? 'lucide:loader-circle' : 'lucide:camera'" :class="{ rot: snapping }" size="13" /> {{ snapping ? 'Collecting all sections…' : 'Save snapshot' }}
              </button>
            </template>
            <p class="subtle pad">
              A snapshot stores the whole assessment. Tick two snapshots — of this database over time, or of two different databases — and compare them.
            </p>
            <UiDataTable
              :columns="[
                { key: 'pick', label: '', sortable: false },
                { key: 'createdAt', label: 'Taken', format: (v) => fmtDate(v) },
                { key: 'label', label: 'Label', format: (v) => v || '—' },
                { key: 'profileName', label: 'Connection' },
                { key: 'dbName', label: 'Database', mono: true, format: (v, r) => `${v ?? '—'}${r.container && r.container !== v ? ` / ${r.container}` : ''}` },
                { key: 'version', label: 'Version', mono: true },
                { key: 'summary', label: 'Issues', sortable: false },
                { key: 'size', label: 'Size', num: true, format: (_, r) => fmtBytes(r.summary.dbSizeBytes) },
                { key: 'objects', label: 'Objects', num: true, format: (_, r) => fmtNum(r.summary.objects) },
                { key: 'act', label: '', sortable: false },
              ]"
              :rows="snapshots.data.value ?? []"
              row-key="id"
              max-height="420px"
              empty-text="No snapshots yet — save one to start the history."
            >
              <template #cell-pick="{ row }">
                <input type="checkbox" :checked="picked.includes(row.id)" :aria-label="`Select snapshot ${row.label || row.createdAt}`" @change="togglePick(row.id)" >
              </template>
              <template #cell-summary="{ row }">
                <span class="row tight">
                  <span class="badge" :class="row.summary.critical ? 'bad' : 'ok'">{{ row.summary.critical }} critical</span>
                  <span class="badge" :class="row.summary.warning ? 'warn' : 'ok'">{{ row.summary.warning }} warning</span>
                </span>
              </template>
              <template #cell-act="{ row }">
                <span class="row tight">
                  <a class="btn sm ghost" :href="`/api/assessment/snapshots/${row.id}/report`" download title="HTML report of this snapshot"><Icon name="lucide:file-down" size="13" /></a>
                  <button class="btn sm ghost" aria-label="Delete snapshot" @click="deletingSnap = row"><Icon name="lucide:trash-2" size="13" /></button>
                </span>
              </template>
            </UiDataTable>
            <div class="row pad">
              <button class="btn primary" :disabled="!pair || comparing" @click="compare">
                <Icon :name="comparing ? 'lucide:loader-circle' : 'lucide:git-compare'" :class="{ rot: comparing }" size="15" /> Compare
              </button>
              <span v-if="pair" class="subtle">
                A = {{ pair.a.dbName }} · {{ fmtDate(pair.a.createdAt) }}{{ pair.a.label ? ` (${pair.a.label})` : '' }} → B = {{ pair.b.dbName }} · {{ fmtDate(pair.b.createdAt) }}{{ pair.b.label ? ` (${pair.b.label})` : '' }}
              </span>
              <span v-else class="subtle">Select two snapshots (the older one becomes A).</span>
            </div>
          </UiCard>

          <div v-if="trend.length >= 2" class="grid three">
            <UiCard title="Issues over time" icon="lucide:triangle-alert">
              <ChartsLine :series="trendIssues" :height="150" :x-format="(v) => fmtDate(new Date(v).toISOString(), false)" :y-format="(v) => fmtNum(v)" />
            </UiCard>
            <UiCard title="Database size" icon="lucide:database">
              <ChartsLine :series="trendSize" :height="150" area :x-format="(v) => fmtDate(new Date(v).toISOString(), false)" :y-format="(v) => fmtBytes(v, 1)" />
            </UiCard>
            <UiCard title="Invalid objects" icon="lucide:circle-x">
              <ChartsLine :series="trendInvalid" :height="150" :x-format="(v) => fmtDate(new Date(v).toISOString(), false)" :y-format="(v) => fmtNum(v, 1)" />
            </UiCard>
          </div>

          <template v-if="diff">
            <div class="row between">
              <h3 class="cmp-title">Comparison · {{ diff.a.dbName }} ({{ fmtDate(diff.a.createdAt) }}) → {{ diff.b.dbName }} ({{ fmtDate(diff.b.createdAt) }})</h3>
              <a class="btn" :href="`/api/assessment/compare?a=${diff.a.id}&b=${diff.b.id}&format=html`" download><Icon name="lucide:file-down" size="14" /> HTML report</a>
            </div>
            <AssessmentCompare :diff="diff" />
          </template>
        </template>
      </div>
    </UiRequireProfile>

    <UiConfirm :model-value="!!deletingSnap" title="Delete snapshot" confirm-label="Delete snapshot" danger @update:model-value="(v) => !v && (deletingSnap = null)" @confirm="deleteSnapshot">
      <p>Delete the snapshot of <strong>{{ deletingSnap?.dbName ?? deletingSnap?.profileName }}</strong> taken {{ fmtDate(deletingSnap?.createdAt ?? null) }}{{ deletingSnap?.label ? ` (${deletingSnap.label})` : '' }}? The database is not touched.</p>
    </UiConfirm>
  </div>
</template>

<style scoped>
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 12.5px;
}
dt {
  color: var(--text-3);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.search {
  width: 220px;
  height: 30px;
}
.pad {
  margin: 0;
  padding: 8px 14px;
}
.sev-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 10px;
}
.sev-stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.sev-stat .badge {
  align-self: flex-start;
}
.sev-stat .badge::before,
.sev-stat :deep(.badge)::before {
  display: none;
}
.sev-stat strong {
  font-size: 20px;
}
.stats {
  gap: 18px;
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}
.stack-sm {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.spin {
  width: 13px;
  height: 13px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.rot {
  animation: spin 0.8s linear infinite;
}
.tight {
  gap: 4px;
  flex-wrap: nowrap;
}
.snap-label {
  width: 220px;
  height: 26px;
  font-size: 12px;
}
.cmp-title {
  margin: 6px 0 0;
  font-size: 15px;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 600px) {
  .sev-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .search {
    width: 100%;
  }
}
</style>

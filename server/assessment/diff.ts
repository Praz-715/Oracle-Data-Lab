import type {
  AssessmentDiff,
  AssessmentFinding,
  AssessmentSection,
  AssessmentSeverity,
  AssessmentSnapshotMeta,
  FieldChange,
  FindingChange,
  PanelDiff,
} from '../../shared/types/lab'

// Snapshot comparison. Each panel is diffed as a keyed row set: rows only in B are "added", only in A
// "removed", and rows in both are compared on configuration fields ("changed") and, separately, on
// numeric fields that drift naturally (sizes, counts — "numeric"). Pure functions, no I/O.

type Row = Record<string, unknown>
type Data = Record<string, AssessmentSection>

interface Spec {
  section: string
  panel: string
  title: string
  /** Extracts the row list from the panel data (default: the data itself). */
  rows?: (data: any) => Row[]
  key: (r: Row) => string
  /** Configuration fields; a function receives both row sets (dynamic columns). */
  fields?: string[] | ((a: Row[], b: Row[]) => string[])
  numeric?: string[]
  /** Only rows matching on either side are compared (e.g. non-default parameters). */
  filter?: (r: Row) => boolean
}

const k = (...parts: unknown[]) => parts.map((p) => String(p ?? '')).join('.')

export const DIFF_SPECS: Spec[] = [
  { section: 'parameters', panel: 'parameters', title: 'Initialization parameters (non-default on either side)', key: (r) => k(r.name), fields: ['value', 'isDefault'], filter: (r) => r.isDefault === 'FALSE' },
  { section: 'spfile', panel: 'effective', title: 'Effective non-default parameters (init.ora)', rows: (d) => d.entries, key: (r) => k(r.name, r.ordinal), fields: ['value'] },
  { section: 'spfile', panel: 'entries', title: 'SPFILE entries', rows: (d) => d.entries, key: (r) => k(r.sid, r.name, r.ordinal), fields: ['value'] },
  { section: 'users', panel: 'users', title: 'Users', key: (r) => k(r.username), fields: ['status', 'profile', 'defaultTablespace', 'temporaryTablespace', 'authentication', 'hasDba'], numeric: ['objects', 'segmentBytes'] },
  { section: 'users', panel: 'quotas', title: 'Tablespace quotas', key: (r) => k(r.username, r.tablespace), fields: ['quota', 'maxBytes'], numeric: ['usedBytes'] },
  {
    section: 'profiles',
    panel: 'profiles',
    title: 'Profile limits',
    rows: (d) => d.limits,
    key: (r) => k(r.resource),
    fields: (a, b) => [...new Set([...a, ...b].flatMap((r) => Object.keys(r)))].filter((f) => f !== 'resource' && f !== 'type'),
  },
  { section: 'security', panel: 'powerful', title: 'Powerful grants to application accounts', key: (r) => k(r.grantee, r.kind, r.privilege), fields: ['adminOption'] },
  { section: 'security', panel: 'defaultPasswords', title: 'Accounts with default passwords', key: (r) => k(r.username), fields: ['status'] },
  { section: 'security', panel: 'publicGrants', title: 'PUBLIC execute on sensitive packages', key: (r) => k(r.object, r.privilege) },
  { section: 'security', panel: 'pwfile', title: 'Password file users', key: (r) => k(r.username), fields: ['sysdba', 'sysoper', 'sysbackup', 'sysdg', 'syskm'] },
  { section: 'security', panel: 'dbLinks', title: 'Database links', key: (r) => k(r.owner, r.dbLink), fields: ['username', 'host'] },
  { section: 'security', panel: 'directories', title: 'Directory objects', key: (r) => k(r.directory), fields: ['path'] },
  { section: 'security', panel: 'roles', title: 'Roles', key: (r) => k(r.role), fields: ['passwordRequired'] },
  {
    section: 'security',
    panel: 'auditing',
    title: 'Unified audit policies enabled',
    rows: (d) => d.enabledPolicies ?? [],
    key: (r) => Object.values(r).map((v) => String(v ?? '')).join('|'),
  },
  {
    section: 'tablespaces',
    panel: 'tablespaces',
    title: 'Tablespaces',
    key: (r) => k(r.name),
    fields: ['contents', 'status', 'bigfile', 'extentManagement', 'segmentSpaceManagement', 'logging', 'forceLogging', 'encrypted', 'autoextend', 'defaultCompression', 'retention'],
    numeric: ['allocatedBytes', 'usedBytes', 'maxBytes', 'files'],
  },
  { section: 'tablespaces', panel: 'datafiles', title: 'Datafiles & tempfiles', key: (r) => k(r.fileName), fields: ['tablespace', 'autoextend', 'status'], numeric: ['bytes', 'maxBytes'] },
  { section: 'objects', panel: 'byType', title: 'Objects by type', key: (r) => k(r.type), numeric: ['total', 'application', 'invalid'] },
  { section: 'objects', panel: 'byOwner', title: 'Objects by owner', key: (r) => k(r.owner), numeric: ['objects', 'tables', 'indexes', 'views', 'plsql', 'invalid', 'segmentBytes'] },
  { section: 'objects', panel: 'invalid', title: 'Invalid objects', key: (r) => k(r.owner, r.name, r.type) },
  { section: 'design', panel: 'stats', title: 'Missing / stale statistics', key: (r) => k(r.owner, r.table), fields: ['state'] },
  { section: 'design', panel: 'fkNoIndex', title: 'Unindexed foreign keys', key: (r) => k(r.owner, r.constraint) },
  { section: 'design', panel: 'noPk', title: 'Tables without primary key', key: (r) => k(r.owner, r.table) },
  { section: 'design', panel: 'unusable', title: 'Unusable indexes', key: (r) => k(r.owner, r.index, r.partition) },
  { section: 'design', panel: 'disabled', title: 'Disabled constraints & triggers', key: (r) => k(r.owner, r.kind, r.name), fields: ['status', 'validated'] },
  { section: 'physical', panel: 'controlfiles', title: 'Control files', key: (r) => k(r.name) },
  { section: 'physical', panel: 'redo', title: 'Online redo log groups', key: (r) => k(r.thread, r.group), fields: ['bytes', 'members'] },
  { section: 'physical', panel: 'archiveDest', title: 'Archive destinations', key: (r) => k(r.name), fields: ['status', 'target', 'destination'] },
  { section: 'instance', panel: 'sgaComponents', title: 'SGA components', key: (r) => k(r.component), numeric: ['currentBytes'] },
  { section: 'instance', panel: 'pdbs', title: 'Pluggable databases', key: (r) => k(r.name), fields: ['openMode', 'restricted'], numeric: ['totalBytes'] },
  { section: 'instance', panel: 'nls', title: 'NLS database parameters', key: (r) => k(r.parameter), fields: ['value'] },
  { section: 'instance', panel: 'properties', title: 'Database properties', key: (r) => k(r.property), fields: ['value'] },
  { section: 'components', panel: 'registry', title: 'Installed components', key: (r) => k(r.id), fields: ['version', 'status'] },
  { section: 'components', panel: 'patches', title: 'Patches', key: (r) => k(r.patchId, r.action, r.actionTime), fields: ['status'] },
  { section: 'components', panel: 'options', title: 'Options (V$OPTION)', key: (r) => k(r.option), fields: ['enabled'] },
  { section: 'components', panel: 'autotask', title: 'Automated maintenance tasks', key: (r) => k(r.client), fields: ['status'] },
  { section: 'components', panel: 'jobs', title: 'Application scheduler jobs', key: (r) => k(r.owner, r.job), fields: ['enabled', 'state', 'repeatInterval'] },
]

const IDENTITY_FIELDS = ['banner', 'version', 'platform', 'cdb', 'container', 'databaseRole', 'openMode', 'logMode', 'forceLogging', 'flashbackOn', 'supplementalLogging', 'protectionMode', 'characterSet', 'nationalCharacterSet', 'hostName', 'instanceName']

/** Equality that treats null / undefined / '' alike. */
function same(a: unknown, b: unknown) {
  const n = (v: unknown) => (v === undefined || v === '' ? null : v)
  return n(a) === n(b)
}

function significant(field: string, a: number, b: number) {
  const d = b - a
  if (d === 0) return false
  // Sizes drift constantly: report them from 1% change; counts on any change.
  return /bytes/i.test(field) ? Math.abs(d) / Math.max(1, Math.abs(a)) >= 0.01 : true
}

export function diffRows(aRows: Row[], bRows: Row[], spec: Pick<Spec, 'key' | 'fields' | 'numeric' | 'filter'>) {
  const am = new Map(aRows.map((r) => [spec.key(r), r]))
  const bm = new Map(bRows.map((r) => [spec.key(r), r]))
  let keys = [...new Set([...am.keys(), ...bm.keys()])].sort()
  if (spec.filter) keys = keys.filter((x) => (am.has(x) && spec.filter!(am.get(x)!)) || (bm.has(x) && spec.filter!(bm.get(x)!)))
  const fields = typeof spec.fields === 'function' ? spec.fields(aRows, bRows) : (spec.fields ?? [])
  const out = { added: [] as PanelDiff['added'], removed: [] as PanelDiff['removed'], changed: [] as PanelDiff['changed'], numeric: [] as PanelDiff['numeric'], unchanged: 0 }
  for (const key of keys) {
    const a = am.get(key)
    const b = bm.get(key)
    if (!a) {
      out.added.push({ key, row: b! })
      continue
    }
    if (!b) {
      out.removed.push({ key, row: a })
      continue
    }
    const changes: FieldChange[] = fields.filter((f) => !same(a[f], b[f])).map((f) => ({ field: f, a: a[f] ?? null, b: b[f] ?? null }))
    if (changes.length) out.changed.push({ key, changes })
    let drift = false
    for (const f of spec.numeric ?? []) {
      const x = a[f] == null ? null : Number(a[f])
      const y = b[f] == null ? null : Number(b[f])
      if (x == null || y == null ? x !== y : significant(f, x, y)) {
        out.numeric.push({ key, field: f, a: x, b: y, delta: x != null && y != null ? y - x : null })
        drift = true
      }
    }
    if (!changes.length && !drift) out.unchanged++
  }
  return out
}

const RANK: Record<AssessmentSeverity, number> = { critical: 0, warning: 1, info: 2, ok: 3, na: 4 }
const isIssue = (s: AssessmentSeverity | null | undefined) => s === 'critical' || s === 'warning' || s === 'info'

export function diffFindings(a: AssessmentFinding[], b: AssessmentFinding[]): AssessmentDiff['findings'] {
  const am = new Map(a.map((f) => [f.id, f]))
  const bm = new Map(b.map((f) => [f.id, f]))
  const out: AssessmentDiff['findings'] = { appeared: [], resolved: [], worse: [], better: [], stillOpen: [] }
  for (const id of new Set([...am.keys(), ...bm.keys()])) {
    const x = am.get(id)
    const y = bm.get(id)
    const c: FindingChange = { id, title: (y ?? x)!.title, category: (y ?? x)!.category, a: x?.severity ?? null, b: y?.severity ?? null, detailA: x?.detail ?? null, detailB: y?.detail ?? null }
    if (isIssue(c.b) && !isIssue(c.a)) out.appeared.push(c)
    else if (isIssue(c.a) && c.b === 'ok') out.resolved.push(c)
    else if (isIssue(c.a) && isIssue(c.b)) {
      if (RANK[c.b!] < RANK[c.a!]) out.worse.push(c)
      else if (RANK[c.b!] > RANK[c.a!]) out.better.push(c)
      else out.stillOpen.push(c)
    }
  }
  const order = (x: FindingChange) => RANK[(x.b ?? x.a)!]
  for (const list of Object.values(out)) list.sort((p, q) => order(p) - order(q))
  return out
}

function okData<T = any>(d: Data, section: string, panel: string): T | null {
  const p = d[section]?.[panel]
  return p?.status === 'ok' ? (p.data as T) : null
}

export function diffAssessments(aData: Data, bData: Data, a: AssessmentSnapshotMeta, b: AssessmentSnapshotMeta): AssessmentDiff {
  const ia = okData<Row>(aData, 'summary', 'identity') ?? {}
  const ib = okData<Row>(bData, 'summary', 'identity') ?? {}
  const identity = IDENTITY_FIELDS.filter((f) => !same(ia[f], ib[f])).map((f) => ({ field: f, a: ia[f] ?? null, b: ib[f] ?? null }))

  const ca = okData<Row>(aData, 'summary', 'counts') ?? {}
  const cb = okData<Row>(bData, 'summary', 'counts') ?? {}
  const counts = [...new Set([...Object.keys(ca), ...Object.keys(cb)])]
    .filter((key) => key !== 'gaps')
    .map((key) => {
      const x = ca[key] == null ? null : Number(ca[key])
      const y = cb[key] == null ? null : Number(cb[key])
      return { key, a: x, b: y, delta: x != null && y != null ? y - x : null }
    })
    .filter((c) => c.a !== c.b)

  const findings = diffFindings(okData<AssessmentFinding[]>(aData, 'findings', 'findings') ?? [], okData<AssessmentFinding[]>(bData, 'findings', 'findings') ?? [])

  const panels: PanelDiff[] = DIFF_SPECS.map((s) => {
    const pa = aData[s.section]?.[s.panel]
    const pb = bData[s.section]?.[s.panel]
    if (pa?.status !== 'ok' || pb?.status !== 'ok') {
      const why = [pa?.status !== 'ok' ? `A: ${pa?.status === 'unavailable' ? pa.reason : 'not captured'}` : null, pb?.status !== 'ok' ? `B: ${pb?.status === 'unavailable' ? pb.reason : 'not captured'}` : null].filter(Boolean).join(' · ')
      return { section: s.section, panel: s.panel, title: s.title, status: 'unavailable', note: why, added: [], removed: [], changed: [], numeric: [], unchanged: 0 }
    }
    const rowsA = ((s.rows ? s.rows(pa.data) : pa.data) ?? []) as Row[]
    const rowsB = ((s.rows ? s.rows(pb.data) : pb.data) ?? []) as Row[]
    return { section: s.section, panel: s.panel, title: s.title, status: 'ok', note: null, ...diffRows(rowsA, rowsB, s) }
  })

  const totals = panels.reduce((t, p) => ({ added: t.added + p.added.length, removed: t.removed + p.removed.length, changed: t.changed + p.changed.length }), { added: 0, removed: 0, changed: 0 })
  return { a, b, identity, counts, findings, panels, totals }
}

/** List/trend summary of a full assessment. */
export function snapshotSummary(d: Data): Omit<AssessmentSnapshotMeta, 'id' | 'profileId' | 'profileName' | 'label' | 'createdAt'> {
  const id = okData<Row>(d, 'summary', 'identity') ?? {}
  const c = okData<Row>(d, 'summary', 'counts') ?? {}
  const f = okData<AssessmentFinding[]>(d, 'findings', 'findings') ?? []
  const n = (v: unknown) => (v == null ? null : Number(v))
  const count = (s: AssessmentSeverity) => f.filter((x) => x.severity === s).length
  return {
    dbName: (id.dbName as string) ?? null,
    container: (id.container as string) ?? null,
    version: (id.version as string) ?? null,
    host: (id.hostName as string) ?? null,
    summary: {
      dbSizeBytes: c.datafileBytes == null && c.tempfileBytes == null ? null : (n(c.datafileBytes) ?? 0) + (n(c.tempfileBytes) ?? 0),
      segmentBytes: n(c.segmentBytes),
      objects: n(c.objects),
      invalid: n(c.objectsInvalid),
      users: n(c.users),
      parametersNonDefault: n(c.parametersNonDefault),
      critical: count('critical'),
      warning: count('warning'),
      info: count('info'),
      ok: count('ok'),
    },
  }
}

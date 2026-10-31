import type { AssessmentFinding, AssessmentSection, AssessmentSeverity, Panel } from '../../shared/types/lab'
import type { AssessmentSectionId } from './assessment'
import { SECTION_TITLES } from './assessment'
import { DASH, bytes, card, esc, htmlDocument, kpi, kv, lineChart, num, table } from './report-html'

// Standalone HTML report of a full database assessment. Summary and health checks get a
// dedicated layout; every other panel is rendered generically (arrays -> tables, scalars -> key/value).

const PANEL_TITLES: Record<string, string> = {
  identity: 'Database identity',
  counts: 'Inventory counts',
  parameters: 'All initialization parameters (V$PARAMETER)',
  source: 'Parameter file in use',
  entries: 'SPFILE entries (V$SPPARAMETER)',
  effective: 'Effective non-default parameters (init.ora syntax)',
  users: 'Users',
  quotas: 'Tablespace quotas',
  profiles: 'Profiles and limits',
  roles: 'Roles',
  powerful: 'Powerful grants to application accounts',
  pwfile: 'Password file users',
  defaultPasswords: 'Accounts with default passwords',
  publicGrants: 'PUBLIC execute on sensitive packages',
  dbLinks: 'Database links',
  directories: 'Directory objects',
  auditing: 'Auditing',
  tablespaces: 'Tablespaces',
  datafiles: 'Datafiles & tempfiles',
  byType: 'Objects by type',
  byOwner: 'Objects by owner',
  invalid: 'Invalid objects',
  recyclebin: 'Recycle bin',
  stats: 'Missing / stale optimizer statistics',
  fkNoIndex: 'Unindexed foreign keys',
  noPk: 'Tables without primary key',
  unusable: 'Unusable indexes',
  disabled: 'Disabled constraints & triggers',
  controlfiles: 'Control files',
  redo: 'Online redo logs',
  switches: 'Log switches per hour (7 days)',
  archiveDest: 'Archive destinations',
  fra: 'Fast recovery area',
  bct: 'Block change tracking',
  sga: 'SGA (V$SGAINFO)',
  sgaComponents: 'SGA dynamic components',
  pga: 'PGA statistics',
  resourceLimits: 'Resource limits',
  pdbs: 'Pluggable databases',
  nls: 'NLS database parameters',
  properties: 'Database properties',
  registry: 'Installed components',
  patches: 'Patches',
  options: 'Options (V$OPTION)',
  features: 'Feature usage',
  autotask: 'Automated maintenance tasks',
  jobs: 'Application scheduler jobs',
  failedRuns: 'Failed scheduler runs (7 days)',
}

const SEVERITY_LABEL: Record<AssessmentSeverity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info', ok: 'OK', na: 'n/a' }
const SEVERITY_CLASS: Record<AssessmentSeverity, string> = { critical: 'bad', warning: 'warn', info: 'info', ok: '', na: 'na' }

function humanize(k: string) {
  const s = k
    .replace(/Pct$/, ' %')
    .replace(/Bytes$/, ' size')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function cell(k: string, v: unknown): string {
  if (v == null || v === '') return DASH
  if (typeof v === 'number') return /bytes$/i.test(k) ? bytes(v) : num(v, 2)
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return v.replace('T', ' ')
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function genericTable(list: Record<string, unknown>[], empty = 'No rows.'): string {
  if (!list.length) return `<p class="muted pad">${esc(empty)}</p>`
  const keys = Object.keys(list[0]!)
  const numeric = keys.map((k, i) => (list.some((r) => typeof r[k] === 'number') ? i : -1)).filter((i) => i >= 0)
  return table(keys.map(humanize), list.map((r) => keys.map((k) => cell(k, r[k]))), numeric, empty)
}

function genericObject(o: Record<string, unknown>): string {
  const scalars: [string, string][] = []
  const blocks: string[] = []
  for (const [k, v] of Object.entries(o)) {
    if (k === 'pfileText') blocks.push(`<div class="card-body"><pre>${esc(v || '(empty)')}</pre></div>`)
    else if (Array.isArray(v) && v.length && typeof v[0] === 'object') blocks.push(`<div class="note"><strong>${esc(humanize(k))}</strong></div>${genericTable(v as Record<string, unknown>[])}`)
    else if (Array.isArray(v) && !v.length) scalars.push([humanize(k), 'none'])
    else scalars.push([humanize(k), cell(k, v)])
  }
  return `${scalars.length ? `<div class="card-body">${kv(scalars)}</div>` : ''}${blocks.join('')}`
}

function panelBody(name: string, p: Panel<any>): string {
  if (p.status !== 'ok') return `<div class="unavailable"><strong>Unavailable</strong>${p.code ? ` <span class="mono">${esc(p.code)}</span>` : ''} — ${esc(p.reason)}${p.requires ? `<br><span class="muted">Requires: ${esc(p.requires)}</span>` : ''}</div>`
  const d = p.data
  let body: string
  if (name === 'switches' && d?.series) {
    body = `<div class="card-body grid two"><div>${lineChart({
      name: 'log switches',
      color: 'var(--chart-1)',
      area: true,
      points: d.series.map((s: { hour: string; switches: number }) => ({ x: Date.parse(s.hour), y: s.switches })),
      yFormat: (v) => num(v, 1),
      xFormat: (v) => new Date(v).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    })}</div><div>${kv([['Total', num(d.total)], ['Peak per hour', num(d.peakPerHour)], ['Average per hour', num(d.avgPerHour, 2)]])}</div></div>`
  } else if (name === 'effective' || name === 'entries') {
    // Parameter-file views: the init.ora text first, the row list below it.
    body = `<div class="card-body"><pre>${esc(d.pfileText || '(no entries)')}</pre></div>${genericTable(d.entries)}`
  } else if (Array.isArray(d)) body = genericTable(d)
  else if (d && typeof d === 'object') body = genericObject(d)
  else body = `<div class="card-body">${esc(cell(name, d))}</div>`
  return `${body}${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}`
}

function findingsBlock(list: AssessmentFinding[]): string {
  const count = (s: AssessmentSeverity) => list.filter((f) => f.severity === s).length
  const kpis = `<div class="grid kpis">
    ${kpi('Critical', String(count('critical')), 'needs action now', count('critical') ? 'bad' : 'ok')}
    ${kpi('Warning', String(count('warning')), 'should be fixed', count('warning') ? 'warn' : 'ok')}
    ${kpi('Info', String(count('info')), 'worth knowing', 'info')}
    ${kpi('Passed', String(count('ok')), `of ${list.length} checks · ${count('na')} n/a`, 'ok')}
  </div>`
  const rows = list
    .map(
      (f) => `<tr>
        <td><span class="badge ${SEVERITY_CLASS[f.severity]}">${SEVERITY_LABEL[f.severity]}</span></td>
        <td>${esc(f.category)}</td>
        <td><strong>${esc(f.title)}</strong><br>${esc(f.detail)}${f.recommendation ? `<br><span class="muted">→ ${esc(f.recommendation)}</span>` : ''}</td>
        <td class="mono">${f.items?.length ? f.items.map(esc).join('<br>') : DASH}</td>
      </tr>`,
    )
    .join('')
  return `${kpis}<section class="card"><div class="card-head"><h2>Health checks</h2></div><div class="table-wrap" style="max-height:none"><table><thead><tr><th>Severity</th><th>Category</th><th>Finding</th><th>Affected</th></tr></thead><tbody>${rows}</tbody></table></div></section>`
}

function summaryBlock(s: AssessmentSection): string {
  const id = s.identity?.status === 'ok' ? s.identity.data : null
  const c = s.counts?.status === 'ok' ? s.counts.data : null
  const k = c
    ? `<div class="grid kpis">
      ${kpi('Users', num(c.users), `${num(c.usersOpen)} open · ${num(c.usersLocked)} locked · ${num(c.usersApplication)} application`)}
      ${kpi('Profiles / roles', `${num(c.profiles)} / ${num(c.roles)}`, 'password & resource profiles · roles')}
      ${kpi('Tablespaces', num(c.tablespaces), `${num(c.datafiles)} datafiles · ${num(c.tempfiles)} tempfiles`)}
      ${kpi('Database size', bytes((c.datafileBytes ?? 0) + (c.tempfileBytes ?? 0)), `segments ${bytes(c.segmentBytes)} · app ${bytes(c.segmentBytesApplication)}`, 'info')}
      ${kpi('Objects', num(c.objects), `${num(c.objectsApplication)} in application schemas · ${num(c.tables)} tables · ${num(c.indexes)} indexes`)}
      ${kpi('Invalid objects', num(c.objectsInvalid), `${num(c.objectsApplicationInvalid)} in application schemas`, c.objectsInvalid ? 'warn' : 'ok')}
      ${kpi('Parameters', num(c.parametersNonDefault), `non-default of ${num(c.parameters)} · ${num(c.spfileEntries)} SPFILE entries`)}
      ${kpi('Redo / control', `${num(c.redoGroups)} / ${num(c.controlfiles)}`, `redo groups (${bytes(c.redoBytes)}) / control files`)}
    </div>`
    : panelBody('counts', s.counts!)
  const identity = id
    ? card(
        'Database identity',
        kv([
          ['Banner', id.banner],
          ['Database', `${id.dbName} (${id.dbUniqueName}) · DBID ${id.dbid}`],
          ['Container', id.container ? `${id.container}${id.cdb === 'YES' ? ' (CDB)' : ''}` : 'non-CDB'],
          ['Instance', `${id.instanceName} on ${id.hostName} · ${id.status} · version ${id.version}`],
          ['Platform', id.platform],
          ['Role / mode', `${id.databaseRole} · ${id.openMode} · ${id.protectionMode}`],
          ['Logging', `${id.logMode} · force logging ${id.forceLogging} · flashback ${id.flashbackOn} · supplemental ${id.supplementalLogging}`],
          ['Character set', `${id.characterSet} / ${id.nationalCharacterSet}`],
          ['Created', cell('created', id.created)],
          ['Started', `${cell('startupTime', id.startupTime)} (up ${num((id.uptimeSeconds ?? 0) / 86400, 1)} days)`],
        ]),
      )
    : card('Database identity', panelBody('identity', s.identity!), { flush: true })
  return `${k}${identity}`
}

export function assessmentHtml(data: Record<AssessmentSectionId, AssessmentSection>, meta: { profileName: string }): string {
  const id = data.summary.identity?.status === 'ok' ? data.summary.identity.data : null
  const title = `Database assessment · ${id ? `${id.dbName}${id.container && id.container !== id.dbName ? ` / ${id.container}` : ''}` : meta.profileName}`
  const order = Object.keys(SECTION_TITLES) as AssessmentSectionId[]
  const toc = order.map((s) => `<a href="#${s}">${esc(SECTION_TITLES[s])}</a>`).join('')

  const sections = order.map((s) => {
    const sec = data[s]
    let inner: string
    if (s === 'summary') inner = summaryBlock(sec)
    else if (s === 'findings') inner = sec.findings?.status === 'ok' ? findingsBlock(sec.findings.data) : card('Health checks', panelBody('findings', sec.findings!), { flush: true })
    else inner = Object.entries(sec).map(([name, p]) => card(PANEL_TITLES[name] ?? humanize(name), panelBody(name, p), { flush: true })).join('\n')
    return `<h3 id="${s}">${esc(SECTION_TITLES[s])}</h3>\n${inner}`
  })

  const body = `
  <section class="card">
    <div class="card-body head">
      <h1>${esc(title)}</h1>
      <div class="meta">${id ? `${esc(id.banner)} · ${esc(id.hostName)} · ` : ''}profile ${esc(meta.profileName)} · collected ${esc(new Date().toLocaleString())}</div>
      <nav class="toc">${toc}</nav>
    </div>
  </section>
  ${sections.join('\n')}
`
  return htmlDocument(title, body, `Generated by OracleDB Data Lab · ${new Date().toISOString()} · read-only dictionary queries, no licensed packs used`)
}

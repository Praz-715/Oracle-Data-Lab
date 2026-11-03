import { describe, expect, it } from 'vitest'
import type { AssessmentFinding, AssessmentSnapshotMeta } from '../../shared/types/lab'
import { diffAssessments, diffFindings, diffRows, snapshotSummary } from '../../server/assessment/diff'

const ok = (data: unknown) => ({ status: 'ok' as const, data, collectedAt: '' })
const f = (id: string, severity: AssessmentFinding['severity']): AssessmentFinding => ({ id, category: 'Security', severity, title: id, detail: `${id} ${severity}` })

describe('assessment diff', () => {
  it('diffs keyed rows into added / removed / changed / numeric drift', () => {
    const a = [
      { username: 'APP', status: 'OPEN', profile: 'DEFAULT', segmentBytes: 1_000_000, objects: 10 },
      { username: 'OLD', status: 'OPEN', profile: 'DEFAULT', segmentBytes: 0, objects: 0 },
      { username: 'SAME', status: 'LOCKED', profile: 'DEFAULT', segmentBytes: 500, objects: 1 },
    ]
    const b = [
      { username: 'APP', status: 'LOCKED', profile: 'APP_PROFILE', segmentBytes: 1_005_000, objects: 12 },
      { username: 'NEW', status: 'OPEN', profile: 'DEFAULT', segmentBytes: 0, objects: 0 },
      { username: 'SAME', status: 'LOCKED', profile: 'DEFAULT', segmentBytes: 501, objects: 1 },
    ]
    const d = diffRows(a, b, { key: (r) => String(r.username), fields: ['status', 'profile'], numeric: ['objects', 'segmentBytes'] })
    expect(d.added.map((x) => x.key)).toEqual(['NEW'])
    expect(d.removed.map((x) => x.key)).toEqual(['OLD'])
    expect(d.changed).toEqual([{ key: 'APP', changes: [{ field: 'status', a: 'OPEN', b: 'LOCKED' }, { field: 'profile', a: 'DEFAULT', b: 'APP_PROFILE' }] }])
    // 0.5% size growth is noise; count changes always show.
    expect(d.numeric).toEqual([{ key: 'APP', field: 'objects', a: 10, b: 12, delta: 2 }])
    expect(d.unchanged).toBe(1)
  })

  it('treats null, undefined and empty string alike and honours either-side filters', () => {
    const a = [{ name: 'p1', value: '', isDefault: 'TRUE' }, { name: 'p2', value: '1', isDefault: 'TRUE' }, { name: 'p3', value: 'x', isDefault: 'FALSE' }]
    const b = [{ name: 'p1', value: null, isDefault: 'TRUE' }, { name: 'p2', value: '2', isDefault: 'FALSE' }, { name: 'p3', value: 'x', isDefault: 'FALSE' }]
    const d = diffRows(a, b, { key: (r) => String(r.name), fields: ['value', 'isDefault'], filter: (r) => r.isDefault === 'FALSE' })
    expect(d.changed.map((c) => c.key)).toEqual(['p2'])
    expect(d.unchanged).toBe(1)
  })

  it('classifies health checks: appeared, resolved, worse, better, still open', () => {
    const a = [f('a', 'warning'), f('b', 'critical'), f('c', 'ok'), f('d', 'warning'), f('e', 'info')]
    const b = [f('a', 'ok'), f('b', 'warning'), f('c', 'critical'), f('d', 'warning'), f('e', 'critical'), f('new', 'info')]
    const d = diffFindings(a, b)
    expect(d.resolved.map((x) => x.id)).toEqual(['a'])
    expect(d.better.map((x) => x.id)).toEqual(['b'])
    expect(d.appeared.map((x) => x.id)).toEqual(['c', 'new'])
    expect(d.worse.map((x) => x.id)).toEqual(['e'])
    expect(d.stillOpen.map((x) => x.id)).toEqual(['d'])
  })

  it('compares whole snapshots, including unavailable panels and identity', () => {
    const meta = { id: 'x', profileId: 'p', profileName: 'lab', label: '', createdAt: '' } as unknown as AssessmentSnapshotMeta
    const A = {
      summary: { identity: ok({ version: '19.24.0.0.0', logMode: 'NOARCHIVELOG' }), counts: ok({ objects: 100, objectsInvalid: 2, gaps: [] }) },
      findings: { findings: ok([f('archivelog', 'warning')]) },
      parameters: { parameters: ok([{ name: 'processes', value: '300', isDefault: 'FALSE' }]) },
      security: { pwfile: { status: 'unavailable' as const, reason: 'ORA-00942', collectedAt: '' } },
    }
    const B = {
      summary: { identity: ok({ version: '23.26.1.0.0', logMode: 'ARCHIVELOG' }), counts: ok({ objects: 120, objectsInvalid: 2, gaps: [] }) },
      findings: { findings: ok([f('archivelog', 'ok')]) },
      parameters: { parameters: ok([{ name: 'processes', value: '500', isDefault: 'FALSE' }]) },
      security: { pwfile: ok([]) },
    }
    const d = diffAssessments(A, B, meta, meta)
    expect(d.identity.map((i) => i.field)).toEqual(['version', 'logMode'])
    expect(d.counts).toEqual([{ key: 'objects', a: 100, b: 120, delta: 20 }])
    expect(d.findings.resolved.map((x) => x.id)).toEqual(['archivelog'])
    const params = d.panels.find((p) => p.panel === 'parameters')!
    expect(params.changed[0]!.changes[0]).toEqual({ field: 'value', a: '300', b: '500' })
    const pw = d.panels.find((p) => p.panel === 'pwfile')!
    expect(pw.status).toBe('unavailable')
    expect(pw.note).toContain('ORA-00942')
    expect(d.totals.changed).toBe(1)
  })

  it('summarizes a snapshot for lists and trends', () => {
    const s = snapshotSummary({
      summary: { identity: ok({ dbName: 'ORCL', container: 'PDB1', version: '23.26', hostName: 'h' }), counts: ok({ datafileBytes: 100, tempfileBytes: 20, objects: 5, objectsInvalid: 1 }) },
      findings: { findings: ok([f('a', 'critical'), f('b', 'warning'), f('c', 'ok')]) },
    })
    expect(s).toMatchObject({ dbName: 'ORCL', container: 'PDB1', summary: { dbSizeBytes: 120, objects: 5, invalid: 1, critical: 1, warning: 1, info: 0, ok: 1 } })
  })
})

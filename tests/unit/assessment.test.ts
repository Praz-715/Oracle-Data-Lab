import { describe, expect, it } from 'vitest'
import type { AssessmentSection } from '../../shared/types/lab'
import type { AssessmentSectionId } from '../../server/services/assessment'
import { SECTION_TITLES } from '../../server/services/assessment'
import { assessmentHtml } from '../../server/services/assessment-report'

const at = '2026-01-01T00:00:00.000Z'
const ok = (data: unknown, note?: string) => ({ status: 'ok' as const, data, collectedAt: at, note })

function fixture(): Record<AssessmentSectionId, AssessmentSection> {
  const empty = Object.fromEntries(Object.keys(SECTION_TITLES).map((k) => [k, {}])) as Record<AssessmentSectionId, AssessmentSection>
  return {
    ...empty,
    summary: {
      identity: ok({ dbName: 'LAB', container: 'PDB1', banner: 'Oracle <script>x</script>', hostName: 'h', cdb: 'YES', uptimeSeconds: 86400 }),
      counts: ok({ users: 3, datafileBytes: 1024, tempfileBytes: 1024, objectsInvalid: 0 }),
    },
    findings: {
      findings: ok([
        { id: 'a', category: 'Security', severity: 'critical', title: 'Default passwords', detail: 'x', items: ['SCOTT'] },
        { id: 'b', category: 'Capacity', severity: 'ok', title: 'Tablespaces', detail: 'fine' },
      ]),
    },
    spfile: { effective: ok({ entries: [{ name: 'processes', value: '300' }], pfileText: "*.processes=300\n*.db_name='LAB'" }) },
    users: { users: ok([{ username: 'APP', segmentBytes: 2048, created: '2026-01-02T03:04:05' }]) },
    security: { pwfile: { status: 'unavailable', reason: 'View not visible', code: 'ORA-00942', requires: 'SELECT_CATALOG_ROLE', collectedAt: at } },
    physical: { switches: ok({ series: [{ hour: '2026-01-01T00:00:00', switches: 1 }, { hour: '2026-01-01T01:00:00', switches: 3 }], total: 4, peakPerHour: 3, avgPerHour: 2 }) },
  }
}

describe('assessment HTML report', () => {
  const html = assessmentHtml(fixture(), { profileName: 'lab <1>' })

  it('is a standalone document with every section and a table of contents', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    for (const [id, title] of Object.entries(SECTION_TITLES)) {
      expect(html).toContain(`id="${id}"`)
      expect(html).toContain(`href="#${id}"`)
      expect(html).toContain(title.replace('&', '&amp;'))
    }
    expect(html).not.toMatch(/<link[^>]+stylesheet|<script[^>]+src=/)
  })

  it('escapes database-provided text', () => {
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('Oracle &lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('lab &lt;1&gt;')
  })

  it('renders findings, unavailable panels, parameter files, sizes and charts', () => {
    expect(html).toContain('Default passwords')
    expect(html).toContain('SCOTT')
    expect(html).toMatch(/Unavailable<\/strong> <span class="mono">ORA-00942<\/span>/)
    expect(html).toContain('Requires: SELECT_CATALOG_ROLE')
    expect(html).toContain('*.db_name=&#39;LAB&#39;')
    expect(html).toContain('2.0 KiB')
    expect(html).toContain('2026-01-02 03:04:05')
    expect(html).toContain('class="chart"')
  })
})

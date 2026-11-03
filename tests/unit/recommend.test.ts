import { describe, expect, it } from 'vitest'
import type { IndexCandidate, RemediationPlan, SqlRef } from '../../shared/types/lab'
import { finish } from '../../server/recommend/fixes'
import { planHtml, planSql } from '../../server/recommend/render'
import {
  addGroupsScript,
  fkIndexScript,
  groupSpec,
  niceSize,
  placeholdersIn,
  profileScript,
  publicRevokeScript,
  qi,
  redoMemberScript,
  redoResizePlan,
  revokeScript,
  smallfileMaxGiB,
  tablespaceFix,
  type RedoGroup,
} from '../../server/recommend/scripts'
import { mergeAdvice } from '../../server/recommend/sql-index'

const MiB = 1024 ** 2
const GiB = 1024 ** 3
const g = (group: number, thread = 1, bytes = 200 * MiB, members = 1, files = [`/u01/redo${group}a.log`]): RedoGroup => ({ group, thread, bytes, members, status: 'INACTIVE', files })

describe('remediation script builders', () => {
  it('rounds sizes to tidy values and quotes only unusual identifiers', () => {
    expect(niceSize(100 * MiB)).toBe('128M')
    expect(niceSize(900 * MiB)).toBe('1G')
    expect(niceSize(2.2 * GiB)).toBe('3G')
    expect(qi('ORDERS')).toBe('ORDERS')
    expect(qi('C##TEGUH')).toBe('C##TEGUH')
    expect(qi('Mixed')).toBe('"Mixed"')
  })

  it('multiplexes redo per storage type', () => {
    expect(redoMemberScript([g(1), g(2, 1, 200 * MiB, 2)])).toBe("ALTER DATABASE ADD LOGFILE MEMBER '<<SECOND_DISK_DIR>>/redo01b.log' TO GROUP 1;")
    expect(redoMemberScript([g(1, 1, 200 * MiB, 1, ['+DATA/ORCL/ONLINELOG/group_1.1'])])).toBe("ALTER DATABASE ADD LOGFILE MEMBER '+<<SECOND_DISKGROUP>>' TO GROUP 1;")
  })

  it('adds groups up to three per thread with the thread size', () => {
    const lines = addGroupsScript([g(1, 1), g(2, 1), g(3, 2, 512 * MiB), g(4, 2, 512 * MiB)], groupSpec({ omf: true, diskGroup: null }))
    expect(lines).toEqual(['ALTER DATABASE ADD LOGFILE THREAD 1 GROUP 5 SIZE 256M;', 'ALTER DATABASE ADD LOGFILE THREAD 2 GROUP 6 SIZE 512M;'])
  })

  it('sizes redo for ~4 switches/hour at peak and drops old groups only afterwards', () => {
    const plan = redoResizePlan([g(1), g(2), g(3)], 30, groupSpec({ omf: false, diskGroup: '+DATA' }))
    // 200 MiB × 30 / 4 = 1.5 GiB → 2G
    expect(plan.target).toBe('2G')
    expect(plan.add[0]).toBe("ALTER DATABASE ADD LOGFILE THREAD 1 GROUP 4 ('+DATA', '+<<SECOND_DISKGROUP>>') SIZE 2G;")
    expect(plan.added).toEqual([4, 5, 6])
    expect(plan.drop).toEqual(['ALTER DATABASE DROP LOGFILE GROUP 1;', 'ALTER DATABASE DROP LOGFILE GROUP 2;', 'ALTER DATABASE DROP LOGFILE GROUP 3;'])
    // Never smaller than twice the current size, even at a low peak.
    expect(redoResizePlan([g(1)], 2, groupSpec({ omf: true, diskGroup: null })).target).toBe('512M')
  })

  it('adds tablespace space within the smallfile limit', () => {
    expect(smallfileMaxGiB(8192)).toBe(31)
    const base = { name: 'USERS', contents: 'PERMANENT', bigfile: false, blockSize: 8192, fileCount: 1, sampleFile: '/u02/oradata/users01.dbf' }
    // 90 GiB used of 100 GiB: needs ~28.6 GiB more → one new file
    const one = tablespaceFix({ ...base, usedBytes: 90 * GiB, maxBytes: 100 * GiB }, false)
    expect(one.code).toBe("ALTER TABLESPACE USERS ADD DATAFILE '<<DATAFILE_DIR>>/users02.dbf' SIZE 4G AUTOEXTEND ON NEXT 256M MAXSIZE 31G;")
    expect(one.placeholder).toBe(true)
    // 200 GiB used of 210: ~76 GiB more → three files; OMF needs no file name
    const omf = tablespaceFix({ ...base, usedBytes: 200 * GiB, maxBytes: 210 * GiB }, true)
    expect(omf.code.split('\n')).toHaveLength(3)
    expect(omf.code).not.toContain("'")
    const asm = tablespaceFix({ ...base, sampleFile: '+DATA/ORCL/DATAFILE/users.259.1', usedBytes: 9 * GiB, maxBytes: 10 * GiB }, false)
    expect(asm.code).toContain("ADD DATAFILE '+DATA' SIZE")
    expect(tablespaceFix({ ...base, contents: 'TEMPORARY', usedBytes: 9 * GiB, maxBytes: 10 * GiB }, true).code).toContain('ADD TEMPFILE')
    expect(tablespaceFix({ ...base, bigfile: true, usedBytes: 9 * GiB, maxBytes: 10 * GiB }, true).code).toBe('ALTER TABLESPACE USERS AUTOEXTEND ON NEXT 1G MAXSIZE UNLIMITED;')
  })

  it('revokes common grants from the root and keeps monitoring privileges commented', () => {
    const r = revokeScript([
      { grantee: 'APP', privilege: 'DBA', adminOption: true, common: false },
      { grantee: 'C##OPS', privilege: 'DBA', adminOption: false, common: true },
      { grantee: 'MON', privilege: 'SELECT ANY DICTIONARY', adminOption: false, common: false, keep: 'monitoring' },
    ])
    expect(r.local).toBe('REVOKE DBA FROM APP;\n-- REVOKE SELECT ANY DICTIONARY FROM MON;   -- monitoring')
    expect(r.common).toBe('REVOKE DBA FROM C##OPS CONTAINER = ALL;')
    expect(r.undoLocal).toBe('GRANT DBA TO APP WITH ADMIN OPTION;')
    expect(r.undoCommon).toBe('GRANT DBA TO C##OPS CONTAINER = ALL;')
  })

  it('grants dependents directly before revoking from PUBLIC; widely used packages stay commented', () => {
    const s = publicRevokeScript([
      { pkg: 'DBMS_SQL', common: false, dependents: ['APP'] },
      { pkg: 'UTL_HTTP', common: true, dependents: ['CTXSYS'] },
    ])
    expect(s.grants.indexOf('GRANT EXECUTE ON SYS.UTL_HTTP TO CTXSYS;')).toBeGreaterThan(-1)
    expect(s.grants).toContain('-- GRANT EXECUTE ON SYS.DBMS_SQL TO APP;')
    expect(s.revokeCommon).toContain('\nREVOKE EXECUTE ON SYS.UTL_HTTP FROM PUBLIC CONTAINER = ALL;')
    expect(s.revokeLocal).toContain('-- REVOKE EXECUTE ON SYS.DBMS_SQL FROM PUBLIC;')
    expect(s.restoreCommon).toBe('GRANT EXECUTE ON SYS.UTL_HTTP TO PUBLIC CONTAINER = ALL;')
  })

  it('hardens a profile from its effective limits and rolls back to the stored ones', () => {
    const s = profileScript(
      {
        profile: 'APP_PROF',
        common: false,
        raw: { FAILED_LOGIN_ATTEMPTS: 'DEFAULT', PASSWORD_VERIFY_FUNCTION: 'NULL', PASSWORD_LIFE_TIME: 'UNLIMITED' },
        eff: { FAILED_LOGIN_ATTEMPTS: 'UNLIMITED', PASSWORD_VERIFY_FUNCTION: 'NULL', PASSWORD_LIFE_TIME: 'UNLIMITED' },
      },
      'ORA12C_VERIFY_FUNCTION',
    )
    expect(s.code.split('\n')[0]).toBe('ALTER PROFILE APP_PROF LIMIT FAILED_LOGIN_ATTEMPTS 5 PASSWORD_VERIFY_FUNCTION ORA12C_VERIFY_FUNCTION;')
    // Password lifetime is only suggested: it would expire service accounts.
    expect(s.code).toContain('-- ALTER PROFILE APP_PROF LIMIT PASSWORD_LIFE_TIME 90')
    expect(s.rollback).toBe('ALTER PROFILE APP_PROF LIMIT FAILED_LOGIN_ATTEMPTS DEFAULT PASSWORD_VERIFY_FUNCTION NULL;')
  })

  it('indexes foreign keys in key order with collision-free names', () => {
    const s = fkIndexScript(
      [
        { owner: 'LAB', table: 'ORDER_ITEMS', constraint: 'OI_ORDER_FK', columns: ['ORDER_ID', 'LINE_NO'] },
        { owner: 'LAB', table: 'Mixed', constraint: 'MX_FK', columns: ['ID'] },
      ],
      new Set(['LAB.OI_ORDER_FK_IX']),
      true,
    )
    expect(s.code).toBe('CREATE INDEX LAB.OI_ORDER_FK_IX2 ON LAB.ORDER_ITEMS (ORDER_ID, LINE_NO) ONLINE;\nCREATE INDEX LAB.MX_FK_IX ON LAB."Mixed" (ID) ONLINE;')
    expect(s.names).toEqual(['LAB.OI_ORDER_FK_IX2', 'LAB.MX_FK_IX'])
  })

  it('finds placeholders and describes them on the recommendation', () => {
    expect(placeholdersIn("x '<<A_B>>' <<A_B>> <<C1>>")).toEqual(['A_B', 'C1'])
    const r = finish(
      { id: 'controlfiles', category: 'Recoverability', severity: 'warning', title: 'Control files', detail: '' },
      { why: 'w', steps: [{ title: 't', kind: 'sql', runAs: 'SYSDBA', code: "SET x = '<<SECOND_DISK_DIR>>/c.ctl'" }], ph: {} },
    )
    expect(r.placeholders).toEqual([expect.stringMatching(/^<<SECOND_DISK_DIR>> — a directory on a different/)])
    expect(r.impact).toEqual({ restart: false, downtime: false, enterpriseOnly: false, risk: 'low', notes: [] })
  })
})

describe('remediation runbook', () => {
  const plan: RemediationPlan = {
    generatedAt: '2026-11-03T05:00:00.000Z',
    profileName: 'lab',
    dbName: 'ORCL',
    container: 'ORCLPDB1',
    version: '23.26.1.0.0',
    checked: 36,
    clean: 30,
    failed: [],
    recommendations: [
      finish(
        { id: 'archivelog', category: 'Recoverability', severity: 'warning', title: 'ARCHIVELOG mode', detail: '' },
        {
          why: 'Point-in-time recovery.',
          impact: { restart: true, downtime: true, risk: 'medium' },
          steps: [
            { title: 'Mount', kind: 'sql', runAs: 'SYSDBA', code: 'SHUTDOWN IMMEDIATE\nSTARTUP MOUNT' },
            { title: 'Backup', kind: 'rman', runAs: 'RMAN', code: 'BACKUP DATABASE PLUS ARCHIVELOG;' },
            { title: 'Edit', kind: 'shell', runAs: 'oracle', code: 'vi init.ora' },
          ],
        },
      ),
    ],
  }

  it('stops when run as a whole and comments out RMAN / shell lines', () => {
    const sql = planSql(plan)
    const firstStatement = sql.split('\n').find((l) => l.trim() && !l.startsWith('--') && !l.startsWith('PROMPT'))
    expect(firstStatement).toBe('EXIT')
    expect(sql).toContain('-- RMAN> BACKUP DATABASE PLUS ARCHIVELOG;')
    expect(sql).toContain('-- $ vi init.ora')
    expect(sql).toContain('SHUTDOWN IMMEDIATE\nSTARTUP MOUNT')
    expect(sql).toContain('RECOMMENDATIONS ONLY')
  })

  it('renders a standalone HTML page that says nothing was executed', () => {
    const html = planHtml(plan)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('Nothing on this page was executed')
    expect(html).toContain('id="rec-archivelog"')
  })
})

describe('SQL index advice merge', () => {
  const ref = (sqlId: string, dbTimePct: number): SqlRef => ({ sqlId, planHash: 1, schema: 'LAB', executions: 10, elapsedMsPerExec: 5, bufferGetsPerExec: 1000, dbTimePct, text: 'SELECT …' })
  const cand = (columns: string[], score: number, coveredBy: string | null = null): IndexCandidate => ({
    id: `LAB.T(${columns.join(',')})`,
    owner: 'LAB',
    table: 'T',
    columns,
    kind: 'filter',
    rationale: '',
    selectivity: 0.01,
    tableRows: 1e6,
    estRows: 1e4,
    coveredBy,
    ddl: '',
    score,
  })

  it('merges the same index across statements and folds prefixes into the longer index', () => {
    const out = mergeAdvice([
      { sql: ref('a', 30), candidates: [cand(['A', 'B'], 100)] },
      { sql: ref('b', 20), candidates: [cand(['A'], 50)] },
      { sql: ref('c', 5), candidates: [cand(['A', 'B'], 120)] },
      { sql: ref('d', 40), candidates: [cand(['X'], 10, 'T_X_IX')] },
    ])
    expect(out.map((a) => a.candidate.columns.join(','))).toEqual(['A,B', 'X'])
    expect(out[0]!.impactPct).toBe(55)
    expect(out[0]!.sql.map((s) => s.sqlId)).toEqual(['a', 'b', 'c'])
    expect(out[0]!.candidate.score).toBe(120)
    // Candidates whose index already exists come last.
    expect(out[1]!.candidate.coveredBy).toBe('T_X_IX')
  })
})

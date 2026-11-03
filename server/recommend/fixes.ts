import type { Connection } from 'oracledb'
import type { AssessmentFinding, FixStep, Recommendation } from '../../shared/types/lab'
import { SENSITIVE_PACKAGES } from '../assessment/packages'
import { versionMajorOf } from '../database/environment'
import { one, rows } from '../database/query'
import { customGrantee, customOwner, customUser, fkNoIndexSql, inList, noPkSql } from '../services/assessment'
import {
  addGroupsScript,
  diskGroupOf,
  fkIndexScript,
  fmtBytes,
  GiB,
  groupSpec,
  isAsm,
  lit,
  niceSize,
  placeholdersIn,
  profileScript,
  publicRevokeScript,
  qi,
  qn,
  redoMemberScript,
  redoResizePlan,
  revokeScript,
  shortName,
  tablespaceFix,
  type GrantFact,
  type PasswordLimit,
  type ProfileFact,
  type RedoGroup,
} from './scripts'

// "Fix it" advice per assessment health check. Each builder reads the facts it needs (read-only
// SELECTs on the dictionary), then writes the script a DBA would run: where to run it, what it
// costs (restart, downtime, Enterprise Edition), how to verify and how to undo it. The app never
// executes any of it. Values the database cannot tell us (a second disk, a new password) are
// <<PLACEHOLDERS>> listed with the recommendation.

export interface FixCtx {
  conn: Connection
  major: number
  /** Numeric server version, e.g. 1202000000 for 12.2. */
  version: number
  cdb: boolean
  container: string | null
  inRoot: boolean
  /** Enterprise Edition (or Free/Personal, which carry the EE feature set): online operations allowed. */
  ee: boolean
  rac: boolean
  dbUniqueName: string
  sessionUser: string
}

const n = (v: unknown) => Number(v ?? 0)

async function tryOne<T>(conn: Connection, sql: string): Promise<T | null> {
  try {
    return await one<T>(conn, sql)
  } catch {
    return null
  }
}

export async function fixContext(conn: Connection): Promise<FixCtx> {
  const major = versionMajorOf(conn)
  const ctx = await one<{ C: string | null; U: string }>(conn, `SELECT ${major >= 12 ? "SYS_CONTEXT('USERENV','CON_NAME')" : 'NULL'} AS "C", SYS_CONTEXT('USERENV','SESSION_USER') AS "U" FROM DUAL`)
  const db = await tryOne<{ C: string; N: string }>(conn, `SELECT ${major >= 12 ? 'CDB' : "'NO'"} AS "C", DB_UNIQUE_NAME AS "N" FROM V$DATABASE`)
  const banner = await tryOne<{ B: string }>(conn, `SELECT BANNER AS "B" FROM V$VERSION WHERE ROWNUM = 1`)
  const inst = await tryOne<{ N: number }>(conn, `SELECT COUNT(*) AS "N" FROM GV$INSTANCE`)
  const cdb = db?.C === 'YES'
  return {
    conn,
    major,
    version: conn.oracleServerVersion ?? 0,
    cdb,
    container: ctx?.C ?? null,
    inRoot: !cdb || ctx?.C === 'CDB$ROOT',
    ee: /enterprise|free|personal/i.test(banner?.B ?? ''),
    rac: n(inst?.N) > 1,
    dbUniqueName: db?.N ?? '<<DB_UNIQUE_NAME>>',
    sessionUser: ctx?.U ?? '',
  }
}

// --- step helpers ------------------------------------------------------------------------------

const root = (c: FixCtx) => (c.cdb ? 'SYSDBA, connected to CDB$ROOT' : 'SYSDBA')
const here = (c: FixCtx, who = 'a DBA') => (c.cdb && !c.inRoot ? `${who}, connected to ${c.container}` : who)
const sql = (title: string, runAs: string, code: string): FixStep => ({ title, kind: 'sql', runAs, code })
const check = (title: string, runAs: string, code: string): FixStep => ({ title, kind: 'check', runAs, code })
const rman = (title: string, code: string): FixStep => ({ title, kind: 'rman', runAs: 'RMAN on the database server: rman target /', code })
const shell = (title: string, runAs: string, code: string): FixStep => ({ title, kind: 'shell', runAs, code })

function srvctl(c: FixCtx) {
  const d = c.major >= 12 ? `-db ${c.dbUniqueName}` : `-d ${c.dbUniqueName}`
  return {
    stop: `srvctl stop database ${d}`,
    start: `srvctl start database ${d}`,
    startOne: (mode: string) => (c.major >= 12 ? `srvctl start instance ${d} -instance <<INSTANCE_NAME>> -startoption ${mode}` : `srvctl start instance ${d} -i <<INSTANCE_NAME>> -o ${mode}`),
  }
}

/** Steps around a change that needs the database MOUNTed (or NOMOUNT): restart, change, open. */
function offline(c: FixCtx, mode: 'MOUNT' | 'NOMOUNT', change: FixStep[]): FixStep[] {
  const mount = mode === 'NOMOUNT' ? 'ALTER DATABASE MOUNT;\n' : ''
  const pdbs = c.cdb ? '\nALTER PLUGGABLE DATABASE ALL OPEN;' : ''
  if (!c.rac) return [sql(`Restart the instance in ${mode} mode`, root(c), `SHUTDOWN IMMEDIATE\nSTARTUP ${mode}`), ...change, sql('Open the database', root(c), `${mount}ALTER DATABASE OPEN;${pdbs}`)]
  const s = srvctl(c)
  return [
    shell(`Stop all instances, then start one in ${mode} mode`, 'oracle OS user on one cluster node', `${s.stop}\n${s.startOne(mode.toLowerCase())}`),
    ...change.map((x) => ({ ...x, runAs: x.kind === 'sql' ? `${x.runAs} (on that instance)` : x.runAs })),
    shell('Restart all instances', 'oracle OS user', `${s.stop}\n${s.start}`),
  ]
}

/** Same as offline() as one block of text (for rollbacks); shell lines become comments. */
function offlineText(c: FixCtx, mode: 'MOUNT' | 'NOMOUNT', code: string) {
  return offline(c, mode, [sql('', root(c), code)])
    .map((s) => (s.kind === 'shell' ? s.code.split('\n').map((l) => `-- OS shell: ${l}`).join('\n') : s.code))
    .join('\n')
}

/** Restart so SCOPE=SPFILE changes take effect. */
function restart(c: FixCtx): FixStep {
  if (c.rac) {
    const s = srvctl(c)
    return shell('Restart all instances (SPFILE changes take effect at startup)', 'oracle OS user', `${s.stop}\n${s.start}`)
  }
  return sql('Restart the instance (SPFILE changes take effect at startup)', root(c), `SHUTDOWN IMMEDIATE\nSTARTUP${c.cdb ? '\nALTER PLUGGABLE DATABASE ALL OPEN;' : ''}`)
}

async function params(conn: Connection, names: string[]): Promise<Record<string, string | null>> {
  const r = await rows<{ N: string; V: string | null }>(conn, `SELECT NAME AS "N", VALUE AS "V" FROM V$PARAMETER WHERE NAME IN (${inList(names)})`)
  return Object.fromEntries(names.map((k) => [k, r.find((x) => x.N === k)?.V || null]))
}

const cdbCol = (c: FixCtx, col: string) => (c.major >= 12 ? col : "'NO'")
const names = (xs: string[]) => inList(xs.length ? xs : ['-'])

/** Descriptions of the placeholders builders use (a builder can override per recommendation). */
const PLACEHOLDERS: Record<string, string> = {
  SECOND_DISKGROUP: 'an ASM disk group other than the one holding the current copy (e.g. RECO)',
  SECOND_DISK_DIR: 'a directory on a different physical disk / controller than the current file',
  DISK_A_DIR: 'directory for the first member (one disk)',
  DISK_B_DIR: 'directory for the second member, on a different physical disk than DISK_A_DIR',
  DATAFILE_DIR: 'directory for the new file, with enough free space',
  FRA_LOCATION: 'directory or ASM disk group (+RECO) for the fast recovery area',
  FRA_SIZE: 'size of the fast recovery area',
  INSTANCE_NAME: 'any one instance of the cluster (srvctl status database)',
  DB_UNIQUE_NAME: 'the DB_UNIQUE_NAME of the database',
  NEW_PASSWORD: 'a new strong password for that account (store it in your password vault)',
  PASSWORD: 'the password the account should get when it is opened again',
  VERIFY_FUNCTION: 'a password verify function owned by SYS (e.g. ORA12C_VERIFY_FUNCTION)',
  APP_TABLESPACE: 'the permanent tablespace that should hold this application data',
  PFILE_PATH: 'full path of the text parameter file the instance was started with',
  SPFILE_LOCATION: 'shared location for the SPFILE (ASM disk group or cluster file system)',
  PATCH_DIR: 'directory where the downloaded Release Update was unzipped',
  PATCH_ID: 'number of the patch to roll back',
  BCT_DIR: 'directory for the block change tracking file (not in the FRA)',
  KEY_COLUMNS: 'the column(s) that identify a row uniquely',
  BACKUP_DEVICE: 'DISK or SBT_TAPE — where the archived logs were backed up to',
  PRIVILEGES_FROM_STEP_2: 'only the privileges the capture shows as used',
}

type Draft = {
  why: string
  steps: FixStep[]
  impact?: Partial<Recommendation['impact']>
  prerequisites?: string[]
  verify?: FixStep | null
  rollback?: FixStep | null
  basedOn?: string[]
  guidanceOnly?: boolean
  /** Placeholder descriptions specific to this recommendation. */
  ph?: Record<string, string>
}
type Builder = (c: FixCtx, f: AssessmentFinding) => Promise<Draft | null>

export function finish(f: AssessmentFinding, d: Draft): Recommendation {
  const text = [...d.steps, d.verify, d.rollback].filter((s): s is FixStep => !!s).map((s) => s.code).join('\n')
  return {
    findingId: f.id,
    title: f.title,
    severity: f.severity,
    category: f.category,
    why: d.why,
    impact: { restart: false, downtime: false, enterpriseOnly: false, risk: 'low', notes: [], ...d.impact },
    prerequisites: d.prerequisites ?? [],
    steps: d.steps,
    verify: d.verify ?? null,
    rollback: d.rollback ?? null,
    placeholders: placeholdersIn(text).map((k) => `<<${k}>> — ${d.ph?.[k] ?? PLACEHOLDERS[k] ?? 'value to fill in'}`),
    basedOn: d.basedOn ?? [],
    guidanceOnly: d.guidanceOnly ?? false,
  }
}

// --- shared fact readers ---------------------------------------------------------------------------

/** Average redo bytes per day over the last 7 days (log switches × average log size). */
async function redoPerDay(conn: Connection) {
  const r = await one<{ D: number; B: number }>(conn, `SELECT (SELECT COUNT(*) FROM V$LOG_HISTORY WHERE FIRST_TIME > SYSDATE - 7) / 7 AS "D", (SELECT AVG(BYTES) FROM V$LOG) AS "B" FROM DUAL`)
  return n(r?.D) * n(r?.B)
}

async function redoGroups(conn: Connection): Promise<RedoGroup[]> {
  const r = await rows<{ G: number; T: number; B: number; M: number; S: string; F: string | null }>(
    conn,
    `SELECT l.GROUP# AS "G", l.THREAD# AS "T", l.BYTES AS "B", l.MEMBERS AS "M", l.STATUS AS "S", f.MEMBER AS "F"
       FROM V$LOG l LEFT JOIN V$LOGFILE f ON f.GROUP# = l.GROUP# ORDER BY l.GROUP#, f.MEMBER`,
  )
  const out = new Map<number, RedoGroup>()
  for (const x of r) {
    const g = out.get(x.G) ?? { group: n(x.G), thread: n(x.T), bytes: n(x.B), members: n(x.M), status: x.S, files: [] }
    if (x.F) g.files.push(x.F)
    out.set(x.G, g)
  }
  return [...out.values()]
}

async function redoLayout(conn: Connection, groups: RedoGroup[]) {
  const p = await params(conn, ['db_create_online_log_dest_1', 'db_create_online_log_dest_2', 'db_create_file_dest', 'db_recovery_file_dest'])
  const omf = !!(p.db_create_online_log_dest_1 || p.db_create_file_dest)
  const diskGroup = groups.flatMap((g) => g.files).map(diskGroupOf).find(Boolean) ?? null
  const omfNote = p.db_create_online_log_dest_1
    ? `Oracle-managed files: one member in each DB_CREATE_ONLINE_LOG_DEST_n (${[p.db_create_online_log_dest_1, p.db_create_online_log_dest_2].filter(Boolean).join(', ')})`
    : `Oracle-managed files: members in DB_CREATE_FILE_DEST (${p.db_create_file_dest})${p.db_recovery_file_dest ? ` and DB_RECOVERY_FILE_DEST (${p.db_recovery_file_dest})` : ' only — a single member, add a second one afterwards'}`
  return { spec: groupSpec({ omf, diskGroup }), note: omf ? omfNote : diskGroup ? `ASM, current disk group ${diskGroup}` : 'file system paths', omf, diskGroup }
}

const switchLogs = (c: FixCtx, count: number) =>
  sql(
    `Switch logs so every group gets used${c.rac ? ' (run on every instance)' : ''}`,
    root(c),
    `${Array.from({ length: Math.max(1, count) }, () => 'ALTER SYSTEM SWITCH LOGFILE;').join('\n')}\nALTER SYSTEM CHECKPOINT;`,
  )

const REDO_CHECK = `SELECT l.GROUP#, l.THREAD#, ROUND(l.BYTES / 1048576) AS MB, l.MEMBERS, l.STATUS, l.ARCHIVED, f.MEMBER, f.STATUS AS MEMBER_STATUS
  FROM V$LOG l JOIN V$LOGFILE f ON f.GROUP# = l.GROUP#
 ORDER BY l.THREAD#, l.GROUP#, f.MEMBER;`

// --- builders ------------------------------------------------------------------------------------

const BUILDERS: Record<string, Builder> = {
  archivelog: async (c) => {
    const p = await params(c.conn, ['db_recovery_file_dest', 'log_archive_dest_1', 'log_archive_dest'])
    const perDay = await redoPerDay(c.conn)
    const dest = p.db_recovery_file_dest || p.log_archive_dest_1 || p.log_archive_dest
    const steps: FixStep[] = []
    if (!dest)
      steps.push(sql('Give the archived logs a destination (fast recovery area)', root(c), `ALTER SYSTEM SET db_recovery_file_dest_size = <<FRA_SIZE>> SCOPE=BOTH SID='*';\nALTER SYSTEM SET db_recovery_file_dest = '<<FRA_LOCATION>>' SCOPE=BOTH SID='*';`))
    steps.push(...offline(c, 'MOUNT', [sql('Switch to ARCHIVELOG mode', root(c), 'ALTER DATABASE ARCHIVELOG;')]))
    steps.push(rman('Take a full backup — the first one that allows point-in-time recovery', 'BACKUP DATABASE PLUS ARCHIVELOG;'))
    return {
      why: 'In NOARCHIVELOG mode filled redo logs are overwritten: only a cold backup can be restored and every change made since that backup is lost. ARCHIVELOG keeps the redo, which allows online backups and recovery to any point in time.',
      impact: { restart: true, downtime: true, risk: 'medium', notes: ['The database is closed between SHUTDOWN and OPEN (usually a few minutes).', 'When the archive destination fills up, the database stops accepting changes — size it and monitor it.'] },
      prerequisites: [
        'A short maintenance window.',
        dest
          ? `Archived logs will go to ${dest}: it needs room for at least three days of redo${perDay ? ` (~${fmtBytes(perDay * 3)} at the current rate)` : ''} plus any backups kept there.`
          : 'An archive location with room for at least three days of redo plus backups.',
      ],
      steps,
      verify: check('Log mode and archive destinations', root(c), `ARCHIVE LOG LIST\nSELECT LOG_MODE FROM V$DATABASE;\nSELECT DEST_NAME, STATUS, DESTINATION FROM V$ARCHIVE_DEST WHERE STATUS <> 'INACTIVE';`),
      rollback: sql('Back to NOARCHIVELOG (loses point-in-time recovery)', root(c), offlineText(c, 'MOUNT', 'ALTER DATABASE NOARCHIVELOG;')),
      basedOn: ['V$DATABASE.LOG_MODE = NOARCHIVELOG', `db_recovery_file_dest = ${p.db_recovery_file_dest ?? '(not set)'}`, `log_archive_dest_1 = ${p.log_archive_dest_1 ?? '(not set)'}`, perDay ? `~${fmtBytes(perDay)} of redo per day (V$LOG_HISTORY, last 7 days)` : 'No log switches recorded in the last 7 days'],
      ph: { FRA_SIZE: `size of the fast recovery area — at least ${niceSize(Math.max(10 * GiB, perDay * 3))} for three days of archived redo, more if backups go there too` },
    }
  },

  controlfiles: async (c) => {
    const files = (await rows<{ N: string }>(c.conn, `SELECT NAME AS "N" FROM V$CONTROLFILE`)).map((x) => x.N)
    if (!files.length) return null
    const p = await params(c.conn, ['spfile'])
    const asm = files.some(isAsm)
    let nr = files.length + 1
    while (files.some((f) => f.toLowerCase().endsWith(`control${String(nr).padStart(2, '0')}.ctl`))) nr++
    const add = asm ? `'+<<SECOND_DISKGROUP>>'` : `'<<SECOND_DISK_DIR>>/control${String(nr).padStart(2, '0')}.ctl'`
    const cur = files.map(lit).join(', ')
    const restore = rman('Write the current control file to every CONTROL_FILES location', `RESTORE CONTROLFILE FROM ${lit(files[0]!)};`)
    const steps: FixStep[] = p.spfile
      ? [sql('Add the second location to CONTROL_FILES (used at the next start)', root(c), `ALTER SYSTEM SET control_files = ${cur}, ${add} SCOPE=SPFILE SID='*';`), ...offline(c, 'NOMOUNT', [restore])]
      : [
          shell('Edit control_files in the text parameter file the instance starts with', 'oracle OS user', `# in <<PFILE_PATH>>:\ncontrol_files = (${cur}, ${add})`),
          ...offline(c, 'NOMOUNT', [restore]),
        ]
    return {
      why: 'With a single control file, losing that one file (disk failure, accidental delete) stops the database and forces a restore and RESETLOGS recovery. Oracle writes every copy listed in CONTROL_FILES identically, so a second copy on another disk makes this failure harmless.',
      impact: { restart: true, downtime: true, risk: 'medium', notes: ['One short outage: SHUTDOWN → STARTUP NOMOUNT → restore → MOUNT → OPEN.', asm ? 'With only a disk group name, RMAN creates the copy as an Oracle-managed file and records its full name in CONTROL_FILES in the SPFILE.' : 'The new directory must exist and be writable by the oracle user.'] },
      prerequisites: ['A maintenance window.', 'A recent backup of the control file (RMAN: BACKUP CURRENT CONTROLFILE;).'],
      steps,
      verify: check('Both copies are in use', root(c), `SELECT NAME, STATUS FROM V$CONTROLFILE;\nSHOW PARAMETER control_files`),
      rollback: sql('Go back to the single copy', root(c), `ALTER SYSTEM SET control_files = ${cur} SCOPE=SPFILE SID='*';\n${c.rac ? '-- then restart all instances with srvctl' : restart(c).code}`),
      basedOn: [`V$CONTROLFILE: ${files.join(', ')}`, p.spfile ? `Started with SPFILE ${p.spfile}` : 'Started with a text PFILE', ...(c.rac ? ['RAC: instances are stopped/started with srvctl'] : [])],
    }
  },

  'redo-groups': async (c) => {
    const groups = await redoGroups(c.conn)
    if (!groups.length) return null
    const lay = await redoLayout(c.conn, groups)
    const single = groups.filter((g) => g.members < 2)
    const add = addGroupsScript(groups, lay.spec)
    const steps: FixStep[] = []
    if (single.length) steps.push(sql(`Add a second member to ${single.length} single-member group(s)`, root(c), redoMemberScript(groups)))
    if (add.length) steps.push(sql('Add groups so every thread has at least three', root(c), add.join('\n')))
    steps.push(switchLogs(c, groups.length + add.length))
    return {
      why: 'Each redo group should have two members on different disks (losing the only member of the CURRENT group crashes the instance and can lose committed work), and each thread needs at least three groups so the log writer never waits for a group to be archived or checkpointed.',
      impact: { risk: 'low', notes: ['Online: no restart. New members show STATUS INVALID until their group is written to — the log switches fix that.', 'A new member takes the size of its group automatically; put the members of one group on separate physical disks.'] },
      steps,
      verify: check('Groups, members and their status', root(c), REDO_CHECK),
      rollback: sql(
        'Remove what was added',
        root(c),
        [
          ...(single.length ? ['-- A member cannot be dropped while its group is CURRENT: switch logs first.'] : []),
          ...(lay.diskGroup
            ? single.map((g) => `-- ALTER DATABASE DROP LOGFILE MEMBER '<name from V$LOGFILE for group ${g.group}>';`)
            : single.map((g) => `ALTER DATABASE DROP LOGFILE MEMBER '<<SECOND_DISK_DIR>>/redo${String(g.group).padStart(2, '0')}b.log';`)),
          ...add.map((l) => `ALTER DATABASE DROP LOGFILE GROUP ${/GROUP (\d+)/.exec(l)![1]};   -- once INACTIVE`),
        ].join('\n'),
      ),
      basedOn: groups.map((g) => `group ${g.group} (thread ${g.thread}): ${fmtBytes(g.bytes)}, ${g.members} member(s)${g.files.length ? ` — ${g.files.join(', ')}` : ''}`).concat(add.length ? [`New groups: ${lay.note}`] : []),
    }
  },

  'log-switches': async (c) => {
    const groups = await redoGroups(c.conn)
    if (!groups.length) return null
    const peak = n((await one<{ P: number }>(c.conn, `SELECT NVL(MAX(c), 0) AS "P" FROM (SELECT COUNT(*) c FROM V$LOG_HISTORY WHERE FIRST_TIME > SYSDATE - 7 GROUP BY TRUNC(FIRST_TIME, 'HH24'))`))?.P)
    const lay = await redoLayout(c.conn, groups)
    const plan = redoResizePlan(groups, peak, lay.spec)
    const fsFiles = !lay.omf && !lay.diskGroup ? groups.flatMap((g) => g.files) : []
    return {
      why: `At peak the redo logs switched ${peak} times in one hour. Every switch triggers a checkpoint and, in ARCHIVELOG mode, an archive; switching more than ~4–6 times per hour causes "checkpoint not complete" / "log file switch" waits. Larger logs switch less often.`,
      impact: { risk: 'low', notes: ['Online: new groups are added first, old groups are dropped only once INACTIVE.', 'Data Guard: also recreate the standby redo logs with the new size (one more group per thread than online groups).', 'Bigger logs mean more redo to apply after an instance crash; ARCHIVE_LAG_TARGET can still force regular switches.'] },
      steps: [
        sql(`Add ${plan.add.length} groups of ${plan.target}`, root(c), plan.add.join('\n')),
        switchLogs(c, groups.length),
        check('Wait until the old groups are INACTIVE (and ARCHIVED = YES in ARCHIVELOG mode)', root(c), REDO_CHECK),
        sql(
          'Drop the old groups, one at a time, each only when INACTIVE',
          root(c),
          plan.drop.join('\n') + (fsFiles.length ? `\n-- Then delete the old files at OS level (not needed for OMF/ASM):\n${fsFiles.map((f) => `--   ${f}`).join('\n')}` : ''),
        ),
      ],
      verify: check('Switch frequency over the last 24 hours', root(c), `SELECT TRUNC(FIRST_TIME, 'HH24') AS HOUR, COUNT(*) AS SWITCHES FROM V$LOG_HISTORY WHERE FIRST_TIME > SYSDATE - 1 GROUP BY TRUNC(FIRST_TIME, 'HH24') ORDER BY 1;`),
      rollback: sql('Back out before the old groups are dropped: drop the new ones once INACTIVE', root(c), plan.added.map((g) => `ALTER DATABASE DROP LOGFILE GROUP ${g};`).join('\n')),
      basedOn: [`Peak ${peak} switches/hour (V$LOG_HISTORY, last 7 days)`, `Current size ${fmtBytes(Math.max(...groups.map((g) => g.bytes)))}, ${groups.length} group(s)`, `Target ${plan.target}: about 4 switches per hour at that peak`, `New groups: ${lay.note}`],
    }
  },

  'archive-dest': async (c) => {
    const r = await rows<{ I: number; N: string; S: string; E: string | null; D: string | null; T: string | null }>(
      c.conn,
      `SELECT DEST_ID AS "I", DEST_NAME AS "N", STATUS AS "S", ERROR AS "E", DESTINATION AS "D", TARGET AS "T" FROM V$ARCHIVE_DEST WHERE STATUS NOT IN ('INACTIVE', 'VALID', 'DEFERRED') ORDER BY 1`,
    )
    if (!r.length) return null
    const hints = r.map((x) => {
      const e = x.E ?? ''
      const cause = /ORA-19809|ORA-19804|ORA-19815/.test(e)
        ? 'the fast recovery area is full — see "Fast recovery area usage"'
        : /ORA-12541|ORA-12514|ORA-12154|ORA-16191|ORA-01017|ORA-03113|ORA-03135/.test(e)
          ? 'the standby cannot be reached or rejects the login: check the listener/TNS alias and that the password file matches the primary'
          : /ORA-00270|ORA-19504|ORA-27040|ORA-27037/.test(e)
            ? 'the destination path is missing, not writable or out of space'
            : 'see the error text and the alert log'
      return `-- dest ${x.I} (${x.N} → ${x.D ?? '?'}): ${x.S}${e ? ` ${e}` : ''}\n--   likely cause: ${cause}`
    })
    return {
      why: 'When the database cannot archive a filled log, it can reuse that log only after archiving succeeds: once every group is waiting, the database stops accepting changes. A failing standby destination also means the standby falls behind.',
      impact: { risk: 'low', notes: ['Re-enabling the destination is online.'] },
      steps: [
        check('Read the error per destination', root(c), `${hints.join('\n')}\nSELECT DEST_ID, STATUS, ERROR, DESTINATION FROM V$ARCHIVE_DEST WHERE STATUS NOT IN ('INACTIVE', 'VALID', 'DEFERRED');\nSELECT DEST_ID, STATUS, GAP_STATUS, ERROR FROM V$ARCHIVE_DEST_STATUS WHERE STATUS <> 'INACTIVE';`),
        sql('After fixing the cause, re-enable the destination and archive the current log', root(c), `${r.map((x) => `ALTER SYSTEM SET log_archive_dest_state_${x.I} = 'ENABLE' SCOPE=BOTH SID='*';`).join('\n')}\nALTER SYSTEM ARCHIVE LOG CURRENT;`),
      ],
      verify: check('All active destinations VALID', root(c), `SELECT DEST_ID, DEST_NAME, STATUS, ERROR FROM V$ARCHIVE_DEST WHERE STATUS <> 'INACTIVE' ORDER BY 1;`),
      basedOn: r.map((x) => `${x.N}: ${x.S} ${x.E ?? ''} (${x.D ?? 'no destination'})`.trim()),
    }
  },

  fra: async (c) => {
    const u = await one<{ N: string; L: number; U: number; R: number }>(c.conn, `SELECT NAME AS "N", SPACE_LIMIT AS "L", SPACE_USED AS "U", SPACE_RECLAIMABLE AS "R" FROM V$RECOVERY_FILE_DEST`)
    if (!u?.N || !n(u.L)) {
      const perDay = await redoPerDay(c.conn)
      return {
        why: 'There is no fast recovery area. It gives archived logs, RMAN backups and flashback logs one managed location where Oracle deletes what is obsolete by itself, and it is required for Flashback Database and guaranteed restore points.',
        impact: { risk: 'low', notes: ['Online. Archive destinations that are set explicitly (LOG_ARCHIVE_DEST_n) keep being used; USE_DB_RECOVERY_FILE_DEST is the default only when none is set.'] },
        steps: [sql('Create the fast recovery area (size first, then location)', root(c), `ALTER SYSTEM SET db_recovery_file_dest_size = <<FRA_SIZE>> SCOPE=BOTH SID='*';\nALTER SYSTEM SET db_recovery_file_dest = '<<FRA_LOCATION>>' SCOPE=BOTH SID='*';`)],
        verify: check('Recovery area', root(c), 'SELECT NAME, ROUND(SPACE_LIMIT / 1048576) AS LIMIT_MB, ROUND(SPACE_USED / 1048576) AS USED_MB FROM V$RECOVERY_FILE_DEST;'),
        rollback: sql('Remove it again (only while nothing is stored there)', root(c), "ALTER SYSTEM SET db_recovery_file_dest = '' SCOPE=BOTH SID='*';"),
        basedOn: ['V$RECOVERY_FILE_DEST: not configured', perDay ? `~${fmtBytes(perDay)} of redo per day (V$LOG_HISTORY, last 7 days)` : 'No log switches in the last 7 days'],
        ph: { FRA_SIZE: `size of the recovery area — at least ${niceSize(Math.max(10 * GiB, perDay * 3))} for three days of archived redo, plus backups if they go there` },
      }
    }
    const usage = await rows<{ T: string; P: number; R: number; F: number }>(
      c.conn,
      `SELECT FILE_TYPE AS "T", PERCENT_SPACE_USED AS "P", PERCENT_SPACE_RECLAIMABLE AS "R", NUMBER_OF_FILES AS "F" FROM V$RECOVERY_AREA_USAGE WHERE PERCENT_SPACE_USED > 0 ORDER BY 2 DESC`,
    )
    const standby = n((await tryOne<{ N: number }>(c.conn, `SELECT COUNT(*) AS "N" FROM V$ARCHIVE_DEST WHERE STATUS <> 'INACTIVE' AND TARGET = 'STANDBY'`))?.N)
    const share = (t: string) => n(usage.find((x) => x.T === t)?.P)
    const net = n(u.U) - n(u.R)
    const bigger = niceSize(Math.max(n(u.L) * 1.25, net / 0.7))
    const steps: FixStep[] = [
      rman('Reconcile RMAN with what is really on disk', 'CROSSCHECK ARCHIVELOG ALL;\nCROSSCHECK BACKUP;\nDELETE NOPROMPT EXPIRED ARCHIVELOG ALL;\nDELETE NOPROMPT EXPIRED BACKUP;'),
      rman('Delete backups the retention policy no longer needs', 'SHOW RETENTION POLICY;\nREPORT OBSOLETE;\nDELETE NOPROMPT OBSOLETE;'),
    ]
    if (share('ARCHIVED LOG') >= 20)
      steps.push(
        rman(
          'Delete archived logs that are already backed up',
          `${standby ? 'CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;\n' : ''}DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 1 TIMES TO DEVICE TYPE <<BACKUP_DEVICE>>;`,
        ),
      )
    steps.push(sql('Or give the recovery area more room (only if the disk / disk group has the free space)', root(c), `ALTER SYSTEM SET db_recovery_file_dest_size = ${bigger} SCOPE=BOTH SID='*';`))
    return {
      why: `The fast recovery area is ${((net / n(u.L)) * 100).toFixed(1)}% full after reclaimable space. When it is full, archiving stops and the database hangs; backups and flashback logs written there fail.`,
      impact: { risk: 'medium', notes: ['All steps are online.', 'Deleted backups and archived logs cannot be brought back — check the retention policy first.', ...(share('FLASHBACK LOG') >= 20 ? ['Flashback logs use a large share: lowering DB_FLASHBACK_RETENTION_TARGET also frees space.'] : [])] },
      steps,
      verify: check('Recovery area usage', root(c), `SELECT NAME, ROUND(SPACE_LIMIT / 1048576) AS LIMIT_MB, ROUND(SPACE_USED / 1048576) AS USED_MB, ROUND(SPACE_RECLAIMABLE / 1048576) AS RECLAIMABLE_MB FROM V$RECOVERY_FILE_DEST;\nSELECT FILE_TYPE, PERCENT_SPACE_USED, PERCENT_SPACE_RECLAIMABLE, NUMBER_OF_FILES FROM V$RECOVERY_AREA_USAGE;`),
      rollback: sql('Undo a size change (deleted files cannot be restored)', root(c), `ALTER SYSTEM SET db_recovery_file_dest_size = ${n(u.L)} SCOPE=BOTH SID='*';`),
      basedOn: [`${u.N}: limit ${fmtBytes(n(u.L))}, used ${fmtBytes(n(u.U))}, reclaimable ${fmtBytes(n(u.R))}`, ...usage.map((x) => `${x.T}: ${x.P}% used, ${x.R}% reclaimable (${x.F} files)`), ...(standby ? [`${standby} standby destination(s)`] : [])],
    }
  },

  'tablespace-usage': async (c) => {
    const r = await rows<{ N: string; C: string; BF: string; BS: number; U: number; M: number; P: number; F: number; S: string | null }>(
      c.conn,
      `SELECT m.TABLESPACE_NAME AS "N", t.CONTENTS AS "C", t.BIGFILE AS "BF", t.BLOCK_SIZE AS "BS", m.USED_SPACE * t.BLOCK_SIZE AS "U", m.TABLESPACE_SIZE * t.BLOCK_SIZE AS "M", ROUND(m.USED_PERCENT, 1) AS "P",
              (SELECT COUNT(*) FROM DBA_DATA_FILES f WHERE f.TABLESPACE_NAME = t.TABLESPACE_NAME) + (SELECT COUNT(*) FROM DBA_TEMP_FILES f WHERE f.TABLESPACE_NAME = t.TABLESPACE_NAME) AS "F",
              NVL((SELECT MIN(f.FILE_NAME) FROM DBA_DATA_FILES f WHERE f.TABLESPACE_NAME = t.TABLESPACE_NAME), (SELECT MIN(f.FILE_NAME) FROM DBA_TEMP_FILES f WHERE f.TABLESPACE_NAME = t.TABLESPACE_NAME)) AS "S"
         FROM DBA_TABLESPACE_USAGE_METRICS m JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = m.TABLESPACE_NAME
        WHERE t.CONTENTS <> 'UNDO' AND m.USED_PERCENT >= 85 ORDER BY m.USED_PERCENT DESC`,
    )
    if (!r.length) return null
    const omf = !!(await params(c.conn, ['db_create_file_dest'])).db_create_file_dest
    const fixes = r.map((x) => ({ x, fix: tablespaceFix({ name: x.N, contents: x.C, bigfile: x.BF === 'YES', blockSize: n(x.BS), usedBytes: n(x.U), maxBytes: n(x.M), fileCount: n(x.F), sampleFile: x.S }, omf) }))
    const asm = r.some((x) => x.S && isAsm(x.S))
    const notes = ['Online: adding files or raising MAXSIZE needs no restart.']
    if (r.some((x) => x.N === 'SYSAUX')) notes.push('SYSAUX: see what fills it first (SELECT OCCUPANT_NAME, SPACE_USAGE_KBYTES FROM V$SYSAUX_OCCUPANTS ORDER BY 2 DESC) — often AWR retention or the unified audit trail.')
    if (r.some((x) => x.C === 'TEMPORARY')) notes.push('TEMP usage is transient: check who uses it (V$TEMPSEG_USAGE) before adding space for one runaway query.')
    return {
      why: 'A tablespace at its maximum size makes inserts and index maintenance fail (ORA-01653 / ORA-01654 / ORA-01652). The script adds space so usage drops to about 70% of the new maximum.',
      impact: { risk: 'low', notes },
      prerequisites: [asm ? 'Enough free space in the disk group (see the check below).' : 'Enough free space on the file system that receives the new files.'],
      steps: [
        check('Current files and free space', here(c), `SELECT TABLESPACE_NAME, FILE_NAME, ROUND(BYTES / 1048576) AS MB, AUTOEXTENSIBLE, ROUND(MAXBYTES / 1048576) AS MAX_MB FROM DBA_DATA_FILES WHERE TABLESPACE_NAME IN (${inList(r.map((x) => x.N))}) ORDER BY 1, 2;${asm ? '\nSELECT NAME, TOTAL_MB, FREE_MB, USABLE_FILE_MB FROM V$ASM_DISKGROUP;' : ''}`),
        ...fixes.map(({ x, fix }) => sql(`${x.N}: ${x.P}% of ${fmtBytes(n(x.M))}`, here(c), fix.code)),
      ],
      verify: check('Usage after the change', here(c), `SELECT TABLESPACE_NAME, ROUND(USED_PERCENT, 1) AS USED_PCT FROM DBA_TABLESPACE_USAGE_METRICS WHERE TABLESPACE_NAME IN (${inList(r.map((x) => x.N))});`),
      rollback: sql('An added file that is still empty can be removed again', here(c), `-- ALTER TABLESPACE <name> DROP ${r[0]!.C === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE'} '<file name from DBA_DATA_FILES>';`),
      basedOn: r.map((x) => `${x.N}: ${fmtBytes(n(x.U))} used of ${fmtBytes(n(x.M))} (${x.P}%), ${x.BF === 'YES' ? 'bigfile' : `${n(x.F)} file(s)`}, block ${n(x.BS)}`).concat([omf ? 'DB_CREATE_FILE_DEST set: new files are Oracle-managed' : asm ? 'Files are in ASM: new files go to the same disk group' : 'File system without OMF: the new file names need a directory']),
    }
  },

  'invalid-objects': async (c) => {
    const r = await rows<{ O: string; A: string; N: number }>(
      c.conn,
      `SELECT o.OWNER AS "O", MAX(CASE WHEN ${customUser(c.major, 'u')} THEN 'Y' ELSE 'N' END) AS "A", COUNT(*) AS "N"
         FROM DBA_OBJECTS o LEFT JOIN DBA_USERS u ON u.USERNAME = o.OWNER WHERE o.STATUS <> 'VALID' GROUP BY o.OWNER ORDER BY 3 DESC`,
    )
    if (!r.length) return null
    const app = r.filter((x) => x.A === 'Y')
    const sys = r.filter((x) => x.A !== 'Y')
    const steps: FixStep[] = [check('Compilation errors to fix first', here(c), `SELECT OWNER, NAME, TYPE, LINE, POSITION, TEXT FROM DBA_ERRORS WHERE ATTRIBUTE = 'ERROR' AND OWNER IN (${names(r.map((x) => x.O))}) ORDER BY OWNER, NAME, TYPE, SEQUENCE;`)]
    if (app.length) steps.push(sql('Recompile the invalid objects of the application schemas', here(c, 'a DBA (or each schema owner)'), app.map((x) => `EXEC DBMS_UTILITY.COMPILE_SCHEMA(schema => ${lit(x.O)}, compile_all => FALSE);`).join('\n')))
    if (sys.length) steps.push(sql('Recompile Oracle-maintained objects', here(c, 'SYSDBA'), '@?/rdbms/admin/utlrp.sql'))
    return {
      why: 'Invalid objects recompile on first use, which can fail at runtime (ORA-04063 / ORA-06508) or stall sessions on library-cache locks. Objects that stay invalid after a recompile have real errors (missing objects or grants).',
      impact: { risk: 'low', notes: ['Online; recompiling can briefly wait on objects in use — prefer a quiet moment.'] },
      steps,
      verify: check('What is still invalid', here(c), `SELECT OWNER, OBJECT_TYPE, COUNT(*) FROM DBA_OBJECTS WHERE STATUS <> 'VALID' GROUP BY OWNER, OBJECT_TYPE ORDER BY 1, 2;`),
      basedOn: r.slice(0, 15).map((x) => `${x.O}: ${x.N} invalid${x.A === 'Y' ? '' : ' (Oracle-maintained)'}`),
    }
  },

  registry: async (c) => {
    const r = await rows<{ I: string; N: string; V: string; S: string }>(c.conn, `SELECT COMP_ID AS "I", COMP_NAME AS "N", VERSION AS "V", STATUS AS "S" FROM DBA_REGISTRY WHERE STATUS NOT IN ('VALID', 'OPTION OFF', 'REMOVED')`)
    if (!r.length) return null
    return {
      why: 'A component that is not VALID can break the features built on it and makes the next patch or upgrade fail its prerequisite checks.',
      impact: { risk: 'medium', notes: ['utlrp is online. If datapatch is needed, follow the Release Update README.'] },
      steps: [
        sql('Recompile everything and re-validate the components', here(c, 'SYSDBA'), '@?/rdbms/admin/utlrp.sql'),
        check('Component status and the last SQL patch actions', here(c, 'SYSDBA'), `SELECT COMP_ID, VERSION, STATUS FROM DBA_REGISTRY ORDER BY 1;${c.major >= 12 ? '\nSELECT PATCH_ID, ACTION, STATUS, ACTION_TIME, DESCRIPTION FROM DBA_REGISTRY_SQLPATCH ORDER BY ACTION_TIME DESC;' : ''}`),
        shell('Still invalid and a SQL patch shows an error: re-run datapatch', 'oracle OS user', '$ORACLE_HOME/OPatch/datapatch -verbose'),
      ],
      verify: check('No component left in a bad state', here(c), `SELECT COMP_ID, STATUS FROM DBA_REGISTRY WHERE STATUS NOT IN ('VALID', 'OPTION OFF', 'REMOVED');`),
      basedOn: r.map((x) => `${x.I} (${x.N}) ${x.V}: ${x.S}`),
      prerequisites: ['If a component stays invalid, search My Oracle Support for its validation procedure — the cause differs per component.'],
    }
  },

  'default-passwords': async (c) => {
    const r = await rows<{ U: string; C: string }>(c.conn, `SELECT d.USERNAME AS "U", ${cdbCol(c, 'u.COMMON')} AS "C" FROM DBA_USERS_WITH_DEFPWD d JOIN DBA_USERS u ON u.USERNAME = d.USERNAME WHERE u.ACCOUNT_STATUS = 'OPEN' ORDER BY 1`)
    if (!r.length) return null
    const mustStay = new Set(['SYS', 'SYSTEM'])
    const line = (x: { U: string; C: string }) => {
      const cont = c.cdb && x.C === 'YES' ? ' CONTAINER = ALL' : ''
      return mustStay.has(x.U) ? `ALTER USER ${qi(x.U)} IDENTIFIED BY "<<NEW_PASSWORD>>"${cont};` : `ALTER USER ${qi(x.U)} ACCOUNT LOCK PASSWORD EXPIRE${cont};`
    }
    const local = r.filter((x) => !(c.cdb && x.C === 'YES'))
    const common = r.filter((x) => c.cdb && x.C === 'YES')
    const steps: FixStep[] = []
    if (local.length) steps.push(sql('Lock the accounts (SYS/SYSTEM: change the password instead)', here(c), local.map(line).join('\n')))
    if (common.length) steps.push(sql('Common accounts: from the root, for every container', root(c), common.map(line).join('\n')))
    return {
      why: 'Default passwords are public knowledge; an OPEN account with one is a login for anybody who can reach the listener.',
      impact: { risk: 'medium', notes: ['If an application logs in with one of these accounts, give it a new password (ALTER USER … IDENTIFIED BY …) and update the application instead of locking it.', ...(r.some((x) => x.U === 'SYS') ? ['After changing the SYS password, copy the password file to every standby / RAC node.'] : [])] },
      steps,
      verify: check('Accounts that still have a default password', here(c), `SELECT d.USERNAME, u.ACCOUNT_STATUS FROM DBA_USERS_WITH_DEFPWD d JOIN DBA_USERS u ON u.USERNAME = d.USERNAME ORDER BY 1;`),
      rollback: sql('Reopen an account (it stays EXPIRED: a new password is required at login)', here(c), r.filter((x) => !mustStay.has(x.U)).map((x) => `ALTER USER ${qi(x.U)} ACCOUNT UNLOCK;`).join('\n')),
      basedOn: r.map((x) => `${x.U}: OPEN with default password${x.C === 'YES' ? ' (common user)' : ''}`),
    }
  },

  'password-policy': async (c) => {
    const used = await rows<{ P: string; N: number }>(c.conn, `SELECT u.PROFILE AS "P", COUNT(*) AS "N" FROM DBA_USERS u WHERE u.ACCOUNT_STATUS = 'OPEN' AND ${customUser(c.major, 'u')} GROUP BY u.PROFILE ORDER BY 1`)
    const lim = await rows<{ P: string; R: PasswordLimit; L: string; C: string }>(
      c.conn,
      `SELECT PROFILE AS "P", RESOURCE_NAME AS "R", LIMIT AS "L", ${cdbCol(c, 'COMMON')} AS "C" FROM DBA_PROFILES WHERE RESOURCE_NAME IN ('FAILED_LOGIN_ATTEMPTS', 'PASSWORD_LIFE_TIME', 'PASSWORD_VERIFY_FUNCTION')`,
    )
    const raw = (p: string, r: PasswordLimit) => lim.find((x) => x.P === p && x.R === r)?.L ?? null
    const eff = (p: string, r: PasswordLimit) => {
      const v = raw(p, r)
      return v === 'DEFAULT' || v == null ? raw('DEFAULT', r) : v
    }
    const keys: PasswordLimit[] = ['FAILED_LOGIN_ATTEMPTS', 'PASSWORD_VERIFY_FUNCTION', 'PASSWORD_LIFE_TIME']
    const facts: ProfileFact[] = used.map(({ P }) => ({
      profile: P,
      common: c.cdb && /^C##/i.test(P) && lim.some((x) => x.P === P && x.C === 'YES'),
      raw: Object.fromEntries(keys.map((k) => [k, raw(P, k)])) as ProfileFact['raw'],
      eff: Object.fromEntries(keys.map((k) => [k, eff(P, k)])) as ProfileFact['eff'],
    }))
    const fns = (await rows<{ N: string }>(c.conn, `SELECT OBJECT_NAME AS "N" FROM DBA_OBJECTS WHERE OWNER = 'SYS' AND OBJECT_TYPE = 'FUNCTION' AND STATUS = 'VALID' AND OBJECT_NAME IN ('ORA12C_VERIFY_FUNCTION', 'VERIFY_FUNCTION_11G')`)).map((x) => x.N)
    const needFn = facts.some((p) => !p.eff.PASSWORD_VERIFY_FUNCTION || p.eff.PASSWORD_VERIFY_FUNCTION === 'NULL')
    const fn = fns.includes('ORA12C_VERIFY_FUNCTION') ? 'ORA12C_VERIFY_FUNCTION' : fns.includes('VERIFY_FUNCTION_11G') ? 'VERIFY_FUNCTION_11G' : null
    const useFn = fn ?? (c.major >= 12 ? 'ORA12C_VERIFY_FUNCTION' : 'VERIFY_FUNCTION_11G')
    const scripts = facts.map((p) => ({ p, s: profileScript(p, useFn) })).filter((x) => x.s.code)
    if (!scripts.length) return null
    const steps: FixStep[] = []
    if (needFn && !fn) steps.push(sql('Create Oracle\'s password verify functions (this script also sets them on the DEFAULT profile)', here(c, 'SYSDBA'), '@?/rdbms/admin/utlpwdmg.sql'))
    const local = scripts.filter((x) => !x.p.common)
    const common = scripts.filter((x) => x.p.common)
    if (local.length) steps.push(sql('Harden the profiles used by open application accounts', here(c), local.map((x) => x.s.code).join('\n')))
    if (common.length) steps.push(sql('Common profiles: from the root', root(c), common.map((x) => x.s.code).join('\n')))
    return {
      why: 'Without FAILED_LOGIN_ATTEMPTS a password can be guessed without limit; without a verify function users can set trivial passwords.',
      impact: { risk: 'medium', notes: ['The verify function only checks passwords set from now on.', 'A misconfigured client that keeps retrying with a wrong password will now lock its account — check connection pools and job credentials first.'] },
      steps,
      verify: check('Limits of the profiles', here(c), `SELECT PROFILE, RESOURCE_NAME, LIMIT FROM DBA_PROFILES WHERE PROFILE IN (${inList([...new Set(scripts.map((x) => x.p.profile).concat('DEFAULT'))])}) AND RESOURCE_TYPE = 'PASSWORD' ORDER BY 1, 2;`),
      rollback: sql('Previous limits', here(c), scripts.map((x) => x.s.rollback).filter(Boolean).join('\n')),
      basedOn: facts.map((p) => `${p.profile} (${used.find((u) => u.P === p.profile)?.N} open user(s)): FAILED_LOGIN_ATTEMPTS ${p.eff.FAILED_LOGIN_ATTEMPTS}, PASSWORD_VERIFY_FUNCTION ${p.eff.PASSWORD_VERIFY_FUNCTION}, PASSWORD_LIFE_TIME ${p.eff.PASSWORD_LIFE_TIME}`).concat([fn ? `${fn} exists` : 'No Oracle verify function installed yet']),
    }
  },

  'dba-grants': async (c) => {
    const r = await rows<{ G: string; A: string; C: string; K: string; T: string | null }>(
      c.conn,
      `SELECT DISTINCT p.GRANTEE AS "G", p.ADMIN_OPTION AS "A", ${cdbCol(c, 'p.COMMON')} AS "C", CASE WHEN u.USERNAME IS NULL THEN 'ROLE' ELSE 'USER' END AS "K", u.DEFAULT_TABLESPACE AS "T"
         FROM DBA_ROLE_PRIVS p LEFT JOIN DBA_USERS u ON u.USERNAME = p.GRANTEE WHERE p.GRANTED_ROLE = 'DBA' AND ${customGrantee(c.major, 'p.GRANTEE')} ORDER BY 1`,
    )
    if (!r.length) return null
    const users = r.filter((x) => x.K === 'USER')
    const segs = await rows<{ O: string; T: string }>(c.conn, `SELECT OWNER AS "O", TABLESPACE_NAME AS "T" FROM DBA_SEGMENTS WHERE OWNER IN (${names(users.map((x) => x.G))}) AND TABLESPACE_NAME IS NOT NULL GROUP BY OWNER, TABLESPACE_NAME ORDER BY 1, 2`)
    const quota = users.flatMap((u) => {
      const ts = [...new Set([...segs.filter((s) => s.O === u.G).map((s) => s.T), ...(segs.some((s) => s.O === u.G) && u.T ? [u.T] : [])])]
      return ts.map((t) => `ALTER USER ${qi(u.G)} QUOTA UNLIMITED ON ${qi(t)};`)
    })
    const grants: GrantFact[] = r.map((x) => ({ grantee: x.G, privilege: 'DBA', adminOption: x.A === 'YES', common: c.cdb && x.C === 'YES' }))
    const rv = revokeScript(grants)
    const capture = c.ee && c.major >= 12
    const list = names(r.map((x) => x.G))
    const steps: FixStep[] = []
    if (capture) {
      steps.push(
        sql(
          'Start capturing which DBA privileges are really used (Privilege Analysis)',
          here(c, 'a user with the CAPTURE_ADMIN role'),
          `BEGIN\n  DBMS_PRIVILEGE_CAPTURE.CREATE_CAPTURE(\n    name        => 'ODL_DBA_ROLE_USE',\n    description => 'Privileges of the DBA role in use',\n    type        => DBMS_PRIVILEGE_CAPTURE.G_ROLE,\n    roles       => ROLE_NAME_LIST('DBA'));\n  DBMS_PRIVILEGE_CAPTURE.ENABLE_CAPTURE('ODL_DBA_ROLE_USE');\nEND;\n/`,
        ),
        sql(
          'After a representative period (a full business cycle, month-end included): stop the capture and list what was used',
          here(c, 'a user with the CAPTURE_ADMIN role'),
          `EXEC DBMS_PRIVILEGE_CAPTURE.DISABLE_CAPTURE('ODL_DBA_ROLE_USE');\nEXEC DBMS_PRIVILEGE_CAPTURE.GENERATE_RESULT('ODL_DBA_ROLE_USE');\nSELECT USERNAME, SYS_PRIV, OBJ_PRIV, OBJECT_OWNER, OBJECT_NAME, COUNT(*) AS USES\n  FROM DBA_USED_PRIVS WHERE CAPTURE = 'ODL_DBA_ROLE_USE'${users.length === r.length ? ` AND USERNAME IN (${list})` : ''}\n GROUP BY USERNAME, SYS_PRIV, OBJ_PRIV, OBJECT_OWNER, OBJECT_NAME ORDER BY 1, 2, 3;`,
        ),
      )
    }
    steps.push(sql('Grant only what is needed', here(c), r.map((x) => `-- GRANT <<PRIVILEGES_FROM_STEP_2>> TO ${qi(x.G)};`).join('\n')))
    if (quota.length) steps.push(sql('Keep the space the users already own writable (revoking DBA can also take away UNLIMITED TABLESPACE)', here(c), quota.join('\n')))
    if (rv.local) steps.push(sql('Revoke the DBA role', here(c), rv.local))
    if (rv.common) steps.push(sql('Revoke common grants (from the root, for all containers)', root(c), rv.common))
    if (capture) steps.push(sql('Remove the capture when done', here(c, 'a user with the CAPTURE_ADMIN role'), "EXEC DBMS_PRIVILEGE_CAPTURE.DROP_CAPTURE('ODL_DBA_ROLE_USE');"))
    const self = r.some((x) => x.G === c.sessionUser)
    return {
      why: 'DBA lets an account read and change every schema, create users and alter the database. An application account with DBA turns any SQL injection or leaked password into full control of the database.',
      impact: {
        risk: 'high',
        notes: [
          'Applications break if they silently relied on DBA privileges — that is what the capture is for.',
          ...(capture ? ['Privilege Analysis is part of Enterprise Edition (no extra option since 2018) and adds little overhead.'] : ['No Privilege Analysis here: review the application code, jobs and audit records before revoking.']),
          ...(self ? [`${c.sessionUser} is the account this app connects with: after the revoke, give it the monitoring grants from sql/admin/ or assessment panels become unavailable.`] : []),
        ],
      },
      steps,
      verify: check('Who still holds DBA', here(c), `SELECT GRANTEE, ADMIN_OPTION FROM DBA_ROLE_PRIVS WHERE GRANTED_ROLE = 'DBA' AND GRANTEE IN (${list});`),
      rollback: sql('Give DBA back', rv.undoCommon && !rv.undoLocal ? root(c) : here(c), [rv.undoLocal, rv.undoCommon ? `-- from CDB$ROOT:\n${rv.undoCommon}` : ''].filter(Boolean).join('\n')),
      basedOn: r.map((x) => `${x.G} (${x.K.toLowerCase()})${x.A === 'YES' ? ' WITH ADMIN OPTION' : ''}${x.C === 'YES' ? ', common grant' : ''}`),
    }
  },

  'any-privileges': async (c) => {
    const r = await rows<{ G: string; P: string; A: string; C: string }>(
      c.conn,
      `SELECT GRANTEE AS "G", PRIVILEGE AS "P", ADMIN_OPTION AS "A", ${cdbCol(c, 'COMMON')} AS "C" FROM DBA_SYS_PRIVS WHERE (PRIVILEGE LIKE '% ANY %' OR PRIVILEGE LIKE '% ANY') AND ${customGrantee(c.major, 'GRANTEE')} ORDER BY 1, 2`,
    )
    if (!r.length) return null
    const grants: GrantFact[] = r.map((x) => ({
      grantee: x.G,
      privilege: x.P,
      adminOption: x.A === 'YES',
      common: c.cdb && x.C === 'YES',
      keep: x.P === 'SELECT ANY DICTIONARY' ? 'monitoring accounts need this one — revoke only if this account does no monitoring' : x.G === c.sessionUser ? 'this app connects with this account' : undefined,
    }))
    const rv = revokeScript(grants)
    const list = names([...new Set(r.map((x) => x.G))])
    const capture = c.ee && c.major >= 12
    const steps: FixStep[] = []
    if (capture)
      steps.push(
        sql('Capture privilege use for a representative period (Privilege Analysis)', here(c, 'a user with the CAPTURE_ADMIN role'), `BEGIN\n  DBMS_PRIVILEGE_CAPTURE.CREATE_CAPTURE(name => 'ODL_ANY_PRIV_USE', type => DBMS_PRIVILEGE_CAPTURE.G_DATABASE);\n  DBMS_PRIVILEGE_CAPTURE.ENABLE_CAPTURE('ODL_ANY_PRIV_USE');\nEND;\n/`),
        sql(
          'Stop it and generate object grants for the ANY privileges that were used',
          here(c, 'a user with the CAPTURE_ADMIN role'),
          `EXEC DBMS_PRIVILEGE_CAPTURE.DISABLE_CAPTURE('ODL_ANY_PRIV_USE');\nEXEC DBMS_PRIVILEGE_CAPTURE.GENERATE_RESULT('ODL_ANY_PRIV_USE');\n-- Review this output; run the GRANTs you agree with:\nSELECT DISTINCT 'GRANT ' || CASE SYS_PRIV WHEN 'EXECUTE ANY PROCEDURE' THEN 'EXECUTE' ELSE REGEXP_SUBSTR(SYS_PRIV, '^[A-Z]+') END\n       || ' ON "' || OBJECT_OWNER || '"."' || OBJECT_NAME || '" TO "' || USERNAME || '";' AS GRANT_STMT\n  FROM DBA_USED_PRIVS\n WHERE CAPTURE = 'ODL_ANY_PRIV_USE' AND OBJECT_NAME IS NOT NULL\n   AND SYS_PRIV IN ('SELECT ANY TABLE', 'READ ANY TABLE', 'INSERT ANY TABLE', 'UPDATE ANY TABLE', 'DELETE ANY TABLE', 'EXECUTE ANY PROCEDURE', 'SELECT ANY SEQUENCE')\n   AND (USERNAME IN (${list}) OR USED_ROLE IN (${list}))\n ORDER BY 1;`,
        ),
      )
    if (rv.local) steps.push(sql('Revoke the ANY privileges (after the object grants are in place)', here(c), rv.local))
    if (rv.common) steps.push(sql('Revoke common grants (from the root, for all containers)', root(c), rv.common))
    if (capture) steps.push(sql('Remove the capture', here(c, 'a user with the CAPTURE_ADMIN role'), "EXEC DBMS_PRIVILEGE_CAPTURE.DROP_CAPTURE('ODL_ANY_PRIV_USE');"))
    return {
      why: '"ANY" privileges apply to every schema, including SYS-owned objects in some cases. Object-level grants give the same access to the objects really used and nothing else.',
      impact: { risk: 'high', notes: ['Revoking breaks code that relied on the privilege — replace it with object grants first.', 'Definer-rights PL/SQL needs direct grants (privileges through roles do not count inside it).'] },
      steps,
      verify: check('Remaining ANY privileges', here(c), `SELECT GRANTEE, PRIVILEGE FROM DBA_SYS_PRIVS WHERE GRANTEE IN (${list}) AND PRIVILEGE LIKE '% ANY%' ORDER BY 1, 2;`),
      rollback: sql('Give the privileges back', here(c), [rv.undoLocal, rv.undoCommon ? `-- from CDB$ROOT:\n${rv.undoCommon}` : ''].filter(Boolean).join('\n')),
      basedOn: r.slice(0, 40).map((x) => `${x.G}: ${x.P}${x.A === 'YES' ? ' WITH ADMIN OPTION' : ''}${x.C === 'YES' ? ' (common)' : ''}`),
    }
  },

  'public-packages': async (c) => {
    const g = await rows<{ T: string; C: string }>(
      c.conn,
      `SELECT TABLE_NAME AS "T", MAX(${cdbCol(c, 'COMMON')}) AS "C" FROM DBA_TAB_PRIVS WHERE GRANTEE = 'PUBLIC' AND OWNER = 'SYS' AND PRIVILEGE = 'EXECUTE' AND TABLE_NAME IN (${inList(SENSITIVE_PACKAGES)}) GROUP BY TABLE_NAME ORDER BY 1`,
    )
    if (!g.length) return null
    const deps = await rows<{ P: string; O: string }>(
      c.conn,
      `SELECT DISTINCT d.REFERENCED_NAME AS "P", d.OWNER AS "O" FROM DBA_DEPENDENCIES d
        WHERE d.REFERENCED_OWNER IN ('SYS', 'PUBLIC') AND d.REFERENCED_NAME IN (${inList(g.map((x) => x.T))}) AND d.OWNER NOT IN ('SYS', 'PUBLIC')
          AND NOT EXISTS (SELECT 1 FROM DBA_TAB_PRIVS p WHERE p.GRANTEE = d.OWNER AND p.OWNER = 'SYS' AND p.TABLE_NAME = d.REFERENCED_NAME AND p.PRIVILEGE = 'EXECUTE')
        ORDER BY 1, 2`,
    )
    const facts = g.map((x) => ({ pkg: x.T, common: c.cdb && x.C === 'YES', dependents: deps.filter((d) => d.P === x.T).map((d) => d.O) }))
    const s = publicRevokeScript(facts)
    const steps: FixStep[] = []
    if (s.grants) steps.push(sql('Grant the packages directly to the schemas whose code uses them', here(c, 'SYSDBA'), s.grants))
    if (s.revokeLocal) steps.push(sql('Revoke from PUBLIC', here(c, 'SYSDBA'), s.revokeLocal))
    if (s.revokeCommon) steps.push(sql('Revoke the common grants from PUBLIC (from the root: affects every PDB — repeat the direct grants in each PDB first)', root(c), s.revokeCommon))
    steps.push(sql('Recompile and check nothing broke', here(c, 'SYSDBA'), "@?/rdbms/admin/utlrp.sql\nSELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM DBA_OBJECTS WHERE STATUS <> 'VALID' ORDER BY 1, 2;\nSELECT COMP_ID, STATUS FROM DBA_REGISTRY ORDER BY 1;"))
    return {
      why: 'Through PUBLIC every account can use these packages: UTL_FILE/UTL_HTTP/UTL_TCP and friends read files on the server or open network connections, a classic route for data exfiltration. CIS benchmarks recommend direct grants to the schemas that need them.',
      impact: { risk: 'high', notes: ['DBA_DEPENDENCIES only shows stored code; dynamic SQL and anonymous blocks sent by applications are not listed — test the applications.', 'Only the network/file packages are active lines; the others are commented until tested.'] },
      steps,
      verify: check('What PUBLIC can still execute', here(c), `SELECT TABLE_NAME FROM DBA_TAB_PRIVS WHERE GRANTEE = 'PUBLIC' AND OWNER = 'SYS' AND PRIVILEGE = 'EXECUTE' AND TABLE_NAME IN (${inList(g.map((x) => x.T))}) ORDER BY 1;`),
      rollback: sql('Restore the PUBLIC grants', s.restoreCommon && !s.restoreLocal ? root(c) : here(c, 'SYSDBA'), [s.restoreLocal, s.restoreCommon ? `-- from CDB$ROOT:\n${s.restoreCommon}` : ''].filter(Boolean).join('\n')),
      basedOn: facts.map((p) => `${p.pkg}${p.common ? ' (common grant)' : ''}: ${p.dependents.length ? `used by ${p.dependents.join(', ')}` : 'no stored code depends on it'}`),
    }
  },

  'system-default-ts': async (c) => {
    const r = await rows<{ U: string; T: string; S: number; UL: number }>(
      c.conn,
      `SELECT u.USERNAME AS "U", u.DEFAULT_TABLESPACE AS "T", (SELECT COUNT(*) FROM DBA_SEGMENTS s WHERE s.OWNER = u.USERNAME) AS "S",
              (SELECT COUNT(*) FROM DBA_SYS_PRIVS p WHERE p.GRANTEE = u.USERNAME AND p.PRIVILEGE = 'UNLIMITED TABLESPACE') AS "UL"
         FROM DBA_USERS u WHERE u.DEFAULT_TABLESPACE IN ('SYSTEM', 'SYSAUX') AND ${customUser(c.major, 'u')} ORDER BY 1`,
    )
    if (!r.length) return null
    const def = (await one<{ V: string }>(c.conn, `SELECT PROPERTY_VALUE AS "V" FROM DATABASE_PROPERTIES WHERE PROPERTY_NAME = 'DEFAULT_PERMANENT_TABLESPACE'`))?.V ?? null
    const hasUsers = !!(await one(c.conn, `SELECT 1 AS "X" FROM DBA_TABLESPACES WHERE TABLESPACE_NAME = 'USERS' AND CONTENTS = 'PERMANENT'`))
    const sysDef = !def || ['SYSTEM', 'SYSAUX'].includes(def)
    const target = !sysDef ? def! : hasUsers ? 'USERS' : '<<APP_TABLESPACE>>'
    const t = target.startsWith('<<') ? target : qi(target)
    const lines = r.flatMap((x) => [`ALTER USER ${qi(x.U)} DEFAULT TABLESPACE ${t};`, ...(n(x.S) && !n(x.UL) ? [`ALTER USER ${qi(x.U)} QUOTA UNLIMITED ON ${t};   -- it creates objects; or a fixed quota, e.g. QUOTA 10G`] : [])])
    const steps: FixStep[] = []
    if (sysDef) steps.push(sql('Make the database default for new users a normal tablespace', here(c), `ALTER DATABASE DEFAULT TABLESPACE ${t};`))
    steps.push(sql('Point the users at it', here(c), lines.join('\n')))
    return {
      why: 'Application segments in SYSTEM/SYSAUX compete with the data dictionary for space: if SYSTEM fills up, the whole database stops working, and dictionary maintenance becomes harder.',
      impact: { risk: 'low', notes: ['Only new segments go to the new default; existing ones stay where they are (see "Application segments in SYSTEM/SYSAUX").'] },
      steps,
      verify: check('Default tablespaces', here(c), `SELECT USERNAME, DEFAULT_TABLESPACE FROM DBA_USERS WHERE USERNAME IN (${names(r.map((x) => x.U))}) ORDER BY 1;`),
      rollback: sql('Previous defaults', here(c), r.map((x) => `ALTER USER ${qi(x.U)} DEFAULT TABLESPACE ${qi(x.T)};`).join('\n')),
      basedOn: r.map((x) => `${x.U} → ${x.T}${n(x.S) ? `, owns ${x.S} segment(s)` : ''}`).concat([`Database default permanent tablespace: ${def ?? 'unknown'}`]),
    }
  },

  'system-segments': async (c) => {
    const seg = await rows<{ O: string; N: string; P: string | null; Y: string; T: string; B: number; LT: string | null; LC: string | null; IT: string | null; IY: string | null }>(
      c.conn,
      `SELECT * FROM (
         SELECT s.OWNER AS "O", s.SEGMENT_NAME AS "N", s.PARTITION_NAME AS "P", s.SEGMENT_TYPE AS "Y", s.TABLESPACE_NAME AS "T", s.BYTES AS "B",
                l.TABLE_NAME AS "LT", l.COLUMN_NAME AS "LC", i.TABLE_NAME AS "IT", i.INDEX_TYPE AS "IY"
           FROM DBA_SEGMENTS s
           LEFT JOIN DBA_LOBS l ON l.OWNER = s.OWNER AND l.SEGMENT_NAME = s.SEGMENT_NAME
           LEFT JOIN DBA_INDEXES i ON i.OWNER = s.OWNER AND i.INDEX_NAME = s.SEGMENT_NAME
          WHERE s.TABLESPACE_NAME IN ('SYSTEM', 'SYSAUX') AND ${customOwner(c.major, 's.OWNER')}
          ORDER BY s.BYTES DESC)
        WHERE ROWNUM <= 300`,
    )
    if (!seg.length) return null
    const owners = [...new Set(seg.map((s) => s.O))]
    const defs = await rows<{ U: string; T: string }>(c.conn, `SELECT USERNAME AS "U", DEFAULT_TABLESPACE AS "T" FROM DBA_USERS WHERE USERNAME IN (${names(owners)})`)
    const ts = (o: string) => {
      const t = defs.find((d) => d.U === o)?.T
      return t && !['SYSTEM', 'SYSAUX'].includes(t) ? qi(t) : '<<APP_TABLESPACE>>'
    }
    const onlineMove = c.ee && c.version >= 1202000000
    const onlineIx = c.ee ? ' ONLINE' : ''
    const tables = new Map<string, { o: string; t: string; move: boolean; lobs: string[] }>()
    const entry = (o: string, t: string) => tables.get(`${o}.${t}`) ?? tables.set(`${o}.${t}`, { o, t, move: false, lobs: [] }).get(`${o}.${t}`)!
    const other: string[] = []
    const indexes: string[] = []
    for (const s of seg) {
      if (s.Y === 'TABLE') entry(s.O, s.N).move = true
      else if (s.Y === 'LOBSEGMENT' && s.LT && s.LC) entry(s.O, s.LT).lobs.push(s.LC)
      else if (s.Y === 'LOBINDEX') continue // moves with its LOB segment
      else if (s.Y === 'INDEX' && s.IY === 'IOT - TOP' && s.IT) other.push(`ALTER TABLE ${qn(s.O, s.IT)} MOVE${onlineIx} TABLESPACE ${ts(s.O)};`)
      else if (s.Y === 'INDEX') indexes.push(`ALTER INDEX ${qn(s.O, s.N)} REBUILD TABLESPACE ${ts(s.O)}${onlineIx};`)
      else if (s.Y === 'INDEX PARTITION' && s.P) indexes.push(`ALTER INDEX ${qn(s.O, s.N)} REBUILD PARTITION ${qi(s.P)} TABLESPACE ${ts(s.O)}${onlineIx};`)
      else if (s.Y === 'TABLE PARTITION' && s.P) other.push(`ALTER TABLE ${qn(s.O, s.N)} MOVE PARTITION ${qi(s.P)} TABLESPACE ${ts(s.O)} UPDATE INDEXES${c.ee && c.major >= 12 ? ' ONLINE' : ''};`)
      else other.push(`-- ${s.Y} ${s.O}.${s.N}${s.P ? ` (${s.P})` : ''}: move manually (see ALTER TABLE … MOVE in the SQL reference)`)
    }
    const moves = [...tables.values()].map((x) =>
      ['ALTER TABLE', qn(x.o, x.t), 'MOVE', onlineMove ? 'ONLINE' : null, x.move ? `TABLESPACE ${ts(x.o)}` : null, ...x.lobs.map((l) => `LOB (${qi(l)}) STORE AS (TABLESPACE ${ts(x.o)})`)].filter(Boolean).join(' ') + ';',
    )
    const steps: FixStep[] = [sql('Move tables, LOBs and partitions', here(c), [...moves, ...other].join('\n'))]
    if (indexes.length) steps.push(sql('Rebuild indexes into the new tablespace', here(c), indexes.join('\n')))
    if (!onlineMove)
      steps.push(
        check('Offline moves leave the table\'s other indexes UNUSABLE: generate their rebuilds', here(c), `SELECT 'ALTER INDEX "' || OWNER || '"."' || INDEX_NAME || '" REBUILD${onlineIx};' FROM DBA_INDEXES WHERE STATUS = 'UNUSABLE' AND OWNER IN (${names(owners)})\nUNION ALL\nSELECT 'ALTER INDEX "' || INDEX_OWNER || '"."' || INDEX_NAME || '" REBUILD PARTITION "' || PARTITION_NAME || '"${onlineIx};' FROM DBA_IND_PARTITIONS WHERE STATUS = 'UNUSABLE' AND INDEX_OWNER IN (${names(owners)});`),
      )
    return {
      why: 'Application data in SYSTEM/SYSAUX can fill the tablespace the data dictionary needs and mixes application and Oracle internals in backups, space management and transport.',
      impact: {
        downtime: !onlineMove,
        enterpriseOnly: false,
        risk: 'medium',
        notes: [
          onlineMove ? 'MOVE ONLINE (12.2+, Enterprise Edition) keeps the tables usable and maintains their indexes.' : 'Without ONLINE moves the table is locked while it is copied and its indexes become UNUSABLE until rebuilt — use a maintenance window.',
          'Each move needs free space for a full copy of the segment in the target tablespace.',
          'Tables with LONG columns cannot be moved this way (export/import them).',
        ],
      },
      prerequisites: owners.some((o) => ts(o).startsWith('<<')) ? ['Pick the target tablespace for owners whose default is SYSTEM/SYSAUX (see "Application users defaulting to SYSTEM/SYSAUX").'] : [],
      steps,
      verify: check('What is left in SYSTEM/SYSAUX', here(c), `SELECT OWNER, SEGMENT_TYPE, COUNT(*), ROUND(SUM(BYTES) / 1048576) AS MB FROM DBA_SEGMENTS WHERE TABLESPACE_NAME IN ('SYSTEM', 'SYSAUX') AND OWNER IN (${names(owners)}) GROUP BY OWNER, SEGMENT_TYPE ORDER BY 1, 2;`),
      basedOn: owners.map((o) => `${o}: ${seg.filter((s) => s.O === o).length} segment(s), ${fmtBytes(seg.filter((s) => s.O === o).reduce((a, s) => a + n(s.B), 0))} → ${ts(o)}`),
    }
  },

  stats: async (c) => {
    const r = await rows<{ O: string; M: number; S: number; L: number; T: number }>(
      c.conn,
      `SELECT * FROM (
         SELECT s.OWNER AS "O", SUM(CASE WHEN s.LAST_ANALYZED IS NULL THEN 1 ELSE 0 END) AS "M", SUM(CASE WHEN s.STALE_STATS = 'YES' THEN 1 ELSE 0 END) AS "S",
                SUM(CASE WHEN s.STATTYPE_LOCKED IS NOT NULL THEN 1 ELSE 0 END) AS "L", COUNT(*) AS "T"
           FROM DBA_TAB_STATISTICS s WHERE s.OBJECT_TYPE = 'TABLE' AND ${customOwner(c.major, 's.OWNER')} AND s.TABLE_NAME NOT LIKE 'BIN$%'
          GROUP BY s.OWNER HAVING SUM(CASE WHEN s.LAST_ANALYZED IS NULL OR s.STALE_STATS = 'YES' THEN 1 ELSE 0 END) > 0
          ORDER BY SUM(CASE WHEN s.LAST_ANALYZED IS NULL OR s.STALE_STATS = 'YES' THEN 1 ELSE 0 END) DESC)
        WHERE ROWNUM <= 40`,
    )
    if (!r.length) return null
    const locked = r.filter((x) => n(x.L))
    const steps: FixStep[] = [sql('Gather missing and stale statistics per schema', here(c, 'a DBA (or each schema owner)'), r.map((x) => `EXEC DBMS_STATS.GATHER_SCHEMA_STATS(ownname => ${lit(x.O)}, options => 'GATHER AUTO');`).join('\n'))]
    if (locked.length) steps.push(check('Tables with locked statistics are skipped — confirm the locks are intentional', here(c), `SELECT OWNER, TABLE_NAME, STATTYPE_LOCKED, LAST_ANALYZED FROM DBA_TAB_STATISTICS WHERE STATTYPE_LOCKED IS NOT NULL AND OWNER IN (${names(locked.map((x) => x.O))}) ORDER BY 1, 2;`))
    return {
      why: 'The optimizer chooses plans from statistics: missing or stale ones make it misjudge row counts, which is the most common cause of a sudden slow plan.',
      impact: {
        risk: 'medium',
        notes: [
          'New statistics can change execution plans (usually for the better). On critical systems gather as pending first: DBMS_STATS.SET_SCHEMA_PREFS(owner, \'PUBLISH\', \'FALSE\') → gather → test with OPTIMIZER_USE_PENDING_STATISTICS → DBMS_STATS.PUBLISH_PENDING_STATS.',
          'Gathering reads the tables: run it outside peak hours.',
        ],
      },
      steps,
      verify: check('Still missing or stale', here(c), `SELECT OWNER, COUNT(*) FROM DBA_TAB_STATISTICS WHERE OBJECT_TYPE = 'TABLE' AND OWNER IN (${names(r.map((x) => x.O))}) AND (LAST_ANALYZED IS NULL OR STALE_STATS = 'YES') GROUP BY OWNER ORDER BY 1;`),
      rollback: sql('Restore the previous statistics (history is kept 31 days by default)', here(c), r.map((x) => `EXEC DBMS_STATS.RESTORE_SCHEMA_STATS(ownname => ${lit(x.O)}, as_of_timestamp => SYSTIMESTAMP - INTERVAL '1' HOUR);   -- adjust to just before the gather`).join('\n')),
      basedOn: r.map((x) => `${x.O}: ${x.M} missing, ${x.S} stale of ${x.T} tables${n(x.L) ? `, ${x.L} locked` : ''}`),
    }
  },

  'autotask-stats': async (c) => ({
    why: 'The automatic statistics task keeps optimizer statistics fresh in the maintenance windows. With it disabled, statistics go stale unless your own jobs gather them.',
    impact: { risk: 'low', notes: ['If your own statistics jobs cover every schema, it can stay disabled on purpose.'] },
    steps: [
      check('Maintenance windows (the task runs in these)', here(c), `SELECT WINDOW_NAME, ENABLED, REPEAT_INTERVAL, DURATION, NEXT_START_DATE FROM DBA_SCHEDULER_WINDOWS ORDER BY 1;\nSELECT CLIENT_NAME, STATUS FROM DBA_AUTOTASK_CLIENT ORDER BY 1;`),
      sql('Enable automatic optimizer statistics collection', here(c), "EXEC DBMS_AUTO_TASK_ADMIN.ENABLE(client_name => 'auto optimizer stats collection', operation => NULL, window_name => NULL);"),
    ],
    verify: check('Task status', here(c), "SELECT CLIENT_NAME, STATUS FROM DBA_AUTOTASK_CLIENT WHERE CLIENT_NAME = 'auto optimizer stats collection';"),
    rollback: sql('Disable it again', here(c), "EXEC DBMS_AUTO_TASK_ADMIN.DISABLE(client_name => 'auto optimizer stats collection', operation => NULL, window_name => NULL);"),
    basedOn: ['DBA_AUTOTASK_CLIENT: auto optimizer stats collection is not ENABLED'],
  }),

  'fk-index': async (c) => {
    const r = await rows<{ owner: string; table: string; constraint: string; columns: string; numRows: number | null }>(
      c.conn,
      `SELECT * FROM (SELECT q.*, t.NUM_ROWS AS "numRows" FROM (${fkNoIndexSql(c.major)}) q LEFT JOIN DBA_TABLES t ON t.OWNER = q."owner" AND t.TABLE_NAME = q."table" ORDER BY t.NUM_ROWS DESC NULLS LAST, 1, 2, 3) WHERE ROWNUM <= 200`,
    )
    if (!r.length) return null
    const owners = [...new Set(r.map((x) => x.owner))]
    const existing = new Set((await rows<{ N: string }>(c.conn, `SELECT OWNER || '.' || INDEX_NAME AS "N" FROM DBA_INDEXES WHERE OWNER IN (${names(owners)})`)).map((x) => x.N))
    const s = fkIndexScript(
      r.map((x) => ({ owner: x.owner, table: x.table, constraint: x.constraint, columns: x.columns.split(', ') })),
      existing,
      c.ee,
    )
    return {
      why: 'Without an index on the foreign key columns, every DELETE of a parent row or update of its key locks the whole child table (and full-scans it to check for children). That causes blocking and deadlocks under concurrent load; joins from parent to child also have to full-scan.',
      impact: { risk: 'low', notes: [c.ee ? 'CREATE INDEX … ONLINE lets DML continue while the index builds.' : 'Without ONLINE (Enterprise Edition only) the build blocks DML on the table — run it in a quiet period.', 'Each index costs space and some DML overhead; for small, read-only lookup tables whose parents are never deleted you can skip it.'] },
      steps: [sql(`Create ${s.names.length} index(es), largest tables first`, here(c), s.code)],
      verify: check('Foreign keys still without an index (re-run the assessment check)', here(c), `SELECT COUNT(*) FROM (${fkNoIndexSql(c.major)});`),
      rollback: sql('Drop the new indexes', here(c), s.names.map((x) => `DROP INDEX ${x};`).join('\n')),
      basedOn: r.slice(0, 25).map((x) => `${x.owner}.${x.table} (${x.columns}) → ${x.constraint}${x.numRows != null ? `, ${Number(x.numRows).toLocaleString('en-US')} rows` : ''}`).concat(r.length > 25 ? [`… and ${r.length - 25} more`] : []),
    }
  },

  'no-pk': async (c) => {
    const t = await rows<{ owner: string; table: string; numRows: number | null }>(c.conn, `SELECT * FROM (${noPkSql(c.major)} ORDER BY t.NUM_ROWS DESC NULLS LAST, 1, 2) WHERE ROWNUM <= 200`)
    if (!t.length) return null
    const cand = await rows<{ O: string; T: string; IO: string; I: string; C: string; NC: number; NU: number }>(
      c.conn,
      `SELECT i.TABLE_OWNER AS "O", i.TABLE_NAME AS "T", i.OWNER AS "IO", i.INDEX_NAME AS "I",
              LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) AS "C", COUNT(*) AS "NC",
              SUM(CASE WHEN tc.NULLABLE = 'N' THEN 0 ELSE 1 END) AS "NU"
         FROM DBA_INDEXES i
         JOIN DBA_IND_COLUMNS ic ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME
         LEFT JOIN DBA_TAB_COLUMNS tc ON tc.OWNER = i.TABLE_OWNER AND tc.TABLE_NAME = i.TABLE_NAME AND tc.COLUMN_NAME = ic.COLUMN_NAME
        WHERE i.UNIQUENESS = 'UNIQUE' AND i.INDEX_TYPE = 'NORMAL' AND (i.TABLE_OWNER, i.TABLE_NAME) IN (SELECT "owner", "table" FROM (${noPkSql(c.major)}))
        GROUP BY i.TABLE_OWNER, i.TABLE_NAME, i.OWNER, i.INDEX_NAME`,
    )
    const cons = new Set((await rows<{ N: string }>(c.conn, `SELECT OWNER || '.' || CONSTRAINT_NAME AS "N" FROM DBA_CONSTRAINTS WHERE OWNER IN (${names([...new Set(t.map((x) => x.owner))])})`)).map((x) => x.N))
    const ready: string[] = []
    const undo: string[] = []
    const manual: string[] = []
    for (const x of t) {
      const best = cand.filter((k) => k.O === x.owner && k.T === x.table && !n(k.NU)).sort((a, b) => n(a.NC) - n(b.NC))[0]
      let name = shortName(x.table, '_PK')
      for (let i = 2; cons.has(`${x.owner}.${name}`); i++) name = shortName(x.table, `_PK${i}`)
      if (best) {
        ready.push(`ALTER TABLE ${qn(x.owner, x.table)} ADD CONSTRAINT ${qi(name)} PRIMARY KEY (${best.C.split(',').map(qi).join(', ')}) USING INDEX ${qn(best.IO, best.I)};`)
        undo.push(`ALTER TABLE ${qn(x.owner, x.table)} DROP CONSTRAINT ${qi(name)} KEEP INDEX;`)
      } else {
        manual.push(`-- ${x.owner}.${x.table}${x.numRows != null ? ` (${Number(x.numRows).toLocaleString('en-US')} rows)` : ''}\n--   SELECT <<KEY_COLUMNS>>, COUNT(*) FROM ${qn(x.owner, x.table)} GROUP BY <<KEY_COLUMNS>> HAVING COUNT(*) > 1;\n--   ALTER TABLE ${qn(x.owner, x.table)} ADD CONSTRAINT ${qi(name)} PRIMARY KEY (<<KEY_COLUMNS>>);`)
      }
    }
    const steps: FixStep[] = []
    if (ready.length) steps.push(sql(`${ready.length} table(s) already have a unique index on NOT NULL columns: promote it to the primary key`, here(c), ready.join('\n')))
    if (manual.length) steps.push(sql(`${manual.length} table(s) need a key chosen by someone who knows the data`, here(c), manual.join('\n')))
    return {
      why: 'Without a primary key rows cannot be identified reliably: replication (GoldenGate, logical standby), deduplication, many tools and ORMs need one, and duplicates creep in unnoticed.',
      impact: { risk: 'low', notes: ['Adding a primary key validates every row (a full scan with a short table lock). USING INDEX reuses the existing unique index, so no new index is built.'] },
      steps,
      verify: check('Tables still without a primary key', here(c), `SELECT COUNT(*) FROM (${noPkSql(c.major)});`),
      rollback: undo.length ? sql('Drop the constraints again (keeping the indexes)', here(c), undo.join('\n')) : null,
      basedOn: [`${t.length} table(s) without a primary key${t.length >= 200 ? ' (first 200)' : ''}`, `${ready.length} with a usable unique index`],
      guidanceOnly: !ready.length,
    }
  },

  'unusable-indexes': async (c) => {
    const r = await rows<{ O: string; I: string; P: string | null; K: string }>(
      c.conn,
      `SELECT OWNER AS "O", INDEX_NAME AS "I", NULL AS "P", 'INDEX' AS "K" FROM DBA_INDEXES WHERE STATUS = 'UNUSABLE' AND ${customOwner(c.major, 'OWNER')}
       UNION ALL SELECT INDEX_OWNER, INDEX_NAME, PARTITION_NAME, 'PARTITION' FROM DBA_IND_PARTITIONS WHERE STATUS = 'UNUSABLE' AND ${customOwner(c.major, 'INDEX_OWNER')}
       UNION ALL SELECT INDEX_OWNER, INDEX_NAME, SUBPARTITION_NAME, 'SUBPARTITION' FROM DBA_IND_SUBPARTITIONS WHERE STATUS = 'UNUSABLE' AND ${customOwner(c.major, 'INDEX_OWNER')}
       ORDER BY 1, 2, 3`,
    )
    if (!r.length) return null
    const online = c.ee ? ' ONLINE' : ''
    return {
      why: 'The optimizer ignores UNUSABLE indexes (queries fall back to full scans) and DML on a table with an unusable unique index fails with ORA-01502.',
      impact: { risk: 'low', notes: [c.ee ? 'REBUILD … ONLINE keeps the table available.' : 'Without ONLINE (Enterprise Edition only) the rebuild blocks DML on the table.'] },
      steps: [sql(`Rebuild ${r.length} index(es) / partition(s)`, here(c), r.map((x) => `ALTER INDEX ${qn(x.O, x.I)} REBUILD${x.K === 'PARTITION' ? ` PARTITION ${qi(x.P!)}` : x.K === 'SUBPARTITION' ? ` SUBPARTITION ${qi(x.P!)}` : ''}${online};`).join('\n'))],
      verify: check('Anything still UNUSABLE', here(c), `SELECT OWNER, INDEX_NAME, STATUS FROM DBA_INDEXES WHERE STATUS = 'UNUSABLE' AND OWNER IN (${names([...new Set(r.map((x) => x.O))])});`),
      basedOn: r.slice(0, 30).map((x) => `${x.O}.${x.I}${x.P ? ` ${x.K.toLowerCase()} ${x.P}` : ''}`),
    }
  },

  'disabled-constraints': async (c) => {
    const r = await rows<{ O: string; T: string | null; K: string; N: string; Y: string | null; S: string; V: string | null; R: string | null }>(
      c.conn,
      `SELECT * FROM (
         SELECT c.OWNER AS "O", c.TABLE_NAME AS "T", 'CONSTRAINT' AS "K", c.CONSTRAINT_NAME AS "N", c.CONSTRAINT_TYPE AS "Y", c.STATUS AS "S", c.VALIDATED AS "V", c.RELY AS "R"
           FROM DBA_CONSTRAINTS c WHERE (c.STATUS = 'DISABLED' OR c.VALIDATED = 'NOT VALIDATED') AND c.CONSTRAINT_TYPE IN ('P', 'U', 'R', 'C') AND ${customOwner(c.major, 'c.OWNER')} AND c.TABLE_NAME NOT LIKE 'BIN$%'
         UNION ALL
         SELECT t.OWNER, t.TABLE_NAME, 'TRIGGER', t.TRIGGER_NAME, NULL, t.STATUS, NULL, NULL FROM DBA_TRIGGERS t WHERE t.STATUS = 'DISABLED' AND ${customOwner(c.major, 't.OWNER')}
         ORDER BY 1, 2, 3, 4)
       WHERE ROWNUM <= 300`,
    )
    if (!r.length) return null
    const cons = r.filter((x) => x.K === 'CONSTRAINT')
    const trig = r.filter((x) => x.K === 'TRIGGER')
    const owners = [...new Set(cons.map((x) => x.O))]
    const haveExc = new Set((await rows<{ O: string }>(c.conn, `SELECT OWNER AS "O" FROM DBA_TABLES WHERE TABLE_NAME = 'EXCEPTIONS' AND OWNER IN (${names(owners)})`)).map((x) => x.O))
    const w = c.version >= 1202000000 ? 128 : 30
    const exc = (o: string) => qn(o, 'EXCEPTIONS')
    const lines = cons.map((x) => {
      const t = qn(x.O, x.T!)
      const name = qi(x.N)
      if (x.R === 'RELY') return `-- ${t} ${name}: RELY constraint, NOVALIDATE on purpose (data warehouse) — leave it`
      const validate = `ALTER TABLE ${t} ENABLE VALIDATE CONSTRAINT ${name} EXCEPTIONS INTO ${exc(x.O)};`
      if (x.S === 'DISABLED' && (x.Y === 'R' || x.Y === 'C')) return `ALTER TABLE ${t} ENABLE NOVALIDATE CONSTRAINT ${name};\n${validate}`
      return validate
    })
    const steps: FixStep[] = []
    const missing = owners.filter((o) => !haveExc.has(o))
    if (missing.length) steps.push(sql('Create an EXCEPTIONS table (as in utlexpt1.sql) to collect violating rows', here(c), missing.map((o) => `CREATE TABLE ${exc(o)} (ROW_ID ROWID, OWNER VARCHAR2(${w}), TABLE_NAME VARCHAR2(${w}), CONSTRAINT VARCHAR2(${w}));`).join('\n')))
    if (lines.length) steps.push(sql('Enable and validate the constraints (foreign keys/checks: NOVALIDATE first, so new DML is checked at once)', here(c), lines.join('\n')))
    if (lines.length) steps.push(check('If a VALIDATE fails (ORA-02293 / ORA-02298 / ORA-02437): look at the offending rows', here(c), owners.map((o) => `SELECT e.CONSTRAINT, e.TABLE_NAME, COUNT(*) FROM ${exc(o)} e GROUP BY e.CONSTRAINT, e.TABLE_NAME;`).join('\n')))
    if (trig.length) steps.push(sql('Enable the triggers (only those not disabled on purpose)', here(c), trig.map((x) => `ALTER TRIGGER ${qn(x.O, x.N)} ENABLE;`).join('\n')))
    return {
      why: 'A disabled or NOT VALIDATED constraint no longer guarantees the data: orphans, duplicates or invalid values can exist, and the optimizer cannot use it for query transformations. Often they are leftovers from a bulk load.',
      impact: { risk: 'medium', notes: ['Validation reads the whole table; ENABLE NOVALIDATE first keeps the lock short for foreign keys and checks.', 'Primary/unique keys build or reuse a unique index when enabled — they fail if duplicates exist.'] },
      prerequisites: ['Confirm with the application owner that none of them is disabled on purpose.'],
      steps,
      verify: check('Still disabled / not validated', here(c), `SELECT OWNER, TABLE_NAME, CONSTRAINT_NAME, STATUS, VALIDATED FROM DBA_CONSTRAINTS WHERE (STATUS = 'DISABLED' OR VALIDATED = 'NOT VALIDATED') AND OWNER IN (${names(owners)}) AND CONSTRAINT_TYPE IN ('P', 'U', 'R', 'C') ORDER BY 1, 2, 3;`),
      rollback: sql(
        'Previous state',
        here(c),
        [
          ...cons.filter((x) => x.R !== 'RELY').map((x) => (x.S === 'DISABLED' ? `ALTER TABLE ${qn(x.O, x.T!)} DISABLE CONSTRAINT ${qi(x.N)}${x.Y === 'P' || x.Y === 'U' ? ' KEEP INDEX' : ''};` : `ALTER TABLE ${qn(x.O, x.T!)} ENABLE NOVALIDATE CONSTRAINT ${qi(x.N)};`)),
          ...trig.map((x) => `ALTER TRIGGER ${qn(x.O, x.N)} DISABLE;`),
          ...missing.map((o) => `DROP TABLE ${exc(o)};`),
        ].join('\n'),
      ),
      basedOn: r.slice(0, 30).map((x) => `${x.O}.${x.T ?? '-'} ${x.K.toLowerCase()} ${x.N}: ${x.S}${x.V === 'NOT VALIDATED' ? ', NOT VALIDATED' : ''}${x.R === 'RELY' ? ', RELY' : ''}`),
    }
  },

  'hidden-params': async (c) => {
    const r = await setParams(c, `p.NAME LIKE '\\_%' ESCAPE '\\'`)
    if (!r.length) return null
    const why = 'Underscore parameters change internal behaviour; they are meant to be set only on Oracle Support\'s advice (or a product requirement, e.g. Exadata, EBS). Forgotten ones survive upgrades and cause odd bugs.'
    const basedOn = r.map((x) => `${x.N} = ${x.V}${x.SP === 'TRUE' ? ' (in SPFILE)' : ' (not in the SPFILE)'}`)
    const sp = r.filter((x) => x.SP === 'TRUE')
    if (!sp.length)
      return {
        why,
        steps: [],
        guidanceOnly: true,
        impact: { notes: ['None of them is in the SPFILE: they were set at runtime — typically by Oracle itself at startup, or by an ALTER SYSTEM … SCOPE=MEMORY — and nothing persists across a restart. There is nothing to reset.'] },
        basedOn,
      }
    return {
      why,
      impact: { restart: true, risk: 'medium', notes: ['Every line is commented: keep the ones Oracle Support or your product documentation requires and uncomment only the others.', 'Reset values take effect at the next restart.'] },
      steps: [sql('Reset the ones nobody can justify', root(c), sp.map((x) => `-- ALTER SYSTEM RESET "${x.N}" SCOPE=SPFILE SID='*';   -- now ${x.V}`).join('\n')), restart(c)],
      verify: check('Underscore parameters still in the SPFILE', root(c), `SELECT NAME, VALUE FROM V$SPPARAMETER WHERE NAME LIKE '\\_%' ESCAPE '\\' AND ISSPECIFIED = 'TRUE' ORDER BY 1;`),
      rollback: sql('Set a value back', root(c), sp.map((x) => `ALTER SYSTEM SET "${x.N}" = ${pval(x)} SCOPE=SPFILE SID='*';`).join('\n')),
      basedOn,
    }
  },

  'deprecated-params': async (c) => {
    const r = await setParams(c, `p.ISDEPRECATED = 'TRUE'`)
    if (!r.length) return null
    const why = 'Deprecated parameters may already be ignored and will be removed in a later release; an upgrade can then fail to start the instance with an unknown parameter.'
    const basedOn = r.map((x) => `${x.N} = ${x.V}${x.SP === 'TRUE' ? ' (in SPFILE)' : ' (not in the SPFILE)'}`)
    const sp = r.filter((x) => x.SP === 'TRUE')
    if (!sp.length) return { why, steps: [], guidanceOnly: true, impact: { notes: ['None of them is in the SPFILE: they were set at runtime and disappear at the next restart. Find whatever sets them (a startup trigger, a script) and remove it there.'] }, basedOn }
    const hint = (x: SetParam) => (DEPRECATED_HINTS[x.N] ? `   -- ${DEPRECATED_HINTS[x.N]}` : '')
    return {
      why,
      impact: { restart: true, risk: 'medium', notes: ['Reset values take effect at the next restart. Read the hint next to each line: some need a replacement setting first.'] },
      steps: [sql('Remove them from the SPFILE', root(c), sp.map((x) => `ALTER SYSTEM RESET ${x.N} SCOPE=SPFILE SID='*';${hint(x)}`).join('\n')), restart(c)],
      verify: check('Deprecated parameters still in the SPFILE', root(c), `SELECT p.NAME, p.VALUE FROM V$SPPARAMETER p JOIN V$PARAMETER v ON v.NAME = p.NAME WHERE v.ISDEPRECATED = 'TRUE' AND p.ISSPECIFIED = 'TRUE' ORDER BY 1;`),
      rollback: sql('Set a value back', root(c), sp.map((x) => `ALTER SYSTEM SET ${x.N} = ${pval(x)} SCOPE=SPFILE SID='*';`).join('\n')),
      basedOn,
    }
  },

  spfile: async (c) => ({
    why: 'With a text PFILE, ALTER SYSTEM … SCOPE=SPFILE/BOTH cannot persist: changes are lost at the next restart unless someone edits the file by hand, and RMAN cannot back up the parameter file automatically.',
    impact: { restart: true, downtime: true, risk: 'low', notes: ['CREATE SPFILE FROM MEMORY captures the values the instance runs with right now (including changes made since startup).'] },
    steps: [
      sql(c.rac ? 'Create the SPFILE on shared storage' : 'Create the SPFILE from the running values', root(c), c.rac ? `CREATE SPFILE = '<<SPFILE_LOCATION>>' FROM MEMORY;` : 'CREATE SPFILE FROM MEMORY;\n-- or from the text file: CREATE SPFILE FROM PFILE = \'<<PFILE_PATH>>\';'),
      ...(c.rac ? [shell('Register it with the cluster', 'oracle OS user', `srvctl modify database ${c.major >= 12 ? '-db' : '-d'} ${c.dbUniqueName} ${c.major >= 12 ? '-spfile' : '-p'} '<<SPFILE_LOCATION>>'`)] : []),
      shell('Move the old text file out of the way so the instance finds the SPFILE', 'oracle OS user', 'mv $ORACLE_HOME/dbs/init$ORACLE_SID.ora $ORACLE_HOME/dbs/init$ORACLE_SID.ora.bak'),
      restart(c),
    ],
    verify: check('The instance now uses an SPFILE', root(c), 'SHOW PARAMETER spfile'),
    rollback: shell('Start from the text file again', 'oracle OS user', 'mv $ORACLE_HOME/dbs/init$ORACLE_SID.ora.bak $ORACLE_HOME/dbs/init$ORACLE_SID.ora\n# and remove/rename the SPFILE in $ORACLE_HOME/dbs, then restart'),
    basedOn: ['V$PARAMETER spfile is empty: started with a text PFILE'],
  }),

  'resource-limits': async (c) => {
    const lim = await rows<{ R: string; C: number; M: number; L: string }>(c.conn, `SELECT RESOURCE_NAME AS "R", CURRENT_UTILIZATION AS "C", MAX_UTILIZATION AS "M", TRIM(LIMIT_VALUE) AS "L" FROM V$RESOURCE_LIMIT WHERE RESOURCE_NAME IN ('processes', 'sessions')`)
    const p = await rows<{ N: string; V: string; D: string }>(c.conn, `SELECT NAME AS "N", VALUE AS "V", ISDEFAULT AS "D" FROM V$PARAMETER WHERE NAME IN ('processes', 'sessions')`)
    const proc = lim.find((x) => x.R === 'processes')
    const sess = lim.find((x) => x.R === 'sessions')
    if (!proc || !sess) return null
    const hot = (x: typeof proc) => n(x.M) >= 0.9 * Number(x.L)
    const roundUp = (v: number) => Math.ceil(v / 50) * 50
    const newProc = hot(proc) ? roundUp(Math.max(n(proc.M) * 1.3, Number(proc.L) + 50)) : Number(proc.L)
    const sessSet = p.find((x) => x.N === 'sessions')?.D === 'FALSE'
    const newSess = roundUp(Math.max(hot(sess) ? n(sess.M) * 1.3 : 0, Number(sess.L), Math.ceil(1.5 * newProc + 22)))
    const set: string[] = []
    if (newProc !== Number(proc.L)) set.push(`ALTER SYSTEM SET processes = ${newProc} SCOPE=SPFILE SID='*';`)
    if (sessSet || (hot(sess) && !hot(proc))) set.push(`ALTER SYSTEM SET sessions = ${newSess} SCOPE=SPFILE SID='*';`)
    if (!set.length) return null
    const top = `SELECT * FROM (SELECT USERNAME, MACHINE, PROGRAM, STATUS, COUNT(*) AS N FROM V$SESSION WHERE TYPE = 'USER' GROUP BY USERNAME, MACHINE, PROGRAM, STATUS ORDER BY N DESC) WHERE ROWNUM <= 20;`
    return {
      why: 'When PROCESSES or SESSIONS is reached, new connections fail (ORA-00020 / ORA-00018). Raise the limit only after ruling out a connection leak — a leaking pool fills any limit.',
      impact: { restart: true, downtime: true, risk: 'medium', notes: ['Each extra process needs OS resources (semaphores, process slots) and PGA memory.', ...(sessSet ? [] : ['SESSIONS is derived from PROCESSES (1.5 × processes + 22) when not set explicitly.'])] },
      prerequisites: ['Linux: kernel.sem SEMMNS and the oracle user\'s nproc limit must cover the new PROCESSES (check /etc/sysctl.conf and /etc/security/limits.conf).'],
      steps: [
        check('Who holds the connections (look for idle sessions piling up from one machine/program)', root(c), `${top}\nSELECT COUNT(*) AS IDLE_OVER_1H FROM V$SESSION WHERE TYPE = 'USER' AND STATUS = 'INACTIVE' AND LAST_CALL_ET > 3600;`),
        sql('Raise the limits', root(c), set.join('\n')),
        restart(c),
      ],
      verify: check('New limits and usage', root(c), "SELECT RESOURCE_NAME, CURRENT_UTILIZATION, MAX_UTILIZATION, LIMIT_VALUE FROM V$RESOURCE_LIMIT WHERE RESOURCE_NAME IN ('processes', 'sessions');"),
      rollback: sql('Previous values', root(c), [`ALTER SYSTEM SET processes = ${proc.L} SCOPE=SPFILE SID='*';`, ...(sessSet || (hot(sess) && !hot(proc)) ? [`ALTER SYSTEM SET sessions = ${sess.L} SCOPE=SPFILE SID='*';`] : [])].join('\n')),
      basedOn: [`processes: now ${proc.C}, peak ${proc.M} of ${proc.L}`, `sessions: now ${sess.C}, peak ${sess.M} of ${sess.L}${sessSet ? ' (set explicitly)' : ' (derived)'}`, `New processes = peak × 1.3 (at least +50), rounded up to 50`],
    }
  },

  'scheduler-failures': async (c) => {
    const r = await rows<{ O: string; J: string; E: number; N: number; L: string }>(
      c.conn,
      `SELECT * FROM (SELECT OWNER AS "O", JOB_NAME AS "J", ERROR# AS "E", COUNT(*) AS "N", TO_CHAR(MAX(LOG_DATE), 'YYYY-MM-DD HH24:MI') AS "L" FROM DBA_SCHEDULER_JOB_RUN_DETAILS
          WHERE STATUS <> 'SUCCEEDED' AND LOG_DATE > SYSTIMESTAMP - INTERVAL '7' DAY GROUP BY OWNER, JOB_NAME, ERROR# ORDER BY 4 DESC) WHERE ROWNUM <= 25`,
    )
    if (!r.length) return null
    const jobs = [...new Set(r.map((x) => `${x.O}.${x.J}`))]
    return {
      why: 'Failing jobs usually mean missed work (statistics, purges, ETL, backups) that nobody notices until its effect shows up.',
      impact: { risk: 'low', notes: ['The fix depends on each error: the steps show the full error text per run.'] },
      steps: [
        check('Error text of the failed runs', here(c), `SELECT LOG_DATE, OWNER, JOB_NAME, STATUS, ERROR#, ADDITIONAL_INFO FROM DBA_SCHEDULER_JOB_RUN_DETAILS WHERE STATUS <> 'SUCCEEDED' AND LOG_DATE > SYSTIMESTAMP - INTERVAL '7' DAY ORDER BY LOG_DATE DESC;`),
        check('Job definitions and state', here(c), `SELECT OWNER, JOB_NAME, ENABLED, STATE, FAILURE_COUNT, MAX_FAILURES, LAST_START_DATE, NEXT_RUN_DATE FROM DBA_SCHEDULER_JOBS WHERE OWNER || '.' || JOB_NAME IN (${inList(jobs)}) ORDER BY 1, 2;`),
        sql('Jobs that are no longer needed can be disabled', here(c), jobs.map((j) => `-- EXEC DBMS_SCHEDULER.DISABLE(${lit(j.split('.').map((x) => `"${x}"`).join('.'))});`).join('\n')),
      ],
      basedOn: r.map((x) => `${x.O}.${x.J}: ORA-${String(x.E).padStart(5, '0')} ×${x.N}, last ${x.L}`),
      guidanceOnly: true,
    }
  },

  recyclebin: async (c) => {
    const r = await rows<{ O: string; N: number; B: number }>(
      c.conn,
      `SELECT r.OWNER AS "O", COUNT(*) AS "N", SUM(r.SPACE * NVL(t.BLOCK_SIZE, 8192)) AS "B" FROM DBA_RECYCLEBIN r LEFT JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = r.TS_NAME GROUP BY r.OWNER ORDER BY 3 DESC NULLS LAST`,
    )
    if (!r.length) return null
    return {
      why: 'Dropped tables stay in the recycle bin and keep their space until purged (Oracle purges them only under space pressure, which can slow down the statement that needs the space).',
      impact: { risk: 'low', notes: ['Purging cannot be undone: recover anything still needed first with FLASHBACK TABLE <name> TO BEFORE DROP.'] },
      steps: [
        check('What is in the recycle bin', here(c), 'SELECT OWNER, ORIGINAL_NAME, TYPE, DROPTIME, CAN_UNDROP FROM DBA_RECYCLEBIN ORDER BY DROPTIME;'),
        sql('Purge the recycle bin of this container', here(c, 'SYSDBA'), 'PURGE DBA_RECYCLEBIN;\n-- or per schema, connected as that user: PURGE RECYCLEBIN;'),
      ],
      verify: check('Empty?', here(c), 'SELECT COUNT(*) FROM DBA_RECYCLEBIN;'),
      basedOn: r.map((x) => `${x.O}: ${x.N} object(s), ${fmtBytes(n(x.B))}`),
    }
  },

  flashback: async (c) => {
    const d = await one<{ L: string }>(c.conn, `SELECT LOG_MODE AS "L" FROM V$DATABASE`)
    const p = await params(c.conn, ['db_recovery_file_dest', 'db_flashback_retention_target'])
    if (!c.ee)
      return { why: 'Flashback Database requires Enterprise Edition.', steps: [], guidanceOnly: true, impact: { enterpriseOnly: true }, basedOn: ['Edition is not Enterprise'], prerequisites: ['Alternative: take an RMAN backup before risky changes.'] }
    const pre: string[] = []
    if (d?.L !== 'ARCHIVELOG') pre.push('ARCHIVELOG mode is required first (see "ARCHIVELOG mode").')
    const perDay = await redoPerDay(c.conn)
    const steps: FixStep[] = []
    // Flashback logs can only live in the fast recovery area.
    if (!p.db_recovery_file_dest)
      steps.push(sql('Create a fast recovery area (flashback logs can only be written there)', root(c), `ALTER SYSTEM SET db_recovery_file_dest_size = <<FRA_SIZE>> SCOPE=BOTH SID='*';\nALTER SYSTEM SET db_recovery_file_dest = '<<FRA_LOCATION>>' SCOPE=BOTH SID='*';`))
    steps.push(sql(`${n(p.db_flashback_retention_target) === 1440 ? 'Turn flashback on' : 'Set the retention (minutes) and turn flashback on'}`, root(c), `${n(p.db_flashback_retention_target) === 1440 ? '' : "ALTER SYSTEM SET db_flashback_retention_target = 1440 SCOPE=BOTH SID='*';\n"}ALTER DATABASE FLASHBACK ON;`))
    return {
      why: 'Flashback Database rewinds the whole database to a point in the retention window in minutes (after a failed upgrade, a bad batch, a logical error) instead of a full restore. It also lets a failed-over Data Guard primary be reinstated.',
      impact: { enterpriseOnly: true, risk: 'low', notes: ['Online (11.2+).', `Flashback logs need roughly the redo volume of the retention window in the fast recovery area${perDay ? ` (~${fmtBytes(perDay)} for one day at the current rate)` : ''}.`, 'A few percent more I/O for flashback writes.'] },
      prerequisites: pre,
      steps,
      ph: { FRA_SIZE: `size of the fast recovery area — at least ${niceSize(Math.max(10 * GiB, perDay * 3))} (flashback logs for the retention window plus archived logs)` },
      verify: check('Flashback status and the oldest point you can rewind to', root(c), 'SELECT FLASHBACK_ON FROM V$DATABASE;\nSELECT OLDEST_FLASHBACK_SCN, OLDEST_FLASHBACK_TIME, RETENTION_TARGET FROM V$FLASHBACK_DATABASE_LOG;'),
      rollback: sql('Turn it off (flashback logs are deleted)', root(c), 'ALTER DATABASE FLASHBACK OFF;'),
      basedOn: [`Log mode ${d?.L}`, `db_recovery_file_dest = ${p.db_recovery_file_dest ?? '(not set)'}`, `db_flashback_retention_target = ${p.db_flashback_retention_target}`],
    }
  },

  'force-logging': async (c) => {
    const standby = n((await tryOne<{ N: number }>(c.conn, `SELECT COUNT(*) AS "N" FROM V$ARCHIVE_DEST WHERE STATUS <> 'INACTIVE' AND TARGET = 'STANDBY'`))?.N)
    const nolog = n((await tryOne<{ N: number }>(c.conn, `SELECT COUNT(*) AS "N" FROM V$DATAFILE WHERE UNRECOVERABLE_TIME > SYSDATE - 30`))?.N)
    return {
      why: standby
        ? 'A standby exists but NOLOGGING operations (direct-path loads, index builds) write no redo, so those blocks arrive corrupt on the standby. FORCE LOGGING makes every change generate redo.'
        : 'Optional without a standby: NOLOGGING operations (direct-path loads, index builds) write no redo, so a restore from backup brings those blocks back as corrupt until the objects are reloaded. FORCE LOGGING makes every change recoverable — enable it if you plan a standby or cannot reload such data.',
      impact: { risk: 'low', notes: ['Online; the statement waits for running unlogged direct writes to finish.', 'NOLOGGING loads become slower and produce more redo (and archived logs).'] },
      steps: [sql('Turn on force logging', root(c), 'ALTER DATABASE FORCE LOGGING;')],
      verify: check('Status', root(c), 'SELECT FORCE_LOGGING FROM V$DATABASE;'),
      rollback: sql('Turn it off', root(c), 'ALTER DATABASE NO FORCE LOGGING;'),
      basedOn: ['V$DATABASE.FORCE_LOGGING = NO', standby ? `${standby} active standby destination(s)` : 'No standby destination', `${nolog} datafile(s) with unrecoverable (NOLOGGING) changes in the last 30 days`],
    }
  },

  bct: async (c) => {
    if (!c.ee) return { why: 'Block change tracking is an Enterprise Edition feature.', steps: [], guidanceOnly: true, impact: { enterpriseOnly: true }, basedOn: ['Edition is not Enterprise'] }
    const omf = (await params(c.conn, ['db_create_file_dest'])).db_create_file_dest
    const df = await tryOne<{ N: string }>(c.conn, `SELECT MIN(NAME) AS "N" FROM V$DATAFILE`)
    const dg = df?.N ? diskGroupOf(df.N) : null
    const inc = n((await tryOne<{ N: number }>(c.conn, `SELECT COUNT(*) AS "N" FROM V$RMAN_BACKUP_JOB_DETAILS WHERE INPUT_TYPE LIKE '%INCR%' AND START_TIME > SYSDATE - 30`))?.N)
    const code = omf
      ? 'ALTER DATABASE ENABLE BLOCK CHANGE TRACKING;'
      : dg
        ? `ALTER DATABASE ENABLE BLOCK CHANGE TRACKING USING FILE '${dg}';`
        : `ALTER DATABASE ENABLE BLOCK CHANGE TRACKING USING FILE '<<BCT_DIR>>/${c.dbUniqueName.toLowerCase()}_bct.chg';`
    return {
      why: 'Without change tracking, every incremental backup reads every block of the database to find the changed ones. With it, RMAN reads only the changed blocks — incrementals become many times faster.',
      impact: { enterpriseOnly: true, risk: 'low', notes: ['Online; a small file (tens of MB) and negligible overhead.', inc ? `${inc} incremental backup job(s) in the last 30 days will benefit.` : 'Only helps incremental backups (BACKUP INCREMENTAL LEVEL 1); no incremental jobs were seen in the last 30 days.'] },
      steps: [sql('Enable block change tracking', root(c), code)],
      verify: check('Status and file', root(c), 'SELECT STATUS, FILENAME, BYTES FROM V$BLOCK_CHANGE_TRACKING;'),
      rollback: sql('Disable it (the file is deleted)', root(c), 'ALTER DATABASE DISABLE BLOCK CHANGE TRACKING;'),
      basedOn: [omf ? `DB_CREATE_FILE_DEST = ${omf}` : dg ? `Datafiles in ASM disk group ${dg}` : 'File system without OMF', `${inc} incremental backup job(s) in 30 days`],
    }
  },

  charset: async (c) => {
    const r = await one<{ V: string }>(c.conn, `SELECT VALUE AS "V" FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER = 'NLS_CHARACTERSET'`)
    return {
      why: 'A non-Unicode character set cannot store characters outside its repertoire (they turn into "?"), and moving to the cloud or consolidating into an AL32UTF8 CDB requires conversion.',
      impact: { downtime: true, risk: 'high', notes: ['A character set conversion is a project, not a one-line fix: test it on a copy first.'] },
      steps: [
        check('Current settings', here(c), "SELECT PARAMETER, VALUE FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET', 'NLS_LENGTH_SEMANTICS');"),
        shell('Option A — in place: Database Migration Assistant for Unicode (DMU)', 'DBA workstation', '# 1. Install DMU and its PL/SQL package in the database (see the DMU guide).\n# 2. Scan: find data that does not convert or would exceed column lengths.\n# 3. Cleanse: widen columns or switch them to CHAR length semantics.\n# 4. Convert (downtime), then re-scan.'),
        shell('Option B — out of place: create a new AL32UTF8 database/PDB and move the data with Data Pump', 'oracle OS user', '# expdp … FULL=Y on the source, impdp into the AL32UTF8 target.\n# Check first for VARCHAR2(n BYTE) columns that need more bytes in UTF-8.'),
      ],
      basedOn: [`NLS_CHARACTERSET = ${r?.V}`],
      guidanceOnly: true,
    }
  },

  'inactive-users': async (c) => {
    if (c.major < 12) return null
    const r = await rows<{ U: string; L: string | null; O: number; C: string }>(
      c.conn,
      `SELECT u.USERNAME AS "U", TO_CHAR(u.LAST_LOGIN, 'YYYY-MM-DD') AS "L", (SELECT COUNT(*) FROM DBA_OBJECTS o WHERE o.OWNER = u.USERNAME) AS "O", u.COMMON AS "C"
         FROM DBA_USERS u WHERE u.ACCOUNT_STATUS = 'OPEN' AND ${customUser(c.major, 'u')} AND (u.LAST_LOGIN IS NULL OR u.LAST_LOGIN < SYSTIMESTAMP - INTERVAL '90' DAY) ORDER BY 1`,
    )
    const list = r.filter((x) => x.U !== c.sessionUser)
    if (!list.length) return null
    const schemaOnly = (x: (typeof r)[number]) => n(x.O) > 0 && !x.L && c.major >= 18
    return {
      why: 'Open accounts nobody uses are unmonitored ways in: their passwords are old, often shared, and nobody notices a login.',
      impact: { risk: 'medium', notes: ['Accounts used rarely (yearly jobs, DR tests) look inactive too — check with their owners.', 'NO AUTHENTICATION (18c+) keeps a schema that owns objects but should never log in: its objects keep working.', ...(r.length > list.length ? [`${c.sessionUser} (this app's own login) is left out.`] : []), ...(list.some((x) => x.C === 'YES') ? ['Common users (C##…): the lock applies to this container; run it in CDB$ROOT with CONTAINER = ALL to lock everywhere.'] : [])] },
      steps: [sql('Lock the accounts / make owners schema-only', here(c), list.map((x) => (schemaOnly(x) ? `ALTER USER ${qi(x.U)} NO AUTHENTICATION;   -- owns ${x.O} objects, never logged in` : `ALTER USER ${qi(x.U)} ACCOUNT LOCK;   -- last login ${x.L ?? 'never'}`)).join('\n'))],
      verify: check('Status', here(c), `SELECT USERNAME, ACCOUNT_STATUS, AUTHENTICATION_TYPE, LAST_LOGIN FROM DBA_USERS WHERE USERNAME IN (${names(list.map((x) => x.U))}) ORDER BY 1;`),
      rollback: sql('Reopen an account', here(c), list.map((x) => (schemaOnly(x) ? `ALTER USER ${qi(x.U)} IDENTIFIED BY "<<PASSWORD>>";` : `ALTER USER ${qi(x.U)} ACCOUNT UNLOCK;`)).join('\n')),
      basedOn: list.map((x) => `${x.U}: last login ${x.L ?? 'never'}, ${x.O} object(s)${x.C === 'YES' ? ', common' : ''}`),
    }
  },

  auditing: async (c) => {
    if (c.major < 12) {
      return {
        why: 'Without auditing there is no record of logins, failed logins or privileged actions — nothing to investigate after an incident.',
        impact: { restart: true, downtime: true, risk: 'low', notes: ['AUDIT_TRAIL is static: it takes effect after a restart.'] },
        steps: [sql('Turn on the database audit trail', root(c), "ALTER SYSTEM SET audit_trail = 'DB' SCOPE=SPFILE SID='*';"), restart(c), sql('Audit logins and privileged actions', root(c), 'AUDIT SESSION WHENEVER NOT SUCCESSFUL;\nAUDIT ALTER USER;\nAUDIT GRANT ANY PRIVILEGE;\nAUDIT SYSTEM GRANT;')],
        verify: check('Audit settings', root(c), "SHOW PARAMETER audit_trail\nSELECT AUDIT_OPTION, SUCCESS, FAILURE FROM DBA_STMT_AUDIT_OPTS ORDER BY 1;"),
        rollback: sql('Turn it off again', root(c), "ALTER SYSTEM SET audit_trail = 'NONE' SCOPE=SPFILE SID='*';"),
        basedOn: ['audit_trail = NONE'],
      }
    }
    const pol = (await rows<{ N: string }>(c.conn, `SELECT DISTINCT POLICY_NAME AS "N" FROM AUDIT_UNIFIED_POLICIES WHERE POLICY_NAME IN ('ORA_SECURECONFIG', 'ORA_LOGON_FAILURES')`)).map((x) => x.N)
    const lines = [...(pol.includes('ORA_SECURECONFIG') ? ['AUDIT POLICY ORA_SECURECONFIG;'] : []), ...(pol.includes('ORA_LOGON_FAILURES') ? ['AUDIT POLICY ORA_LOGON_FAILURES WHENEVER NOT SUCCESSFUL;'] : [])]
    if (!lines.length) return null
    return {
      why: 'Without auditing there is no record of failed logins or privileged actions (user/privilege changes, ALTER SYSTEM) — nothing to investigate after an incident. Oracle ships predefined unified audit policies for exactly this.',
      impact: { risk: 'low', notes: ['Online, no restart (unified auditing).', 'The audit trail grows: plan housekeeping with DBMS_AUDIT_MGMT (SET_LAST_ARCHIVE_TIMESTAMP + CREATE_PURGE_JOB).'] },
      steps: [sql('Enable Oracle\'s predefined policies', here(c, 'a user with the AUDIT_ADMIN role'), lines.join('\n'))],
      verify: check('Enabled policies and recent records', here(c), 'SELECT POLICY_NAME, ENABLED_OPTION, SUCCESS, FAILURE FROM AUDIT_UNIFIED_ENABLED_POLICIES ORDER BY 1;\nSELECT EVENT_TIMESTAMP, DBUSERNAME, ACTION_NAME, RETURN_CODE FROM UNIFIED_AUDIT_TRAIL WHERE EVENT_TIMESTAMP > SYSTIMESTAMP - INTERVAL \'1\' HOUR ORDER BY 1 DESC;'),
      rollback: sql('Disable them', here(c, 'a user with the AUDIT_ADMIN role'), lines.map((l) => `NOAUDIT POLICY ${/POLICY (\w+)/.exec(l)![1]};`).join('\n')),
      basedOn: ['audit_trail = NONE and no unified audit policy enabled', `Predefined policies available: ${pol.join(', ')}`],
    }
  },

  'memory-management': async (c) => {
    const p = await rows<{ N: string; V: string }>(c.conn, `SELECT NAME AS "N", VALUE AS "V" FROM V$PARAMETER WHERE NAME IN ('memory_target', 'sga_target', 'sga_max_size', 'pga_aggregate_target', 'shared_pool_size', 'db_cache_size', 'large_pool_size', 'java_pool_size', 'streams_pool_size')`)
    const v = (k: string) => n(p.find((x) => x.N === k)?.V)
    if (v('memory_target') || v('sga_target')) return null
    const sga = n((await one<{ B: number }>(c.conn, `SELECT SUM(VALUE) AS "B" FROM V$SGA`))?.B)
    const target = Math.floor(Math.min(sga, v('sga_max_size') || sga) / (1024 * 1024))
    const set = ['shared_pool_size', 'db_cache_size', 'large_pool_size', 'java_pool_size', 'streams_pool_size'].filter((k) => v(k))
    return {
      why: 'With manual SGA sizing the buffer cache and shared pool cannot give memory to each other when the workload changes (ORA-04031 in the shared pool while the cache has room). ASMM moves memory between them automatically.',
      impact: { restart: true, downtime: true, risk: 'low', notes: ['Use ASMM (SGA_TARGET), not AMM (MEMORY_TARGET), on Linux: AMM cannot use HugePages.', 'Pool sizes that stay set act as minimums under ASMM.'] },
      steps: [
        sql('Enable ASMM with the current SGA size', root(c), [`ALTER SYSTEM SET sga_target = ${target}M SCOPE=SPFILE SID='*';`, ...(v('pga_aggregate_target') ? [] : [`ALTER SYSTEM SET pga_aggregate_target = ${Math.max(256, Math.round(target * 0.25))}M SCOPE=SPFILE SID='*';`]), ...set.map((k) => `-- ALTER SYSTEM RESET ${k} SCOPE=SPFILE SID='*';   -- optional: let ASMM size it freely (now ${p.find((x) => x.N === k)?.V})`)].join('\n')),
        restart(c),
      ],
      verify: check('Memory parameters and components', root(c), "SHOW PARAMETER sga_target\nSELECT COMPONENT, ROUND(CURRENT_SIZE / 1048576) AS MB FROM V$SGA_DYNAMIC_COMPONENTS WHERE CURRENT_SIZE > 0 ORDER BY 2 DESC;"),
      rollback: sql('Back to manual sizing', root(c), "ALTER SYSTEM RESET sga_target SCOPE=SPFILE SID='*';"),
      basedOn: [`SGA ${fmtBytes(sga)} (V$SGA)`, ...p.filter((x) => n(x.V)).map((x) => `${x.N} = ${x.V}`)],
    }
  },

  'patch-level': async (c) => {
    const last = await tryOne<{ D: string; T: string }>(c.conn, `SELECT * FROM (SELECT DESCRIPTION AS "D", TO_CHAR(ACTION_TIME, 'YYYY-MM-DD') AS "T" FROM DBA_REGISTRY_SQLPATCH WHERE STATUS = 'SUCCESS' ORDER BY ACTION_TIME DESC) WHERE ROWNUM = 1`)
    return {
      why: 'Release Updates ship quarterly with security fixes (CVEs) and bug fixes; a database more than a year behind carries known, published vulnerabilities.',
      impact: { restart: true, downtime: true, risk: 'medium', notes: [c.rac ? 'RAC: most Release Updates can be applied rolling, one node at a time (opatchauto).' : 'Single instance: downtime while the home is patched — out-of-place patching (a new patched home, then switch) keeps it short and rollback easy.', 'Patch a test copy first and read the README of the exact patch.'] },
      steps: [
        shell('Patches in the Oracle home', 'oracle OS user', '$ORACLE_HOME/OPatch/opatch lspatches'),
        check('Patches recorded in the database', here(c), 'SELECT PATCH_ID, ACTION, STATUS, ACTION_TIME, DESCRIPTION FROM DBA_REGISTRY_SQLPATCH ORDER BY ACTION_TIME DESC;'),
        shell('Download the latest Release Update for this version and the current OPatch (patch 6880880) from My Oracle Support, then check conflicts', 'oracle OS user', '$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph <<PATCH_DIR>>'),
        shell(c.rac ? 'Apply (Grid Infrastructure + database homes, rolling)' : 'Apply to the home (database and listener stopped)', c.rac ? 'root, on each node in turn' : 'oracle OS user', c.rac ? '$GRID_HOME/OPatch/opatchauto apply <<PATCH_DIR>>' : 'cd <<PATCH_DIR>>\n$ORACLE_HOME/OPatch/opatch apply'),
        shell('Load the SQL changes into the database (after startup)', 'oracle OS user', '$ORACLE_HOME/OPatch/datapatch -verbose'),
      ],
      verify: check('Patch recorded in the database', here(c), "SELECT PATCH_ID, ACTION, STATUS, ACTION_TIME FROM DBA_REGISTRY_SQLPATCH ORDER BY ACTION_TIME DESC;\nSELECT COUNT(*) FROM DBA_OBJECTS WHERE STATUS <> 'VALID';"),
      rollback: shell('Roll the patch back', 'oracle OS user', '$ORACLE_HOME/OPatch/opatch rollback -id <<PATCH_ID>>\n$ORACLE_HOME/OPatch/datapatch -verbose'),
      basedOn: [last ? `Last SQL patch: ${last.D} on ${last.T}` : 'No SQL patch recorded', `Server version ${c.version}`],
      guidanceOnly: true,
    }
  },
}

// --- parameter helpers ------------------------------------------------------------------------------

type SetParam = { N: string; V: string | null; T: number; SP: string | null }

function setParams(c: FixCtx, where: string) {
  return rows<SetParam>(c.conn, `SELECT p.NAME AS "N", p.VALUE AS "V", p.TYPE AS "T", (SELECT MAX(s.ISSPECIFIED) FROM V$SPPARAMETER s WHERE s.NAME = p.NAME) AS "SP" FROM V$PARAMETER p WHERE ${where} AND p.ISDEFAULT = 'FALSE' ORDER BY 1`)
}

/** Parameter value as ALTER SYSTEM SET needs it: strings (type 2) and file names (4) quoted. */
const pval = (x: SetParam) => (x.T === 2 || x.T === 4 ? lit(x.V ?? '') : (x.V ?? "''"))

const DEPRECATED_HINTS: Record<string, string> = {
  utl_file_dir: 'replaced by DIRECTORY objects (CREATE DIRECTORY …; GRANT READ, WRITE ON DIRECTORY …) — UTL_FILE ignores it from 18c',
  sec_case_sensitive_logon: 'if it is FALSE, logins become case-sensitive after the reset: check DBA_USERS.PASSWORD_VERSIONS and the clients first',
  remote_os_authent: 'insecure; resetting disables remote OS authentication',
  background_dump_dest: 'replaced by diagnostic_dest',
  user_dump_dest: 'replaced by diagnostic_dest',
  core_dump_dest: 'replaced by diagnostic_dest',
  standby_archive_dest: 'use LOG_ARCHIVE_DEST_n with VALID_FOR=(STANDBY_LOGFILE,STANDBY_ROLE)',
  log_archive_local_first: 'no longer has an effect',
  parallel_automatic_tuning: 'use PARALLEL_DEGREE_POLICY',
  cursor_space_for_time: 'no longer has an effect',
}

// --- entry points --------------------------------------------------------------------------------------

export function hasFix(id: string) {
  return id in BUILDERS
}

/** Builds the recommendation for one finding, or null when there is nothing to fix (any more). */
export async function buildRecommendation(c: FixCtx, f: AssessmentFinding): Promise<Recommendation | null> {
  if (f.severity === 'ok' || f.severity === 'na') return null
  const b = BUILDERS[f.id]
  if (!b) {
    if (!f.recommendation) return null
    return finish(f, { why: f.detail, steps: [], guidanceOnly: true, prerequisites: [f.recommendation] })
  }
  const d = await b(c, f)
  return d ? finish(f, d) : null
}

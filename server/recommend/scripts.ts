// Pure script builders for remediation advice. Inputs are facts read from the database; outputs
// are SQL/RMAN text the DBA reviews and runs. Nothing here executes anything.

export const GiB = 1024 ** 3
const MiB = 1024 ** 2

/** SQL string literal. */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Identifier as Oracle needs it in a script: plain when it is an ordinary upper-case name, quoted otherwise. */
export const qi = (s: string) => (/^[A-Z][A-Z0-9_$#]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)
export const qn = (owner: string, name: string) => `${qi(owner)}.${qi(name)}`

export function fmtBytes(v: number) {
  if (v >= GiB) return `${(v / GiB).toFixed(1)} GiB`
  return `${Math.round(v / MiB)} MiB`
}

/** Rounds a byte size up to a tidy value (64M steps below 1 GiB, whole GiB above). */
export function niceSize(bytes: number): string {
  if (bytes <= GiB) {
    const m = [64, 128, 256, 512].find((s) => s * MiB >= bytes)
    return m ? `${m}M` : '1G'
  }
  return `${Math.ceil(bytes / GiB)}G`
}

/** Short name within the identifier limit. */
export function shortName(base: string, suffix: string, max = 30) {
  return `${base.slice(0, max - suffix.length).replace(/_+$/, '')}${suffix}`
}

/** ASM paths start with '+': naming only the disk group lets Oracle name the file. */
export const isAsm = (path: string) => path.startsWith('+')
export const diskGroupOf = (path: string) => (isAsm(path) ? path.split('/')[0]! : null)

const pad2 = (n: number) => String(n).padStart(2, '0')

// --- redo -------------------------------------------------------------------------------------

export interface RedoGroup {
  group: number
  thread: number
  bytes: number
  members: number
  status: string
  files: string[]
}

/** Member clause for a new redo group: '' (OMF), the ASM disk groups, or two file-system paths. */
export type GroupSpec = (group: number) => string

export function groupSpec(layout: { omf: boolean; diskGroup: string | null }): GroupSpec {
  if (layout.omf) return () => ''
  if (layout.diskGroup) return () => ` ('${layout.diskGroup}', '+<<SECOND_DISKGROUP>>')`
  return (g) => ` ('<<DISK_A_DIR>>/redo${pad2(g)}a.log', '<<DISK_B_DIR>>/redo${pad2(g)}b.log')`
}

/** Adds a second member to every single-member group (ASM: a disk group; file system: an explicit path). */
export function redoMemberScript(groups: RedoGroup[]): string {
  const asm = groups.some((g) => g.files.some(isAsm))
  return groups
    .filter((g) => g.members < 2)
    .map((g) =>
      asm
        ? `ALTER DATABASE ADD LOGFILE MEMBER '+<<SECOND_DISKGROUP>>' TO GROUP ${g.group};`
        : `ALTER DATABASE ADD LOGFILE MEMBER '<<SECOND_DISK_DIR>>/redo${pad2(g.group)}b.log' TO GROUP ${g.group};`,
    )
    .join('\n')
}

/** Groups needed so every thread has at least three, the same size as that thread's existing groups. */
export function addGroupsScript(groups: RedoGroup[], spec: GroupSpec): string[] {
  let next = Math.max(...groups.map((g) => g.group)) + 1
  const out: string[] = []
  for (const t of [...new Set(groups.map((g) => g.thread))].sort((a, b) => a - b)) {
    const mine = groups.filter((g) => g.thread === t)
    const size = niceSize(Math.max(...mine.map((g) => g.bytes)))
    for (let i = mine.length; i < 3; i++) {
      const g = next++
      out.push(`ALTER DATABASE ADD LOGFILE THREAD ${t} GROUP ${g}${spec(g)} SIZE ${size};`)
    }
  }
  return out
}

/**
 * Bigger redo logs: sized so peak load switches about every 15 minutes (4 per hour), never less
 * than twice the current size. New groups are added first; the old ones are dropped once INACTIVE.
 */
export function redoResizePlan(groups: RedoGroup[], peakPerHour: number, spec: GroupSpec) {
  const cur = Math.max(...groups.map((g) => g.bytes))
  const target = niceSize(Math.max(cur * 2, (cur * peakPerHour) / 4))
  let next = Math.max(...groups.map((g) => g.group)) + 1
  const add: string[] = []
  for (const t of [...new Set(groups.map((g) => g.thread))].sort((a, b) => a - b)) {
    const count = Math.max(3, groups.filter((g) => g.thread === t).length)
    for (let i = 0; i < count; i++) {
      const g = next++
      add.push(`ALTER DATABASE ADD LOGFILE THREAD ${t} GROUP ${g}${spec(g)} SIZE ${target};`)
    }
  }
  const added = add.map((_, i) => next - add.length + i)
  const drop = groups.map((g) => `ALTER DATABASE DROP LOGFILE GROUP ${g.group};`)
  return { target, add, added, drop }
}

// --- tablespaces --------------------------------------------------------------------------------

export interface TablespaceFact {
  name: string
  contents: string
  bigfile: boolean
  blockSize: number
  /** Used and maximum size as DBA_TABLESPACE_USAGE_METRICS counts them (bytes). */
  usedBytes: number
  maxBytes: number
  fileCount: number
  /** An existing file name, to derive the ASM disk group for the new file. */
  sampleFile: string | null
}

/** A smallfile datafile holds at most 4,194,303 blocks; whole GiB below that limit. */
export function smallfileMaxGiB(blockSize: number) {
  return Math.floor((4194303 * blockSize) / GiB)
}

/**
 * Space so usage drops to ~70% of the new maximum. Smallfile: enough new autoextending files;
 * bigfile: raise the single file's maximum. File placement: OMF when DB_CREATE_FILE_DEST is set,
 * the existing ASM disk group, else a <<DATAFILE_DIR>> placeholder.
 */
export function tablespaceFix(t: TablespaceFact, omf: boolean): { code: string; placeholder: boolean } {
  const kind = t.contents === 'TEMPORARY' ? 'TEMPFILE' : 'DATAFILE'
  if (t.bigfile) return { code: `ALTER TABLESPACE ${qi(t.name)} AUTOEXTEND ON NEXT 1G MAXSIZE UNLIMITED;`, placeholder: false }
  const need = Math.max(GiB, t.usedBytes / 0.7 - t.maxBytes)
  const capG = smallfileMaxGiB(t.blockSize)
  const files = Math.max(1, Math.ceil(need / (capG * GiB)))
  // Start small and let autoextend grow each file up to the smallfile maximum.
  const initial = niceSize(Math.min(need / files, 4 * GiB))
  const asm = t.sampleFile ? diskGroupOf(t.sampleFile) : null
  const lines: string[] = []
  for (let i = 1; i <= files; i++) {
    const spec = omf ? '' : asm ? ` '${asm}'` : ` '<<DATAFILE_DIR>>/${t.name.toLowerCase()}${pad2(t.fileCount + i)}.dbf'`
    lines.push(`ALTER TABLESPACE ${qi(t.name)} ADD ${kind}${spec} SIZE ${initial} AUTOEXTEND ON NEXT 256M MAXSIZE ${capG}G;`)
  }
  return { code: lines.join('\n'), placeholder: !omf && !asm }
}

// --- privileges ------------------------------------------------------------------------------

export interface GrantFact {
  grantee: string
  privilege: string
  adminOption: boolean
  /** DBA_*_PRIVS.COMMON = 'YES' (granted commonly from CDB$ROOT). */
  common: boolean
  /** Set when the revoke should stay commented (e.g. a monitoring account that needs it). */
  keep?: string
}

/** REVOKE statements split by where they must run (common grants only from the root), plus their undo. */
export function revokeScript(grants: GrantFact[]) {
  const line = (g: GrantFact) => {
    const s = `REVOKE ${g.privilege} FROM ${qi(g.grantee)}${g.common ? ' CONTAINER = ALL' : ''};`
    return g.keep ? `-- ${s}   -- ${g.keep}` : s
  }
  const undo = (g: GrantFact) => `GRANT ${g.privilege} TO ${qi(g.grantee)}${g.adminOption ? ' WITH ADMIN OPTION' : ''}${g.common ? ' CONTAINER = ALL' : ''};`
  return {
    local: grants.filter((g) => !g.common).map(line).join('\n'),
    common: grants.filter((g) => g.common).map(line).join('\n'),
    undoLocal: grants.filter((g) => !g.common && !g.keep).map(undo).join('\n'),
    undoCommon: grants.filter((g) => g.common && !g.keep).map(undo).join('\n'),
  }
}

export interface PublicPackageFact {
  pkg: string
  common: boolean
  /** Schemas whose objects depend on the package and have no direct grant yet. */
  dependents: string[]
}

export const NETWORK_FILE = new Set(['UTL_FILE', 'UTL_HTTP', 'UTL_TCP', 'UTL_SMTP', 'UTL_INADDR', 'UTL_MAIL', 'HTTPURITYPE', 'DBMS_LDAP', 'DBMS_BACKUP_RESTORE', 'DBMS_JAVA'])

/**
 * Revoke EXECUTE from PUBLIC the safe way: first grant directly to every schema whose objects depend
 * on the package, then revoke. Network/file packages are active lines; the widely used ones stay
 * commented until the applications are tested. A grant made commonly (COMMON=YES) can only be
 * revoked from CDB$ROOT with CONTAINER = ALL, so revokes are split by where they must run.
 */
export function publicRevokeScript(pkgs: PublicPackageFact[]) {
  const sorted = [...pkgs].sort((a, b) => Number(NETWORK_FILE.has(b.pkg)) - Number(NETWORK_FILE.has(a.pkg)) || a.pkg.localeCompare(b.pkg))
  const c = (p: PublicPackageFact) => (NETWORK_FILE.has(p.pkg) ? '' : '-- ')
  const label = (p: PublicPackageFact) => `-- ${p.pkg}${NETWORK_FILE.has(p.pkg) ? ' (network / file access)' : ' (widely used: uncomment only after testing your applications)'}`
  const grants = sorted
    .filter((p) => p.dependents.length)
    .map((p) => [label(p), ...p.dependents.map((d) => `${c(p)}GRANT EXECUTE ON SYS.${p.pkg} TO ${qi(d)};`)].join('\n'))
    .join('\n\n')
  const revoke = (common: boolean) =>
    sorted
      .filter((p) => p.common === common)
      .map((p) => `${label(p)}\n${c(p)}REVOKE EXECUTE ON SYS.${p.pkg} FROM PUBLIC${common ? ' CONTAINER = ALL' : ''};`)
      .join('\n\n')
  const restore = (common: boolean) =>
    sorted
      .filter((p) => p.common === common)
      .map((p) => `GRANT EXECUTE ON SYS.${p.pkg} TO PUBLIC${common ? ' CONTAINER = ALL' : ''};`)
      .join('\n')
  return { grants, revokeLocal: revoke(false), revokeCommon: revoke(true), restoreLocal: restore(false), restoreCommon: restore(true) }
}

// --- profiles --------------------------------------------------------------------------------

export type PasswordLimit = 'FAILED_LOGIN_ATTEMPTS' | 'PASSWORD_VERIFY_FUNCTION' | 'PASSWORD_LIFE_TIME'

export interface ProfileFact {
  profile: string
  /** Common profile (C##… created in CDB$ROOT): only alterable from the root with CONTAINER = ALL. */
  common: boolean
  /** DBA_PROFILES.LIMIT as stored (may be DEFAULT). */
  raw: Record<PasswordLimit, string | null>
  /** Effective value after DEFAULT-profile inheritance. */
  eff: Record<PasswordLimit, string | null>
}

/**
 * ALTER PROFILE for the weak settings, values from common hardening baselines (CIS: ≤ 5 failed
 * logins, a verify function). A password lifetime is only suggested (commented): expiring the
 * password of an application service account takes the application down.
 */
export function profileScript(p: ProfileFact, verifyFunction: string | null) {
  const set: string[] = []
  const undo: string[] = []
  if (p.eff.FAILED_LOGIN_ATTEMPTS === 'UNLIMITED') {
    set.push('FAILED_LOGIN_ATTEMPTS 5')
    undo.push(`FAILED_LOGIN_ATTEMPTS ${p.raw.FAILED_LOGIN_ATTEMPTS ?? 'DEFAULT'}`)
  }
  if (!p.eff.PASSWORD_VERIFY_FUNCTION || p.eff.PASSWORD_VERIFY_FUNCTION === 'NULL') {
    set.push(`PASSWORD_VERIFY_FUNCTION ${verifyFunction ?? '<<VERIFY_FUNCTION>>'}`)
    undo.push(`PASSWORD_VERIFY_FUNCTION ${p.raw.PASSWORD_VERIFY_FUNCTION ?? 'DEFAULT'}`)
  }
  const container = p.common ? ' CONTAINER = ALL' : ''
  const name = qi(p.profile)
  const lines: string[] = []
  if (set.length) lines.push(`ALTER PROFILE ${name} LIMIT ${set.join(' ')}${container};`)
  if (p.eff.PASSWORD_LIFE_TIME === 'UNLIMITED')
    lines.push(`-- Human accounts only (never for service accounts, whose passwords would expire):\n-- ALTER PROFILE ${name} LIMIT PASSWORD_LIFE_TIME 90 PASSWORD_GRACE_TIME 7${container};`)
  return { code: lines.join('\n'), rollback: undo.length ? `ALTER PROFILE ${name} LIMIT ${undo.join(' ')}${container};` : '' }
}

// --- indexes --------------------------------------------------------------------------------

export interface FkFact {
  owner: string
  table: string
  constraint: string
  columns: string[]
}

/** One CREATE INDEX per unindexed foreign key, in the key's column order; names avoid existing indexes. */
export function fkIndexScript(fks: FkFact[], existingNames: Set<string>, online: boolean) {
  const used = new Set(existingNames)
  const names: string[] = []
  const code = fks
    .map((f) => {
      let name = shortName(f.constraint, '_IX')
      for (let i = 2; used.has(`${f.owner}.${name}`); i++) name = shortName(f.constraint, `_IX${i}`)
      used.add(`${f.owner}.${name}`)
      names.push(qn(f.owner, name))
      return `CREATE INDEX ${qn(f.owner, name)} ON ${qn(f.owner, f.table)} (${f.columns.map(qi).join(', ')})${online ? ' ONLINE' : ''};`
    })
    .join('\n')
  return { code, names }
}

/** Placeholders (<<NAME>>) used in a block of script text. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/<<([A-Z0-9_]+)>>/g)].map((m) => m[1]!))]
}

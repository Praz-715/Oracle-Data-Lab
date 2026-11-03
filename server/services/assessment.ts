import type { Connection } from 'oracledb'
import type { AssessmentFinding, AssessmentSection, AssessmentSeverity } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { versionMajorOf } from '../database/environment'
import { oracleErrorInfo } from '../database/errors'
import { one, rows, softPanel } from '../database/query'

// Database assessment: a read-only inventory of the whole database (parameters, parameter file,
// users, profiles, privileges, tablespaces, objects, physical structure, memory, components) plus
// automated health checks. Every query is SELECT-only and license-free (no AWR/ASH/packs).
// Version differences are handled by choosing columns per major version; anything the account
// cannot see becomes an "unavailable" panel or an `na` finding, never a guessed value.

const CATALOG = 'SELECT_CATALOG_ROLE (or SELECT ANY DICTIONARY)'
const TS = `'YYYY-MM-DD"T"HH24:MI:SS'`

/** Schemas shipped by Oracle on 11g, where DBA_USERS.ORACLE_MAINTAINED does not exist yet. */
const ORACLE_SCHEMAS_11G = [
  'SYS', 'SYSTEM', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'WMSYS', 'EXFSYS', 'CTXSYS', 'XDB', 'ANONYMOUS', 'ORDSYS', 'ORDDATA',
  'ORDPLUGINS', 'SI_INFORMTN_SCHEMA', 'MDSYS', 'OLAPSYS', 'MDDATA', 'SPATIAL_WFS_ADMIN_USR', 'SPATIAL_CSW_ADMIN_USR', 'SYSMAN',
  'MGMT_VIEW', 'FLOWS_FILES', 'APEX_PUBLIC_USER', 'APEX_030200', 'APEX_040000', 'APEX_040200', 'OWBSYS', 'OWBSYS_AUDIT',
  'ORACLE_OCM', 'XS$NULL', 'DIP', 'TSMSYS', 'DMSYS', 'LBACSYS', 'DVSYS', 'DVF', 'PUBLIC',
]
const ORACLE_ROLES_11G = [
  'CONNECT', 'RESOURCE', 'DBA', 'SELECT_CATALOG_ROLE', 'EXECUTE_CATALOG_ROLE', 'DELETE_CATALOG_ROLE', 'EXP_FULL_DATABASE',
  'IMP_FULL_DATABASE', 'DATAPUMP_EXP_FULL_DATABASE', 'DATAPUMP_IMP_FULL_DATABASE', 'RECOVERY_CATALOG_OWNER', 'SCHEDULER_ADMIN',
  'AQ_ADMINISTRATOR_ROLE', 'AQ_USER_ROLE', 'OEM_MONITOR', 'OEM_ADVISOR', 'LOGSTDBY_ADMINISTRATOR', 'HS_ADMIN_ROLE',
  'HS_ADMIN_SELECT_ROLE', 'HS_ADMIN_EXECUTE_ROLE', 'GLOBAL_AQ_USER_ROLE', 'JAVASYSPRIV', 'JAVAUSERPRIV', 'JAVADEBUGPRIV',
  'JAVAIDPRIV', 'JAVA_ADMIN', 'JAVA_DEPLOY', 'EJBCLIENT', 'XDBADMIN', 'XDB_SET_INVOKER', 'XDB_WEBSERVICES', 'AUTHENTICATEDUSER',
  'CTXAPP', 'OLAP_DBA', 'OLAP_USER', 'OLAP_XS_ADMIN', 'WM_ADMIN_ROLE', 'SPATIAL_CSW_ADMIN', 'SPATIAL_WFS_ADMIN', 'MGMT_USER',
  'CSW_USR_ROLE', 'WFS_USR_ROLE', 'ADM_PARALLEL_EXECUTE_TASK', 'GATHER_SYSTEM_STATISTICS', 'DBFS_ROLE', 'CWM_USER', 'PLUSTRACE',
]
export const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(',')

/** Condition on a DBA_USERS alias that is true for application (non Oracle-maintained) users. */
export function customUser(major: number, a: string) {
  return major >= 12 ? `${a}.ORACLE_MAINTAINED = 'N'` : `${a}.USERNAME IS NOT NULL AND ${a}.USERNAME NOT IN (${inList(ORACLE_SCHEMAS_11G)})`
}
/** Condition on an owner/grantee column that is true for application schemas. */
export function customOwner(major: number, col: string) {
  return `EXISTS (SELECT 1 FROM DBA_USERS cu_ WHERE cu_.USERNAME = ${col} AND ${customUser(major, 'cu_')})`
}
/** Condition on a grantee column that excludes Oracle-maintained users and roles. */
export function customGrantee(major: number, col: string) {
  return major >= 12
    ? `${col} NOT IN (SELECT USERNAME FROM DBA_USERS WHERE ORACLE_MAINTAINED = 'Y') AND ${col} NOT IN (SELECT ROLE FROM DBA_ROLES WHERE ORACLE_MAINTAINED = 'Y') AND ${col} <> 'PUBLIC'`
    : `${col} NOT IN (${inList(ORACLE_SCHEMAS_11G)}) AND ${col} NOT IN (${inList(ORACLE_ROLES_11G)})`
}

/** Executable PL/SQL packages that CIS benchmarks say PUBLIC should not have EXECUTE on. */
export const SENSITIVE_PACKAGES = [
  'UTL_FILE', 'UTL_HTTP', 'UTL_TCP', 'UTL_SMTP', 'UTL_INADDR', 'UTL_MAIL', 'UTL_DBWS', 'UTL_ORAMTS', 'HTTPURITYPE', 'DBMS_LDAP',
  'DBMS_BACKUP_RESTORE', 'DBMS_JAVA', 'DBMS_JAVA_TEST', 'DBMS_ADVISOR', 'DBMS_CRYPTO', 'DBMS_JOB', 'DBMS_LOB',
  'DBMS_OBFUSCATION_TOOLKIT', 'DBMS_SCHEDULER', 'DBMS_SQL', 'DBMS_XMLGEN', 'DBMS_XMLQUERY',
]
const NETWORK_FILE_PACKAGES = new Set(['UTL_FILE', 'UTL_HTTP', 'UTL_TCP', 'UTL_SMTP', 'UTL_INADDR', 'UTL_MAIL', 'HTTPURITYPE', 'DBMS_LDAP', 'DBMS_BACKUP_RESTORE', 'DBMS_JAVA'])

const POWERFUL_ROLES = ['DBA', 'IMP_FULL_DATABASE', 'EXP_FULL_DATABASE', 'DATAPUMP_EXP_FULL_DATABASE', 'DATAPUMP_IMP_FULL_DATABASE', 'SELECT_CATALOG_ROLE', 'EXECUTE_CATALOG_ROLE', 'DELETE_CATALOG_ROLE', 'SCHEDULER_ADMIN', 'AUDIT_ADMIN', 'PDB_DBA']
const POWERFUL_PRIVS = [
  'ALTER SYSTEM', 'ALTER DATABASE', 'ALTER USER', 'CREATE USER', 'DROP USER', 'BECOME USER', 'GRANT ANY PRIVILEGE', 'GRANT ANY ROLE',
  'GRANT ANY OBJECT PRIVILEGE', 'AUDIT SYSTEM', 'EXEMPT ACCESS POLICY', 'EXEMPT REDACTION POLICY', 'ALTER PROFILE', 'DROP PROFILE',
  'UNLIMITED TABLESPACE', 'SYSDBA', 'SYSOPER', 'ADMINISTER DATABASE TRIGGER', 'CREATE ANY DIRECTORY', 'CREATE PUBLIC DATABASE LINK',
]

/** Database-clock timestamps (TO_CHAR ... TS) carry no zone, like elsewhere in the app; normalize empties. */
function iso(v: string | null | undefined) {
  return v || null
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

async function summary(conn: Connection): Promise<AssessmentSection> {
  const major = versionMajorOf(conn)
  const identity = await softPanel(async () => {
    const db = await one<Record<string, unknown>>(
      conn,
      `SELECT d.NAME AS "dbName", d.DB_UNIQUE_NAME AS "dbUniqueName", d.DBID AS "dbid", TO_CHAR(d.CREATED, ${TS}) AS "created",
              d.LOG_MODE AS "logMode", d.OPEN_MODE AS "openMode", d.DATABASE_ROLE AS "databaseRole", d.PROTECTION_MODE AS "protectionMode",
              d.FORCE_LOGGING AS "forceLogging", d.FLASHBACK_ON AS "flashbackOn", d.SUPPLEMENTAL_LOG_DATA_MIN AS "supplementalLogging",
              d.PLATFORM_NAME AS "platform"${major >= 12 ? ', d.CDB AS "cdb"' : ''}
         FROM V$DATABASE d`,
    )
    const inst = await one<Record<string, unknown>>(
      conn,
      `SELECT INSTANCE_NAME AS "instanceName", HOST_NAME AS "hostName", ${major >= 18 ? 'VERSION_FULL' : 'VERSION'} AS "version",
              TO_CHAR(STARTUP_TIME, ${TS}) AS "startupTime", ROUND((SYSDATE - STARTUP_TIME) * 86400) AS "uptimeSeconds",
              STATUS AS "status", ARCHIVER AS "archiver", LOGINS AS "logins", PARALLEL AS "parallel"
         FROM V$INSTANCE`,
    )
    const banner = await one<{ B: string }>(conn, `SELECT BANNER AS "B" FROM V$VERSION WHERE ROWNUM = 1`)
    const nls = await rows<{ P: string; V: string }>(
      conn,
      `SELECT PARAMETER AS "P", VALUE AS "V" FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET')`,
    )
    const ctx = major >= 12 ? await one<{ C: string }>(conn, `SELECT SYS_CONTEXT('USERENV', 'CON_NAME') AS "C" FROM DUAL`) : null
    const cs = Object.fromEntries(nls.map((n) => [n.P, n.V]))
    return {
      banner: banner?.B ?? null,
      ...db,
      ...inst,
      container: ctx?.C ?? null,
      characterSet: cs.NLS_CHARACTERSET ?? null,
      nationalCharacterSet: cs.NLS_NCHAR_CHARACTERSET ?? null,
      created: iso(db?.created as string),
      startupTime: iso(inst?.startupTime as string),
    }
  }, CATALOG)

  const counts = await softPanel(async () => {
    const out: Record<string, number | null> = {}
    const gaps: string[] = []
    const take = async (sql: string) => {
      try {
        const r = await one<Record<string, number | null>>(conn, sql)
        Object.assign(out, r)
      } catch (err) {
        const i = oracleErrorInfo(err)
        if (!i.unavailable) throw err
        gaps.push(i.code)
      }
    }
    await take(`SELECT COUNT(*) AS "users", SUM(CASE WHEN u.ACCOUNT_STATUS = 'OPEN' THEN 1 ELSE 0 END) AS "usersOpen",
                       SUM(CASE WHEN u.ACCOUNT_STATUS LIKE '%LOCKED%' THEN 1 ELSE 0 END) AS "usersLocked",
                       SUM(CASE WHEN u.ACCOUNT_STATUS LIKE '%EXPIRED%' THEN 1 ELSE 0 END) AS "usersExpired",
                       SUM(CASE WHEN ${customUser(major, 'u')} THEN 1 ELSE 0 END) AS "usersApplication"
                  FROM DBA_USERS u`)
    await take(`SELECT COUNT(DISTINCT PROFILE) AS "profiles" FROM DBA_PROFILES`)
    await take(`SELECT COUNT(*) AS "roles" FROM DBA_ROLES`)
    await take(`SELECT COUNT(*) AS "tablespaces" FROM DBA_TABLESPACES`)
    await take(`SELECT COUNT(*) AS "datafiles", SUM(BYTES) AS "datafileBytes" FROM DBA_DATA_FILES`)
    await take(`SELECT COUNT(*) AS "tempfiles", SUM(BYTES) AS "tempfileBytes" FROM DBA_TEMP_FILES`)
    await take(`SELECT COUNT(*) AS "objects", SUM(CASE WHEN o.STATUS <> 'VALID' THEN 1 ELSE 0 END) AS "objectsInvalid",
                       SUM(CASE WHEN ${customUser(major, 'u')} THEN 1 ELSE 0 END) AS "objectsApplication",
                       SUM(CASE WHEN ${customUser(major, 'u')} AND o.STATUS <> 'VALID' THEN 1 ELSE 0 END) AS "objectsApplicationInvalid",
                       SUM(CASE WHEN o.OBJECT_TYPE = 'TABLE' THEN 1 ELSE 0 END) AS "tables",
                       SUM(CASE WHEN o.OBJECT_TYPE = 'INDEX' THEN 1 ELSE 0 END) AS "indexes"
                  FROM DBA_OBJECTS o LEFT JOIN DBA_USERS u ON u.USERNAME = o.OWNER`)
    await take(`SELECT SUM(s.BYTES) AS "segmentBytes", SUM(CASE WHEN ${customUser(major, 'u')} THEN s.BYTES ELSE 0 END) AS "segmentBytesApplication"
                  FROM DBA_SEGMENTS s LEFT JOIN DBA_USERS u ON u.USERNAME = s.OWNER`)
    await take(`SELECT COUNT(*) AS "parameters", SUM(CASE WHEN ISDEFAULT = 'FALSE' THEN 1 ELSE 0 END) AS "parametersNonDefault" FROM V$PARAMETER`)
    await take(`SELECT COUNT(*) AS "spfileEntries" FROM V$SPPARAMETER WHERE ISSPECIFIED = 'TRUE'`)
    await take(`SELECT COUNT(*) AS "redoGroups", SUM(BYTES) AS "redoBytes" FROM V$LOG`)
    await take(`SELECT COUNT(*) AS "controlfiles" FROM V$CONTROLFILE`)
    await take(`SELECT COUNT(*) AS "dbLinks" FROM DBA_DB_LINKS`)
    await take(`SELECT COUNT(*) AS "directories" FROM DBA_DIRECTORIES`)
    if (major >= 12) await take(`SELECT COUNT(*) AS "pdbs" FROM V$PDBS`)
    return { ...out, gaps }
  }, CATALOG)

  return { identity, counts }
}

async function parameters(conn: Connection): Promise<AssessmentSection> {
  const major = versionMajorOf(conn)
  const list = await softPanel(
    () =>
      rows(
        conn,
        `SELECT p.NAME AS "name", p.DISPLAY_VALUE AS "value",
                DECODE(p.TYPE, 1, 'boolean', 2, 'string', 3, 'integer', 4, 'file', 5, 'reserved', 6, 'big integer', 'other') AS "type",
                p.ISDEFAULT AS "isDefault", p.ISMODIFIED AS "isModified", p.ISSES_MODIFIABLE AS "sessionModifiable",
                p.ISSYS_MODIFIABLE AS "systemModifiable", ${major >= 12 ? 'p.ISPDB_MODIFIABLE' : 'NULL'} AS "pdbModifiable",
                p.ISDEPRECATED AS "deprecated", p.DESCRIPTION AS "description"
           FROM V$PARAMETER p
          ORDER BY p.NAME`,
      ),
    CATALOG,
    'Values as seen by this session/container (V$PARAMETER). Hidden "_" parameters appear only when set.',
  )
  return { parameters: list }
}

function pfileValue(v: string | null, type: string | null) {
  if (v == null) return "''"
  if (type && /integer|boolean|number/i.test(type)) return v
  return `'${v.replace(/'/g, "''")}'`
}

async function spfile(conn: Connection): Promise<AssessmentSection> {
  const source = await softPanel(async () => {
    const r = await one<{ V: string | null }>(conn, `SELECT VALUE AS "V" FROM V$PARAMETER WHERE NAME = 'spfile'`)
    return { spfile: r?.V || null, mode: r?.V ? 'SPFILE' : 'PFILE (text init.ora) or memory only' }
  }, CATALOG)
  const entries = await softPanel(
    async () => {
      const r = await rows<{ sid: string; name: string; ordinal: number; value: string | null; displayValue: string | null; type: string | null }>(
        conn,
        `SELECT SID AS "sid", NAME AS "name", ORDINAL AS "ordinal", VALUE AS "value", DISPLAY_VALUE AS "displayValue", TYPE AS "type"
           FROM V$SPPARAMETER
          WHERE ISSPECIFIED = 'TRUE'
          ORDER BY NAME, SID, ORDINAL`,
      )
      // Rebuild what `CREATE PFILE FROM SPFILE` would write: one line per sid.name, multi-values joined.
      const lines = new Map<string, string[]>()
      for (const e of r) {
        const k = `${e.sid}.${e.name}`
        const arr = lines.get(k) ?? []
        arr.push(pfileValue(e.value, e.type))
        lines.set(k, arr)
      }
      const text = [...lines].map(([k, vals]) => `${k}=${vals.join(',')}`).join('\n')
      return { entries: r, pfileText: text }
    },
    CATALOG,
    'Entries explicitly set in the server parameter file (V$SPPARAMETER). Inside a PDB only PDB-level settings are listed; the instance-wide SPFILE is visible from CDB$ROOT.',
  )
  // What the running instance actually uses beyond defaults — the practical init.ora, also inside a PDB.
  const effective = await softPanel(
    async () => {
      // V$PARAMETER2 has one row per value, so list parameters (control_files ...) quote correctly.
      const r = await rows<{ name: string; ordinal: number; value: string | null; displayValue: string | null; type: string }>(
        conn,
        `SELECT NAME AS "name", ORDINAL AS "ordinal", VALUE AS "value", DISPLAY_VALUE AS "displayValue",
                DECODE(TYPE, 1, 'boolean', 3, 'integer', 6, 'big integer', 'string') AS "type"
           FROM V$PARAMETER2 WHERE ISDEFAULT = 'FALSE' ORDER BY NAME, ORDINAL`,
      )
      const lines = new Map<string, string[]>()
      for (const e of r) lines.set(e.name, [...(lines.get(e.name) ?? []), pfileValue(e.value, e.type)])
      return { entries: r, pfileText: [...lines].map(([k, vals]) => `*.${k}=${vals.join(',')}`).join('\n') }
    },
    CATALOG,
    'Non-default parameters in effect for this instance/container (V$PARAMETER2), written in init.ora syntax.',
  )
  return { source, entries, effective }
}

async function users(conn: Connection): Promise<AssessmentSection> {
  const major = versionMajorOf(conn)
  const maint = major >= 12 ? 'u.ORACLE_MAINTAINED' : `CASE WHEN ${customUser(major, 'u')} THEN 'N' ELSE 'Y' END`
  const list = await softPanel(async () => {
    const r = await rows<Record<string, any>>(
      conn,
      `SELECT u.USERNAME AS "username", u.ACCOUNT_STATUS AS "status", u.PROFILE AS "profile",
              u.DEFAULT_TABLESPACE AS "defaultTablespace", u.TEMPORARY_TABLESPACE AS "temporaryTablespace",
              TO_CHAR(u.CREATED, ${TS}) AS "created", TO_CHAR(u.LOCK_DATE, ${TS}) AS "lockDate", TO_CHAR(u.EXPIRY_DATE, ${TS}) AS "expiryDate",
              u.AUTHENTICATION_TYPE AS "authentication", ${maint} AS "oracleMaintained",
              ${major >= 12 ? 'u.COMMON' : 'NULL'} AS "common", ${major >= 12 ? `TO_CHAR(u.LAST_LOGIN, ${TS})` : 'NULL'} AS "lastLogin",
              NVL(r.n, 0) AS "roles", NVL(sp.n, 0) AS "sysPrivs", NVL(o.n, 0) AS "objects", NVL(s.b, 0) AS "segmentBytes",
              CASE WHEN dba.GRANTEE IS NOT NULL THEN 'YES' ELSE 'NO' END AS "hasDba"
         FROM DBA_USERS u
         LEFT JOIN (SELECT GRANTEE, COUNT(*) n FROM DBA_ROLE_PRIVS GROUP BY GRANTEE) r ON r.GRANTEE = u.USERNAME
         LEFT JOIN (SELECT GRANTEE, COUNT(*) n FROM DBA_SYS_PRIVS GROUP BY GRANTEE) sp ON sp.GRANTEE = u.USERNAME
         LEFT JOIN (SELECT OWNER, COUNT(*) n FROM DBA_OBJECTS GROUP BY OWNER) o ON o.OWNER = u.USERNAME
         LEFT JOIN (SELECT OWNER, SUM(BYTES) b FROM DBA_SEGMENTS GROUP BY OWNER) s ON s.OWNER = u.USERNAME
         LEFT JOIN (SELECT DISTINCT GRANTEE FROM DBA_ROLE_PRIVS WHERE GRANTED_ROLE = 'DBA') dba ON dba.GRANTEE = u.USERNAME
        ORDER BY 10, 1`,
    )
    return r.map((x) => ({ ...x, created: iso(x.created), lockDate: iso(x.lockDate), expiryDate: iso(x.expiryDate), lastLogin: iso(x.lastLogin) }))
  }, CATALOG)
  const quotas = await softPanel(
    () =>
      rows(
        conn,
        `SELECT q.USERNAME AS "username", q.TABLESPACE_NAME AS "tablespace", q.BYTES AS "usedBytes",
                DECODE(q.MAX_BYTES, -1, NULL, q.MAX_BYTES) AS "maxBytes", DECODE(q.MAX_BYTES, -1, 'UNLIMITED', 'LIMITED') AS "quota"
           FROM DBA_TS_QUOTAS q
          ORDER BY q.USERNAME, q.TABLESPACE_NAME`,
      ),
    CATALOG,
  )
  return { users: list, quotas }
}

async function profiles(conn: Connection): Promise<AssessmentSection> {
  const matrix = await softPanel(async () => {
    const lim = await rows<{ profile: string; resource: string; type: string; limit: string }>(
      conn,
      `SELECT PROFILE AS "profile", RESOURCE_NAME AS "resource", RESOURCE_TYPE AS "type", LIMIT AS "limit"
         FROM DBA_PROFILES ORDER BY RESOURCE_TYPE DESC, RESOURCE_NAME, PROFILE`,
    )
    const used = await rows<{ profile: string; users: number; openUsers: number }>(
      conn,
      `SELECT PROFILE AS "profile", COUNT(*) AS "users", SUM(CASE WHEN ACCOUNT_STATUS = 'OPEN' THEN 1 ELSE 0 END) AS "openUsers"
         FROM DBA_USERS GROUP BY PROFILE`,
    )
    const names = [...new Set(lim.map((l) => l.profile))].sort((a, b) => (a === 'DEFAULT' ? -1 : b === 'DEFAULT' ? 1 : a.localeCompare(b)))
    const def = new Map(lim.filter((l) => l.profile === 'DEFAULT').map((l) => [l.resource, l.limit]))
    const byRes = new Map<string, Record<string, string>>()
    for (const l of lim) {
      const row = byRes.get(l.resource) ?? { resource: l.resource, type: l.type }
      // "DEFAULT" inherits from the DEFAULT profile; show the effective value next to it.
      row[l.profile] = l.limit === 'DEFAULT' && l.profile !== 'DEFAULT' ? `DEFAULT → ${def.get(l.resource) ?? '?'}` : l.limit
      byRes.set(l.resource, row)
    }
    return {
      profiles: names.map((n) => ({ profile: n, users: used.find((u) => u.profile === n)?.users ?? 0, openUsers: used.find((u) => u.profile === n)?.openUsers ?? 0 })),
      limits: [...byRes.values()],
    }
  }, CATALOG, '"DEFAULT → x" means the profile inherits the value x from the DEFAULT profile.')
  return { profiles: matrix }
}

async function security(conn: Connection): Promise<AssessmentSection> {
  const major = versionMajorOf(conn)
  const roles = await softPanel(
    () =>
      rows(
        conn,
        `SELECT r.ROLE AS "role", r.PASSWORD_REQUIRED AS "passwordRequired",
                ${major >= 12 ? 'r.ORACLE_MAINTAINED' : `CASE WHEN r.ROLE IN (${inList(ORACLE_ROLES_11G)}) THEN 'Y' ELSE 'N' END`} AS "oracleMaintained",
                ${major >= 12 ? 'r.COMMON' : 'NULL'} AS "common",
                NVL(g.n, 0) AS "grantees", NVL(sp.n, 0) AS "sysPrivs", NVL(tp.n, 0) AS "objectPrivs"
           FROM DBA_ROLES r
           LEFT JOIN (SELECT GRANTED_ROLE, COUNT(*) n FROM DBA_ROLE_PRIVS GROUP BY GRANTED_ROLE) g ON g.GRANTED_ROLE = r.ROLE
           LEFT JOIN (SELECT GRANTEE, COUNT(*) n FROM DBA_SYS_PRIVS GROUP BY GRANTEE) sp ON sp.GRANTEE = r.ROLE
           LEFT JOIN (SELECT GRANTEE, COUNT(*) n FROM DBA_TAB_PRIVS GROUP BY GRANTEE) tp ON tp.GRANTEE = r.ROLE
          ORDER BY 3, 1`,
      ),
    CATALOG,
  )
  const powerful = await softPanel(
    () =>
      rows(
        conn,
        `SELECT GRANTEE AS "grantee", 'ROLE' AS "kind", GRANTED_ROLE AS "privilege", ADMIN_OPTION AS "adminOption"
           FROM DBA_ROLE_PRIVS
          WHERE GRANTED_ROLE IN (${inList(POWERFUL_ROLES)}) AND ${customGrantee(major, 'GRANTEE')}
         UNION ALL
         SELECT GRANTEE, 'SYSTEM PRIVILEGE', PRIVILEGE, ADMIN_OPTION
           FROM DBA_SYS_PRIVS
          WHERE (PRIVILEGE LIKE '% ANY %' OR PRIVILEGE LIKE '% ANY' OR PRIVILEGE IN (${inList(POWERFUL_PRIVS)})) AND ${customGrantee(major, 'GRANTEE')}
          ORDER BY 1, 2, 3`,
      ),
    CATALOG,
    'Grants of powerful roles and system privileges to application users/roles (Oracle-maintained accounts excluded).',
  )
  const pwfile = await softPanel(
    () =>
      rows(
        conn,
        `SELECT USERNAME AS "username", SYSDBA AS "sysdba", SYSOPER AS "sysoper"${major >= 12 ? ', SYSBACKUP AS "sysbackup", SYSDG AS "sysdg", SYSKM AS "syskm"' : ''}
           FROM V$PWFILE_USERS ORDER BY 1`,
      ),
    CATALOG,
    'Accounts in the password file (administrative privileges usable while the database is closed).',
  )
  const defaultPasswords = await softPanel(
    () =>
      rows(
        conn,
        `SELECT d.USERNAME AS "username", u.ACCOUNT_STATUS AS "status"
           FROM DBA_USERS_WITH_DEFPWD d JOIN DBA_USERS u ON u.USERNAME = d.USERNAME
          ORDER BY CASE WHEN u.ACCOUNT_STATUS = 'OPEN' THEN 0 ELSE 1 END, 1`,
      ),
    'SELECT on DBA_USERS_WITH_DEFPWD (granted to SYS/DBA)',
  )
  const publicGrants = await softPanel(
    () =>
      rows(
        conn,
        `SELECT TABLE_NAME AS "object", PRIVILEGE AS "privilege", OWNER AS "owner"
           FROM DBA_TAB_PRIVS
          WHERE GRANTEE = 'PUBLIC' AND OWNER = 'SYS' AND TABLE_NAME IN (${inList(SENSITIVE_PACKAGES)})
          ORDER BY 1`,
      ),
    CATALOG,
    'Sensitive SYS packages executable by PUBLIC (CIS Oracle Database benchmark list).',
  )
  const dbLinks = await softPanel(
    () =>
      rows(
        conn,
        `SELECT OWNER AS "owner", DB_LINK AS "dbLink", USERNAME AS "username", HOST AS "host", TO_CHAR(CREATED, ${TS}) AS "created"
           FROM DBA_DB_LINKS ORDER BY 1, 2`,
      ),
    CATALOG,
  )
  const directories = await softPanel(
    () => rows(conn, `SELECT OWNER AS "owner", DIRECTORY_NAME AS "directory", DIRECTORY_PATH AS "path" FROM DBA_DIRECTORIES ORDER BY 2`),
    CATALOG,
  )
  const auditing = await softPanel(async () => {
    const trail = await one<{ V: string | null }>(conn, `SELECT VALUE AS "V" FROM V$PARAMETER WHERE NAME = 'audit_trail'`)
    let unified: string | null = null
    let policies: Record<string, unknown>[] = []
    if (major >= 12) {
      unified = (await one<{ V: string }>(conn, `SELECT VALUE AS "V" FROM V$OPTION WHERE PARAMETER = 'Unified Auditing'`))?.V ?? null
      try {
        const r = await conn.execute<Record<string, unknown>>(`SELECT * FROM AUDIT_UNIFIED_ENABLED_POLICIES`)
        policies = (r.rows ?? []).map(camelKeys)
      } catch (err) {
        if (!oracleErrorInfo(err).unavailable) throw err
      }
    }
    return { auditTrail: trail?.V ?? null, unifiedAuditingOnly: unified, enabledPolicies: policies }
  }, CATALOG, 'Unified auditing "TRUE" = pure unified mode; "FALSE" = mixed mode (traditional AUDIT_TRAIL plus unified policies).')
  return { roles, powerful, pwfile, defaultPasswords, publicGrants, dbLinks, directories, auditing }
}

function camelKeys(r: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), v instanceof Date ? v.toISOString() : v]))
}

async function tablespaces(conn: Connection): Promise<AssessmentSection> {
  const list = await softPanel(
    () =>
      rows(
        conn,
        `SELECT t.TABLESPACE_NAME AS "name", t.CONTENTS AS "contents", t.STATUS AS "status", t.BIGFILE AS "bigfile", t.BLOCK_SIZE AS "blockSize",
                t.EXTENT_MANAGEMENT AS "extentManagement", t.ALLOCATION_TYPE AS "allocationType", t.SEGMENT_SPACE_MANAGEMENT AS "segmentSpaceManagement",
                t.LOGGING AS "logging", t.FORCE_LOGGING AS "forceLogging", t.ENCRYPTED AS "encrypted", t.RETENTION AS "retention",
                t.DEF_TAB_COMPRESSION AS "defaultCompression",
                NVL(f.bytes, 0) AS "allocatedBytes", m.USED_SPACE * t.BLOCK_SIZE AS "usedBytes", m.TABLESPACE_SIZE * t.BLOCK_SIZE AS "maxBytes",
                ROUND(m.USED_PERCENT, 2) AS "usedPct", NVL(f.autoext, 'NO') AS "autoextend", NVL(f.files, 0) AS "files",
                NVL(seg.n, 0) AS "segments", NVL(du.n, 0) AS "defaultForUsers"
           FROM DBA_TABLESPACES t
           LEFT JOIN DBA_TABLESPACE_USAGE_METRICS m ON m.TABLESPACE_NAME = t.TABLESPACE_NAME
           LEFT JOIN (
             SELECT TABLESPACE_NAME, SUM(BYTES) AS bytes, MAX(AUTOEXTENSIBLE) AS autoext, COUNT(*) AS files FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME
             UNION ALL
             SELECT TABLESPACE_NAME, SUM(BYTES), MAX(AUTOEXTENSIBLE), COUNT(*) FROM DBA_TEMP_FILES GROUP BY TABLESPACE_NAME
           ) f ON f.TABLESPACE_NAME = t.TABLESPACE_NAME
           LEFT JOIN (SELECT TABLESPACE_NAME, COUNT(*) n FROM DBA_SEGMENTS GROUP BY TABLESPACE_NAME) seg ON seg.TABLESPACE_NAME = t.TABLESPACE_NAME
           LEFT JOIN (
             SELECT ts, SUM(n) n FROM (
               SELECT DEFAULT_TABLESPACE ts, COUNT(*) n FROM DBA_USERS GROUP BY DEFAULT_TABLESPACE
               UNION ALL
               SELECT TEMPORARY_TABLESPACE, COUNT(*) FROM DBA_USERS GROUP BY TEMPORARY_TABLESPACE
             ) GROUP BY ts
           ) du ON du.ts = t.TABLESPACE_NAME
          ORDER BY t.CONTENTS, t.TABLESPACE_NAME`,
      ),
    CATALOG,
    'Used/max from DBA_TABLESPACE_USAGE_METRICS (max includes autoextend headroom).',
  )
  const datafiles = await softPanel(
    () =>
      rows(
        conn,
        `SELECT 'DATA' AS "kind", FILE_ID AS "fileId", FILE_NAME AS "fileName", TABLESPACE_NAME AS "tablespace", BYTES AS "bytes",
                MAXBYTES AS "maxBytes", AUTOEXTENSIBLE AS "autoextend", INCREMENT_BY AS "incrementBlocks", STATUS AS "status"
           FROM DBA_DATA_FILES
         UNION ALL
         SELECT 'TEMP', FILE_ID, FILE_NAME, TABLESPACE_NAME, BYTES, MAXBYTES, AUTOEXTENSIBLE, INCREMENT_BY, STATUS
           FROM DBA_TEMP_FILES
          ORDER BY 4, 2`,
      ),
    CATALOG,
  )
  return { tablespaces: list, datafiles }
}

async function objects(conn: Connection): Promise<AssessmentSection> {
  const major = versionMajorOf(conn)
  const app = customUser(major, 'u')
  const byType = await softPanel(
    () =>
      rows(
        conn,
        `SELECT o.OBJECT_TYPE AS "type", COUNT(*) AS "total", SUM(CASE WHEN o.STATUS <> 'VALID' THEN 1 ELSE 0 END) AS "invalid",
                SUM(CASE WHEN ${app} THEN 1 ELSE 0 END) AS "application", SUM(CASE WHEN ${app} THEN 0 ELSE 1 END) AS "oracle"
           FROM DBA_OBJECTS o LEFT JOIN DBA_USERS u ON u.USERNAME = o.OWNER
          GROUP BY o.OBJECT_TYPE
          ORDER BY 2 DESC`,
      ),
    CATALOG,
    '"Oracle" counts objects owned by Oracle-maintained schemas and PUBLIC.',
  )
  const byOwner = await softPanel(
    () =>
      rows(
        conn,
        `SELECT o.OWNER AS "owner", MAX(CASE WHEN ${app} THEN 'N' ELSE 'Y' END) AS "oracleMaintained", COUNT(*) AS "objects",
                SUM(CASE WHEN o.OBJECT_TYPE = 'TABLE' THEN 1 ELSE 0 END) AS "tables",
                SUM(CASE WHEN o.OBJECT_TYPE = 'INDEX' THEN 1 ELSE 0 END) AS "indexes",
                SUM(CASE WHEN o.OBJECT_TYPE IN ('VIEW', 'MATERIALIZED VIEW') THEN 1 ELSE 0 END) AS "views",
                SUM(CASE WHEN o.OBJECT_TYPE = 'SEQUENCE' THEN 1 ELSE 0 END) AS "sequences",
                SUM(CASE WHEN o.OBJECT_TYPE = 'SYNONYM' THEN 1 ELSE 0 END) AS "synonyms",
                SUM(CASE WHEN o.OBJECT_TYPE IN ('PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'TYPE', 'TYPE BODY') THEN 1 ELSE 0 END) AS "plsql",
                SUM(CASE WHEN o.OBJECT_TYPE = 'LOB' THEN 1 ELSE 0 END) AS "lobs",
                SUM(CASE WHEN o.STATUS <> 'VALID' THEN 1 ELSE 0 END) AS "invalid",
                MAX(NVL(seg.b, 0)) AS "segmentBytes"
           FROM DBA_OBJECTS o
           LEFT JOIN DBA_USERS u ON u.USERNAME = o.OWNER
           LEFT JOIN (SELECT OWNER, SUM(BYTES) b FROM DBA_SEGMENTS GROUP BY OWNER) seg ON seg.OWNER = o.OWNER
          GROUP BY o.OWNER
          ORDER BY 2, 3 DESC`,
      ),
    CATALOG,
  )
  const invalid = await softPanel(async () => {
    const r = await rows<Record<string, any>>(
      conn,
      `SELECT * FROM (
         SELECT o.OWNER AS "owner", o.OBJECT_NAME AS "name", o.OBJECT_TYPE AS "type", o.STATUS AS "status",
                TO_CHAR(o.LAST_DDL_TIME, ${TS}) AS "lastDdl",
                (SELECT COUNT(*) FROM DBA_ERRORS e WHERE e.OWNER = o.OWNER AND e.NAME = o.OBJECT_NAME AND e.TYPE = o.OBJECT_TYPE) AS "errors"
           FROM DBA_OBJECTS o
          WHERE o.STATUS <> 'VALID'
          ORDER BY o.OWNER, o.OBJECT_TYPE, o.OBJECT_NAME)
        WHERE ROWNUM <= 1000`,
    )
    return r.map((x) => ({ ...x, lastDdl: iso(x.lastDdl) }))
  }, CATALOG, 'First 1,000 invalid objects. Recompile with UTL_RECOMP.RECOMP_SERIAL / utlrp.sql after reviewing errors.')
  const recyclebin = await softPanel(
    () =>
      rows(
        conn,
        `SELECT r.OWNER AS "owner", COUNT(*) AS "objects", SUM(r.SPACE * NVL(t.BLOCK_SIZE, 8192)) AS "bytes"
           FROM DBA_RECYCLEBIN r LEFT JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = r.TS_NAME
          GROUP BY r.OWNER ORDER BY 3 DESC NULLS LAST`,
      ),
    CATALOG,
    'Dropped objects still holding space. PURGE DBA_RECYCLEBIN (as SYSDBA) or PURGE RECYCLEBIN per user to release it.',
  )
  return { byType, byOwner, invalid, recyclebin }
}

/** Application tables without a primary key; MV containers, external, temporary and IOT overflow tables excluded. */
export function noPkSql(major: number) {
  // Anti-joins against pre-filtered sets: correlated NOT EXISTS on DBA_MVIEWS/DBA_EXTERNAL_TABLES is slow.
  return `SELECT t.OWNER AS "owner", t.TABLE_NAME AS "table", t.NUM_ROWS AS "numRows", t.PARTITIONED AS "partitioned"
            FROM DBA_TABLES t
            LEFT JOIN (SELECT DISTINCT OWNER, TABLE_NAME FROM DBA_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'P') pk ON pk.OWNER = t.OWNER AND pk.TABLE_NAME = t.TABLE_NAME
            LEFT JOIN (SELECT OWNER, OBJECT_NAME FROM DBA_OBJECTS WHERE OBJECT_TYPE = 'MATERIALIZED VIEW') mv ON mv.OWNER = t.OWNER AND mv.OBJECT_NAME = t.TABLE_NAME
            LEFT JOIN (SELECT OWNER, TABLE_NAME FROM DBA_EXTERNAL_TABLES) x ON x.OWNER = t.OWNER AND x.TABLE_NAME = t.TABLE_NAME
           WHERE pk.OWNER IS NULL AND mv.OWNER IS NULL AND x.OWNER IS NULL AND ${customOwner(major, 't.OWNER')}
             AND t.TEMPORARY = 'N' AND t.NESTED = 'NO' AND t.SECONDARY = 'N' AND t.DROPPED = 'NO'
             AND (t.IOT_TYPE IS NULL OR t.IOT_TYPE = 'IOT')
             AND t.TABLE_NAME NOT LIKE 'MLOG$%' AND t.TABLE_NAME NOT LIKE 'RUPD$%'`
}

/** Foreign keys whose columns are not the leading columns (in any order) of some index on the child table. */
export function fkNoIndexSql(major: number) {
  return `SELECT c.OWNER AS "owner", c.TABLE_NAME AS "table", c.CONSTRAINT_NAME AS "constraint", c.R_OWNER AS "refOwner",
                 (SELECT p.TABLE_NAME FROM DBA_CONSTRAINTS p WHERE p.OWNER = c.R_OWNER AND p.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME) AS "refTable",
                 (SELECT LISTAGG(x.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY x.POSITION) FROM DBA_CONS_COLUMNS x
                   WHERE x.OWNER = c.OWNER AND x.CONSTRAINT_NAME = c.CONSTRAINT_NAME) AS "columns"
            FROM DBA_CONSTRAINTS c
           WHERE c.CONSTRAINT_TYPE = 'R' AND ${customOwner(major, 'c.OWNER')} AND c.TABLE_NAME NOT LIKE 'BIN$%'
             AND NOT EXISTS (
               SELECT 1 FROM DBA_INDEXES i
                WHERE i.TABLE_OWNER = c.OWNER AND i.TABLE_NAME = c.TABLE_NAME
                  AND NOT EXISTS (
                    SELECT 1 FROM DBA_CONS_COLUMNS cc
                     WHERE cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
                       AND NOT EXISTS (
                         SELECT 1 FROM DBA_IND_COLUMNS ic
                          WHERE ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME AND ic.COLUMN_NAME = cc.COLUMN_NAME
                            AND ic.COLUMN_POSITION <= (SELECT COUNT(*) FROM DBA_CONS_COLUMNS n WHERE n.OWNER = c.OWNER AND n.CONSTRAINT_NAME = c.CONSTRAINT_NAME))))`
}

/** Unusable indexes and index (sub)partitions, flagged by whether the owner is Oracle-maintained. */
export function unusableSql(major: number) {
  return `SELECT q.*, CASE WHEN ${customOwner(major, 'q."owner"')} THEN 'N' ELSE 'Y' END AS "oracleMaintained" FROM (
            SELECT OWNER AS "owner", INDEX_NAME AS "index", TABLE_NAME AS "table", NULL AS "partition", STATUS AS "status" FROM DBA_INDEXES WHERE STATUS = 'UNUSABLE'
            UNION ALL
            SELECT p.INDEX_OWNER, p.INDEX_NAME, i.TABLE_NAME, p.PARTITION_NAME, p.STATUS
              FROM DBA_IND_PARTITIONS p JOIN DBA_INDEXES i ON i.OWNER = p.INDEX_OWNER AND i.INDEX_NAME = p.INDEX_NAME WHERE p.STATUS = 'UNUSABLE'
            UNION ALL
            SELECT p.INDEX_OWNER, p.INDEX_NAME, i.TABLE_NAME, p.SUBPARTITION_NAME, p.STATUS
              FROM DBA_IND_SUBPARTITIONS p JOIN DBA_INDEXES i ON i.OWNER = p.INDEX_OWNER AND i.INDEX_NAME = p.INDEX_NAME WHERE p.STATUS = 'UNUSABLE'
          ) q`
}

async function design(conn: Connection): Promise<AssessmentSection> {
  const major = versionMajorOf(conn)
  const noPk = await softPanel(
    () => rows(conn, `SELECT * FROM (${noPkSql(major)} ORDER BY t.NUM_ROWS DESC NULLS LAST, 1, 2) WHERE ROWNUM <= 500`),
    CATALOG,
    'Application tables without a primary key (MV containers, external, temporary and IOT overflow tables excluded). First 500.',
  )
  const fkNoIndex = await softPanel(
    () => rows(conn, `SELECT * FROM (${fkNoIndexSql(major)} ORDER BY 1, 2, 3) WHERE ROWNUM <= 500`),
    CATALOG,
    'Foreign keys whose columns are not the leading columns of any index: deletes/updates on the parent lock the whole child table. First 500.',
  )
  const stats = await softPanel(async () => {
    const r = await rows<Record<string, any>>(
      conn,
      `SELECT * FROM (
         SELECT s.OWNER AS "owner", s.TABLE_NAME AS "table", s.NUM_ROWS AS "numRows", TO_CHAR(s.LAST_ANALYZED, ${TS}) AS "lastAnalyzed",
                CASE WHEN s.LAST_ANALYZED IS NULL THEN 'MISSING' ELSE 'STALE' END AS "state", s.STATTYPE_LOCKED AS "locked"
           FROM DBA_TAB_STATISTICS s
          WHERE s.OBJECT_TYPE = 'TABLE' AND ${customOwner(major, 's.OWNER')} AND s.TABLE_NAME NOT LIKE 'BIN$%'
            AND (s.LAST_ANALYZED IS NULL OR s.STALE_STATS = 'YES')
          ORDER BY 5, 1, 2)
        WHERE ROWNUM <= 1000`,
    )
    return r.map((x) => ({ ...x, lastAnalyzed: iso(x.lastAnalyzed) }))
  }, CATALOG, 'Application tables with missing or stale optimizer statistics. Fix with DBMS_STATS.GATHER_SCHEMA_STATS. First 1,000.')
  const unusable = await softPanel(
    () => rows(conn, `${unusableSql(major)} ORDER BY 6, 1, 2, 4`),
    CATALOG,
    'Unusable indexes are ignored by the optimizer and block DML on unique keys. Rebuild with ALTER INDEX ... REBUILD.',
  )
  const disabled = await softPanel(
    () =>
      rows(
        conn,
        `SELECT * FROM (
           SELECT c.OWNER AS "owner", c.TABLE_NAME AS "table", 'CONSTRAINT' AS "kind", c.CONSTRAINT_NAME AS "name",
                  DECODE(c.CONSTRAINT_TYPE, 'P', 'primary key', 'U', 'unique', 'R', 'foreign key', 'C', 'check', c.CONSTRAINT_TYPE) AS "type",
                  c.STATUS AS "status", c.VALIDATED AS "validated"
             FROM DBA_CONSTRAINTS c
            WHERE (c.STATUS = 'DISABLED' OR c.VALIDATED = 'NOT VALIDATED') AND c.CONSTRAINT_TYPE IN ('P', 'U', 'R', 'C')
              AND ${customOwner(major, 'c.OWNER')} AND c.TABLE_NAME NOT LIKE 'BIN$%'
           UNION ALL
           SELECT t.OWNER, t.TABLE_NAME, 'TRIGGER', t.TRIGGER_NAME, t.TRIGGERING_EVENT, t.STATUS, NULL
             FROM DBA_TRIGGERS t
            WHERE t.STATUS = 'DISABLED' AND ${customOwner(major, 't.OWNER')}
            ORDER BY 1, 2, 3, 4)
          WHERE ROWNUM <= 500`,
      ),
    CATALOG,
    'Disabled or NOT VALIDATED constraints and disabled triggers in application schemas. First 500.',
  )
  return { stats, fkNoIndex, noPk, unusable, disabled }
}

/** Fills missing hours with zero so the chart never interpolates across a gap. */
function hourly(points: { hour: string; switches: number }[], endHour: string, hours: number) {
  const by = new Map(points.map((p) => [p.hour, p.switches]))
  const end = Date.parse(`${endHour}Z`)
  const out = []
  for (let i = hours - 1; i >= 0; i--) {
    const k = new Date(end - i * 3600_000).toISOString().slice(0, 19)
    out.push({ hour: k, switches: by.get(k) ?? 0 })
  }
  return out
}

async function physical(conn: Connection): Promise<AssessmentSection> {
  const controlfiles = await softPanel(
    () =>
      rows(
        conn,
        `SELECT NAME AS "name", STATUS AS "status", IS_RECOVERY_DEST_FILE AS "inRecoveryArea", BLOCK_SIZE * FILE_SIZE_BLKS AS "bytes" FROM V$CONTROLFILE`,
      ),
    CATALOG,
  )
  const redo = await softPanel(
    () =>
      rows(
        conn,
        `SELECT l.GROUP# AS "group", l.THREAD# AS "thread", l.SEQUENCE# AS "sequence", l.BYTES AS "bytes", l.MEMBERS AS "members",
                l.ARCHIVED AS "archived", l.STATUS AS "status",
                (SELECT LISTAGG(f.MEMBER, ', ') WITHIN GROUP (ORDER BY f.MEMBER) FROM V$LOGFILE f WHERE f.GROUP# = l.GROUP#) AS "files"
           FROM V$LOG l ORDER BY 2, 1`,
      ),
    CATALOG,
  )
  const switches = await softPanel(async () => {
    const r = await rows<{ hour: string; switches: number }>(
      conn,
      `SELECT TO_CHAR(TRUNC(FIRST_TIME, 'HH24'), ${TS}) AS "hour", COUNT(*) AS "switches"
         FROM V$LOG_HISTORY WHERE FIRST_TIME > SYSDATE - 7 GROUP BY TRUNC(FIRST_TIME, 'HH24')`,
    )
    const now = await one<{ H: string }>(conn, `SELECT TO_CHAR(TRUNC(SYSDATE, 'HH24'), ${TS}) AS "H" FROM DUAL`)
    const series = hourly(r, now!.H, 168)
    const total = series.reduce((a, p) => a + p.switches, 0)
    return { series, total, peakPerHour: Math.max(0, ...series.map((p) => p.switches)), avgPerHour: Math.round((total / series.length) * 100) / 100 }
  }, CATALOG, 'Log switches per hour, last 7 days (database clock). Sustained > ~4–6 per hour usually means redo logs are too small.')
  const archiveDest = await softPanel(
    () =>
      rows(
        conn,
        `SELECT DEST_ID AS "destId", DEST_NAME AS "name", STATUS AS "status", TARGET AS "target", DESTINATION AS "destination",
                BINDING AS "binding", ERROR AS "error"
           FROM V$ARCHIVE_DEST WHERE STATUS <> 'INACTIVE' ORDER BY 1`,
      ),
    CATALOG,
  )
  const fra = await softPanel(async () => {
    const dest = await rows(
      conn,
      `SELECT NAME AS "name", SPACE_LIMIT AS "limitBytes", SPACE_USED AS "usedBytes", SPACE_RECLAIMABLE AS "reclaimableBytes", NUMBER_OF_FILES AS "files"
         FROM V$RECOVERY_FILE_DEST`,
    )
    const usage = await rows(
      conn,
      `SELECT FILE_TYPE AS "fileType", PERCENT_SPACE_USED AS "pctUsed", PERCENT_SPACE_RECLAIMABLE AS "pctReclaimable", NUMBER_OF_FILES AS "files"
         FROM V$RECOVERY_AREA_USAGE ORDER BY 2 DESC`,
    )
    return { destinations: dest.filter((d: any) => d.name), usage }
  }, CATALOG)
  const bct = await softPanel(
    () => rows(conn, `SELECT STATUS AS "status", FILENAME AS "file", BYTES AS "bytes" FROM V$BLOCK_CHANGE_TRACKING`),
    CATALOG,
    'Block change tracking lets RMAN incremental backups read only changed blocks (Enterprise Edition).',
  )
  return { controlfiles, redo, switches, archiveDest, fra, bct }
}

async function instance(conn: Connection): Promise<AssessmentSection> {
  const major = versionMajorOf(conn)
  const sga = await softPanel(() => rows(conn, `SELECT NAME AS "name", BYTES AS "bytes", RESIZEABLE AS "resizeable" FROM V$SGAINFO ORDER BY BYTES DESC`), CATALOG)
  const sgaComponents = await softPanel(
    () =>
      rows(
        conn,
        `SELECT COMPONENT AS "component", CURRENT_SIZE AS "currentBytes", MIN_SIZE AS "minBytes", MAX_SIZE AS "maxBytes",
                USER_SPECIFIED_SIZE AS "specifiedBytes", OPER_COUNT AS "resizeOps", LAST_OPER_TYPE AS "lastOperation"
           FROM V$SGA_DYNAMIC_COMPONENTS WHERE CURRENT_SIZE > 0 ORDER BY CURRENT_SIZE DESC`,
      ),
    CATALOG,
  )
  const pga = await softPanel(() => rows(conn, `SELECT NAME AS "name", VALUE AS "value", UNIT AS "unit" FROM V$PGASTAT`), CATALOG)
  const resourceLimits = await softPanel(
    () =>
      rows(
        conn,
        `SELECT RESOURCE_NAME AS "resource", CURRENT_UTILIZATION AS "current", MAX_UTILIZATION AS "max",
                TRIM(INITIAL_ALLOCATION) AS "initial", TRIM(LIMIT_VALUE) AS "limit"
           FROM V$RESOURCE_LIMIT ORDER BY 1`,
      ),
    CATALOG,
    '"max" is the high-water mark since instance startup.',
  )
  const nls = await softPanel(() => rows(conn, `SELECT PARAMETER AS "parameter", VALUE AS "value" FROM NLS_DATABASE_PARAMETERS ORDER BY 1`), CATALOG)
  const properties = await softPanel(
    () => rows(conn, `SELECT PROPERTY_NAME AS "property", PROPERTY_VALUE AS "value", DESCRIPTION AS "description" FROM DATABASE_PROPERTIES ORDER BY 1`),
    CATALOG,
  )
  const pdbs =
    major >= 12
      ? await softPanel(
          () =>
            rows(
              conn,
              `SELECT CON_ID AS "conId", NAME AS "name", OPEN_MODE AS "openMode", RESTRICTED AS "restricted", TOTAL_SIZE AS "totalBytes",
                      TO_CHAR(OPEN_TIME, ${TS}) AS "openTime"
                 FROM V$PDBS ORDER BY 1`,
            ),
          CATALOG,
          'Inside a PDB only the current container is visible.',
        )
      : { status: 'unavailable' as const, reason: 'Multitenant (PDBs) requires Oracle 12c or later.', collectedAt: new Date().toISOString() }
  return { sga, sgaComponents, pga, resourceLimits, pdbs, nls, properties }
}

async function components(conn: Connection): Promise<AssessmentSection> {
  const major = versionMajorOf(conn)
  const registry = await softPanel(
    () =>
      rows(
        conn,
        `SELECT COMP_ID AS "id", COMP_NAME AS "name", ${major >= 18 ? 'VERSION_FULL' : 'VERSION'} AS "version", STATUS AS "status",
                SCHEMA AS "schema", MODIFIED AS "modified"
           FROM DBA_REGISTRY ORDER BY 1`,
      ),
    CATALOG,
  )
  const patches = await softPanel(async () => {
    const r =
      major >= 12
        ? await rows<Record<string, any>>(
            conn,
            `SELECT PATCH_ID AS "patchId", ACTION AS "action", STATUS AS "status", TO_CHAR(ACTION_TIME, ${TS}) AS "actionTime",
                    DESCRIPTION AS "description"
               FROM DBA_REGISTRY_SQLPATCH ORDER BY ACTION_TIME DESC NULLS LAST`,
          )
        : await rows<Record<string, any>>(
            conn,
            `SELECT ID AS "patchId", ACTION AS "action", NAMESPACE AS "status", TO_CHAR(ACTION_TIME, ${TS}) AS "actionTime",
                    VERSION || ' ' || COMMENTS AS "description"
               FROM DBA_REGISTRY_HISTORY ORDER BY ACTION_TIME DESC NULLS LAST`,
          )
    return r.map((x) => ({ ...x, actionTime: iso(x.actionTime) }))
  }, CATALOG, major >= 12 ? 'SQL patches applied by datapatch (DBA_REGISTRY_SQLPATCH).' : 'Patch/upgrade history (DBA_REGISTRY_HISTORY).')
  const options = await softPanel(() => rows(conn, `SELECT PARAMETER AS "option", VALUE AS "enabled" FROM V$OPTION ORDER BY 2 DESC, 1`), CATALOG)
  const features = await softPanel(
    async () => {
      const r = await rows<Record<string, any>>(
        conn,
        `SELECT NAME AS "feature", SUM(DETECTED_USAGES) AS "detectedUsages", MAX(CURRENTLY_USED) AS "currentlyUsed",
                TO_CHAR(MIN(FIRST_USAGE_DATE), ${TS}) AS "firstUsed", TO_CHAR(MAX(LAST_USAGE_DATE), ${TS}) AS "lastUsed", MAX(VERSION) AS "version"
           FROM DBA_FEATURE_USAGE_STATISTICS
          WHERE DETECTED_USAGES > 0
          GROUP BY NAME ORDER BY 1`,
      )
      return r.map((x) => ({ ...x, firstUsed: iso(x.firstUsed), lastUsed: iso(x.lastUsed) }))
    },
    CATALOG,
    'Sampled about weekly by the database. Informational only — not a license determination.',
  )
  const autotask = await softPanel(
    () => rows(conn, `SELECT CLIENT_NAME AS "client", STATUS AS "status" FROM DBA_AUTOTASK_CLIENT ORDER BY 1`),
    CATALOG,
    'Automated maintenance tasks (optimizer statistics, segment advisor, SQL tuning advisor).',
  )
  const jobs = await softPanel(async () => {
    const r = await rows<Record<string, any>>(
      conn,
      `SELECT OWNER AS "owner", JOB_NAME AS "job", ENABLED AS "enabled", STATE AS "state", JOB_TYPE AS "jobType",
              TO_CHAR(CAST(LAST_START_DATE AS DATE), ${TS}) AS "lastStart", TO_CHAR(CAST(NEXT_RUN_DATE AS DATE), ${TS}) AS "nextRun",
              RUN_COUNT AS "runs", FAILURE_COUNT AS "failures", REPEAT_INTERVAL AS "repeatInterval"
         FROM DBA_SCHEDULER_JOBS
        WHERE ${customOwner(major, 'OWNER')}
        ORDER BY 1, 2`,
    )
    return r.map((x) => ({ ...x, lastStart: iso(x.lastStart), nextRun: iso(x.nextRun) }))
  }, CATALOG, 'Scheduler jobs owned by application schemas.')
  const failedRuns = await softPanel(async () => {
    const r = await rows<Record<string, any>>(
      conn,
      `SELECT * FROM (
         SELECT OWNER AS "owner", JOB_NAME AS "job", STATUS AS "status", TO_CHAR(CAST(ACTUAL_START_DATE AS DATE), ${TS}) AS "start",
                ERROR# AS "error", TO_CHAR(SUBSTR(ADDITIONAL_INFO, 1, 300)) AS "info"
           FROM DBA_SCHEDULER_JOB_RUN_DETAILS
          WHERE STATUS <> 'SUCCEEDED' AND LOG_DATE > SYSTIMESTAMP - INTERVAL '7' DAY
          ORDER BY LOG_DATE DESC)
        WHERE ROWNUM <= 200`,
    )
    return r.map((x) => ({ ...x, start: iso(x.start) }))
  }, CATALOG, 'Scheduler job runs that did not succeed in the last 7 days (all owners).')
  return { registry, patches, options, features, autotask, jobs, failedRuns }
}

export const ASSESSMENT_SECTIONS = {
  summary,
  findings,
  parameters,
  spfile,
  users,
  profiles,
  security,
  tablespaces,
  objects,
  design,
  physical,
  instance,
  components,
} as const satisfies Record<string, (conn: Connection) => Promise<AssessmentSection>>

export type AssessmentSectionId = keyof typeof ASSESSMENT_SECTIONS

export const SECTION_TITLES: Record<AssessmentSectionId, string> = {
  summary: 'Summary',
  findings: 'Health checks',
  parameters: 'Initialization parameters',
  spfile: 'Parameter file',
  users: 'Users',
  profiles: 'Profiles',
  security: 'Security & privileges',
  tablespaces: 'Tablespaces & datafiles',
  objects: 'Objects',
  design: 'Schema health',
  physical: 'Physical structure',
  instance: 'Memory & instance',
  components: 'Components, patches & features',
}

export async function assessmentSection(profileId: string, name: string): Promise<AssessmentSection> {
  const fn = ASSESSMENT_SECTIONS[name as AssessmentSectionId]
  if (!fn) throw createError({ statusCode: 404, statusMessage: `Unknown assessment section ${name}` })
  return withConnection(profileId, (conn) => fn(conn), { action: `assessment:${name}`, callTimeoutMs: 180000 })
}

/** Runs every section on one connection (for the exported report). */
export async function fullAssessment(profileId: string) {
  return withConnection(
    profileId,
    async (conn) => {
      const out = {} as Record<AssessmentSectionId, AssessmentSection>
      for (const [k, fn] of Object.entries(ASSESSMENT_SECTIONS)) out[k as AssessmentSectionId] = await fn(conn)
      return out
    },
    { action: 'assessment:report', callTimeoutMs: 180000 },
  )
}

// ---------------------------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------------------------

type Check = { id: string; category: AssessmentFinding['category']; title: string; run: (conn: Connection, major: number) => Promise<Omit<AssessmentFinding, 'id' | 'category' | 'title'>> }

const n = (v: unknown) => Number(v ?? 0)
const names = (r: Record<string, unknown>[], f: (x: any) => string) => r.slice(0, 25).map(f)
const pct = (v: number) => `${v.toFixed(1)}%`

const CHECKS: Check[] = [
  {
    id: 'archivelog',
    category: 'Recoverability',
    title: 'ARCHIVELOG mode',
    run: async (conn) => {
      const r = await one<{ M: string }>(conn, `SELECT LOG_MODE AS "M" FROM V$DATABASE`)
      return r?.M === 'ARCHIVELOG'
        ? { severity: 'ok', detail: 'The database archives redo, so online backups and point-in-time recovery are possible.' }
        : { severity: 'warning', detail: `Log mode is ${r?.M}. Only cold backups and recovery to the last backup are possible.`, recommendation: 'Enable ARCHIVELOG mode (SHUTDOWN IMMEDIATE; STARTUP MOUNT; ALTER DATABASE ARCHIVELOG; ALTER DATABASE OPEN).' }
    },
  },
  {
    id: 'controlfiles',
    category: 'Recoverability',
    title: 'Control file multiplexing',
    run: async (conn) => {
      const r = await rows<{ N: string }>(conn, `SELECT NAME AS "N" FROM V$CONTROLFILE`)
      return r.length >= 2
        ? { severity: 'ok', detail: `${r.length} control file copies.`, items: r.map((x) => x.N) }
        : { severity: 'warning', detail: `Only ${r.length} control file. Losing it requires a restore.`, recommendation: 'Add a second copy on a different disk via CONTROL_FILES.', items: r.map((x) => x.N) }
    },
  },
  {
    id: 'redo-groups',
    category: 'Availability',
    title: 'Redo log groups and members',
    run: async (conn) => {
      const r = await rows<{ T: number; G: number; M: number }>(conn, `SELECT THREAD# AS "T", COUNT(*) AS "G", MIN(MEMBERS) AS "M" FROM V$LOG GROUP BY THREAD#`)
      const fewGroups = r.filter((x) => x.G < 3)
      const single = r.filter((x) => x.M < 2)
      if (!fewGroups.length && !single.length) return { severity: 'ok', detail: r.map((x) => `thread ${x.T}: ${x.G} groups × ≥${x.M} members`).join('; ') }
      const parts = []
      if (fewGroups.length) parts.push(`fewer than 3 groups on thread(s) ${fewGroups.map((x) => x.T).join(', ')}`)
      if (single.length) parts.push(`single-member groups on thread(s) ${single.map((x) => x.T).join(', ')} (no multiplexing)`)
      return { severity: 'warning', detail: `Redo: ${parts.join('; ')}.`, recommendation: 'Use ≥ 3 groups per thread and 2 members per group on separate disks (ALTER DATABASE ADD LOGFILE MEMBER ...).' }
    },
  },
  {
    id: 'log-switches',
    category: 'Performance',
    title: 'Redo log switch frequency',
    run: async (conn) => {
      const r = await one<{ P: number; A: number }>(
        conn,
        `SELECT NVL(MAX(c), 0) AS "P", NVL(ROUND(AVG(c), 2), 0) AS "A" FROM (SELECT COUNT(*) c FROM V$LOG_HISTORY WHERE FIRST_TIME > SYSDATE - 7 GROUP BY TRUNC(FIRST_TIME, 'HH24'))`,
      )
      const peak = n(r?.P)
      if (peak > 12) return { severity: 'warning', detail: `Peak ${peak} switches in one hour (avg ${r?.A}/active hour, last 7 days).`, recommendation: 'Resize redo logs so a switch happens about every 15–20 minutes at peak load.' }
      return { severity: 'ok', detail: `Peak ${peak} switches/hour, avg ${r?.A} per active hour over the last 7 days.` }
    },
  },
  {
    id: 'archive-dest',
    category: 'Recoverability',
    title: 'Archive destinations',
    run: async (conn) => {
      const r = await rows<{ D: string; S: string; E: string | null }>(conn, `SELECT DEST_NAME AS "D", STATUS AS "S", ERROR AS "E" FROM V$ARCHIVE_DEST WHERE STATUS NOT IN ('INACTIVE')`)
      const bad = r.filter((x) => x.S !== 'VALID' && x.S !== 'DEFERRED')
      if (bad.length) return { severity: 'critical', detail: `${bad.length} archive destination(s) in error.`, items: bad.map((x) => `${x.D}: ${x.S} ${x.E ?? ''}`.trim()), recommendation: 'Fix the destination (space, path, network) — the database can hang when it cannot archive.' }
      return { severity: r.length ? 'ok' : 'info', detail: r.length ? `${r.length} active destination(s), all VALID.` : 'No active archive destinations.' }
    },
  },
  {
    id: 'fra',
    category: 'Capacity',
    title: 'Fast recovery area usage',
    run: async (conn) => {
      const r = await one<{ N: string | null; L: number; U: number; R: number }>(conn, `SELECT NAME AS "N", SPACE_LIMIT AS "L", SPACE_USED AS "U", SPACE_RECLAIMABLE AS "R" FROM V$RECOVERY_FILE_DEST`)
      if (!r?.N || !n(r.L)) return { severity: 'info', detail: 'No fast recovery area configured (DB_RECOVERY_FILE_DEST).' }
      const used = ((n(r.U) - n(r.R)) / n(r.L)) * 100
      const sev: AssessmentSeverity = used >= 90 ? 'critical' : used >= 80 ? 'warning' : 'ok'
      return { severity: sev, detail: `${pct(used)} used after reclaimable space (${r.N}).`, recommendation: sev === 'ok' ? undefined : 'Back up and delete archived logs, or raise DB_RECOVERY_FILE_DEST_SIZE.' }
    },
  },
  {
    id: 'tablespace-usage',
    category: 'Capacity',
    title: 'Tablespace usage',
    run: async (conn) => {
      const r = await rows<{ N: string; P: number }>(
        conn,
        `SELECT m.TABLESPACE_NAME AS "N", ROUND(m.USED_PERCENT, 1) AS "P" FROM DBA_TABLESPACE_USAGE_METRICS m JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = m.TABLESPACE_NAME
          WHERE t.CONTENTS <> 'UNDO' AND m.USED_PERCENT >= 85 ORDER BY 2 DESC`,
      )
      if (!r.length) return { severity: 'ok', detail: 'All permanent/temporary tablespaces are below 85% of their maximum size.' }
      return { severity: r.some((x) => x.P >= 95) ? 'critical' : 'warning', detail: `${r.length} tablespace(s) at ≥ 85% of max size.`, items: r.map((x) => `${x.N} ${x.P}%`), recommendation: 'Add datafiles, enable autoextend or purge data.' }
    },
  },
  {
    id: 'invalid-objects',
    category: 'Schema health',
    title: 'Invalid objects',
    run: async (conn, major) => {
      const r = await rows<{ O: string; N: string; T: string; A: string }>(
        conn,
        `SELECT o.OWNER AS "O", o.OBJECT_NAME AS "N", o.OBJECT_TYPE AS "T", CASE WHEN ${customUser(major, 'u')} THEN 'Y' ELSE 'N' END AS "A"
           FROM DBA_OBJECTS o LEFT JOIN DBA_USERS u ON u.USERNAME = o.OWNER WHERE o.STATUS <> 'VALID' ORDER BY 4 DESC, 1, 2`,
      )
      if (!r.length) return { severity: 'ok', detail: 'No invalid objects.' }
      const sys = r.filter((x) => x.A === 'N').length
      return {
        severity: sys ? 'warning' : 'info',
        detail: `${r.length} invalid object(s): ${r.length - sys} in application schemas, ${sys} in Oracle-maintained schemas.`,
        items: names(r, (x) => `${x.O}.${x.N} (${x.T})`),
        recommendation: 'Review DBA_ERRORS, then recompile (EXEC UTL_RECOMP.RECOMP_SERIAL or @?/rdbms/admin/utlrp.sql).',
      }
    },
  },
  {
    id: 'registry',
    category: 'Availability',
    title: 'Installed components (DBA_REGISTRY)',
    run: async (conn) => {
      const r = await rows<{ I: string; S: string }>(conn, `SELECT COMP_ID AS "I", STATUS AS "S" FROM DBA_REGISTRY WHERE STATUS NOT IN ('VALID', 'OPTION OFF', 'REMOVED')`)
      return r.length
        ? { severity: 'critical', detail: `${r.length} component(s) not VALID.`, items: r.map((x) => `${x.I}: ${x.S}`), recommendation: 'Run utlrp.sql; if still invalid, check the component upgrade/patch logs (datapatch).' }
        : { severity: 'ok', detail: 'All registered components are VALID.' }
    },
  },
  {
    id: 'default-passwords',
    category: 'Security',
    title: 'Accounts with default passwords',
    run: async (conn) => {
      const r = await rows<{ U: string; S: string }>(conn, `SELECT d.USERNAME AS "U", u.ACCOUNT_STATUS AS "S" FROM DBA_USERS_WITH_DEFPWD d JOIN DBA_USERS u ON u.USERNAME = d.USERNAME`)
      const open = r.filter((x) => x.S === 'OPEN')
      if (open.length) return { severity: 'critical', detail: `${open.length} OPEN account(s) still use a default password.`, items: open.map((x) => x.U), recommendation: 'Change the passwords or lock the accounts (ALTER USER x ACCOUNT LOCK PASSWORD EXPIRE).' }
      return { severity: r.length ? 'info' : 'ok', detail: r.length ? `${r.length} account(s) have default passwords but are locked/expired.` : 'No accounts with default passwords.' }
    },
  },
  {
    id: 'password-policy',
    category: 'Security',
    title: 'Password policy of profiles in use',
    run: async (conn, major) => {
      const lim = await rows<{ P: string; R: string; L: string }>(
        conn,
        `SELECT PROFILE AS "P", RESOURCE_NAME AS "R", LIMIT AS "L" FROM DBA_PROFILES
          WHERE RESOURCE_NAME IN ('FAILED_LOGIN_ATTEMPTS', 'PASSWORD_LIFE_TIME', 'PASSWORD_VERIFY_FUNCTION')`,
      )
      const used = await rows<{ P: string }>(conn, `SELECT DISTINCT u.PROFILE AS "P" FROM DBA_USERS u WHERE u.ACCOUNT_STATUS = 'OPEN' AND ${customUser(major, 'u')}`)
      const eff = (p: string, r: string) => {
        const v = lim.find((x) => x.P === p && x.R === r)?.L
        return v === 'DEFAULT' || v == null ? lim.find((x) => x.P === 'DEFAULT' && x.R === r)?.L : v
      }
      const issues: string[] = []
      let sev: AssessmentSeverity = 'ok'
      for (const { P } of used) {
        if (eff(P, 'FAILED_LOGIN_ATTEMPTS') === 'UNLIMITED') { issues.push(`${P}: FAILED_LOGIN_ATTEMPTS UNLIMITED`); sev = 'warning' }
        if (['NULL', null, undefined].includes(eff(P, 'PASSWORD_VERIFY_FUNCTION'))) { issues.push(`${P}: no PASSWORD_VERIFY_FUNCTION`); sev = 'warning' }
        if (eff(P, 'PASSWORD_LIFE_TIME') === 'UNLIMITED') { issues.push(`${P}: PASSWORD_LIFE_TIME UNLIMITED`); if (sev === 'ok') sev = 'info' }
      }
      if (!used.length) return { severity: 'info', detail: 'No OPEN application users.' }
      return sev === 'ok'
        ? { severity: 'ok', detail: `Profiles in use (${used.map((u) => u.P).join(', ')}) lock accounts and verify password complexity.` }
        : { severity: sev, detail: `${issues.length} weak setting(s) in profiles used by OPEN application users.`, items: issues, recommendation: 'Set FAILED_LOGIN_ATTEMPTS, a PASSWORD_VERIFY_FUNCTION (e.g. ORA12C_VERIFY_FUNCTION) and a password lifetime on application profiles.' }
    },
  },
  {
    id: 'dba-grants',
    category: 'Security',
    title: 'DBA role granted to application accounts',
    run: async (conn, major) => {
      const r = await rows<{ G: string }>(conn, `SELECT GRANTEE AS "G" FROM DBA_ROLE_PRIVS WHERE GRANTED_ROLE = 'DBA' AND ${customGrantee(major, 'GRANTEE')} ORDER BY 1`)
      return r.length
        ? { severity: 'warning', detail: `${r.length} non-Oracle account(s)/role(s) hold DBA.`, items: r.map((x) => x.G), recommendation: 'Grant only the privileges each account needs (least privilege).' }
        : { severity: 'ok', detail: 'No application account holds the DBA role.' }
    },
  },
  {
    id: 'any-privileges',
    category: 'Security',
    title: '"ANY" system privileges to application accounts',
    run: async (conn, major) => {
      const r = await rows<{ G: string; P: string }>(
        conn,
        `SELECT GRANTEE AS "G", PRIVILEGE AS "P" FROM DBA_SYS_PRIVS WHERE (PRIVILEGE LIKE '% ANY %' OR PRIVILEGE LIKE '% ANY') AND ${customGrantee(major, 'GRANTEE')} ORDER BY 1, 2`,
      )
      return r.length
        ? { severity: 'warning', detail: `${r.length} "ANY" privilege grant(s) to ${new Set(r.map((x) => x.G)).size} application grantee(s).`, items: names(r, (x) => `${x.G}: ${x.P}`), recommendation: 'Replace ANY privileges with object-level grants.' }
        : { severity: 'ok', detail: 'No "ANY" system privileges granted to application accounts.' }
    },
  },
  {
    id: 'public-packages',
    category: 'Security',
    title: 'PUBLIC execute on sensitive packages',
    run: async (conn) => {
      const r = await rows<{ T: string }>(conn, `SELECT DISTINCT TABLE_NAME AS "T" FROM DBA_TAB_PRIVS WHERE GRANTEE = 'PUBLIC' AND OWNER = 'SYS' AND TABLE_NAME IN (${inList(SENSITIVE_PACKAGES)}) ORDER BY 1`)
      if (!r.length) return { severity: 'ok', detail: 'PUBLIC has no EXECUTE on the CIS sensitive package list.' }
      const risky = r.filter((x) => NETWORK_FILE_PACKAGES.has(x.T))
      return {
        severity: risky.length ? 'warning' : 'info',
        detail: `PUBLIC can execute ${r.length} sensitive package(s)${risky.length ? `, including network/file access (${risky.map((x) => x.T).join(', ')})` : ''}.`,
        items: r.map((x) => x.T),
        recommendation: 'Revoke from PUBLIC and grant to the accounts that need them (test application impact first).',
      }
    },
  },
  {
    id: 'system-default-ts',
    category: 'Configuration',
    title: 'Application users defaulting to SYSTEM/SYSAUX',
    run: async (conn, major) => {
      const r = await rows<{ U: string; T: string }>(conn, `SELECT u.USERNAME AS "U", u.DEFAULT_TABLESPACE AS "T" FROM DBA_USERS u WHERE u.DEFAULT_TABLESPACE IN ('SYSTEM', 'SYSAUX') AND ${customUser(major, 'u')} ORDER BY 1`)
      return r.length
        ? { severity: 'warning', detail: `${r.length} application user(s) have SYSTEM/SYSAUX as default tablespace.`, items: r.map((x) => `${x.U} → ${x.T}`), recommendation: 'ALTER USER ... DEFAULT TABLESPACE <app tablespace>.' }
        : { severity: 'ok', detail: 'No application user defaults to SYSTEM or SYSAUX.' }
    },
  },
  {
    id: 'system-segments',
    category: 'Capacity',
    title: 'Application segments in SYSTEM/SYSAUX',
    run: async (conn, major) => {
      const r = await rows<{ O: string; T: string; N: number; B: number }>(
        conn,
        `SELECT s.OWNER AS "O", s.TABLESPACE_NAME AS "T", COUNT(*) AS "N", SUM(s.BYTES) AS "B" FROM DBA_SEGMENTS s
          WHERE s.TABLESPACE_NAME IN ('SYSTEM', 'SYSAUX') AND ${customOwner(major, 's.OWNER')} GROUP BY s.OWNER, s.TABLESPACE_NAME ORDER BY 4 DESC`,
      )
      return r.length
        ? { severity: 'warning', detail: `${r.reduce((a, x) => a + n(x.N), 0)} application segment(s) stored in SYSTEM/SYSAUX.`, items: r.map((x) => `${x.O} in ${x.T}: ${x.N} segment(s)`), recommendation: 'Move them (ALTER TABLE ... MOVE / ALTER INDEX ... REBUILD TABLESPACE ...).' }
        : { severity: 'ok', detail: 'No application segments in SYSTEM/SYSAUX.' }
    },
  },
  {
    id: 'stats',
    category: 'Performance',
    title: 'Optimizer statistics (application tables)',
    run: async (conn, major) => {
      const r = await one<{ M: number; S: number; T: number }>(
        conn,
        `SELECT SUM(CASE WHEN s.LAST_ANALYZED IS NULL THEN 1 ELSE 0 END) AS "M", SUM(CASE WHEN s.STALE_STATS = 'YES' THEN 1 ELSE 0 END) AS "S", COUNT(*) AS "T"
           FROM DBA_TAB_STATISTICS s WHERE s.OBJECT_TYPE = 'TABLE' AND ${customOwner(major, 's.OWNER')} AND s.TABLE_NAME NOT LIKE 'BIN$%'`,
      )
      const missing = n(r?.M)
      const stale = n(r?.S)
      if (!missing && !stale) return { severity: 'ok', detail: `Statistics present and fresh on all ${n(r?.T)} application tables.` }
      return { severity: 'warning', detail: `${missing} table(s) without statistics and ${stale} with stale statistics (of ${n(r?.T)}).`, recommendation: 'EXEC DBMS_STATS.GATHER_SCHEMA_STATS(\'<schema>\') — see Schema health for the list.' }
    },
  },
  {
    id: 'autotask-stats',
    category: 'Performance',
    title: 'Automatic statistics collection',
    run: async (conn) => {
      const r = await one<{ S: string }>(conn, `SELECT STATUS AS "S" FROM DBA_AUTOTASK_CLIENT WHERE CLIENT_NAME = 'auto optimizer stats collection'`)
      if (!r) return { severity: 'info', detail: 'The auto optimizer stats task is not registered.' }
      return r.S === 'ENABLED'
        ? { severity: 'ok', detail: 'auto optimizer stats collection is ENABLED.' }
        : { severity: 'warning', detail: `auto optimizer stats collection is ${r.S}.`, recommendation: "EXEC DBMS_AUTO_TASK_ADMIN.ENABLE('auto optimizer stats collection', NULL, NULL) — or make sure your own stats jobs cover all schemas." }
    },
  },
  {
    id: 'fk-index',
    category: 'Performance',
    title: 'Unindexed foreign keys',
    run: async (conn, major) => {
      const r = await rows<{ owner: string; table: string; constraint: string }>(conn, `${fkNoIndexSql(major)} ORDER BY 1, 2`)
      return r.length
        ? { severity: 'warning', detail: `${r.length} foreign key(s) without a supporting index — parent DML takes table locks on the child.`, items: names(r, (x) => `${x.owner}.${x.table} (${x.constraint})`), recommendation: 'Create an index on the foreign key columns.' }
        : { severity: 'ok', detail: 'Every application foreign key has a supporting index.' }
    },
  },
  {
    id: 'no-pk',
    category: 'Schema health',
    title: 'Tables without a primary key',
    run: async (conn, major) => {
      const r = await rows<{ owner: string; table: string }>(conn, `${noPkSql(major)} ORDER BY 1, 2`)
      return r.length
        ? { severity: 'info', detail: `${r.length} application table(s) have no primary key (replication, GoldenGate and row identification need one).`, items: names(r, (x) => `${x.owner}.${x.table}`) }
        : { severity: 'ok', detail: 'Every application table has a primary key.' }
    },
  },
  {
    id: 'unusable-indexes',
    category: 'Performance',
    title: 'Unusable indexes',
    run: async (conn, major) => {
      const r = await rows<{ owner: string; index: string; partition: string | null; oracleMaintained: string }>(conn, `${unusableSql(major)} ORDER BY 1, 2`)
      const label = (x: (typeof r)[number]) => `${x.owner}.${x.index}${x.partition ? ` (${x.partition})` : ''}`
      const app = r.filter((x) => x.oracleMaintained === 'N')
      if (app.length) return { severity: 'warning', detail: `${app.length} application index(es)/partition(s) UNUSABLE.`, items: names(app, label), recommendation: 'ALTER INDEX ... REBUILD [PARTITION ...] ONLINE.' }
      if (r.length) return { severity: 'info', detail: `${r.length} unusable index segment(s), all in Oracle-maintained schemas (often by design, e.g. internal logging tables).`, items: names(r, label) }
      return { severity: 'ok', detail: 'No unusable indexes or index partitions.' }
    },
  },
  {
    id: 'disabled-constraints',
    category: 'Schema health',
    title: 'Disabled constraints and triggers',
    run: async (conn, major) => {
      const r = await one<{ C: number; T: number }>(
        conn,
        `SELECT (SELECT COUNT(*) FROM DBA_CONSTRAINTS c WHERE (c.STATUS = 'DISABLED' OR c.VALIDATED = 'NOT VALIDATED') AND c.CONSTRAINT_TYPE IN ('P', 'U', 'R', 'C')
                   AND ${customOwner(major, 'c.OWNER')} AND c.TABLE_NAME NOT LIKE 'BIN$%') AS "C",
                (SELECT COUNT(*) FROM DBA_TRIGGERS t WHERE t.STATUS = 'DISABLED' AND ${customOwner(major, 't.OWNER')}) AS "T"
           FROM DUAL`,
      )
      const c = n(r?.C)
      const t = n(r?.T)
      return c || t
        ? { severity: 'info', detail: `${c} disabled/not-validated constraint(s) and ${t} disabled trigger(s) in application schemas.`, recommendation: 'Confirm they are intentional (e.g. left over from a bulk load).' }
        : { severity: 'ok', detail: 'All application constraints and triggers are enabled and validated.' }
    },
  },
  {
    id: 'hidden-params',
    category: 'Configuration',
    title: 'Hidden (underscore) parameters',
    run: async (conn) => {
      const r = await rows<{ N: string; V: string }>(conn, `SELECT NAME AS "N", DISPLAY_VALUE AS "V" FROM V$PARAMETER WHERE NAME LIKE '\\_%' ESCAPE '\\' AND ISDEFAULT = 'FALSE' ORDER BY 1`)
      return r.length
        ? { severity: 'info', detail: `${r.length} hidden parameter(s) set explicitly. They should only be set on Oracle Support's advice.`, items: r.map((x) => `${x.N}=${x.V}`) }
        : { severity: 'ok', detail: 'No hidden parameters set.' }
    },
  },
  {
    id: 'deprecated-params',
    category: 'Configuration',
    title: 'Deprecated parameters set',
    run: async (conn) => {
      const r = await rows<{ N: string; V: string }>(conn, `SELECT NAME AS "N", DISPLAY_VALUE AS "V" FROM V$PARAMETER WHERE ISDEPRECATED = 'TRUE' AND ISDEFAULT = 'FALSE' ORDER BY 1`)
      return r.length
        ? { severity: 'warning', detail: `${r.length} deprecated parameter(s) explicitly set — they may be ignored or removed in the next release.`, items: r.map((x) => `${x.N}=${x.V}`), recommendation: 'Remove them from the SPFILE (ALTER SYSTEM RESET name SCOPE=SPFILE).' }
        : { severity: 'ok', detail: 'No deprecated parameters are set.' }
    },
  },
  {
    id: 'spfile',
    category: 'Configuration',
    title: 'Server parameter file (SPFILE)',
    run: async (conn) => {
      const r = await one<{ V: string | null }>(conn, `SELECT VALUE AS "V" FROM V$PARAMETER WHERE NAME = 'spfile'`)
      return r?.V
        ? { severity: 'ok', detail: `Started with SPFILE ${r.V}.` }
        : { severity: 'warning', detail: 'The instance was started with a text PFILE; ALTER SYSTEM ... SCOPE=SPFILE changes cannot persist.', recommendation: 'CREATE SPFILE FROM PFILE and restart.' }
    },
  },
  {
    id: 'resource-limits',
    category: 'Capacity',
    title: 'Processes / sessions headroom',
    run: async (conn) => {
      const r = await rows<{ R: string; C: number; M: number; L: string }>(
        conn,
        `SELECT RESOURCE_NAME AS "R", CURRENT_UTILIZATION AS "C", MAX_UTILIZATION AS "M", TRIM(LIMIT_VALUE) AS "L" FROM V$RESOURCE_LIMIT
          WHERE RESOURCE_NAME IN ('processes', 'sessions', 'transactions', 'parallel_max_servers')`,
      )
      if (!r.length) return { severity: 'na', detail: 'V$RESOURCE_LIMIT returns no rows in this container — connect to CDB$ROOT to check instance limits.' }
      const out: string[] = []
      let sev: AssessmentSeverity = 'ok'
      for (const x of r) {
        const lim = Number(x.L)
        if (!Number.isFinite(lim) || lim <= 0) continue
        const cur = (n(x.C) / lim) * 100
        const hw = (n(x.M) / lim) * 100
        out.push(`${x.R}: now ${n(x.C)}, peak ${n(x.M)} of ${lim}`)
        if (cur >= 90) sev = 'critical'
        else if (hw >= 90 && sev !== 'critical') sev = 'warning'
      }
      return sev === 'ok'
        ? { severity: 'ok', detail: 'Peak usage of processes/sessions stayed below 90% of the limits since startup.', items: out }
        : { severity: sev, detail: 'A process/session limit was (nearly) reached — new connections fail with ORA-00020 / ORA-00018.', items: out, recommendation: 'Raise PROCESSES (and SESSIONS) or fix connection leaks / pool sizing.' }
    },
  },
  {
    id: 'scheduler-failures',
    category: 'Availability',
    title: 'Failed scheduler jobs (7 days)',
    run: async (conn) => {
      const r = await rows<{ O: string; J: string; N: number }>(
        conn,
        `SELECT OWNER AS "O", JOB_NAME AS "J", COUNT(*) AS "N" FROM DBA_SCHEDULER_JOB_RUN_DETAILS
          WHERE STATUS <> 'SUCCEEDED' AND LOG_DATE > SYSTIMESTAMP - INTERVAL '7' DAY GROUP BY OWNER, JOB_NAME ORDER BY 3 DESC`,
      )
      return r.length
        ? { severity: 'warning', detail: `${r.reduce((a, x) => a + n(x.N), 0)} failed/stopped run(s) across ${r.length} job(s).`, items: names(r, (x) => `${x.O}.${x.J} ×${x.N}`), recommendation: 'See Components → failed runs for error codes.' }
        : { severity: 'ok', detail: 'No failed scheduler runs in the last 7 days.' }
    },
  },
  {
    id: 'recyclebin',
    category: 'Capacity',
    title: 'Recycle bin',
    run: async (conn) => {
      const r = await one<{ N: number; B: number }>(
        conn,
        `SELECT COUNT(*) AS "N", SUM(r.SPACE * NVL(t.BLOCK_SIZE, 8192)) AS "B" FROM DBA_RECYCLEBIN r LEFT JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = r.TS_NAME`,
      )
      return n(r?.N)
        ? { severity: 'info', detail: `${n(r?.N)} dropped object(s) holding about ${(n(r?.B) / 1048576).toFixed(1)} MiB.`, recommendation: 'PURGE DBA_RECYCLEBIN when the objects are no longer needed.' }
        : { severity: 'ok', detail: 'Recycle bin is empty.' }
    },
  },
  {
    id: 'flashback',
    category: 'Recoverability',
    title: 'Flashback database',
    run: async (conn) => {
      const r = await one<{ F: string }>(conn, `SELECT FLASHBACK_ON AS "F" FROM V$DATABASE`)
      return r?.F === 'YES'
        ? { severity: 'ok', detail: 'Flashback Database is on (fast rewind after logical errors or failed changes).' }
        : { severity: 'info', detail: `Flashback Database is ${r?.F}. Guaranteed restore points before risky changes are still possible.` }
    },
  },
  {
    id: 'force-logging',
    category: 'Recoverability',
    title: 'Force logging',
    run: async (conn) => {
      const r = await one<{ F: string; R: string }>(conn, `SELECT FORCE_LOGGING AS "F", DATABASE_ROLE AS "R" FROM V$DATABASE`)
      const dg = await one<{ N: number }>(conn, `SELECT COUNT(*) AS "N" FROM V$ARCHIVE_DEST WHERE STATUS <> 'INACTIVE' AND TARGET = 'STANDBY'`)
      if (r?.F === 'YES') return { severity: 'ok', detail: 'FORCE LOGGING is on — NOLOGGING operations still generate redo.' }
      return n(dg?.N)
        ? { severity: 'warning', detail: 'A standby destination exists but FORCE LOGGING is off: NOLOGGING loads will not reach the standby.', recommendation: 'ALTER DATABASE FORCE LOGGING.' }
        : { severity: 'info', detail: 'FORCE LOGGING is off (fine without a standby; NOLOGGING operations are not recoverable from backups).' }
    },
  },
  {
    id: 'bct',
    category: 'Performance',
    title: 'Block change tracking',
    run: async (conn) => {
      const r = await one<{ S: string }>(conn, `SELECT STATUS AS "S" FROM V$BLOCK_CHANGE_TRACKING`)
      return r?.S === 'ENABLED'
        ? { severity: 'ok', detail: 'Enabled — incremental backups read only changed blocks.' }
        : { severity: 'info', detail: 'Disabled. Incremental RMAN backups scan every block (EE: ALTER DATABASE ENABLE BLOCK CHANGE TRACKING).' }
    },
  },
  {
    id: 'charset',
    category: 'Configuration',
    title: 'Database character set',
    run: async (conn) => {
      const r = await one<{ V: string }>(conn, `SELECT VALUE AS "V" FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER = 'NLS_CHARACTERSET'`)
      return r?.V === 'AL32UTF8'
        ? { severity: 'ok', detail: 'AL32UTF8 (Unicode).' }
        : { severity: 'info', detail: `${r?.V} — not Unicode. Multilingual data and some cloud migrations need AL32UTF8.` }
    },
  },
  {
    id: 'inactive-users',
    category: 'Security',
    title: 'Open accounts not used for 90 days',
    run: async (conn, major) => {
      if (major < 12) return { severity: 'na', detail: 'DBA_USERS.LAST_LOGIN requires Oracle 12c or later.' }
      const r = await rows<{ U: string; L: string | null }>(
        conn,
        `SELECT u.USERNAME AS "U", TO_CHAR(u.LAST_LOGIN, 'YYYY-MM-DD') AS "L" FROM DBA_USERS u
          WHERE u.ACCOUNT_STATUS = 'OPEN' AND ${customUser(major, 'u')} AND (u.LAST_LOGIN IS NULL OR u.LAST_LOGIN < SYSTIMESTAMP - INTERVAL '90' DAY) ORDER BY 1`,
      )
      return r.length
        ? { severity: 'info', detail: `${r.length} OPEN application account(s) with no login in 90 days (or never).`, items: names(r, (x) => `${x.U} (${x.L ?? 'never'})`), recommendation: 'Lock accounts that are no longer used.' }
        : { severity: 'ok', detail: 'Every OPEN application account logged in within the last 90 days.' }
    },
  },
  {
    id: 'auditing',
    category: 'Security',
    title: 'Database auditing',
    run: async (conn, major) => {
      const trail = (await one<{ V: string }>(conn, `SELECT VALUE AS "V" FROM V$PARAMETER WHERE NAME = 'audit_trail'`))?.V ?? 'NONE'
      let policies = 0
      if (major >= 12) policies = n((await one<{ N: number }>(conn, `SELECT COUNT(*) AS "N" FROM AUDIT_UNIFIED_ENABLED_POLICIES`))?.N)
      if (trail.toUpperCase() === 'NONE' && !policies) return { severity: 'warning', detail: 'No traditional audit trail and no unified audit policies enabled.', recommendation: 'Enable at least logon/privileged-action auditing (e.g. AUDIT POLICY ORA_SECURECONFIG).' }
      return { severity: 'ok', detail: `audit_trail=${trail}${major >= 12 ? `, ${policies} unified policy enablement(s)` : ''}.` }
    },
  },
  {
    id: 'memory-management',
    category: 'Configuration',
    title: 'Memory management mode',
    run: async (conn) => {
      const r = await rows<{ N: string; V: string }>(conn, `SELECT NAME AS "N", VALUE AS "V" FROM V$PARAMETER WHERE NAME IN ('memory_target', 'sga_target', 'pga_aggregate_target', 'pga_aggregate_limit')`)
      const v = Object.fromEntries(r.map((x) => [x.N, n(x.V)]))
      const mode = v.memory_target ? 'AMM (memory_target)' : v.sga_target ? 'ASMM (sga_target + pga_aggregate_target)' : 'manual SGA sizing'
      return { severity: v.memory_target || v.sga_target ? 'ok' : 'info', detail: `Mode: ${mode}.`, items: r.map((x) => `${x.N}=${x.V}`) }
    },
  },
  {
    id: 'patch-level',
    category: 'Availability',
    title: 'Latest SQL patch',
    run: async (conn, major) => {
      if (major < 12) return { severity: 'na', detail: 'DBA_REGISTRY_SQLPATCH requires Oracle 12c or later.' }
      const r = await one<{ D: string; T: string; A: number }>(
        conn,
        `SELECT * FROM (SELECT DESCRIPTION AS "D", TO_CHAR(ACTION_TIME, 'YYYY-MM-DD') AS "T", ROUND(SYSDATE - CAST(ACTION_TIME AS DATE)) AS "A"
                          FROM DBA_REGISTRY_SQLPATCH WHERE STATUS = 'SUCCESS' ORDER BY ACTION_TIME DESC) WHERE ROWNUM = 1`,
      )
      if (!r) return { severity: 'info', detail: 'No SQL patches recorded (base release, or datapatch not run).' }
      return { severity: n(r.A) > 365 ? 'warning' : 'ok', detail: `${r.D} applied ${r.T} (${r.A} days ago).`, recommendation: n(r.A) > 365 ? 'Apply a current Release Update — security fixes ship quarterly.' : undefined }
    },
  },
]

async function findings(conn: Connection): Promise<AssessmentSection> {
  return { findings: await softPanel(() => runFindings(conn), CATALOG, `${CHECKS.length} automated checks. "n/a" = not checkable with this account or Oracle version.`) }
}

async function runCheckDef(conn: Connection, c: Check, major: number): Promise<AssessmentFinding> {
  try {
    return { id: c.id, category: c.category, title: c.title, ...(await c.run(conn, major)) }
  } catch (err) {
    const i = oracleErrorInfo(err)
    return { id: c.id, category: c.category, title: c.title, severity: 'na', detail: `Not checked — ${i.code}: ${i.hint ?? i.message}` }
  }
}

/** Runs one health check by id (null when the id is unknown). */
export async function runCheck(conn: Connection, id: string): Promise<AssessmentFinding | null> {
  const c = CHECKS.find((x) => x.id === id)
  return c ? runCheckDef(conn, c, versionMajorOf(conn)) : null
}

export async function runFindings(conn: Connection): Promise<AssessmentFinding[]> {
  const major = versionMajorOf(conn)
  const out: AssessmentFinding[] = []
  for (const c of CHECKS) out.push(await runCheckDef(conn, c, major))
  const order: Record<AssessmentSeverity, number> = { critical: 0, warning: 1, info: 2, na: 3, ok: 4 }
  return out.sort((a, b) => order[a.severity] - order[b.severity])
}

import type { Connection } from 'oracledb'
import type { DbEnvironment } from '../../shared/types/lab'
import { driverInfo } from './driver'
import { oracleErrorInfo } from './errors'
import { one, rows } from './query'

function editionFromBanner(banner: string): string {
  const b = banner.toLowerCase()
  if (b.includes('enterprise')) return 'Enterprise Edition'
  if (b.includes('standard edition 2')) return 'Standard Edition 2'
  if (b.includes('standard')) return 'Standard Edition'
  if (b.includes('express')) return 'Express Edition'
  if (b.includes('free')) return 'Free'
  if (b.includes('personal')) return 'Personal Edition'
  return 'Unknown'
}

export function versionMajorOf(conn: Connection): number {
  return Math.floor((conn.oracleServerVersion ?? 0) / 100000000) || 0
}

export async function detectEnvironment(conn: Connection): Promise<DbEnvironment> {
  const unavailable: Record<string, string> = {}
  const versionMajor = versionMajorOf(conn)
  const note = (k: string, err: unknown) => {
    const i = oracleErrorInfo(err)
    unavailable[k] = `${i.code}: ${i.hint ?? i.message}`
  }

  const ctx12 =
    versionMajor >= 12
      ? `, SYS_CONTEXT('USERENV','CON_NAME') AS "conName", SYS_CONTEXT('USERENV','CON_ID') AS "conId"`
      : ''
  const ctx = (await one<Record<string, string | null>>(
    conn,
    `SELECT SYS_CONTEXT('USERENV','DB_NAME') AS "dbName",
            SYS_CONTEXT('USERENV','DB_UNIQUE_NAME') AS "dbUniqueName",
            SYS_CONTEXT('USERENV','INSTANCE_NAME') AS "instanceName",
            SYS_CONTEXT('USERENV','SERVER_HOST') AS "serverHost",
            SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS "currentSchema",
            SYS_CONTEXT('USERENV','SESSION_USER') AS "sessionUser"${ctx12}
       FROM DUAL`,
  ))!

  let banner = ''
  try {
    const r = await one<{ banner: string }>(conn, `SELECT BANNER AS "banner" FROM V$VERSION WHERE ROWNUM = 1`)
    banner = r?.banner ?? ''
  } catch (err) {
    note('banner', err)
  }

  const env: DbEnvironment = {
    connected: true,
    serverVersion: conn.oracleServerVersionString ?? '',
    versionMajor,
    banner,
    edition: editionFromBanner(banner),
    dbName: ctx.dbName ?? null,
    dbUniqueName: ctx.dbUniqueName ?? null,
    instanceName: ctx.instanceName ?? null,
    hostName: ctx.serverHost ?? null,
    instanceStatus: null,
    startupTime: null,
    uptimeSeconds: null,
    databaseRole: null,
    openMode: null,
    logMode: null,
    protectionMode: null,
    isCdb: versionMajor >= 12 ? null : false,
    containerName: ctx.conName ?? null,
    conId: ctx.conId != null ? Number(ctx.conId) : null,
    characterSet: null,
    nationalCharacterSet: null,
    currentSchema: ctx.currentSchema ?? '',
    sessionUser: ctx.sessionUser ?? '',
    serverTypeInUse: null,
    isRac: null,
    instanceCount: null,
    options: {},
    privileges: { catalogAccess: false, dbaViews: false, vDollar: false },
    driver: driverInfo(),
    unavailable,
  }

  try {
    const inst = await one<any>(
      conn,
      `SELECT INSTANCE_NAME AS "instanceName", HOST_NAME AS "hostName", STATUS AS "status",
              TO_CHAR(STARTUP_TIME, 'YYYY-MM-DD"T"HH24:MI:SS') AS "startupTime",
              ROUND((SYSDATE - STARTUP_TIME) * 86400) AS "uptime"
         FROM V$INSTANCE`,
    )
    if (inst) {
      env.instanceName = inst.instanceName
      env.hostName = inst.hostName
      env.instanceStatus = inst.status
      env.startupTime = inst.startupTime
      env.uptimeSeconds = Number(inst.uptime)
      env.privileges.vDollar = true
    }
  } catch (err) {
    note('instance', err)
  }

  try {
    const cdbCol = versionMajor >= 12 ? `, CDB AS "cdb"` : ''
    const db = await one<any>(
      conn,
      `SELECT DATABASE_ROLE AS "role", OPEN_MODE AS "openMode", LOG_MODE AS "logMode",
              PROTECTION_MODE AS "protectionMode"${cdbCol}
         FROM V$DATABASE`,
    )
    if (db) {
      env.databaseRole = db.role
      env.openMode = db.openMode
      env.logMode = db.logMode
      env.protectionMode = db.protectionMode
      if (versionMajor >= 12) env.isCdb = db.cdb === 'YES'
    }
  } catch (err) {
    note('database', err)
  }

  try {
    const nls = await rows<{ p: string; v: string }>(
      conn,
      `SELECT PARAMETER AS "p", VALUE AS "v" FROM NLS_DATABASE_PARAMETERS
        WHERE PARAMETER IN ('NLS_CHARACTERSET','NLS_NCHAR_CHARACTERSET')`,
    )
    for (const r of nls) {
      if (r.p === 'NLS_CHARACTERSET') env.characterSet = r.v
      else env.nationalCharacterSet = r.v
    }
    env.privileges.catalogAccess = true
  } catch (err) {
    note('characterSet', err)
  }

  try {
    const opts = await rows<{ p: string; v: string }>(conn, `SELECT PARAMETER AS "p", VALUE AS "v" FROM V$OPTION`)
    for (const o of opts) env.options[o.p] = o.v === 'TRUE'
  } catch (err) {
    note('options', err)
  }

  try {
    const r = await one<{ n: number }>(conn, `SELECT COUNT(*) AS "n" FROM GV$INSTANCE`)
    env.instanceCount = Number(r?.n ?? 0)
    env.isRac = env.instanceCount > 1 || env.options['Real Application Clusters'] === true
  } catch (err) {
    env.isRac = env.options['Real Application Clusters'] ?? null
    note('rac', err)
  }

  try {
    const s = await one<{ server: string }>(
      conn,
      `SELECT SERVER AS "server" FROM V$SESSION WHERE SID = SYS_CONTEXT('USERENV','SID')`,
    )
    env.serverTypeInUse = s?.server ?? null
  } catch (err) {
    note('serverType', err)
  }

  try {
    await one(conn, `SELECT 1 FROM DBA_TABLESPACES WHERE ROWNUM = 1`)
    env.privileges.dbaViews = true
  } catch {
    env.privileges.dbaViews = false
  }

  if (env.privileges.vDollar && !env.privileges.dbaViews) {
    unavailable.dbaViews = 'DBA_* views not visible; storage panels fall back to USER_* views where possible.'
  }
  return env
}

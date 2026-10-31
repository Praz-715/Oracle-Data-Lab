import oracledb from 'oracledb'
import type { Connection, Pool } from 'oracledb'
import { getStoredProfile, resolveCredentials, type ResolvedCredentials } from '../services/profiles'
import { oracleErrorInfo } from './errors'

let driverReady = false
let driverMode: 'thin' | 'thick' = 'thin'

/** Initializes node-oracledb once. Thick mode must be chosen before the first connection. */
export function initDriver(): void {
  if (driverReady) return
  const cfg = useRuntimeConfig().oracle
  if (cfg.driverMode === 'thick') {
    oracledb.initOracleClient({
      libDir: cfg.clientLibDir || undefined,
      configDir: cfg.configDir || undefined,
    })
    driverMode = 'thick'
  }
  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT
  oracledb.fetchAsString = [oracledb.CLOB]
  oracledb.fetchAsBuffer = [oracledb.BLOB]
  oracledb.autoCommit = false
  driverReady = true
}

export function driverInfo() {
  initDriver()
  let clientVersion: string | null = null
  if (driverMode === 'thick') {
    try {
      clientVersion = oracledb.oracleClientVersionString
    } catch {
      clientVersion = null
    }
  }
  return { mode: driverMode, version: oracledb.versionString, clientVersion }
}

const PRIVILEGES: Record<string, number | undefined> = {
  sysdba: oracledb.SYSDBA,
  sysoper: oracledb.SYSOPER,
  sysbackup: oracledb.SYSBACKUP,
  sysdg: oracledb.SYSDG,
}

function baseAttrs(c: ResolvedCredentials) {
  const cfg = useRuntimeConfig().oracle
  return {
    user: c.user,
    password: c.password,
    connectString: c.connectString,
    configDir: cfg.configDir || undefined,
    walletLocation: c.walletLocation,
    walletPassword: c.walletPassword,
  }
}

export type Purpose = 'app' | 'bench'
const pools = new Map<string, Promise<Pool>>()

function poolKey(profileId: string, purpose: Purpose) {
  return `${profileId}:${purpose}`
}

async function getPool(profileId: string, purpose: Purpose, size?: number): Promise<Pool> {
  const k = poolKey(profileId, purpose)
  let p = pools.get(k)
  if (p && purpose === 'bench' && size) {
    // A benchmark pool sized for fewer sessions would queue workers: recreate it.
    const existing = await p.catch(() => null)
    if (!existing || existing.poolMax < size) {
      pools.delete(k)
      await existing?.close(0).catch(() => {})
      p = undefined
    }
  }
  if (!p) {
    p = (async () => {
      initDriver()
      const profile = await getStoredProfile(profileId)
      const creds = await resolveCredentials(profile)
      const cfg = useRuntimeConfig().oracle
      const poolMax = purpose === 'bench' ? Math.max(1, size ?? 4) : Number(cfg.poolMax)
      return oracledb.createPool({
        ...baseAttrs(creds),
        poolAlias: `odl:${k}`,
        poolMin: purpose === 'bench' ? 0 : Number(cfg.poolMin),
        poolMax,
        poolIncrement: 1,
        poolTimeout: Number(cfg.poolTimeout),
        queueTimeout: 60000,
        enableStatistics: true,
      })
    })()
    pools.set(k, p)
    p.catch(() => pools.delete(k))
  }
  return p
}

/** Drop pools for a profile (after edit/delete) so new credentials take effect. */
export async function closeProfilePools(profileId: string): Promise<void> {
  for (const purpose of ['app', 'bench'] as Purpose[]) {
    const k = poolKey(profileId, purpose)
    const p = pools.get(k)
    if (!p) continue
    pools.delete(k)
    try {
      await (await p).close(5)
    } catch {
      // pool may never have opened
    }
  }
}

export async function closeAllPools(): Promise<void> {
  const ids = new Set([...pools.keys()].map((k) => k.split(':')[0]!))
  await Promise.all([...ids].map(closeProfilePools))
}

export interface ConnOptions {
  purpose?: Purpose
  /** Max connections for a dedicated benchmark pool. */
  size?: number
  /** Shown in V$SESSION.ACTION so lab sessions are easy to identify. */
  action?: string
  callTimeoutMs?: number
}

async function rawConnection(profileId: string, opts: ConnOptions): Promise<Connection> {
  initDriver()
  const profile = await getStoredProfile(profileId)
  // Privileged (SYSDBA etc.) logins cannot use a homogeneous pool: use standalone connections.
  if (profile.privilege !== 'none') {
    const creds = await resolveCredentials(profile)
    return oracledb.getConnection({ ...baseAttrs(creds), privilege: PRIVILEGES[profile.privilege] })
  }
  const pool = await getPool(profileId, opts.purpose ?? 'app', opts.size)
  return pool.getConnection()
}

export async function getConnection(profileId: string, opts: ConnOptions = {}): Promise<Connection> {
  const conn = await rawConnection(profileId, opts)
  conn.callTimeout = opts.callTimeoutMs ?? Number(useRuntimeConfig().oracle.callTimeoutMs)
  conn.module = 'OracleDB Data Lab'
  conn.action = (opts.action ?? 'app').slice(0, 32)
  return conn
}

export async function withConnection<T>(
  profileId: string,
  fn: (conn: Connection) => Promise<T>,
  opts: ConnOptions = {},
): Promise<T> {
  let conn: Connection | null = null
  try {
    conn = await getConnection(profileId, opts)
    return await fn(conn)
  } catch (err) {
    throw toHttpError(err)
  } finally {
    try {
      await conn?.close()
    } catch {
      // connection already broken; the pool discards it
    }
  }
}

/**
 * Oracle/driver errors become 502 responses that keep the ORA/NJS code and hint, so the UI can show
 * "ORA-01017: invalid username/password" instead of a generic server error. H3 errors pass through.
 */
function toHttpError(err: unknown) {
  if (isError(err)) return err
  const info = oracleErrorInfo(err)
  if (info.code === 'ERROR') return err
  return createError({
    statusCode: 502,
    statusMessage: `${info.message}${info.hint ? ` — ${info.hint}` : ''}`.replace(/[\r\n]+/g, ' ').slice(0, 500),
    data: { code: info.code, hint: info.hint ?? null },
  })
}

/** One-off standalone connection for "Test Connection" with credentials that are not saved. */
export async function withAdhocConnection<T>(creds: ResolvedCredentials, fn: (conn: Connection) => Promise<T>): Promise<T> {
  initDriver()
  const conn = await oracledb.getConnection({
    ...baseAttrs(creds),
    privilege: creds.privilege !== 'none' ? PRIVILEGES[creds.privilege] : undefined,
    connectTimeout: 15,
  } as oracledb.ConnectionAttributes)
  conn.callTimeout = 30000
  conn.module = 'OracleDB Data Lab'
  conn.action = 'test-connection'
  try {
    return await fn(conn)
  } finally {
    await conn.close().catch(() => {})
  }
}

export async function poolStatus(profileId: string) {
  const out: Record<string, unknown>[] = []
  for (const purpose of ['app', 'bench'] as Purpose[]) {
    const p = pools.get(poolKey(profileId, purpose))
    if (!p) {
      out.push({ purpose, open: false })
      continue
    }
    try {
      const pool = await p
      const stats = pool.getStatistics?.()
      out.push({
        purpose,
        open: true,
        status: pool.status === oracledb.POOL_STATUS_OPEN ? 'open' : String(pool.status),
        connectionsOpen: pool.connectionsOpen,
        connectionsInUse: pool.connectionsInUse,
        poolMin: pool.poolMin,
        poolMax: pool.poolMax,
        poolTimeout: pool.poolTimeout,
        queueLength: stats?.currentQueueLength ?? null,
        totalRequests: stats?.connectionRequests ?? null,
        failedRequests: stats?.failedRequests ?? null,
        requestTimeouts: stats?.requestTimeouts ?? null,
        averageTimeInQueueMs: stats?.averageTimeInQueue ?? null,
        upSince: stats?.upTime ?? null,
      })
    } catch (err) {
      out.push({ purpose, open: false, error: (err as Error).message })
    }
  }
  return out
}

export { oracledb }

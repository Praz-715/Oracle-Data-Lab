import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import type { ZodType } from 'zod'
import type { AuditEntry, LabSettings } from '../../shared/types/lab'

/** Persistent app store (.data/lab). Holds profiles, jobs, plans, audit log and snapshots. */
export function labStore() {
  return useStorage('lab')
}

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function labLimits() {
  const l = useRuntimeConfig().limits
  return {
    maxConcurrency: Number(l.maxConcurrency),
    maxBenchmarkSeconds: Number(l.maxBenchmarkSeconds),
    heavyConcurrencyThreshold: Number(l.heavyConcurrencyThreshold),
    maxBatchSize: Number(l.maxBatchSize),
    maxRows: Number(l.maxRows),
    maxConcurrentJobs: Number(l.maxConcurrentJobs),
    maxExtensionTables: Number(l.maxExtensionTables),
    maxUploadMb: Number(l.maxUploadMb ?? 512),
  }
}

// ---------------------------------------------------------------------------
// Secrets: saved connection passwords are encrypted at rest with AES-256-GCM.
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null
let secretSource: LabSettings['secretSource'] = 'env'

async function encryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey
  let secret = String(useRuntimeConfig().labSecret || '')
  if (!secret) {
    secretSource = 'generated'
    const store = labStore()
    secret = String((await store.getItem<string>('secret.key')) || '')
    if (!secret) {
      secret = randomBytes(32).toString('base64')
      await store.setItem('secret.key', secret)
    }
  }
  cachedKey = createHash('sha256').update(secret).digest()
  return cachedKey
}

export function currentSecretSource() {
  return secretSource
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = await encryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('.')
}

export async function decryptSecret(sealed: string): Promise<string> {
  const [ver, iv, tag, data] = sealed.split('.')
  if (ver !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported secret format')
  const key = await encryptionKey()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export async function readBodyAs<T>(event: H3Event, schema: ZodType<T>): Promise<T> {
  const body = await readBody(event)
  const parsed = schema.safeParse(body ?? {})
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid request',
      data: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    })
  }
  return parsed.data
}

export function queryAs<T>(event: H3Event, schema: ZodType<T>): T {
  const parsed = schema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid query',
      data: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    })
  }
  return parsed.data
}

export function requireParam(event: H3Event, name: string): string {
  const v = getRouterParam(event, name)
  if (!v) throw createError({ statusCode: 400, statusMessage: `Missing parameter: ${name}` })
  return decodeURIComponent(v)
}

// ---------------------------------------------------------------------------
// Audit log: every state-changing action against a database is recorded.
// ---------------------------------------------------------------------------

export async function audit(entry: Omit<AuditEntry, 'id' | 'ts'>): Promise<void> {
  const ts = nowIso()
  const id = newId()
  const key = `audit:${ts.slice(0, 10).replaceAll('-', '')}:${ts.replace(/[:.]/g, '')}-${id.slice(0, 8)}`
  // Never let a password or similar sneak into the audit trail.
  const detail = entry.detail?.replace(/(password|identified by)\s*[:=]?\s*\S+/gi, '$1 ******')
  await labStore().setItem(key, { ...entry, detail, id, ts } satisfies AuditEntry)
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  const store = labStore()
  const keys = (await store.getKeys('audit')).sort().reverse().slice(0, limit)
  const items = await Promise.all(keys.map((k) => store.getItem<AuditEntry>(k)))
  return items.filter((x): x is AuditEntry => !!x)
}

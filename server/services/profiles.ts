import { z } from 'zod'
import type { ConnectionInput, ConnectionProfile } from '../../shared/types/lab'

interface StoredProfile extends ConnectionProfile {
  passwordEnc: string | null
  walletPasswordEnc: string | null
}

const ident = /^[A-Za-z][A-Za-z0-9_$#]*$/
const hostRe = /^[A-Za-z0-9.\-_:[\]]+$/
const serviceRe = /^[A-Za-z0-9._\-$#]+$/

export const connectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    host: z.string().trim().max(255).regex(hostRe, 'Invalid host').or(z.literal('')),
    port: z.coerce.number().int().min(1).max(65535).default(1521),
    method: z.enum(['service', 'sid', 'descriptor']),
    serviceName: z.string().trim().max(128).regex(serviceRe, 'Invalid service name').or(z.literal('')).optional(),
    sid: z.string().trim().max(64).regex(serviceRe, 'Invalid SID').or(z.literal('')).optional(),
    descriptor: z.string().trim().max(4000).optional(),
    serverType: z.enum(['dedicated', 'shared', 'pooled', 'default']).default('dedicated'),
    username: z.string().trim().min(1).max(128),
    password: z.string().max(1024).optional(),
    privilege: z.enum(['none', 'sysdba', 'sysoper', 'sysbackup', 'sysdg']).default('none'),
    walletLocation: z.string().trim().max(1024).optional(),
    walletPassword: z.string().max(1024).optional(),
    useTls: z.boolean().default(false),
    mode: z.enum(['read-only', 'lab']).default('read-only'),
    allowedSchemas: z
      .array(z.string().trim().toUpperCase().regex(ident, 'Invalid schema name').max(128))
      .max(50)
      .default([]),
    notes: z.string().max(2000).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'service' && !v.serviceName) ctx.addIssue({ code: 'custom', path: ['serviceName'], message: 'Service name required' })
    if (v.method === 'sid' && !v.sid) ctx.addIssue({ code: 'custom', path: ['sid'], message: 'SID required' })
    if (v.method === 'descriptor' && !v.descriptor) ctx.addIssue({ code: 'custom', path: ['descriptor'], message: 'Descriptor required' })
    if (v.method !== 'descriptor' && !v.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'Host required' })
  })

export type ValidConnectionInput = z.infer<typeof connectionInputSchema>

function key(id: string) {
  return `profiles:${id}`
}

function toPublic(p: StoredProfile): ConnectionProfile {
  const { passwordEnc, walletPasswordEnc: _w, ...rest } = p
  return { ...rest, hasPassword: !!passwordEnc }
}

export async function listProfiles(): Promise<ConnectionProfile[]> {
  const store = labStore()
  const keys = await store.getKeys('profiles')
  const items = await Promise.all(keys.map((k) => store.getItem<StoredProfile>(k)))
  return items
    .filter((p): p is StoredProfile => !!p)
    .map(toPublic)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getStoredProfile(id: string): Promise<StoredProfile> {
  const p = await labStore().getItem<StoredProfile>(key(id))
  if (!p) throw createError({ statusCode: 404, statusMessage: 'Connection profile not found' })
  return p
}

export async function getProfile(id: string): Promise<ConnectionProfile> {
  return toPublic(await getStoredProfile(id))
}

export async function saveProfile(input: ValidConnectionInput, id?: string): Promise<ConnectionProfile> {
  const existing = id ? await getStoredProfile(id) : null
  const now = nowIso()
  const record: StoredProfile = {
    id: existing?.id ?? newId(),
    name: input.name,
    host: input.host,
    port: input.port,
    method: input.method,
    serviceName: input.serviceName ?? '',
    sid: input.sid ?? '',
    descriptor: input.descriptor ?? '',
    serverType: input.serverType,
    username: input.username,
    hasPassword: false,
    privilege: input.privilege,
    walletLocation: input.walletLocation ?? '',
    useTls: input.useTls,
    mode: input.mode,
    allowedSchemas: [...new Set(input.allowedSchemas)],
    notes: input.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // An omitted/empty password on update keeps the stored one; it is never sent back.
    passwordEnc: input.password ? await encryptSecret(input.password) : (existing?.passwordEnc ?? null),
    walletPasswordEnc: input.walletPassword
      ? await encryptSecret(input.walletPassword)
      : (existing?.walletPasswordEnc ?? null),
  }
  await labStore().setItem(key(record.id), record)
  return toPublic(record)
}

export async function deleteProfile(id: string): Promise<void> {
  await getStoredProfile(id)
  await labStore().removeItem(key(id))
}

/** Builds a connect descriptor from validated fields (never from free text except `descriptor`). */
export function buildConnectString(p: Pick<StoredProfile, 'method' | 'host' | 'port' | 'serviceName' | 'sid' | 'descriptor' | 'serverType' | 'useTls'>): string {
  if (p.method === 'descriptor') return p.descriptor
  const protocol = p.useTls ? 'TCPS' : 'TCP'
  const server = p.serverType === 'default' ? '' : `(SERVER=${p.serverType.toUpperCase()})`
  const target = p.method === 'sid' ? `(SID=${p.sid})` : `(SERVICE_NAME=${p.serviceName})`
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol})(HOST=${p.host})(PORT=${p.port}))(CONNECT_DATA=${target}${server}))`
}

export interface ResolvedCredentials {
  user: string
  password: string
  connectString: string
  privilege: StoredProfile['privilege']
  walletLocation?: string
  walletPassword?: string
}

export async function resolveCredentials(p: StoredProfile): Promise<ResolvedCredentials> {
  if (!p.passwordEnc) throw createError({ statusCode: 400, statusMessage: 'Profile has no saved password' })
  return {
    user: p.username,
    password: await decryptSecret(p.passwordEnc),
    connectString: buildConnectString(p),
    privilege: p.privilege,
    walletLocation: p.walletLocation || undefined,
    walletPassword: p.walletPasswordEnc ? await decryptSecret(p.walletPasswordEnc) : undefined,
  }
}

export function credentialsFromInput(input: ValidConnectionInput): ResolvedCredentials {
  if (!input.password) throw createError({ statusCode: 400, statusMessage: 'Password required to test a connection' })
  return {
    user: input.username,
    password: input.password,
    connectString: buildConnectString({
      method: input.method,
      host: input.host,
      port: input.port,
      serviceName: input.serviceName ?? '',
      sid: input.sid ?? '',
      descriptor: input.descriptor ?? '',
      serverType: input.serverType,
      useTls: input.useTls,
    }),
    privilege: input.privilege,
    walletLocation: input.walletLocation || undefined,
    walletPassword: input.walletPassword || undefined,
  }
}

/**
 * Guard for every write path: the profile must be in lab mode and the target schema must be
 * explicitly authorized on that profile. Production profiles default to read-only.
 */
export function assertWritable(profile: ConnectionProfile, schema: string): void {
  if (profile.mode !== 'lab') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Profile is read-only. Switch it to lab mode in Connections to allow writes.',
    })
  }
  if (!profile.allowedSchemas.includes(schema.toUpperCase())) {
    throw createError({
      statusCode: 403,
      statusMessage: `Schema ${schema.toUpperCase()} is not in this profile's authorized schemas.`,
    })
  }
}

export type { ConnectionInput, StoredProfile }

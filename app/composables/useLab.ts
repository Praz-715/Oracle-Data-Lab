import type { ConnectionProfile, DbEnvironment } from '~~/shared/types/lab'

const STORAGE_KEY = 'odl-profile'

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * The connection profile the console is pointed at. Only the profile id is remembered in the
 * browser; credentials never leave the server.
 */
export function useActiveProfile() {
  const profiles = useState<ConnectionProfile[]>('odl-profiles', () => [])
  const activeId = useState<string | null>('odl-active-profile', () => null)
  const loaded = useState('odl-profiles-loaded', () => false)
  const environment = useState<DbEnvironment | null>('odl-env', () => null)
  const envError = useState<string | null>('odl-env-error', () => null)

  async function refresh() {
    profiles.value = await api<ConnectionProfile[]>('/api/connections')
    loaded.value = true
    if (!activeId.value) activeId.value = readStored()
    if (activeId.value && !profiles.value.some((p) => p.id === activeId.value)) activeId.value = null
    if (!activeId.value && profiles.value.length) activeId.value = profiles.value[0]!.id
  }

  function select(id: string | null) {
    activeId.value = id
    environment.value = null
    envError.value = null
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id)
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // storage unavailable (private mode): selection just isn't remembered
    }
  }

  async function loadEnvironment() {
    if (!activeId.value) return
    try {
      environment.value = await api<DbEnvironment>(`/api/connections/${activeId.value}/environment`)
      envError.value = null
    } catch (err) {
      environment.value = null
      envError.value = apiErrorMessage(err)
    }
  }

  const active = computed(() => profiles.value.find((p) => p.id === activeId.value) ?? null)
  /** Default schema for lab work: first authorized schema, else the login user. */
  const labSchema = computed(() => active.value?.allowedSchemas[0] ?? active.value?.username.toUpperCase() ?? '')
  const writable = computed(() => active.value?.mode === 'lab' && (active.value?.allowedSchemas.length ?? 0) > 0)

  return { profiles, activeId, active, loaded, environment, envError, labSchema, writable, refresh, select, loadEnvironment }
}

/** Lab dataset coordinates shared across Generator / Explorer / Performance pages. */
export function useLabTarget() {
  const { labSchema } = useActiveProfile()
  const schema = useState<string>('odl-target-schema', () => '')
  const prefix = useState<string>('odl-target-prefix', () => 'DL_')
  watch(
    labSchema,
    (s) => {
      if (!schema.value && s) schema.value = s
    },
    { immediate: true },
  )
  return { schema, prefix }
}

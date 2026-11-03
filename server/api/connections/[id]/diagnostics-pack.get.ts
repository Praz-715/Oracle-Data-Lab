import { packAccessParameter } from '../../../services/diagnostics-pack'
import { getProfile } from '../../../services/profiles'

// License state of the profile plus the database's control_management_pack_access setting.
export default defineEventHandler(async (event) => {
  const profile = await getProfile(requireParam(event, 'id'))
  const packAccess = await packAccessParameter(profile.id).catch(() => null)
  return { enabled: profile.diagnosticsPack, changedAt: profile.diagnosticsPackChangedAt ?? null, packAccess }
})

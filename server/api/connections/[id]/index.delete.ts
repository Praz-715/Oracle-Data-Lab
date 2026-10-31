import { closeProfilePools } from '../../../database/driver'
import { deleteProfile, getProfile } from '../../../services/profiles'

export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const p = await getProfile(id)
  await closeProfilePools(id)
  await deleteProfile(id)
  await audit({ action: 'connection.deleted', profileId: id, target: p.name, outcome: 'ok' })
  return { ok: true }
})

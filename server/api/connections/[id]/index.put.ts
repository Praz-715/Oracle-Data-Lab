import { closeProfilePools } from '../../../database/driver'
import { connectionInputSchema, getProfile, saveProfile } from '../../../services/profiles'

export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const input = await readBodyAs(event, connectionInputSchema)
  const before = await getProfile(id)
  const profile = await saveProfile(input, id)
  await closeProfilePools(id)
  const modeChange = before.mode !== profile.mode ? `, mode ${before.mode} -> ${profile.mode}` : ''
  await audit({
    action: 'connection.updated',
    profileId: id,
    target: profile.name,
    detail: `schemas=${profile.allowedSchemas.join(',') || '-'}${modeChange}${input.password ? ', password changed' : ''}`,
    outcome: 'ok',
  })
  return profile
})

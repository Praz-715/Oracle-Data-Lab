import { connectionInputSchema, saveProfile } from '../../services/profiles'

export default defineEventHandler(async (event) => {
  const input = await readBodyAs(event, connectionInputSchema)
  const profile = await saveProfile(input)
  await audit({ action: 'connection.created', profileId: profile.id, target: profile.name, detail: `mode=${profile.mode}`, outcome: 'ok' })
  return profile
})

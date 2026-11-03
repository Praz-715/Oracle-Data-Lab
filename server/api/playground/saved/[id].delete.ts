import { deleteSaved } from '../../../services/playground'

export default defineEventHandler(async (event) => {
  await deleteSaved(requireParam(event, 'id'))
  return { ok: true }
})

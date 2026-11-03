import { deleteSnapshot } from '../../../services/assessment-history'

export default defineEventHandler(async (event) => {
  await deleteSnapshot(requireParam(event, 'id'))
  return { ok: true }
})

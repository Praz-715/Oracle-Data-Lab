import { deleteUpload } from '../../../services/datasets'

export default defineEventHandler(async (event) => {
  await deleteUpload(requireParam(event, 'id'))
  return { ok: true }
})

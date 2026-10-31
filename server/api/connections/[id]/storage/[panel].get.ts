import { storagePanel } from '../../../../services/storage-lab'

export default defineEventHandler((event) =>
  storagePanel(requireParam(event, 'id'), requireParam(event, 'panel'), getQuery(event) as Record<string, string>),
)

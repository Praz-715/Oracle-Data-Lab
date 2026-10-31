import { monitorPanel } from '../../../../services/monitoring'

export default defineEventHandler((event) =>
  monitorPanel(requireParam(event, 'id'), requireParam(event, 'panel'), getQuery(event) as Record<string, string>),
)

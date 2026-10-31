import { withConnection } from '../../../database/driver'
import { detectEnvironment } from '../../../database/environment'

export default defineEventHandler((event) => withConnection(requireParam(event, 'id'), detectEnvironment, { action: 'environment' }))

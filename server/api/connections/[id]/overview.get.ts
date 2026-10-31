import { overview } from '../../../services/analytics'

export default defineEventHandler((event) => overview(requireParam(event, 'id')))

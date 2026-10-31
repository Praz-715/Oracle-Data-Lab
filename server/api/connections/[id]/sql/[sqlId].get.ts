import { sqlDetail } from '../../../../services/monitoring'

export default defineEventHandler((event) => sqlDetail(requireParam(event, 'id'), requireParam(event, 'sqlId')))

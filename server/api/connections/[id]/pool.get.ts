import { poolStatus } from '../../../database/driver'

export default defineEventHandler((event) => poolStatus(requireParam(event, 'id')))

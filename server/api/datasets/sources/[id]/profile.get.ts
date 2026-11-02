import { profileQuerySchema, profileSource } from '../../../../services/datasets'

export default defineEventHandler((event) => profileSource(requireParam(event, 'id'), queryAs(event, profileQuerySchema)))

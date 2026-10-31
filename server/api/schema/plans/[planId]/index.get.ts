import { getPlan } from '../../../../services/schema'

export default defineEventHandler((event) => getPlan(requireParam(event, 'planId')))

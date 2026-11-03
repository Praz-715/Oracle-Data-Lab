import { activityQuerySchema, liveActivity } from '../../../services/activity'

export default defineEventHandler((event) => liveActivity(requireParam(event, 'id'), queryAs(event, activityQuerySchema)))

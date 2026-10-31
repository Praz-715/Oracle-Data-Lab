import { assessmentSection } from '../../../../services/assessment'

export default defineEventHandler((event) => assessmentSection(requireParam(event, 'id'), requireParam(event, 'section')))

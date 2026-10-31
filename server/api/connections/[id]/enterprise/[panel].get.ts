import { enterprisePanel } from '../../../../services/enterprise'

export default defineEventHandler((event) => enterprisePanel(requireParam(event, 'id'), requireParam(event, 'panel')))

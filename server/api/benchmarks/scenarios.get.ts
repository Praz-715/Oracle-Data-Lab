import { listScenarios } from '../../services/benchmark'

export default defineEventHandler(() => ({ scenarios: listScenarios(), limits: labLimits() }))

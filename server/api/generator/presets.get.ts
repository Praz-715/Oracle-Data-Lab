import { SIZE_PRESETS } from '../../generators/estimate'

export default defineEventHandler(() => ({ presets: SIZE_PRESETS, limits: labLimits() }))

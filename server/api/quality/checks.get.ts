import { QUALITY_CHECKS } from '../../services/quality'

export default defineEventHandler(() =>
  QUALITY_CHECKS.map((c) => ({ id: c.id, category: c.category, title: c.title, description: c.description })),
)

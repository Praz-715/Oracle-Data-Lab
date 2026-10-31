import { driverInfo } from '../database/driver'

export default defineEventHandler(() => {
  let driver: ReturnType<typeof driverInfo> | { error: string }
  try {
    driver = driverInfo()
  } catch (err) {
    driver = { error: (err as Error).message }
  }
  return { ok: true, time: nowIso(), driver }
})

import type { LabSettings } from '../../shared/types/lab'
import { driverInfo } from '../database/driver'

export default defineEventHandler(async (): Promise<LabSettings & { driverError?: string }> => {
  const cfg = useRuntimeConfig().oracle
  let mode: LabSettings['driverMode'] = cfg.driverMode === 'thick' ? 'thick' : 'thin'
  let version = ''
  let driverError: string | undefined
  try {
    const d = driverInfo()
    mode = d.mode
    version = d.version
  } catch (err) {
    driverError = (err as Error).message
  }
  // Touch the key once so secretSource reflects reality.
  await encryptSecret('probe')
  return {
    driverMode: mode,
    driverVersion: version,
    limits: labLimits(),
    pool: { poolMax: Number(cfg.poolMax), poolMin: Number(cfg.poolMin), poolTimeout: Number(cfg.poolTimeout), callTimeoutMs: Number(cfg.callTimeoutMs) },
    dataDir: '.data/lab',
    secretSource: currentSecretSource(),
    driverError,
  }
})

import { withConnection } from '../../../database/driver'
import { detectEnvironment } from '../../../database/environment'
import { oracleErrorInfo } from '../../../database/errors'

export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const t0 = performance.now()
  try {
    const env = await withConnection(id, detectEnvironment, { action: 'test-connection', callTimeoutMs: 30000 })
    return { ok: true, elapsedMs: Math.round(performance.now() - t0), environment: env }
  } catch (err) {
    return { ok: false, elapsedMs: Math.round(performance.now() - t0), error: oracleErrorInfo(err) }
  }
})

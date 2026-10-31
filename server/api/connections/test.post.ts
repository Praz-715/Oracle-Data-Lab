import { withAdhocConnection } from '../../database/driver'
import { detectEnvironment } from '../../database/environment'
import { oracleErrorInfo } from '../../database/errors'
import { connectionInputSchema, credentialsFromInput } from '../../services/profiles'

/** Tests unsaved connection settings. The password is used once and never stored or echoed. */
export default defineEventHandler(async (event) => {
  const input = await readBodyAs(event, connectionInputSchema)
  const t0 = performance.now()
  try {
    const env = await withAdhocConnection(credentialsFromInput(input), detectEnvironment)
    return { ok: true, elapsedMs: Math.round(performance.now() - t0), environment: env }
  } catch (err) {
    return { ok: false, elapsedMs: Math.round(performance.now() - t0), error: oracleErrorInfo(err) }
  }
})

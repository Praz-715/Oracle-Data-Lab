import { z } from 'zod'
import { setDiagnosticsPack } from '../../../services/profiles'

// Enabling requires an explicit confirmation flag from the license dialog; it is audited.
const body = z.object({ enabled: z.boolean(), confirmLicensed: z.boolean().default(false) })

export default defineEventHandler(async (event) => {
  const b = await readBodyAs(event, body)
  if (b.enabled && !b.confirmLicensed) {
    throw createError({ statusCode: 400, statusMessage: 'Confirm that this database is licensed for Oracle Diagnostics Pack.' })
  }
  return setDiagnosticsPack(requireParam(event, 'id'), b.enabled)
})

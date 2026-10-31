import { z } from 'zod'
import { analyzeErrors, parseAlertText } from '../../services/tuning'

/** Groups ORA/TNS errors in pasted alert-log or trace text. Nothing is stored. */
export default defineEventHandler(async (event) => {
  const { text } = await readBodyAs(event, z.object({ text: z.string().min(1).max(20_000_000) }))
  const lines = parseAlertText(text)
  return { lines: lines.length, groups: analyzeErrors(lines) }
})

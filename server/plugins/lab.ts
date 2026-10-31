import { closeAllPools, initDriver } from '../database/driver'
import { recoverJobs } from '../jobs/runner'
// Side-effect imports register the job executors.
import '../services/schema'
import '../services/generator'
import '../services/quality'
import '../services/benchmark'
import '../services/cleanup'

export default defineNitroPlugin(async (nitroApp) => {
  try {
    initDriver()
  } catch (err) {
    // Thick mode misconfiguration is reported on the Settings page and on every connection attempt.
    console.error('[odl] Oracle driver initialization failed:', (err as Error).message)
  }
  const n = await recoverJobs()
  if (n) console.warn(`[odl] ${n} job(s) were active during the last shutdown and are now marked interrupted (resumable from Job History).`)

  nitroApp.hooks.hook('close', async () => {
    await closeAllPools()
  })
})

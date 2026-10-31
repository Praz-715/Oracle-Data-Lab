import { z } from 'zod'
import { createJob } from '../../../../jobs/runner'
import { assertWritable, getProfile } from '../../../../services/profiles'
import { getPlan, type ApplyConfig } from '../../../../services/schema'

const body = z.object({
  /** SHA-256 the user reviewed: the server refuses to apply a plan that differs from it. */
  sha256: z.string().length(64),
  skipExisting: z.boolean().default(false),
  confirm: z.literal(true),
})

export default defineEventHandler(async (event) => {
  const plan = await getPlan(requireParam(event, 'planId'))
  const b = await readBodyAs(event, body)
  if (b.sha256 !== plan.sha256) throw createError({ statusCode: 409, statusMessage: 'Plan changed since it was reviewed. Re-generate and review the DDL.' })
  const profile = await getProfile(plan.profileId)
  assertWritable(profile, plan.schema)
  const job = await createJob<ApplyConfig>({
    type: 'schema-apply',
    profileId: profile.id,
    title: `Apply ${plan.statements.length} DDL statements to ${plan.schema} (${plan.options.prefix}*)`,
    config: { planId: plan.id, schema: plan.schema, skipExisting: b.skipExisting, statementCount: plan.statements.length },
    resumable: true,
  })
  await audit({ action: 'schema.apply.started', profileId: profile.id, target: plan.schema, detail: `plan ${plan.id} sha ${plan.sha256.slice(0, 12)} job ${job.id}`, outcome: 'requested' })
  return job
})

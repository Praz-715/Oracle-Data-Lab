import { z } from 'zod'
import type { AssessmentDiff, AssessmentSection, AssessmentSnapshotMeta } from '../../shared/types/lab'
import { diffAssessments, snapshotSummary } from '../assessment/diff'
import type { AssessmentSectionId } from './assessment'
import { fullAssessment } from './assessment'
import { getProfile } from './profiles'

// Assessment history: a snapshot stores the full assessment (all sections) so any two snapshots —
// of the same database over time, or of different databases — can be compared later. Metadata is
// kept under a separate key so listing and trend charts never load the full data.

type Data = Record<AssessmentSectionId, AssessmentSection>
interface Stored {
  meta: AssessmentSnapshotMeta
  data: Data
}

const dataKey = (id: string) => `assessment-snap:${id}`
const metaKey = (id: string) => `assessment-snapmeta:${id}`

export const snapshotCreateSchema = z.object({
  profileId: z.string().min(1),
  label: z.string().trim().max(120).default(''),
})

export async function saveSnapshot(input: z.infer<typeof snapshotCreateSchema>): Promise<AssessmentSnapshotMeta> {
  const profile = await getProfile(input.profileId)
  const data = await fullAssessment(profile.id)
  const meta: AssessmentSnapshotMeta = { id: newId(), profileId: profile.id, profileName: profile.name, label: input.label, createdAt: nowIso(), ...snapshotSummary(data) }
  await labStore().setItem(dataKey(meta.id), { meta, data } satisfies Stored)
  await labStore().setItem(metaKey(meta.id), meta)
  await audit({ action: 'assessment.snapshot.saved', profileId: profile.id, target: meta.dbName ?? profile.name, detail: input.label || meta.id, outcome: 'ok' })
  return meta
}

export async function listSnapshots(profileId?: string): Promise<AssessmentSnapshotMeta[]> {
  const store = labStore()
  const keys = await store.getKeys('assessment-snapmeta')
  const metas = (await Promise.all(keys.map((k) => store.getItem<AssessmentSnapshotMeta>(k)))).filter((m): m is AssessmentSnapshotMeta => !!m)
  return metas.filter((m) => !profileId || m.profileId === profileId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getSnapshot(id: string): Promise<Stored> {
  const s = await labStore().getItem<Stored>(dataKey(id))
  if (!s) throw createError({ statusCode: 404, statusMessage: 'Assessment snapshot not found' })
  return s
}

export async function deleteSnapshot(id: string) {
  const s = await getSnapshot(id)
  await labStore().removeItem(dataKey(id))
  await labStore().removeItem(metaKey(id))
  await audit({ action: 'assessment.snapshot.deleted', profileId: s.meta.profileId, target: s.meta.dbName ?? s.meta.profileName, detail: s.meta.label || id, outcome: 'ok' })
}

export async function compareSnapshots(aId: string, bId: string): Promise<AssessmentDiff> {
  if (aId === bId) throw createError({ statusCode: 400, statusMessage: 'Pick two different snapshots.' })
  const [a, b] = await Promise.all([getSnapshot(aId), getSnapshot(bId)])
  return diffAssessments(a.data, b.data, a.meta, b.meta)
}

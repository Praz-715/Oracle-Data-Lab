import { saveSnapshot, snapshotCreateSchema } from '../../services/assessment-history'

export default defineEventHandler(async (event) => saveSnapshot(await readBodyAs(event, snapshotCreateSchema)))

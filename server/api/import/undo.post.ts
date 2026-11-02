import { startUndo, undoRequestSchema } from '../../services/importer'

export default defineEventHandler(async (event) => startUndo(await readBodyAs(event, undoRequestSchema)))

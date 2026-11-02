import { uploadSource } from '../../services/datasets'

// Raw-body upload (the file is the request body, its name in x-file-name), streamed to disk.
export default defineEventHandler((event) => uploadSource(event))

import type { DataSource } from '~~/shared/types/lab'

/**
 * Uploads a CSV/XLSX file as the raw request body (streamed to disk server-side). Uses XHR because
 * fetch() cannot report upload progress.
 */
export function useUpload() {
  const progress = ref<number | null>(null)
  const uploading = ref(false)
  const { push } = useToasts()

  function upload(file: File): Promise<DataSource | null> {
    uploading.value = true
    progress.value = 0
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/datasets/upload')
      xhr.setRequestHeader('x-odl-client', '1')
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name))
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) progress.value = e.loaded / e.total
      }
      const done = (src: DataSource | null) => {
        uploading.value = false
        progress.value = null
        resolve(src)
      }
      xhr.onload = () => {
        let body: any
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          body = null
        }
        if (xhr.status >= 200 && xhr.status < 300 && body?.id) {
          push({ tone: 'ok', title: 'File uploaded', detail: `${body.name} · ${fmtBytes(body.sizeBytes)}` })
          done(body as DataSource)
        } else {
          push({ tone: 'bad', title: 'Upload failed', detail: body?.statusMessage || body?.message || `HTTP ${xhr.status}` })
          done(null)
        }
      }
      xhr.onerror = () => {
        push({ tone: 'bad', title: 'Upload failed', detail: 'Network error' })
        done(null)
      }
      xhr.send(file)
    })
  }

  return { upload, progress, uploading }
}

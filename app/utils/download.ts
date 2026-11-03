/** Downloads a server-generated file (uses the filename from Content-Disposition); throws with the API message on error. */
export async function downloadFile(url: string, fallbackName: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.statusMessage || body?.message || `HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  return name
}

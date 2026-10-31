// Basic hardening for the API: state-changing requests must carry a custom header, which a
// cross-site form or simple fetch cannot send without a CORS preflight (this app allows none).
export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/')) return
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  const method = event.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  if (getHeader(event, 'x-odl-client') !== '1') {
    throw createError({ statusCode: 403, statusMessage: 'Missing x-odl-client header' })
  }
})

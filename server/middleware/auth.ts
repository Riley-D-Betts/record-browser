/**
 * Everything under /api requires a session, except logging in and framework internals.
 *
 * Applied as middleware rather than per-handler so a new catalog endpoint is protected
 * by default — the failure mode of the opposite arrangement is an unauthenticated route
 * nobody notices.
 *
 * The `/api/_` exemption is load-bearing, not cosmetic. Nuxt puts its own endpoints
 * there (`_auth` for the session itself, `_nuxt_icon` for icon data), and guarding them
 * actively breaks login: `requireUserSession` on a request with no cookie seals a fresh
 * empty session and sends it back, so one unauthenticated internal request racing the
 * login response overwrites the just-issued cookie and silently signs the user out.
 */
const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/logout', '/api/_health']

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return
  if (path.startsWith('/api/_')) return
  if (PUBLIC_PATHS.includes(path)) return

  await requireUserSession(event)
})

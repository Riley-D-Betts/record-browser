import type { H3Event } from 'h3'
import { EDITOR_ROLES } from '../../shared/constants'
import type { UserRole } from '../../shared/constants'

/**
 * Session-derived actor for the current request.
 *
 * Everything that writes to the catalog goes through here, so `createdBy`,
 * `updatedBy` and the audit trail can only ever be attributed to the logged-in user.
 */
export async function requireActor(event: H3Event) {
  const { user } = await requireUserSession(event)
  return user as { id: string; email: string; name: string; role: UserRole }
}

/** Guards every mutating handler. Viewers may read and export, nothing more. */
export async function requireEditor(event: H3Event) {
  const actor = await requireActor(event)
  if (!EDITOR_ROLES.includes(actor.role)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Your account has read-only access to the catalog',
    })
  }
  return actor
}

export async function requireAdmin(event: H3Event) {
  const actor = await requireActor(event)
  if (actor.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Administrators only' })
  }
  return actor
}

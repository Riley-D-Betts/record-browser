import { EDITOR_ROLES } from '#shared/constants'

/**
 * Whether the signed-in user may change the catalog.
 *
 * Mirrors requireEditor() on the server. This only hides controls — the server is
 * still the thing enforcing it, so a viewer who forges a request gets a 403 rather
 * than a write.
 */
export function useCanEdit() {
  const { user } = useUserSession()
  return computed(() => Boolean(user.value && EDITOR_ROLES.includes(user.value.role)))
}

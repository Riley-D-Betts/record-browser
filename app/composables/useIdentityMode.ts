import type { IdentityMode } from '#shared/constants'

/**
 * Which of the three identities the whole app is currently showing.
 *
 * The tool exists partly because names and IDs get conflated, so this is deliberately
 * global rather than per-table: you switch once and every record, field, node and
 * report row answers in the same vocabulary.
 *
 * Persisted in a cookie so it survives reloads — a preference this pervasive being
 * reset on every visit would be a papercut.
 */
export function useIdentityMode() {
  const cookie = useCookie<IdentityMode>('identity-mode', {
    default: () => 'label',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  })

  const mode = useState<IdentityMode>('identity-mode', () => cookie.value ?? 'label')

  watch(mode, (value) => {
    cookie.value = value
  })

  return mode
}

export interface Identifiable {
  apiName?: string | null
  label?: string | null
  externalId?: string | null
}

/**
 * Resolve an entity's display text for the current mode.
 *
 * Falls back rather than rendering nothing: a record with no source ID still has to
 * appear in the list. `isFallback` lets the UI mark those, which doubles as a
 * data-quality nudge — the gaps become visible exactly when you switch to that mode.
 */
export function resolveIdentity(
  entity: Identifiable | null | undefined,
  mode: IdentityMode,
): { text: string; isFallback: boolean; isIdentifier: boolean } {
  if (!entity) return { text: '—', isFallback: true, isIdentifier: false }

  const preferred =
    mode === 'label' ? entity.label : mode === 'api' ? entity.apiName : entity.externalId

  if (preferred) {
    return { text: preferred, isFallback: false, isIdentifier: mode !== 'label' }
  }

  const fallback = entity.label || entity.apiName || entity.externalId
  return {
    text: fallback || '—',
    isFallback: true,
    isIdentifier: !entity.label && Boolean(entity.apiName || entity.externalId),
  }
}

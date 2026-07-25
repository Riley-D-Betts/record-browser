<script setup lang="ts">
import { IDENTITY_MODE_LABELS } from '#shared/constants'
import type { Identifiable } from '~/composables/useIdentityMode'

/**
 * The single place the identity toggle is honoured.
 *
 * Nothing in the app renders a raw `.label` or `.apiName` directly — if it did, that
 * spot would silently ignore the toggle and the guarantee would be worthless. The
 * tooltip always shows all three, so the other two identities are one hover away
 * without switching modes.
 */
const props = withDefaults(
  defineProps<{
    entity: Identifiable | null | undefined
    /** Prefix with the owning record, for fields shown outside their record's page. */
    prefix?: Identifiable | null
    bold?: boolean
    muted?: boolean
  }>(),
  { prefix: null, bold: false, muted: false },
)

const mode = useIdentityMode()
const resolved = computed(() => resolveIdentity(props.entity, mode.value))
const resolvedPrefix = computed(() =>
  props.prefix ? resolveIdentity(props.prefix, mode.value) : null,
)

const tooltip = computed(() => {
  const e = props.entity
  if (!e) return ''
  return [
    `${IDENTITY_MODE_LABELS.label}: ${e.label || '—'}`,
    `${IDENTITY_MODE_LABELS.api}: ${e.apiName || '—'}`,
    `${IDENTITY_MODE_LABELS.external}: ${e.externalId || 'not recorded'}`,
  ].join('\n')
})
</script>

<template>
  <span :title="tooltip" class="inline-flex items-baseline gap-1 min-w-0">
    <span
      v-if="resolvedPrefix"
      class="text-dimmed shrink-0"
      :class="resolvedPrefix.isIdentifier && 'identifier'"
    >{{ resolvedPrefix.text }}<span class="text-muted">.</span></span>
    <span
      class="truncate"
      :class="[
        resolved.isIdentifier && 'identifier',
        bold && 'font-medium',
        muted && 'text-muted',
        // A fallback means the requested identity is missing on this entity. Showing
        // it dimmed makes the gap visible the moment you switch to that mode.
        resolved.isFallback && mode !== 'label' && 'text-dimmed italic',
      ]"
    >{{ resolved.text }}</span>
  </span>
</template>

<script setup lang="ts">
import { SOURCE_KIND_DESCRIPTIONS, SOURCE_KIND_LABELS } from '#shared/constants'
import type { SourceKind } from '#shared/constants'

const props = defineProps<{
  kind: SourceKind
  /** A user_entry field an integration writes is not really a person typing it. */
  externallyPopulated?: boolean
}>()

const display = computed(() => {
  if (props.kind === 'user_entry' && props.externallyPopulated) {
    return {
      label: 'External',
      icon: 'i-lucide-plug',
      color: 'warning' as const,
      title:
        'Written by an integration or job, not by a person. Lineage treats this as an external origin.',
    }
  }
  return {
    user_entry: {
      label: SOURCE_KIND_LABELS.user_entry,
      icon: 'i-lucide-keyboard',
      color: 'neutral' as const,
      title: SOURCE_KIND_DESCRIPTIONS.user_entry,
    },
    reference: {
      label: SOURCE_KIND_LABELS.reference,
      icon: 'i-lucide-arrow-right-left',
      color: 'info' as const,
      title: SOURCE_KIND_DESCRIPTIONS.reference,
    },
    derived: {
      label: SOURCE_KIND_LABELS.derived,
      icon: 'i-lucide-function-square',
      color: 'primary' as const,
      title: SOURCE_KIND_DESCRIPTIONS.derived,
    },
  }[props.kind]
})
</script>

<template>
  <UBadge
    :color="display.color"
    variant="subtle"
    :icon="display.icon"
    :label="display.label"
    :title="display.title"
    size="sm"
  />
</template>

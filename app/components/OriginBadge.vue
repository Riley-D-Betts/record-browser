<script setup lang="ts">
import type { Origin } from '#shared/constants'

defineProps<{ origin: Origin }>()
</script>

<template>
  <UBadge
    :color="origin === 'native' ? 'neutral' : 'success'"
    variant="subtle"
    size="sm"
    :label="origin === 'native' ? 'Native' : 'Custom'"
    :title="
      origin === 'native'
        ? 'Shipped with the product — changing it is usually not an option'
        : 'Added by the team — safe to change, and yours to maintain'
    "
  />
</template>

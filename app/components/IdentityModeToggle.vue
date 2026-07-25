<script setup lang="ts">
import { IDENTITY_MODES, IDENTITY_MODE_LABELS } from '#shared/constants'

const mode = useIdentityMode()

const items = IDENTITY_MODES.map((value) => ({
  value,
  label: { label: 'Label', api: 'Name', external: 'ID' }[value],
  title: IDENTITY_MODE_LABELS[value],
}))
</script>

<template>
  <div
    class="inline-flex items-center rounded-md bg-elevated p-0.5 ring ring-accented"
    role="radiogroup"
    aria-label="Which identifier to display"
  >
    <button
      v-for="item in items"
      :key="item.value"
      type="button"
      role="radio"
      :aria-checked="mode === item.value"
      :title="item.title"
      class="rounded px-2 py-1 text-xs font-medium transition-colors"
      :class="
        mode === item.value
          ? 'bg-default text-highlighted shadow-sm'
          : 'text-muted hover:text-default'
      "
      @click="mode = item.value"
    >
      {{ item.label }}
    </button>
  </div>
</template>

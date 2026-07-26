<script setup lang="ts">
import { FIXED_LISTS } from '#shared/lists'

/**
 * Everything the catalog offers as a choice, in one place.
 *
 * Both halves are here on purpose. Showing only the editable lists would leave someone
 * hunting for cardinality or the native/custom split, finding nothing, and concluding
 * the page was unfinished. Each closed list is listed with the reason it is closed —
 * which is a shorter conversation than the one that starts "why can't I edit this?".
 */
useHead({ title: 'Settings' })

const canEdit = useCanEdit()
const { lists, refresh: refreshLists } = useLists()

/** A list edit changes what every dropdown offers, so refetch the lot. */
async function onChanged() {
  await refreshLists()
  await refreshNuxtData(['data-types', 'modules'])
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Settings</h1>
      <p class="mt-1 max-w-3xl text-sm text-muted">
        The choices behind every dropdown in the catalog. Your source system's
        vocabulary is not ours to decide in advance, so anything that is only ever a
        label is yours to change.
      </p>
    </div>

    <UAlert
      v-if="!canEdit"
      color="info"
      variant="subtle"
      icon="i-lucide-eye"
      title="Read-only"
      description="Your account can see these lists but not change them."
    />

    <SettingsDataTypeEditor @changed="onChanged" />

    <SettingsModuleEditor @changed="onChanged" />

    <SettingsListEditor
      v-for="list in lists ?? []"
      :key="list.key"
      :list="list"
      @changed="onChanged"
    />

    <section class="rounded-lg border border-default">
      <header class="border-b border-default px-4 py-3">
        <h3 class="font-medium text-highlighted">Not editable, and why</h3>
        <p class="mt-0.5 max-w-3xl text-sm text-muted">
          These look like lists but are the shape of the model. Adding a member would
          give the code a value it has no meaning for, so they are shown here rather
          than left out for someone to go looking for.
        </p>
      </header>
      <div class="divide-y divide-default">
        <div v-for="list in FIXED_LISTS" :key="list.key" class="px-4 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="text-sm font-medium">{{ list.title }}</h4>
            <UBadge
              v-for="m in list.members"
              :key="m.key"
              :label="m.label"
              color="neutral"
              variant="subtle"
              size="sm"
            />
          </div>
          <p class="mt-1.5 max-w-3xl text-xs text-muted">{{ list.reason }}</p>
        </div>
      </div>
    </section>
  </div>
</template>

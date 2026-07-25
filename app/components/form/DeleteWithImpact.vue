<script setup lang="ts">
/**
 * Delete a record or field, showing what it would break.
 *
 * The server refuses with 409 and the list of dependents when something else sources
 * from the target. That list is the whole point of the constraint — surfacing it here
 * is what turns "computer says no" into a decision the user can actually make.
 *
 * Forcing is offered afterwards, and is honest about the consequence: the dependent
 * fields keep their source kind but lose their upstream, which the integrity report
 * then flags rather than the breakage going unrecorded.
 */
const props = defineProps<{
  /** e.g. `/api/fields/abc` */
  endpoint: string
  entityLabel: string
  entityKind: 'record' | 'field'
  redirectTo?: string
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ deleted: [] }>()

const toast = useToast()
const deleting = ref(false)
const blockers = ref<Array<Record<string, any>>>([])
const error = ref('')

watch(open, (isOpen) => {
  if (isOpen) {
    blockers.value = []
    error.value = ''
  }
})

async function remove(force = false) {
  deleting.value = true
  error.value = ''
  try {
    await $fetch(`${props.endpoint}${force ? '?force=1' : ''}`, { method: 'DELETE' })
    toast.add({
      title: `${props.entityKind === 'record' ? 'Record' : 'Field'} deleted`,
      description: force
        ? 'Dependent fields kept their source kind but lost their upstream — they now show in the broken-provenance report.'
        : undefined,
      color: 'success',
    })
    open.value = false
    emit('deleted')
    if (props.redirectTo) await navigateTo(props.redirectTo)
  } catch (e: any) {
    if (e?.statusCode === 409 || e?.data?.statusCode === 409) {
      blockers.value = e?.data?.data?.dependents ?? []
      error.value = e?.data?.statusMessage ?? 'Something depends on this'
    } else {
      error.value = e?.data?.statusMessage ?? e?.message ?? 'Could not delete'
    }
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Delete this?">
    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-default">
          <strong class="text-highlighted">{{ entityLabel }}</strong> will be removed
          from the catalog.
          <template v-if="entityKind === 'record'">
            Its fields and their relationships go with it.
          </template>
        </p>

        <p class="text-sm text-muted">
          If you only want to retire it, marking it deprecated keeps the history
          instead.
        </p>

        <template v-if="blockers.length">
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="`${blockers.length} field${blockers.length === 1 ? '' : 's'} depend${blockers.length === 1 ? 's' : ''} on this`"
            description="Deleting anyway leaves them with a broken source. They keep their source kind but lose their upstream, and will appear in the broken-provenance report."
          />

          <ul class="max-h-48 divide-y divide-default overflow-y-auto rounded-lg border border-default text-sm">
            <li
              v-for="dep in blockers"
              :key="dep.fieldId"
              class="flex items-center justify-between gap-2 px-3 py-2"
            >
              <NuxtLink :to="`/fields/${dep.fieldId}`" class="hover:underline">
                <EntityName
                  :entity="{
                    apiName: dep.fieldApiName,
                    label: dep.fieldLabel,
                    externalId: null,
                  }"
                  :prefix="{ apiName: dep.recordApiName, label: null, externalId: null }"
                />
              </NuxtLink>
              <UBadge :label="dep.kind" color="neutral" variant="subtle" size="sm" />
            </li>
          </ul>
        </template>

        <UAlert
          v-else-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="error"
        />

        <div class="flex justify-end gap-2 border-t border-default pt-4">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
          <UButton
            v-if="blockers.length"
            color="error"
            :loading="deleting"
            label="Delete anyway"
            @click="remove(true)"
          />
          <UButton
            v-else
            color="error"
            :loading="deleting"
            label="Delete"
            @click="remove(false)"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>

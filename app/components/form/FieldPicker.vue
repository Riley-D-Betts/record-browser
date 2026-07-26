<script setup lang="ts">
import type { FieldDetailResponse } from '~~/server/api/fields/[id].get'

/**
 * Choose a field from anywhere in the catalog.
 *
 * Searches server-side rather than loading every field up front — a catalog large
 * enough to need this tool is large enough that shipping all its fields to the client
 * to filter locally would be the wrong trade.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string | null
    /** Usually the field being edited: nothing may source from itself. */
    excludeFieldId?: string | null
    /** Already-chosen fields, hidden from results so they cannot be added twice. */
    excludeFieldIds?: string[]
    placeholder?: string
  }>(),
  { excludeFieldId: null, excludeFieldIds: () => [], placeholder: 'Search for a field…' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>()

const open = ref(false)
const search = ref('')
const debounced = refDebounced(search, 200)

const { data: results, status } = await useFetch('/api/fields', {
  query: computed(() => ({ q: debounced.value || undefined, perPage: 25 })),
  immediate: false,
  watch: [debounced],
})

const excluded = computed(
  () => new Set([props.excludeFieldId, ...props.excludeFieldIds].filter(Boolean) as string[]),
)

const visible = computed(() =>
  (results.value?.rows ?? []).filter((row) => !excluded.value.has(row.id)),
)

const { data: selected } = await useFetch<FieldDetailResponse>(
  () => (props.modelValue ? `/api/fields/${props.modelValue}` : ''),
  { immediate: Boolean(props.modelValue), watch: [() => props.modelValue] },
)

function choose(id: string) {
  emit('update:modelValue', id)
  open.value = false
  search.value = ''
}
</script>

<template>
  <div>
    <div v-if="modelValue && selected" class="flex items-center gap-2">
      <div class="min-w-0 flex-1 rounded-md border border-default px-3 py-2 text-sm">
        <EntityName
          :entity="selected"
          :prefix="{
            apiName: selected.recordApiName,
            label: selected.recordLabel,
            externalId: null,
          }"
        />
      </div>
      <UButton
        icon="i-lucide-pencil"
        color="neutral"
        variant="ghost"
        size="sm"
        title="Choose a different field"
        @click="open = true"
      />
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="sm"
        title="Clear"
        @click="emit('update:modelValue', null)"
      />
    </div>

    <UButton
      v-else
      icon="i-lucide-search"
      color="neutral"
      variant="outline"
      block
      class="justify-start"
      :label="placeholder"
      @click="open = true"
    />

    <UModal v-model:open="open" title="Choose a field">
      <template #body>
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Search by name, label or source ID…"
          autofocus
          class="w-full"
        />

        <div class="mt-3 max-h-80 overflow-y-auto">
          <p
            v-if="!search"
            class="px-1 py-8 text-center text-sm text-muted"
          >
            Start typing to find a field.
          </p>
          <p
            v-else-if="status !== 'pending' && visible.length === 0"
            class="px-1 py-8 text-center text-sm text-muted"
          >
            Nothing matches “{{ search }}”.
          </p>
          <button
            v-for="row in visible"
            :key="row.id"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-elevated"
            @click="choose(row.id)"
          >
            <div class="min-w-0 flex-1">
              <EntityName
                :entity="row"
                :prefix="{
                  apiName: row.recordApiName,
                  label: row.recordLabel,
                  externalId: null,
                }"
              />
              <div class="text-xs text-dimmed">{{ row.dataTypeLabel ?? 'no type' }}</div>
            </div>
            <SourceKindBadge
              :kind="row.sourceKind"
              :externally-populated="row.isExternallyPopulated"
            />
          </button>
        </div>
      </template>
    </UModal>
  </div>
</template>

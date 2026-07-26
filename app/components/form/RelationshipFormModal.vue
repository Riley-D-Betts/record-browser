<script setup lang="ts">
import { CARDINALITIES, CARDINALITY_LABELS, DELETE_BEHAVIORS } from '#shared/constants'
import type { RecordDetailResponse } from '~~/server/api/records/[id].get'

/**
 * Create or edit a parent-child relationship.
 *
 * The linking field must live on the child — the child is what points at the parent.
 * The picker is scoped to the child's fields so the invalid choice cannot be made,
 * rather than being made and then rejected.
 */
const props = defineProps<{
  /** The record this was opened from; pre-selected on either side. */
  contextRecordId: string
  relationship?: Record<string, any> | null
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const toast = useToast()
const { data: records } = await useFetch('/api/records', { query: { perPage: 200 } })

const NO_FIELD = 'none'

const blank = () => ({
  parentRecordId: props.contextRecordId,
  childRecordId: '',
  viaFieldId: NO_FIELD,
  cardinality: 'one_to_many' as (typeof CARDINALITIES)[number],
  isIdentifying: false,
  onDelete: 'none' as (typeof DELETE_BEHAVIORS)[number],
  label: '',
  description: '',
})

const form = ref(blank())
const saving = ref(false)
const error = ref('')

const isEdit = computed(() => Boolean(props.relationship?.id))

// Keyed on `open` alone — see the note in FieldFormModal.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    error.value = ''
    const r = props.relationship
    form.value = r
      ? {
          parentRecordId: r.parentRecordId,
          childRecordId: r.childRecordId,
          viaFieldId: r.viaFieldId ?? NO_FIELD,
          cardinality: r.cardinality,
          isIdentifying: Boolean(r.isIdentifying),
          onDelete: r.onDelete ?? 'none',
          label: r.label ?? '',
          description: r.description ?? '',
        }
      : blank()
  },
  { immediate: true },
)

const recordOptions = computed(() =>
  (records.value?.rows ?? []).map((r) => ({ label: `${r.label} (${r.apiName})`, value: r.id })),
)

// Only the child's own fields can implement the link.
const { data: childFields } = await useFetch<RecordDetailResponse>(
  () => (form.value.childRecordId ? `/api/records/${form.value.childRecordId}` : ''),
  { immediate: false, watch: [() => form.value.childRecordId] },
)

const viaOptions = computed(() => [
  { label: 'Not recorded', value: NO_FIELD },
  ...(childFields.value?.fields ?? []).map((f: any) => ({
    label: `${f.label} (${f.apiName})`,
    value: f.id,
  })),
])

// Changing the child invalidates a linking field chosen from the previous one.
watch(
  () => form.value.childRecordId,
  () => {
    if (!isEdit.value) form.value.viaFieldId = NO_FIELD
  },
)

const cardinalityOptions = CARDINALITIES.map((c) => ({
  label: `${CARDINALITY_LABELS[c]} — ${c.replace(/_/g, ' ')}`,
  value: c,
}))
const deleteOptions = DELETE_BEHAVIORS.map((d) => ({
  label: { cascade: 'Cascade', restrict: 'Restrict', set_null: 'Set null', none: 'Not specified' }[d],
  value: d,
}))

async function submit() {
  saving.value = true
  error.value = ''

  const body = {
    parentRecordId: form.value.parentRecordId,
    childRecordId: form.value.childRecordId,
    viaFieldId: form.value.viaFieldId === NO_FIELD ? null : form.value.viaFieldId,
    cardinality: form.value.cardinality,
    isIdentifying: form.value.isIdentifying,
    onDelete: form.value.onDelete,
    label: form.value.label.trim() || null,
    description: form.value.description.trim() || null,
  }

  try {
    if (props.relationship?.id) {
      await $fetch(`/api/relationships/${props.relationship.id}`, { method: 'PATCH', body })
    } else {
      await $fetch('/api/relationships', { method: 'POST', body })
    }
    toast.add({ title: isEdit.value ? 'Relationship updated' : 'Relationship added', color: 'success' })
    open.value = false
    emit('saved')
  } catch (e: any) {
    const issues = e?.data?.data?.issues ?? e?.data?.issues
    error.value =
      Array.isArray(issues) && issues.length > 0
        ? issues.map((i: any) => i.message).join(' ')
        : (e?.data?.statusMessage ?? e?.message ?? 'Could not save')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit relationship' : 'Add relationship'"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <form class="space-y-4" @submit.prevent="submit">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Parent" help="The 'one' side." required>
            <USelect v-model="form.parentRecordId" :items="recordOptions" class="w-full" />
          </UFormField>

          <UFormField label="Child" help="The side that points at the parent." required>
            <USelect v-model="form.childRecordId" :items="recordOptions" class="w-full" />
          </UFormField>
        </div>

        <UFormField
          label="Linking field"
          help="The field on the child that holds the reference. Only the child's own fields are offered."
        >
          <USelect
            v-model="form.viaFieldId"
            :items="viaOptions"
            :disabled="!form.childRecordId"
            class="w-full"
          />
        </UFormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Cardinality">
            <USelect v-model="form.cardinality" :items="cardinalityOptions" class="w-full" />
          </UFormField>

          <UFormField label="On delete" help="What the source system does to children.">
            <USelect v-model="form.onDelete" :items="deleteOptions" class="w-full" />
          </UFormField>
        </div>

        <UCheckbox
          v-model="form.isIdentifying"
          label="Identifying"
          help="The child cannot exist without its parent."
        />

        <UFormField label="Label" help="How people describe it, e.g. 'Order has many lines'.">
          <UInput v-model="form.label" class="w-full" />
        </UFormField>

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="error"
        />

        <div class="flex justify-end gap-2 border-t border-default pt-4">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
          <UButton
            type="submit"
            :loading="saving"
            :disabled="!form.parentRecordId || !form.childRecordId"
            :label="isEdit ? 'Save changes' : 'Add relationship'"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>

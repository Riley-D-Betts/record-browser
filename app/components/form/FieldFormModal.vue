<script setup lang="ts">
import { ORIGINS, ORIGIN_LABELS } from '#shared/constants'
import type { FieldSourceInput } from '#shared/schemas'

const props = defineProps<{
  /** Required when creating. */
  recordId: string
  /** Omit to create. */
  field?: Record<string, any> | null
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [field: any] }>()

const toast = useToast()
const { data: dataTypes } = await useFetch('/api/data-types')

const NO_TYPE = 'none'

const blankSource = (): FieldSourceInput => ({
  sourceKind: 'user_entry',
  isExternallyPopulated: false,
  sourceNotes: null,
})

const blank = () => ({
  apiName: '',
  label: '',
  externalId: '',
  dataTypeId: NO_TYPE,
  origin: 'custom' as (typeof ORIGINS)[number],
  isRequired: false,
  isUnique: false,
  isPrimaryKey: false,
  isDeprecated: false,
  description: '',
  length: '',
  precision: '',
  scale: '',
  options: '',
})

const form = ref(blank())
const source = ref<FieldSourceInput>(blankSource())
const saving = ref(false)
const error = ref('')
const fieldErrors = ref<Record<string, string>>({})
const apiNameTouched = ref(false)

const isEdit = computed(() => Boolean(props.field?.id))

/**
 * Keyed on `open` alone, deliberately.
 *
 * Watching props.field too would reset the form every time that object changed
 * identity — and a background refetch anywhere in the app does exactly that, so a
 * half-filled form would silently revert while someone was typing into it.
 */
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    error.value = ''
    fieldErrors.value = {}
    apiNameTouched.value = false

    const f = props.field
    const detail = f?.typeDetail
      ? typeof f.typeDetail === 'string'
        ? JSON.parse(f.typeDetail)
        : f.typeDetail
      : {}

    form.value = f
      ? {
          apiName: f.apiName ?? '',
          label: f.label ?? '',
          externalId: f.externalId ?? '',
          dataTypeId: f.dataTypeId ?? NO_TYPE,
          origin: f.origin ?? 'custom',
          isRequired: Boolean(f.isRequired),
          isUnique: Boolean(f.isUnique),
          isPrimaryKey: Boolean(f.isPrimaryKey),
          isDeprecated: Boolean(f.isDeprecated),
          description: f.description ?? '',
          length: detail.length != null ? String(detail.length) : '',
          precision: detail.precision != null ? String(detail.precision) : '',
          scale: detail.scale != null ? String(detail.scale) : '',
          options: Array.isArray(detail.options) ? detail.options.join('\n') : '',
        }
      : blank()

    // Rebuild the source union from the flat columns the API returns.
    if (!f) {
      source.value = blankSource()
    } else if (f.sourceKind === 'reference') {
      source.value = {
        sourceKind: 'reference',
        sourceFieldId: f.upstream?.[0]?.fieldId ?? '',
        sourceNotes: f.sourceNotes ?? null,
      }
    } else if (f.sourceKind === 'derived') {
      source.value = {
        sourceKind: 'derived',
        sourceExpression: f.sourceExpression ?? '',
        derivationLanguage: f.derivationLanguage ?? null,
        dependsOn: (f.upstream ?? []).map((u: any) => u.fieldId),
        sourceNotes: f.sourceNotes ?? null,
      }
    } else {
      source.value = {
        sourceKind: 'user_entry',
        isExternallyPopulated: Boolean(f.isExternallyPopulated),
        sourceNotes: f.sourceNotes ?? null,
      }
    }
  },
  { immediate: true },
)

watch(
  () => form.value.label,
  (label) => {
    if (isEdit.value || apiNameTouched.value) return
    form.value.apiName = label
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_{2,}/g, '_')
  },
)

const typeOptions = computed(() => [
  { label: 'No type set', value: NO_TYPE },
  ...(dataTypes.value ?? []).map((t) => ({ label: t.label, value: t.id })),
])
const originOptions = ORIGINS.map((o) => ({ label: ORIGIN_LABELS[o], value: o }))

/**
 * Which detail inputs to show is driven by the chosen type's own flags, not a
 * hardcoded switch — that is what makes the type catalog genuinely extensible: a
 * user adding a type declares what it takes, and this form adapts with no code change.
 */
const selectedType = computed(() =>
  (dataTypes.value ?? []).find((t) => t.id === form.value.dataTypeId),
)

async function submit() {
  saving.value = true
  error.value = ''
  fieldErrors.value = {}

  const detail: Record<string, unknown> = {}
  if (selectedType.value?.supportsLength && form.value.length) {
    detail.length = Number(form.value.length)
  }
  if (selectedType.value?.supportsPrecision && form.value.precision) {
    detail.precision = Number(form.value.precision)
  }
  if (selectedType.value?.supportsScale && form.value.scale) {
    detail.scale = Number(form.value.scale)
  }
  if (selectedType.value?.supportsOptions && form.value.options.trim()) {
    detail.options = form.value.options
      .split('\n')
      .map((o) => o.trim())
      .filter(Boolean)
  }

  const body: Record<string, unknown> = {
    apiName: form.value.apiName.trim(),
    label: form.value.label.trim(),
    externalId: form.value.externalId.trim() || null,
    dataTypeId: form.value.dataTypeId === NO_TYPE ? null : form.value.dataTypeId,
    typeDetail: Object.keys(detail).length > 0 ? detail : null,
    origin: form.value.origin,
    isRequired: form.value.isRequired,
    isUnique: form.value.isUnique,
    isPrimaryKey: form.value.isPrimaryKey,
    isDeprecated: form.value.isDeprecated,
    description: form.value.description.trim() || null,
    source: source.value,
  }
  if (!isEdit.value) body.recordId = props.recordId

  try {
    const saved = props.field?.id
      ? await $fetch(`/api/fields/${props.field.id}`, { method: 'PATCH', body })
      : await $fetch('/api/fields', { method: 'POST', body })

    toast.add({ title: isEdit.value ? 'Field updated' : 'Field created', color: 'success' })
    open.value = false
    emit('saved', saved)
  } catch (e: any) {
    const issues = e?.data?.data?.issues ?? e?.data?.issues
    if (Array.isArray(issues) && issues.length > 0) {
      // Paths arrive dotted ("source.sourceExpression"). Top-level ones map onto an
      // input; nested ones belong to the source editor, which has no per-input slot,
      // so they surface in the banner rather than being silently dropped.
      const orphaned: string[] = []
      for (const issue of issues) {
        const path = String(issue.path ?? '')
        if (path && !path.includes('.')) fieldErrors.value[path] = issue.message
        else orphaned.push(issue.message)
      }
      error.value =
        orphaned.length > 0 ? orphaned.join(' ') : 'Some fields need attention.'
    } else {
      // A 422 from the cycle guard carries the offending path — worth showing, since
      // "would create a circular dependency" is meaningless without knowing which loop.
      const cycle = e?.data?.data?.cycle
      error.value =
        (e?.data?.statusMessage ?? e?.message ?? 'Could not save') +
        (Array.isArray(cycle) ? ` (${cycle.length} fields in the loop)` : '')
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit field' : 'New field'"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <form class="space-y-5" @submit.prevent="submit">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Display label" required :error="fieldErrors.label">
            <UInput v-model="form.label" autofocus class="w-full" />
          </UFormField>

          <UFormField label="Technical name" required :error="fieldErrors.apiName">
            <UInput
              v-model="form.apiName"
              class="w-full font-mono text-sm"
              @input="apiNameTouched = true"
            />
          </UFormField>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Source ID" :error="fieldErrors.externalId">
            <UInput v-model="form.externalId" class="w-full font-mono text-sm" />
          </UFormField>

          <UFormField label="Origin">
            <USelect v-model="form.origin" :items="originOptions" class="w-full" />
          </UFormField>
        </div>

        <div>
          <UFormField label="Type">
            <USelect v-model="form.dataTypeId" :items="typeOptions" class="w-full" />
          </UFormField>

          <div
            v-if="
              selectedType?.supportsLength ||
              selectedType?.supportsPrecision ||
              selectedType?.supportsScale ||
              selectedType?.supportsOptions
            "
            class="mt-3 grid gap-3 sm:grid-cols-3"
          >
            <UFormField v-if="selectedType?.supportsLength" label="Length">
              <UInput v-model="form.length" type="number" min="0" class="w-full" />
            </UFormField>
            <UFormField v-if="selectedType?.supportsPrecision" label="Precision">
              <UInput v-model="form.precision" type="number" min="0" class="w-full" />
            </UFormField>
            <UFormField v-if="selectedType?.supportsScale" label="Scale">
              <UInput v-model="form.scale" type="number" min="0" class="w-full" />
            </UFormField>
            <UFormField
              v-if="selectedType?.supportsOptions"
              label="Allowed values"
              help="One per line."
              class="sm:col-span-3"
            >
              <UTextarea v-model="form.options" :rows="3" class="w-full font-mono text-sm" />
            </UFormField>
          </div>
        </div>

        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <UCheckbox v-model="form.isPrimaryKey" label="Primary key" />
          <UCheckbox v-model="form.isRequired" label="Required" />
          <UCheckbox v-model="form.isUnique" label="Unique" />
          <UCheckbox v-model="form.isDeprecated" label="Deprecated" />
        </div>

        <UFormField label="Description" :error="fieldErrors.description">
          <UTextarea v-model="form.description" :rows="2" class="w-full" />
        </UFormField>

        <div class="border-t border-default pt-4">
          <FormFieldSourceEditor v-model="source" :current-field-id="props.field?.id ?? null" />
        </div>

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
            :label="isEdit ? 'Save changes' : 'Create field'"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>

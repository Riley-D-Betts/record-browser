<script setup lang="ts">
import { ORIGINS, ORIGIN_LABELS } from '#shared/constants'

/**
 * Create or edit a record.
 *
 * All three identities are on the form at once — this is where they get reconciled,
 * so hiding two behind the display toggle would defeat the point.
 */
const props = defineProps<{
  /** Omit to create. */
  record?: Record<string, any> | null
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [record: any] }>()

const toast = useToast()
const { data: modules } = await useFetch('/api/modules')

const NO_MODULE = 'none'
const blank = () => ({
  apiName: '',
  label: '',
  externalId: '',
  moduleId: NO_MODULE,
  origin: 'custom' as (typeof ORIGINS)[number],
  description: '',
  isDeprecated: false,
})

const form = ref(blank())
const saving = ref(false)
const error = ref('')
const fieldErrors = ref<Record<string, string>>({})

// Keyed on `open` alone — see the note in FieldFormModal.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    error.value = ''
    fieldErrors.value = {}
    form.value = props.record
      ? {
          apiName: props.record.apiName ?? '',
          label: props.record.label ?? '',
          externalId: props.record.externalId ?? '',
          moduleId: props.record.moduleId ?? NO_MODULE,
          origin: props.record.origin ?? 'custom',
          description: props.record.description ?? '',
          isDeprecated: Boolean(props.record.isDeprecated),
        }
      : blank()
  },
  { immediate: true },
)

const isEdit = computed(() => Boolean(props.record?.id))

const moduleOptions = computed(() => [
  { label: 'No module', value: NO_MODULE },
  ...(modules.value ?? []).map((m) => ({ label: m.name, value: m.id })),
])
const originOptions = ORIGINS.map((o) => ({ label: ORIGIN_LABELS[o], value: o }))

/**
 * Suggest a technical name from the label while creating, but stop the moment the
 * user edits it themselves — silently rewriting a name someone typed is worse than
 * not suggesting at all.
 */
const apiNameTouched = ref(false)
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

async function submit() {
  saving.value = true
  error.value = ''
  fieldErrors.value = {}

  const body = {
    apiName: form.value.apiName.trim(),
    label: form.value.label.trim(),
    externalId: form.value.externalId.trim() || null,
    moduleId: form.value.moduleId === NO_MODULE ? null : form.value.moduleId,
    origin: form.value.origin,
    description: form.value.description.trim() || null,
    isDeprecated: form.value.isDeprecated,
  }

  try {
    const saved = props.record?.id
      ? await $fetch(`/api/records/${props.record.id}`, { method: 'PATCH', body })
      : await $fetch('/api/records', { method: 'POST', body })

    toast.add({
      title: isEdit.value ? 'Record updated' : 'Record created',
      color: 'success',
    })
    open.value = false
    emit('saved', saved)
  } catch (e: any) {
    // Zod issues come back as an array; surface them next to the offending input
    // rather than as one opaque banner.
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
      error.value = e?.data?.statusMessage ?? e?.message ?? 'Could not save'
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit record' : 'New record'"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <form class="space-y-4" @submit.prevent="submit">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            label="Display label"
            help="What people call it."
            required
            :error="fieldErrors.label"
          >
            <UInput v-model="form.label" autofocus class="w-full" />
          </UFormField>

          <UFormField
            label="Technical name"
            help="The identifier used in code."
            required
            :error="fieldErrors.apiName"
          >
            <UInput
              v-model="form.apiName"
              class="w-full font-mono text-sm"
              @input="apiNameTouched = true"
            />
          </UFormField>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            label="Source ID"
            help="The source system's own identifier. Without it a re-import creates a duplicate instead of updating."
            :error="fieldErrors.externalId"
          >
            <UInput v-model="form.externalId" class="w-full font-mono text-sm" />
          </UFormField>

          <UFormField label="Module" help="Grouping — the main lever against an unreadable ERD.">
            <USelect v-model="form.moduleId" :items="moduleOptions" class="w-full" />
          </UFormField>
        </div>

        <UFormField
          label="Origin"
          help="Native means it shipped with the product; custom means your team added it."
        >
          <USelect v-model="form.origin" :items="originOptions" class="w-full" />
        </UFormField>

        <UFormField label="Description" :error="fieldErrors.description">
          <UTextarea v-model="form.description" :rows="3" class="w-full" />
        </UFormField>

        <UCheckbox
          v-model="form.isDeprecated"
          label="Deprecated"
          help="Hidden by default but never deleted — what used to exist is part of what a catalog is for."
        />

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="error"
        />

        <div class="flex justify-end gap-2 border-t border-default pt-4">
          <UButton
            color="neutral"
            variant="ghost"
            label="Cancel"
            @click="open = false"
          />
          <UButton
            type="submit"
            :loading="saving"
            :label="isEdit ? 'Save changes' : 'Create record'"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>

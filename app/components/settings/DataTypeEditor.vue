<script setup lang="ts">
/**
 * Field types — the list behind the "Type" dropdown on every field.
 *
 * Kept apart from the generic list editor because a type is more than a label: the
 * four `supports*` flags decide which detail inputs the field form renders. Without
 * them a type someone adds is an inert word — with them, adding "geo_point" and
 * ticking "precision" makes the form adapt with no code change. That is the whole
 * reason the type catalog is a table rather than a constant.
 */
const emit = defineEmits<{ changed: [] }>()

const canEdit = useCanEdit()
const toast = useToast()
const { options: listOptions } = useLists()

const { data: types, refresh } = await useFetch('/api/data-types', { key: 'data-types' })

const editing = ref<any>(null)
const open = ref(false)
const saving = ref(false)
const error = ref('')
const fieldErrors = ref<Record<string, string>>({})

const blank = () => ({
  key: '',
  label: '',
  category: 'other',
  description: '',
  supportsLength: false,
  supportsPrecision: false,
  supportsScale: false,
  supportsOptions: false,
})
const form = ref(blank())

const isEdit = computed(() => Boolean(editing.value?.id))
const categoryOptions = computed(() => listOptions('data_type_category'))

const keyTouched = ref(false)
watch(
  () => form.value.label,
  (label) => {
    if (isEdit.value || keyTouched.value) return
    form.value.key = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  },
)

function edit(type: any) {
  editing.value = type
  keyTouched.value = true
  error.value = ''
  fieldErrors.value = {}
  form.value = {
    key: type.key,
    label: type.label,
    category: type.category,
    description: type.description ?? '',
    supportsLength: type.supportsLength,
    supportsPrecision: type.supportsPrecision,
    supportsScale: type.supportsScale,
    supportsOptions: type.supportsOptions,
  }
  open.value = true
}

function create() {
  editing.value = null
  keyTouched.value = false
  error.value = ''
  fieldErrors.value = {}
  form.value = blank()
  open.value = true
}

async function submit() {
  saving.value = true
  error.value = ''
  fieldErrors.value = {}

  const body = {
    key: form.value.key.trim(),
    label: form.value.label.trim(),
    category: form.value.category,
    description: form.value.description.trim() || null,
    supportsLength: form.value.supportsLength,
    supportsPrecision: form.value.supportsPrecision,
    supportsScale: form.value.supportsScale,
    supportsOptions: form.value.supportsOptions,
  }

  try {
    if (isEdit.value) {
      await $fetch(`/api/data-types/${editing.value.id}`, { method: 'PATCH', body })
    } else {
      await $fetch('/api/data-types', { method: 'POST', body })
    }
    toast.add({ title: isEdit.value ? 'Field type updated' : 'Field type added', color: 'success' })
    open.value = false
    await refresh()
    emit('changed')
  } catch (e: any) {
    const issues = e?.data?.data?.issues ?? e?.data?.issues
    if (Array.isArray(issues) && issues.length > 0) {
      for (const issue of issues) fieldErrors.value[String(issue.path)] = issue.message
      error.value = 'Some fields need attention.'
    } else {
      error.value = e?.data?.statusMessage ?? e?.message ?? 'Could not save'
    }
  } finally {
    saving.value = false
  }
}

const removing = ref<string | null>(null)

async function remove(type: any) {
  removing.value = type.id
  try {
    await $fetch(`/api/data-types/${type.id}`, { method: 'DELETE' })
    toast.add({ title: `Deleted "${type.label}"`, color: 'success' })
    await refresh()
    emit('changed')
  } catch (e: any) {
    // The server refuses when fields still use the type and names them; that reason is
    // the useful part, so it goes in the toast rather than being flattened to "failed".
    toast.add({
      title: 'Not deleted',
      description: e?.data?.statusMessage ?? e?.message,
      color: 'error',
    })
  } finally {
    removing.value = null
  }
}

/** Grouped so a long catalog stays scannable, in the category list's own order. */
const grouped = computed(() => {
  const order = categoryOptions.value.map((c: any) => c.value)
  const byCategory = new Map<string, any[]>()
  for (const t of types.value ?? []) {
    const list = byCategory.get(t.category) ?? []
    list.push(t)
    byCategory.set(t.category, list)
  }
  return [...byCategory.entries()]
    .sort((a, b) => {
      const ai = order.indexOf(a[0])
      const bi = order.indexOf(b[0])
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
    })
    .map(([category, items]) => ({
      category,
      label: categoryOptions.value.find((c: any) => c.value === category)?.label ?? category,
      items,
    }))
})

const supportSummary = (t: any) =>
  [
    t.supportsLength && 'length',
    t.supportsPrecision && 'precision',
    t.supportsScale && 'scale',
    t.supportsOptions && 'allowed values',
  ]
    .filter(Boolean)
    .join(', ')
</script>

<template>
  <section class="rounded-lg border border-default">
    <header class="flex flex-wrap items-start justify-between gap-2 border-b border-default px-4 py-3">
      <div>
        <h3 class="font-medium text-highlighted">Field types</h3>
        <p class="mt-0.5 text-sm text-muted">
          The list behind the Type dropdown on every field. Ticking a detail box below
          makes the field form offer that input — so a type you add is as usable as one
          that shipped.
        </p>
      </div>
      <UButton
        v-if="canEdit"
        size="xs"
        variant="subtle"
        icon="i-lucide-plus"
        label="Add type"
        @click="create"
      />
    </header>

    <div v-for="group in grouped" :key="group.category">
      <h4
        class="border-b border-default bg-elevated/40 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-dimmed"
      >
        {{ group.label }}
      </h4>
      <ul class="divide-y divide-default">
        <li v-for="t in group.items" :key="t.id" class="flex items-center gap-3 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm">{{ t.label }}</span>
              <UBadge
                v-if="t.isBuiltin"
                label="Built in"
                color="neutral"
                variant="outline"
                size="sm"
              />
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-dimmed">
              <span class="identifier">{{ t.key }}</span>
              <span v-if="t.usageCount > 0">· {{ t.usageCount }} fields</span>
              <span v-if="supportSummary(t)">· takes {{ supportSummary(t) }}</span>
            </div>
          </div>
          <div v-if="canEdit" class="flex shrink-0 items-center gap-0.5">
            <UButton
              icon="i-lucide-pencil"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="edit(t)"
            />
            <UButton
              v-if="!t.isBuiltin"
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              :loading="removing === t.id"
              @click="remove(t)"
            />
          </div>
        </li>
      </ul>
    </div>

    <UModal
      v-model:open="open"
      :title="isEdit ? 'Edit field type' : 'New field type'"
      :ui="{ content: 'max-w-2xl' }"
    >
      <template #body>
        <form class="space-y-4" @submit.prevent="submit">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Label" required :error="fieldErrors.label">
              <UInput v-model="form.label" autofocus class="w-full" />
            </UFormField>
            <UFormField
              label="Stored value"
              required
              :error="fieldErrors.key"
              :help="
                isEdit && editing?.isBuiltin
                  ? 'Fixed — this type ships with the catalog.'
                  : 'What exports and imports use to name this type.'
              "
            >
              <UInput
                v-model="form.key"
                :disabled="isEdit && editing?.isBuiltin"
                class="w-full font-mono text-sm"
                @input="keyTouched = true"
              />
            </UFormField>
          </div>

          <UFormField label="Category" help="Grouping only." :error="fieldErrors.category">
            <USelect v-model="form.category" :items="categoryOptions" class="w-full" />
          </UFormField>

          <UFormField label="Description" :error="fieldErrors.description">
            <UTextarea v-model="form.description" :rows="2" class="w-full" />
          </UFormField>

          <fieldset class="rounded-md border border-default p-3">
            <legend class="px-1 text-sm font-medium">Detail inputs</legend>
            <p class="mb-2 text-xs text-muted">
              Which extra inputs the field form should offer for a field of this type.
            </p>
            <div class="grid gap-2 sm:grid-cols-2">
              <UCheckbox v-model="form.supportsLength" label="Length" />
              <UCheckbox v-model="form.supportsPrecision" label="Precision" />
              <UCheckbox v-model="form.supportsScale" label="Scale" />
              <UCheckbox v-model="form.supportsOptions" label="Allowed values" />
            </div>
          </fieldset>

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
              :label="isEdit ? 'Save changes' : 'Add type'"
            />
          </div>
        </form>
      </template>
    </UModal>
  </section>
</template>

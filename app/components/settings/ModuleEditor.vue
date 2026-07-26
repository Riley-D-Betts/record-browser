<script setup lang="ts">
/**
 * Modules — the grouping behind the Module dropdown, and the main lever against an
 * ERD nobody can read.
 *
 * Deleting one is not destructive: `records.module_id` is `set null`, so the records
 * survive and land in "No module". The count of how many moved comes back from the
 * server and is reported, because a silent regrouping of forty records is exactly the
 * kind of thing someone needs told.
 */
const emit = defineEmits<{ changed: [] }>()

const canEdit = useCanEdit()
const toast = useToast()

const { data: modules, refresh } = await useFetch('/api/modules', { key: 'modules' })

const open = ref(false)
const editing = ref<any>(null)
const saving = ref(false)
const error = ref('')
const fieldErrors = ref<Record<string, string>>({})
const removing = ref<string | null>(null)

const blank = () => ({ key: '', name: '', description: '', color: '#3b82f6' })
const form = ref(blank())
const isEdit = computed(() => Boolean(editing.value?.id))

const keyTouched = ref(false)
watch(
  () => form.value.name,
  (name) => {
    if (isEdit.value || keyTouched.value) return
    form.value.key = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  },
)

function create() {
  editing.value = null
  keyTouched.value = false
  error.value = ''
  fieldErrors.value = {}
  form.value = blank()
  open.value = true
}

function edit(m: any) {
  editing.value = m
  keyTouched.value = true
  error.value = ''
  fieldErrors.value = {}
  form.value = {
    key: m.key,
    name: m.name,
    description: m.description ?? '',
    color: m.color ?? '#3b82f6',
  }
  open.value = true
}

async function submit() {
  saving.value = true
  error.value = ''
  fieldErrors.value = {}

  const body = {
    key: form.value.key.trim(),
    name: form.value.name.trim(),
    description: form.value.description.trim() || null,
    color: form.value.color || null,
  }

  try {
    if (isEdit.value) {
      await $fetch(`/api/modules/${editing.value.id}`, { method: 'PATCH', body })
    } else {
      await $fetch('/api/modules', { method: 'POST', body })
    }
    toast.add({ title: isEdit.value ? 'Module updated' : 'Module created', color: 'success' })
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

async function remove(m: any) {
  removing.value = m.id
  try {
    const result: any = await $fetch(`/api/modules/${m.id}`, { method: 'DELETE' })
    toast.add({
      title: `Deleted "${m.name}"`,
      description:
        result?.recordsUngrouped > 0
          ? `${result.recordsUngrouped} record${result.recordsUngrouped === 1 ? '' : 's'} moved to "No module" — none were deleted.`
          : undefined,
      color: 'success',
    })
    await refresh()
    emit('changed')
  } catch (e: any) {
    toast.add({
      title: 'Not deleted',
      description: e?.data?.statusMessage ?? e?.message,
      color: 'error',
    })
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <section class="rounded-lg border border-default">
    <header class="flex flex-wrap items-start justify-between gap-2 border-b border-default px-4 py-3">
      <div>
        <h3 class="font-medium text-highlighted">Modules</h3>
        <p class="mt-0.5 text-sm text-muted">
          How records are grouped, and what tints them in the ERD. Deleting a module
          moves its records to "No module" rather than deleting them.
        </p>
      </div>
      <UButton
        v-if="canEdit"
        size="xs"
        variant="subtle"
        icon="i-lucide-plus"
        label="Add module"
        @click="create"
      />
    </header>

    <p v-if="!modules?.length" class="px-4 py-6 text-center text-sm text-muted">
      No modules yet. Records will all sit together until there are some.
    </p>

    <ul v-else class="divide-y divide-default">
      <li v-for="m in modules" :key="m.id" class="flex items-center gap-3 px-4 py-2.5">
        <span
          class="size-3 shrink-0 rounded-full border border-default"
          :style="{ backgroundColor: m.color ?? 'transparent' }"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm">{{ m.name }}</div>
          <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-dimmed">
            <span class="identifier">{{ m.key }}</span>
            <span v-if="m.recordCount != null">· {{ m.recordCount }} records</span>
            <span v-if="m.description">· {{ m.description }}</span>
          </div>
        </div>
        <div v-if="canEdit" class="flex shrink-0 items-center gap-0.5">
          <UButton
            icon="i-lucide-pencil"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="edit(m)"
          />
          <UButton
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            size="xs"
            :loading="removing === m.id"
            @click="remove(m)"
          />
        </div>
      </li>
    </ul>

    <UModal
      v-model:open="open"
      :title="isEdit ? 'Edit module' : 'New module'"
      :ui="{ content: 'max-w-xl' }"
    >
      <template #body>
        <form class="space-y-4" @submit.prevent="submit">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Name" required :error="fieldErrors.name">
              <UInput v-model="form.name" autofocus class="w-full" />
            </UFormField>
            <UFormField
              label="Key"
              required
              :error="fieldErrors.key"
              help="Lowercase, hyphens."
            >
              <UInput
                v-model="form.key"
                class="w-full font-mono text-sm"
                @input="keyTouched = true"
              />
            </UFormField>
          </div>

          <UFormField label="Colour" help="Tints this module's nodes in the ERD." :error="fieldErrors.color">
            <div class="flex items-center gap-2">
              <input v-model="form.color" type="color" class="h-9 w-14 rounded border border-default bg-default" >
              <UInput v-model="form.color" class="font-mono text-sm" />
            </div>
          </UFormField>

          <UFormField label="Description" :error="fieldErrors.description">
            <UTextarea v-model="form.description" :rows="2" class="w-full" />
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
              :label="isEdit ? 'Save changes' : 'Create module'"
            />
          </div>
        </form>
      </template>
    </UModal>
  </section>
</template>

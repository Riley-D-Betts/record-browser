<script setup lang="ts">
import { listItemKeySchema } from '#shared/lists'

/**
 * One editable list: its members, in order, with add / rename / hide / delete.
 *
 * The three operations are deliberately not equivalent, and the UI says so rather
 * than making the user find out:
 *
 *   rename  — always fine, the label is presentation
 *   hide    — always fine, and the right answer for a value in use
 *   delete  — only when nothing chose it, because the key is what rows store
 */
const props = defineProps<{ list: any }>()
const emit = defineEmits<{ changed: [] }>()

const canEdit = useCanEdit()
const toast = useToast()

const adding = ref(false)
const draft = ref({ key: '', label: '', description: '' })
const busy = ref<string | null>(null)
const error = ref('')

/** Editing state per item, so a half-typed label is not lost by a refresh. */
const editingId = ref<string | null>(null)
const editDraft = ref({ label: '', description: '' })

const keyTouched = ref(false)
watch(
  () => draft.value.label,
  (label) => {
    if (keyTouched.value) return
    draft.value.key = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  },
)

// `undefined`, not `''` — UFormField treats any non-undefined `error` as an error
// state, so an empty string paints a valid input red with no message to explain it.
const keyProblem = computed(() => {
  if (!draft.value.key) return undefined
  const result = listItemKeySchema.safeParse(draft.value.key)
  return result.success ? undefined : (result.error.issues[0]?.message ?? 'Invalid key')
})

function startAdd() {
  adding.value = true
  keyTouched.value = false
  error.value = ''
  draft.value = { key: '', label: '', description: '' }
}

async function call(path: string, options: any, successTitle: string) {
  busy.value = path
  error.value = ''
  try {
    const result: any = await $fetch(path, options)
    if (result?.hiddenWhileInUse?.count > 0) {
      const { count, noun } = result.hiddenWhileInUse
      toast.add({
        title: successTitle,
        description: `${count} ${noun}${count === 1 ? '' : 's'} still hold this value and are unchanged — it simply cannot be chosen again.`,
        color: 'info',
      })
    } else {
      toast.add({ title: successTitle, color: 'success' })
    }
    emit('changed')
    return true
  } catch (e: any) {
    const issues = e?.data?.data?.issues ?? e?.data?.issues
    error.value = Array.isArray(issues)
      ? issues.map((i: any) => i.message).join(' ')
      : (e?.data?.statusMessage ?? e?.message ?? 'Could not save')
    return false
  } finally {
    busy.value = null
  }
}

async function add() {
  const ok = await call(
    `/api/lists/${props.list.key}`,
    {
      method: 'POST',
      body: {
        key: draft.value.key.trim(),
        label: draft.value.label.trim(),
        description: draft.value.description.trim() || null,
        sortOrder: props.list.items.length,
      },
    },
    `Added "${draft.value.label.trim()}"`,
  )
  if (ok) adding.value = false
}

function startEdit(item: any) {
  editingId.value = item.id
  editDraft.value = { label: item.label, description: item.description ?? '' }
  error.value = ''
}

async function saveEdit(item: any) {
  const ok = await call(
    `/api/lists/${props.list.key}/${item.id}`,
    {
      method: 'PATCH',
      body: {
        label: editDraft.value.label.trim(),
        description: editDraft.value.description.trim() || null,
      },
    },
    'Saved',
  )
  if (ok) editingId.value = null
}

const toggleActive = (item: any) =>
  call(
    `/api/lists/${props.list.key}/${item.id}`,
    { method: 'PATCH', body: { isActive: !item.isActive } },
    item.isActive ? `"${item.label}" hidden` : `"${item.label}" restored`,
  )

const remove = (item: any) =>
  call(
    `/api/lists/${props.list.key}/${item.id}`,
    { method: 'DELETE' },
    `Deleted "${item.label}"`,
  )

async function move(item: any, delta: number) {
  const ordered = [...props.list.items]
  const from = ordered.findIndex((i: any) => i.id === item.id)
  const to = from + delta
  if (to < 0 || to >= ordered.length) return

  const swap = ordered[to]
  busy.value = item.id
  try {
    await Promise.all([
      $fetch(`/api/lists/${props.list.key}/${item.id}`, {
        method: 'PATCH',
        body: { sortOrder: to },
      }),
      $fetch(`/api/lists/${props.list.key}/${swap.id}`, {
        method: 'PATCH',
        body: { sortOrder: from },
      }),
    ])
    emit('changed')
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="rounded-lg border border-default">
    <header class="border-b border-default px-4 py-3">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 class="font-medium text-highlighted">{{ list.title }}</h3>
          <p class="mt-0.5 text-sm text-muted">{{ list.description }}</p>
        </div>
        <UButton
          v-if="canEdit && !adding"
          size="xs"
          variant="subtle"
          icon="i-lucide-plus"
          label="Add"
          @click="startAdd"
        />
      </div>
      <p class="mt-2 text-xs text-dimmed">Chosen in: {{ list.usedFor }}</p>
    </header>

    <UAlert
      v-if="list.unknownValuesInUse.length > 0"
      class="rounded-none border-x-0 border-t-0"
      color="warning"
      variant="subtle"
      icon="i-lucide-help-circle"
      title="Values in use that are not on this list"
      :description="`${list.unknownValuesInUse
        .map((u: any) => `${u.value} (${u.count})`)
        .join(', ')} — most likely from a JSON import made on another install. Add them here to give them a label.`"
    />

    <div v-if="adding" class="border-b border-default bg-elevated/40 px-4 py-3">
      <div class="grid gap-3 sm:grid-cols-2">
        <UFormField label="Label" required>
          <UInput v-model="draft.label" autofocus placeholder="Business rule" class="w-full" />
        </UFormField>
        <UFormField
          label="Stored value"
          :error="keyProblem"
          help="What gets written on every row that chooses this. Fixed once created."
        >
          <UInput
            v-model="draft.key"
            class="w-full font-mono text-sm"
            @input="keyTouched = true"
          />
        </UFormField>
      </div>
      <UFormField class="mt-3" label="Description">
        <UInput v-model="draft.description" class="w-full" />
      </UFormField>
      <div class="mt-3 flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" size="sm" label="Cancel" @click="adding = false" />
        <UButton
          size="sm"
          label="Add"
          :loading="busy === `/api/lists/${list.key}`"
          :disabled="!draft.label.trim() || !draft.key.trim() || Boolean(keyProblem)"
          @click="add"
        />
      </div>
    </div>

    <UAlert
      v-if="error"
      class="rounded-none border-x-0 border-t-0"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :description="error"
    />

    <ul class="divide-y divide-default">
      <li
        v-for="(item, index) in list.items"
        :key="item.id"
        class="px-4 py-2.5"
        :class="item.isActive ? '' : 'bg-elevated/30'"
      >
        <div v-if="editingId === item.id" class="space-y-3">
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="Label" required>
              <UInput v-model="editDraft.label" autofocus class="w-full" />
            </UFormField>
            <UFormField label="Stored value" help="Fixed — rows already hold it.">
              <UInput :model-value="item.key" disabled class="w-full font-mono text-sm" />
            </UFormField>
          </div>
          <UFormField label="Description">
            <UInput v-model="editDraft.description" class="w-full" />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              label="Cancel"
              @click="editingId = null"
            />
            <UButton
              size="sm"
              label="Save"
              :loading="busy === `/api/lists/${list.key}/${item.id}`"
              :disabled="!editDraft.label.trim()"
              @click="saveEdit(item)"
            />
          </div>
        </div>

        <div v-else class="flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm" :class="item.isActive ? '' : 'text-dimmed'">
                {{ item.label }}
              </span>
              <UBadge
                v-if="!item.isActive"
                label="Hidden"
                color="neutral"
                variant="subtle"
                size="sm"
              />
              <UBadge
                v-if="item.isBuiltin"
                label="Built in"
                color="neutral"
                variant="outline"
                size="sm"
              />
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-dimmed">
              <span class="identifier">{{ item.key }}</span>
              <span v-if="item.usageCount > 0">
                · used by {{ item.usageCount }}
              </span>
              <span v-if="item.description">· {{ item.description }}</span>
            </div>
          </div>

          <div v-if="canEdit" class="flex shrink-0 items-center gap-0.5">
            <UButton
              icon="i-lucide-chevron-up"
              color="neutral"
              variant="ghost"
              size="xs"
              :disabled="index === 0 || busy === item.id"
              @click="move(item, -1)"
            />
            <UButton
              icon="i-lucide-chevron-down"
              color="neutral"
              variant="ghost"
              size="xs"
              :disabled="index === list.items.length - 1 || busy === item.id"
              @click="move(item, 1)"
            />
            <UButton
              icon="i-lucide-pencil"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="startEdit(item)"
            />
            <UButton
              :icon="item.isActive ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              color="neutral"
              variant="ghost"
              size="xs"
              :title="item.isActive ? 'Hide — stops it being chosen, changes nothing that already uses it' : 'Offer it again'"
              @click="toggleActive(item)"
            />
            <UButton
              v-if="item.canDelete"
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              title="Delete"
              @click="remove(item)"
            />
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

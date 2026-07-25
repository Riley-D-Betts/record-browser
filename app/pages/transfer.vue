<script setup lang="ts">
useHead({ title: 'Import / export' })

const toast = useToast()
const importing = ref(false)
const preview = ref<any>(null)
const fileContent = ref<any>(null)
const fileName = ref('')

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  fileName.value = file.name
  preview.value = null

  try {
    fileContent.value = JSON.parse(await file.text())
  } catch {
    toast.add({ title: 'That file is not valid JSON', color: 'error' })
    fileContent.value = null
    return
  }
  await runPreview()
}

/**
 * The preview runs the real import inside a transaction that is then rolled back, so
 * what you see reflects actual constraint behaviour rather than a simulation that can
 * drift from it.
 */
async function runPreview() {
  if (!fileContent.value) return
  importing.value = true
  try {
    preview.value = await $fetch('/api/import/json?dryRun=1', {
      method: 'POST',
      body: fileContent.value,
    })
  } catch (e: any) {
    toast.add({
      title: 'Could not read that catalog',
      description: e?.data?.statusMessage ?? e.message,
      color: 'error',
    })
  } finally {
    importing.value = false
  }
}

async function commit() {
  if (!fileContent.value) return
  importing.value = true
  try {
    const result: any = await $fetch('/api/import/json', {
      method: 'POST',
      body: fileContent.value,
    })
    toast.add({
      title: 'Import complete',
      description: `${result.records} records, ${result.fields} fields, ${result.relationships} relationships added.`,
      color: 'success',
    })
    preview.value = null
    fileContent.value = null
    fileName.value = ''
    await refreshNuxtData()
  } catch (e: any) {
    toast.add({
      title: 'Import failed — nothing was written',
      description: e?.data?.statusMessage ?? e.message,
      color: 'error',
    })
  } finally {
    importing.value = false
  }
}

const summaryRows = computed(() =>
  preview.value
    ? [
        { label: 'Data types', value: preview.value.dataTypes },
        { label: 'Modules', value: preview.value.modules },
        { label: 'Records', value: preview.value.records },
        { label: 'Fields', value: preview.value.fields },
        { label: 'Relationships', value: preview.value.relationships },
      ]
    : [],
)
</script>

<template>
  <div class="max-w-3xl space-y-8">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Import & export</h1>
      <p class="mt-1 text-sm text-muted">
        The catalog round-trips through a single JSON format.
      </p>
    </div>

    <section class="rounded-lg border border-default p-4">
      <h2 class="text-sm font-medium text-highlighted">Export</h2>
      <p class="mt-1 text-sm text-muted">
        References are written as <code class="identifier">Record.field</code> rather
        than internal IDs, so the file is portable and readable in a diff. Commit one
        per release and <code class="identifier">git diff</code> shows exactly what
        changed in the source application's schema.
      </p>
      <UButton
        class="mt-3"
        icon="i-lucide-download"
        size="sm"
        variant="subtle"
        label="Download catalog JSON"
        to="/api/export/json?download=1"
        external
      />
    </section>

    <section class="rounded-lg border border-default p-4">
      <h2 class="text-sm font-medium text-highlighted">Import</h2>
      <p class="mt-1 text-sm text-muted">
        Nothing is written until you confirm. Records, fields, provenance and
        relationships are applied in one transaction — a failure anywhere leaves the
        catalog untouched.
      </p>

      <label
        class="mt-3 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-default px-4 py-8 text-sm text-muted transition-colors hover:border-accented"
      >
        <input type="file" accept="application/json,.json" class="sr-only" @change="onFile" >
        <span class="flex items-center gap-2">
          <UIcon name="i-lucide-upload" class="size-4" />
          {{ fileName || 'Choose a catalog JSON file' }}
        </span>
      </label>

      <div v-if="importing" class="mt-4 text-sm text-muted">Working…</div>

      <div v-if="preview" class="mt-4 space-y-4">
        <div class="rounded-lg border border-default">
          <div class="border-b border-default px-3 py-2 text-xs uppercase tracking-wide text-muted">
            Would be added
          </div>
          <dl class="divide-y divide-default text-sm">
            <div
              v-for="row in summaryRows"
              :key="row.label"
              class="flex items-center justify-between px-3 py-1.5"
            >
              <dt :class="row.value > 0 ? 'text-default' : 'text-dimmed'">
                {{ row.label }}
              </dt>
              <dd
                class="tabular-nums"
                :class="row.value > 0 ? 'text-highlighted' : 'text-dimmed'"
              >{{ row.value }}</dd>
            </div>
          </dl>
        </div>

        <UAlert
          v-if="preview.warnings?.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="`${preview.warnings.length} thing${preview.warnings.length === 1 ? '' : 's'} to know`"
        >
          <template #description>
            <ul class="mt-1 list-disc space-y-1 pl-4 text-xs">
              <li v-for="(warning, i) in preview.warnings.slice(0, 12)" :key="i">
                {{ warning }}
              </li>
              <li v-if="preview.warnings.length > 12" class="text-dimmed">
                …and {{ preview.warnings.length - 12 }} more
              </li>
            </ul>
          </template>
        </UAlert>

        <div class="flex gap-2">
          <UButton
            :loading="importing"
            label="Apply import"
            icon="i-lucide-check"
            @click="commit"
          />
          <UButton
            variant="ghost"
            color="neutral"
            label="Cancel"
            @click="
              () => {
                preview = null
                fileContent = null
                fileName = ''
              }
            "
          />
        </div>
      </div>
    </section>
  </div>
</template>

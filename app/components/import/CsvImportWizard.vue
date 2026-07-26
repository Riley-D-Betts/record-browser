<script setup lang="ts">
import Papa from 'papaparse'
import type { BadgeProps } from '@nuxt/ui'
import {
  COLUMNS,
  STRATEGIES,
  STRATEGY_DESCRIPTIONS,
  STRATEGY_LABELS,
  autoMapHeaders,
  detectShape,
} from '#shared/csvColumns'

/**
 * Parses in the browser and posts rows as JSON, matching what the JSON importer
 * already does — no multipart plumbing exists anywhere on the server, and a schema
 * catalog's worth of rows is small enough that adding it would buy nothing.
 */

const emit = defineEmits<{ imported: [] }>()
const toast = useToast()

const MAX_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 20_000

const fileName = ref('')
const headers = ref<string[]>([])
const rows = ref<Array<Record<string, string>>>([])
const mapping = ref<Record<string, string | null>>({})
const strategy = ref<(typeof STRATEGIES)[number]>('fill-blanks')
const emptyCellsClear = ref(false)
const approvedRenames = ref<number[]>([])
const preview = ref<any>(null)
const busy = ref(false)
const showAllRows = ref(false)

const shape = computed(() =>
  detectShape(Object.values(mapping.value).filter(Boolean) as string[]),
)

/** Canonical key -> header, i.e. the inverse of what the UI edits. */
const mappingByKey = computed(() => {
  const out: Record<string, string> = {}
  for (const [header, key] of Object.entries(mapping.value)) {
    if (key) out[key] = header
  }
  return out
})

const unmappedCount = computed(
  () => Object.values(mapping.value).filter((v) => !v).length,
)

const columnOptions = computed(() => [
  { label: 'Ignore this column', value: 'ignore' },
  ...COLUMNS.map((c) => ({ label: c.label, value: c.key })),
])

function reset() {
  fileName.value = ''
  headers.value = []
  rows.value = []
  mapping.value = {}
  preview.value = null
  approvedRenames.value = []
  showAllRows.value = false
}

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  reset()

  if (file.size > MAX_BYTES) {
    toast.add({
      title: 'That file is too large',
      description: `${(file.size / 1024 / 1024).toFixed(1)} MB — the cap is 5 MB. Split it, or import in parts.`,
      color: 'error',
    })
    return
  }

  fileName.value = file.name
  busy.value = true

  const text = await file.text()
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  busy.value = false

  if (!parsed.meta.fields?.length) {
    toast.add({ title: 'No column headers found in that file', color: 'error' })
    reset()
    return
  }
  if (parsed.data.length > MAX_ROWS) {
    toast.add({
      title: 'Too many rows',
      description: `${parsed.data.length.toLocaleString()} rows — the cap is ${MAX_ROWS.toLocaleString()}.`,
      color: 'error',
    })
    reset()
    return
  }

  headers.value = parsed.meta.fields
  rows.value = parsed.data
  mapping.value = autoMapHeaders(parsed.meta.fields)

  // Papaparse reports malformed lines rather than throwing; they are worth saying out
  // loud, because a quoting problem silently shifts every column after it.
  if (parsed.errors.length > 0) {
    toast.add({
      title: `${parsed.errors.length} line${parsed.errors.length === 1 ? '' : 's'} could not be parsed`,
      description: parsed.errors[0]?.message,
      color: 'warning',
    })
  }

  await runPreview()
}

async function runPreview() {
  if (!rows.value.length) return
  busy.value = true
  try {
    preview.value = await $fetch('/api/import/csv?dryRun=1', {
      method: 'POST',
      body: {
        mapping: mappingByKey.value,
        rows: rows.value,
        strategy: strategy.value,
        emptyCellsClear: emptyCellsClear.value,
        approvedRenames: approvedRenames.value,
      },
    })
  } catch (e: any) {
    toast.add({
      title: 'Could not read that file',
      description: e?.data?.statusMessage ?? e.message,
      color: 'error',
    })
    preview.value = null
  } finally {
    busy.value = false
  }
}

// Re-plan whenever a decision changes, so the numbers on screen always describe the
// options currently selected rather than the ones they were selected under.
watch([strategy, emptyCellsClear, mapping, approvedRenames], () => {
  if (rows.value.length) runPreview()
}, { deep: true })

async function commit() {
  busy.value = true
  try {
    const result: any = await $fetch('/api/import/csv', {
      method: 'POST',
      body: {
        mapping: mappingByKey.value,
        rows: rows.value,
        strategy: strategy.value,
        emptyCellsClear: emptyCellsClear.value,
        approvedRenames: approvedRenames.value,
      },
    })
    const parts = [
      result.recordsCreated && `${result.recordsCreated} records added`,
      result.recordsUpdated && `${result.recordsUpdated} records updated`,
      result.fieldsCreated && `${result.fieldsCreated} fields added`,
      result.fieldsUpdated && `${result.fieldsUpdated} fields updated`,
      result.relationshipsCreated && `${result.relationshipsCreated} relationships added`,
    ].filter(Boolean)
    toast.add({
      title: 'Import complete',
      description: parts.length ? parts.join(', ') : 'Nothing needed changing.',
      color: 'success',
    })
    reset()
    emit('imported')
  } catch (e: any) {
    toast.add({
      title: 'Import failed — nothing was written',
      description: e?.data?.statusMessage ?? e.message,
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

const totals = computed(() => {
  if (!preview.value) return null
  const r = preview.value.counts.records
  const f = preview.value.counts.fields
  const rel = preview.value.counts.relationships ?? { create: 0, update: 0, unchanged: 0, skip: 0, error: 0 }
  return {
    create: r.create + f.create + rel.create,
    update: r.update + f.update + rel.update,
    unchanged: r.unchanged + f.unchanged + rel.unchanged,
    skip: r.skip + f.skip + rel.skip,
    error: r.error + f.error + rel.error,
  }
})

const relationshipCount = computed(
  () => preview.value?.counts?.relationships?.create ?? 0,
)

const hasWork = computed(
  () => Boolean(totals.value && (totals.value.create > 0 || totals.value.update > 0)),
)

const visibleRows = computed(() => {
  const all = preview.value?.rows ?? []
  const interesting = all.filter((r: any) => r.action !== 'unchanged' || r.suppressed.length)
  return showAllRows.value ? all : interesting
})

const actionColor: Record<string, BadgeProps['color']> = {
  create: 'success',
  update: 'info',
  unchanged: 'neutral',
  skip: 'warning',
}
</script>

<template>
  <div class="space-y-4">
    <label
      class="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-default px-4 py-8 text-sm text-muted transition-colors hover:border-accented"
    >
      <input type="file" accept=".csv,text/csv" class="sr-only" @change="onFile" >
      <span class="flex items-center gap-2">
        <UIcon name="i-lucide-upload" class="size-4" />
        {{ fileName || 'Choose a CSV file' }}
      </span>
    </label>

    <template v-if="headers.length">
      <!-- mapping -->
      <section class="rounded-lg border border-default">
        <div class="flex items-center justify-between border-b border-default px-3 py-2">
          <h3 class="text-sm font-medium text-highlighted">Columns</h3>
          <div class="flex items-center gap-2 text-xs text-muted">
            <UBadge
              :label="shape === 'fields' ? 'Field rows' : 'Record rows'"
              color="neutral"
              variant="subtle"
              size="sm"
            />
            <span v-if="unmappedCount">{{ unmappedCount }} ignored</span>
          </div>
        </div>

        <div class="max-h-64 space-y-1 overflow-y-auto p-3">
          <div
            v-for="header in headers"
            :key="header"
            class="grid grid-cols-[1fr_auto_1fr] items-center gap-2"
          >
            <div class="identifier truncate text-sm" :title="header">{{ header }}</div>
            <UIcon name="i-lucide-arrow-right" class="size-3.5 shrink-0 text-dimmed" />
            <USelect
              :model-value="mapping[header] ?? 'ignore'"
              :items="columnOptions"
              size="sm"
              class="w-full"
              @update:model-value="mapping[header] = $event === 'ignore' ? null : $event"
            />
          </div>
        </div>
      </section>

      <!-- strategy -->
      <section class="rounded-lg border border-default p-3">
        <h3 class="mb-2 text-sm font-medium text-highlighted">
          What should happen to rows that already exist?
        </h3>
        <div class="grid gap-2 sm:grid-cols-3">
          <button
            v-for="option in STRATEGIES"
            :key="option"
            type="button"
            class="rounded-lg border p-2.5 text-left transition-colors"
            :class="
              strategy === option
                ? 'border-primary bg-primary/5'
                : 'border-default hover:border-accented'
            "
            @click="strategy = option"
          >
            <div class="text-sm font-medium text-highlighted">
              {{ STRATEGY_LABELS[option] }}
            </div>
            <div class="mt-0.5 text-xs text-muted">
              {{ STRATEGY_DESCRIPTIONS[option] }}
            </div>
          </button>
        </div>

        <p v-if="strategy === 'fill-blanks'" class="mt-2 text-xs text-dimmed">
          Yes/no columns are never changed on an existing row — a
          <span class="italic">no</span> already in the catalog is an answer, not a
          blank. Choose “the file wins” to change those in bulk.
        </p>

        <UCheckbox
          v-if="strategy === 'overwrite'"
          v-model="emptyCellsClear"
          class="mt-3"
          label="Treat an empty cell as “clear this value”"
          help="Off by default. In a CSV an empty cell and “I don't have that data” look identical, so this is destructive on sparse files."
        />
      </section>

      <!-- preview -->
      <section v-if="preview" class="space-y-3">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <div
            v-for="(count, key) in totals"
            :key="key"
            class="rounded-lg border border-default px-3 py-2"
            :class="key === 'error' && count > 0 ? 'border-error/50' : ''"
          >
            <div
              class="text-lg font-semibold tabular-nums"
              :class="count > 0 ? 'text-highlighted' : 'text-dimmed'"
            >{{ count }}</div>
            <div class="text-xs capitalize text-muted">
              {{ key === 'skip' ? 'skipped' : key }}
            </div>
          </div>
        </div>

        <UAlert
          v-if="preview.errors.length"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="`${preview.errors.length} row${preview.errors.length === 1 ? '' : 's'} cannot be imported`"
        >
          <template #description>
            <p class="mb-1 text-xs">Nothing will be written until these are fixed.</p>
            <ul class="list-disc space-y-1 pl-4 text-xs">
              <li v-for="(err, i) in preview.errors.slice(0, 10)" :key="i">
                <span class="font-medium">Line {{ err.rowNumber }}</span> — {{ err.message }}
              </li>
              <li v-if="preview.errors.length > 10" class="text-dimmed">
                …and {{ preview.errors.length - 10 }} more
              </li>
            </ul>
          </template>
        </UAlert>

        <UAlert
          v-if="preview.renames.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-pencil-line"
          :title="`${preview.renames.length} technical name${preview.renames.length === 1 ? ' has' : 's have'} changed in the source system`"
        >
          <template #description>
            <p class="mb-2 text-xs">
              Matched by source ID. Renaming is never applied unless you say so.
            </p>
            <div
              v-for="rename in preview.renames"
              :key="rename.rowNumber"
              class="flex items-center gap-2 py-0.5 text-xs"
            >
              <UCheckbox
                :model-value="approvedRenames.includes(rename.rowNumber)"
                @update:model-value="
                  approvedRenames = $event
                    ? [...approvedRenames, rename.rowNumber]
                    : approvedRenames.filter((n) => n !== rename.rowNumber)
                "
              />
              <span class="identifier">{{ rename.from }}</span>
              <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed" />
              <span class="identifier">{{ rename.to }}</span>
              <span class="text-dimmed">line {{ rename.rowNumber }}</span>
            </div>
          </template>
        </UAlert>

        <div v-if="preview.columnImpact.length" class="rounded-lg border border-default p-3">
          <h4 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            What would change
          </h4>
          <div class="flex flex-wrap gap-1.5">
            <UBadge
              v-for="impact in preview.columnImpact"
              :key="`${impact.entity}-${impact.column}`"
              :label="`${impact.column}: ${impact.rows}`"
              color="neutral"
              variant="subtle"
              size="sm"
            />
          </div>
        </div>

        <UAlert
          v-if="preview.columnWarnings?.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Some values could not be read"
        >
          <template #description>
            <p class="mb-1 text-xs">
              These cells are skipped and the rows still import. A large count usually
              means the column means something different from what it was mapped to.
            </p>
            <ul class="list-disc space-y-1 pl-4 text-xs">
              <li v-for="cw in preview.columnWarnings" :key="cw.column">
                <span class="font-medium">{{ cw.column }}</span>:
                {{ cw.rows }} value{{ cw.rows === 1 ? '' : 's' }} not understood
                <span class="text-dimmed">— e.g. “{{ cw.sample }}”</span>
              </li>
            </ul>
          </template>
        </UAlert>

        <UAlert
          v-if="relationshipCount > 0"
          color="info"
          variant="subtle"
          icon="i-lucide-git-branch"
          :title="`${relationshipCount} relationship${relationshipCount === 1 ? '' : 's'} will be created`"
          description="Derived from the reference-target column: the target is the parent, this row's record is the child, and the field is the link."
        />

        <UAlert
          v-if="preview.warnings.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-info"
          :title="`${preview.warnings.length} thing${preview.warnings.length === 1 ? '' : 's'} to know`"
        >
          <template #description>
            <ul class="mt-1 list-disc space-y-1 pl-4 text-xs">
              <li v-for="(w, i) in preview.warnings.slice(0, 8)" :key="i">{{ w }}</li>
              <li v-if="preview.warnings.length > 8" class="text-dimmed">
                …and {{ preview.warnings.length - 8 }} more
              </li>
            </ul>
          </template>
        </UAlert>

        <div v-if="visibleRows.length" class="overflow-hidden rounded-lg border border-default">
          <div class="flex items-center justify-between border-b border-default px-3 py-2">
            <h4 class="text-xs font-medium uppercase tracking-wide text-muted">
              Row detail
            </h4>
            <UButton
              variant="link"
              color="neutral"
              size="xs"
              :label="showAllRows ? 'Only what changes' : 'Show every row'"
              @click="showAllRows = !showAllRows"
            />
          </div>
          <div class="max-h-72 overflow-y-auto">
            <div
              v-for="row in visibleRows"
              :key="`${row.entity}-${row.rowNumber}`"
              class="border-b border-default px-3 py-2 text-sm last:border-0"
            >
              <div class="flex items-center gap-2">
                <UBadge
                  :label="row.action"
                  :color="actionColor[row.action] ?? 'neutral'"
                  variant="subtle"
                  size="sm"
                />
                <span class="identifier truncate">{{ row.key }}</span>
                <span class="ml-auto shrink-0 text-xs text-dimmed">
                  line {{ row.rowNumber }}
                </span>
              </div>

              <ul v-if="row.changes.length" class="mt-1 space-y-0.5 pl-1 text-xs">
                <li v-for="change in row.changes" :key="change.column" class="text-muted">
                  <span class="text-default">{{ change.column }}</span>:
                  <span class="text-dimmed line-through">{{ change.before ?? '—' }}</span>
                  →
                  <span class="text-default">{{ change.after ?? '—' }}</span>
                </li>
              </ul>

              <ul v-if="row.suppressed.length" class="mt-1 space-y-0.5 pl-1 text-xs">
                <li
                  v-for="s in row.suppressed"
                  :key="s.column"
                  class="text-warning"
                  :title="'The file disagreed here and was not applied'"
                >
                  <span>{{ s.column }}</span>: kept
                  <span class="text-muted">“{{ s.existing ?? '—' }}”</span>, file said
                  <span class="text-muted">“{{ s.incoming ?? '—' }}”</span>
                </li>
              </ul>

              <p v-if="row.reason" class="mt-1 pl-1 text-xs text-dimmed">{{ row.reason }}</p>
            </div>
          </div>
          <div
            v-if="preview.truncatedRows"
            class="border-t border-default px-3 py-2 text-xs text-dimmed"
          >
            {{ preview.truncatedRows }} further rows not shown.
          </div>
        </div>

        <div class="flex items-center gap-2">
          <UButton
            :loading="busy"
            :disabled="!hasWork || preview.errors.length > 0"
            icon="i-lucide-check"
            :label="
              preview.errors.length
                ? 'Fix the errors first'
                : hasWork
                  ? 'Apply import'
                  : 'Nothing to apply'
            "
            @click="commit"
          />
          <UButton variant="ghost" color="neutral" label="Cancel" @click="reset" />
        </div>
      </section>

      <p v-else-if="busy" class="text-sm text-muted">Working…</p>
    </template>
  </div>
</template>

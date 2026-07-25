<script setup lang="ts">
import { ORIGINS, SOURCE_KINDS, SOURCE_KIND_LABELS } from '#shared/constants'

useHead({ title: 'Browse' })

const route = useRoute()
const router = useRouter()

const tab = ref<'records' | 'fields'>(
  route.query.tab === 'fields' ? 'fields' : 'records',
)
// Nuxt UI's USelect reserves the empty string to mean "cleared", so an explicit
// sentinel is needed for the "no filter" option rather than ''.
const ANY = 'any'

const search = ref((route.query.q as string) ?? '')
const moduleId = ref((route.query.moduleId as string) ?? ANY)
const origin = ref((route.query.origin as string) ?? ANY)
const sourceKind = ref((route.query.sourceKind as string) ?? ANY)
const includeDeprecated = ref(route.query.deprecated === '1')

const debounced = refDebounced(search, 200)

const { data: modules } = await useFetch('/api/modules')

/** Sentinel -> omitted from the query string. */
const filterValue = (v: string) => (v && v !== ANY ? v : undefined)

const recordQuery = computed(() => ({
  q: debounced.value || undefined,
  moduleId: filterValue(moduleId.value),
  origin: filterValue(origin.value),
  includeDeprecated: includeDeprecated.value ? '1' : undefined,
  perPage: 200,
}))

const fieldQuery = computed(() => ({
  q: debounced.value || undefined,
  moduleId: filterValue(moduleId.value),
  origin: filterValue(origin.value),
  sourceKind: filterValue(sourceKind.value),
  includeDeprecated: includeDeprecated.value ? '1' : undefined,
  perPage: 200,
}))

const { data: recordData, status: recordStatus } = await useFetch('/api/records', {
  query: recordQuery,
})
const { data: fieldData, status: fieldStatus } = await useFetch('/api/fields', {
  query: fieldQuery,
})

// Keep the URL in step so a filtered view can be shared or bookmarked — half the
// value of a browser like this is being able to send someone the exact list.
watchEffect(() => {
  router.replace({
    query: {
      ...(tab.value === 'fields' ? { tab: 'fields' } : {}),
      ...(search.value ? { q: search.value } : {}),
      ...(filterValue(moduleId.value) ? { moduleId: moduleId.value } : {}),
      ...(filterValue(origin.value) ? { origin: origin.value } : {}),
      ...(filterValue(sourceKind.value) ? { sourceKind: sourceKind.value } : {}),
      ...(includeDeprecated.value ? { deprecated: '1' } : {}),
    },
  })
})

const moduleOptions = computed(() => [
  { label: 'All modules', value: ANY },
  ...(modules.value ?? []).map((m) => ({ label: m.name, value: m.id })),
])
const originOptions = [
  { label: 'Native & custom', value: ANY },
  ...ORIGINS.map((o) => ({ label: o === 'native' ? 'Native only' : 'Custom only', value: o })),
]
const sourceKindOptions = [
  { label: 'Any source', value: ANY },
  ...SOURCE_KINDS.map((k) => ({ label: SOURCE_KIND_LABELS[k], value: k })),
]

const activeFilters = computed(
  () =>
    [
      filterValue(moduleId.value),
      filterValue(origin.value),
      tab.value === 'fields' ? filterValue(sourceKind.value) : undefined,
    ].filter(Boolean).length + (includeDeprecated.value ? 1 : 0),
)

function clearFilters() {
  moduleId.value = ANY
  origin.value = ANY
  sourceKind.value = ANY
  includeDeprecated.value = false
}

const loading = computed(() =>
  tab.value === 'records' ? recordStatus.value === 'pending' : fieldStatus.value === 'pending',
)

const canEdit = useCanEdit()
const creatingRecord = ref(false)

async function onRecordCreated(created: any) {
  // Straight into the new record — the next thing anyone wants is to add its fields.
  await navigateTo(`/records/${created.id}`)
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex rounded-md bg-elevated p-0.5 ring ring-accented">
        <button
          v-for="option in (['records', 'fields'] as const)"
          :key="option"
          type="button"
          class="rounded px-3 py-1 text-sm font-medium capitalize transition-colors"
          :class="
            tab === option
              ? 'bg-default text-highlighted shadow-sm'
              : 'text-muted hover:text-default'
          "
          @click="tab = option"
        >
          {{ option }}
        </button>
      </div>

      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search names, labels, source IDs, expressions…"
        class="min-w-64 flex-1"
        :ui="{ trailing: 'pe-1' }"
      >
        <template v-if="search" #trailing>
          <UButton
            color="neutral"
            variant="link"
            icon="i-lucide-x"
            size="xs"
            @click="search = ''"
          />
        </template>
      </UInput>

      <span class="text-sm tabular-nums text-muted">
        {{ tab === 'records' ? recordData?.total ?? 0 : fieldData?.total ?? 0 }}
        {{ tab }}
      </span>

      <UButton
        v-if="canEdit"
        icon="i-lucide-plus"
        size="sm"
        label="New record"
        @click="creatingRecord = true"
      />
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <USelect v-model="moduleId" :items="moduleOptions" size="sm" class="w-44" />
      <USelect v-model="origin" :items="originOptions" size="sm" class="w-40" />
      <USelect
        v-if="tab === 'fields'"
        v-model="sourceKind"
        :items="sourceKindOptions"
        size="sm"
        class="w-40"
      />
      <UCheckbox v-model="includeDeprecated" label="Include deprecated" size="sm" />
      <UButton
        v-if="activeFilters > 0"
        variant="link"
        color="neutral"
        size="xs"
        label="Clear filters"
        @click="clearFilters"
      />
    </div>

    <div class="overflow-x-auto rounded-lg border border-default">
      <table v-if="tab === 'records'" class="w-full text-sm">
        <thead class="border-b border-default bg-elevated/50 text-left">
          <tr class="text-xs uppercase tracking-wide text-muted">
            <th class="px-3 py-2 font-medium">Record</th>
            <th class="px-3 py-2 font-medium">Module</th>
            <th class="px-3 py-2 font-medium">Origin</th>
            <th class="px-3 py-2 text-right font-medium">Fields</th>
            <th class="px-3 py-2 text-right font-medium">Links</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr
            v-for="row in recordData?.rows"
            :key="row.id"
            class="cursor-pointer hover:bg-elevated/40"
            @click="navigateTo(`/records/${row.id}`)"
          >
            <td class="max-w-md px-3 py-2">
              <EntityName :entity="row" bold />
              <div v-if="row.description" class="truncate text-xs text-dimmed">
                {{ row.description }}
              </div>
            </td>
            <td class="px-3 py-2">
              <span v-if="row.moduleName" class="inline-flex items-center gap-1.5">
                <span
                  class="size-2 rounded-full"
                  :style="{ background: row.moduleColor ?? '#94a3b8' }"
                />
                <span class="text-muted">{{ row.moduleName }}</span>
              </span>
              <span v-else class="text-dimmed">—</span>
            </td>
            <td class="px-3 py-2"><OriginBadge :origin="row.origin" /></td>
            <td class="px-3 py-2 text-right tabular-nums text-muted">
              {{ row.fieldCount }}
            </td>
            <td class="px-3 py-2 text-right tabular-nums text-muted">
              {{ row.relationshipCount }}
            </td>
          </tr>
        </tbody>
      </table>

      <table v-else class="w-full text-sm">
        <thead class="border-b border-default bg-elevated/50 text-left">
          <tr class="text-xs uppercase tracking-wide text-muted">
            <th class="px-3 py-2 font-medium">Field</th>
            <th class="px-3 py-2 font-medium">Type</th>
            <th class="px-3 py-2 font-medium">Source</th>
            <th class="px-3 py-2 font-medium">Origin</th>
            <th class="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr
            v-for="row in fieldData?.rows"
            :key="row.id"
            class="cursor-pointer hover:bg-elevated/40"
            @click="navigateTo(`/fields/${row.id}`)"
          >
            <td class="max-w-md px-3 py-2">
              <EntityName
                :entity="row"
                :prefix="{
                  apiName: row.recordApiName,
                  label: row.recordLabel,
                  externalId: null,
                }"
                bold
              />
              <div
                v-if="row.sourceExpression"
                class="identifier mt-0.5 truncate text-xs text-dimmed"
              >
                {{ row.sourceExpression }}
              </div>
            </td>
            <td class="px-3 py-2 text-muted">{{ row.dataTypeLabel ?? '—' }}</td>
            <td class="px-3 py-2">
              <SourceKindBadge
                :kind="row.sourceKind"
                :externally-populated="row.isExternallyPopulated"
              />
            </td>
            <td class="px-3 py-2"><OriginBadge :origin="row.origin" /></td>
            <td class="px-3 py-2">
              <div class="flex gap-1">
                <UBadge
                  v-if="row.isPrimaryKey"
                  label="PK"
                  color="warning"
                  variant="subtle"
                  size="sm"
                />
                <UBadge
                  v-if="row.isRequired"
                  label="Required"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                />
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div
        v-if="!loading && (tab === 'records' ? !recordData?.rows.length : !fieldData?.rows.length)"
        class="px-3 py-12 text-center text-sm text-muted"
      >
        <template v-if="search || activeFilters > 0">Nothing matches those filters.</template>
        <template v-else-if="tab === 'records'">
          <p>The catalog is empty.</p>
          <UButton
            v-if="canEdit"
            class="mt-3"
            size="sm"
            variant="subtle"
            icon="i-lucide-plus"
            label="Add the first record"
            @click="creatingRecord = true"
          />
          <p class="mt-3 text-xs text-dimmed">
            Or bring a whole schema in at once from
            <NuxtLink to="/transfer" class="underline">import</NuxtLink>.
          </p>
        </template>
        <template v-else>No fields yet.</template>
      </div>
    </div>

    <FormRecordFormModal
      v-if="canEdit"
      v-model:open="creatingRecord"
      @saved="onRecordCreated"
    />
  </div>
</template>

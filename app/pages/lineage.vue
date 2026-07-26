<script setup lang="ts">
import type { LineageResponse } from '~~/server/api/fields/[id]/lineage.get'

useHead({ title: 'Lineage' })

const route = useRoute()
const router = useRouter()

const fieldId = computed(() => (route.query.fieldId as string) || '')
const depth = ref(Number(route.query.depth) || 10)
const search = ref('')
const debounced = refDebounced(search, 200)

const { data: candidates } = await useFetch('/api/fields', {
  query: computed(() => ({ q: debounced.value || undefined, perPage: 20 })),
})

const { data: lineage, status } = await useFetch<LineageResponse>(
  () => (fieldId.value ? `/api/fields/${fieldId.value}/lineage` : ''),
  {
    query: computed(() => ({ direction: 'both', depth: depth.value })),
    immediate: Boolean(fieldId.value),
    watch: [fieldId, depth],
  },
)

function select(id: string) {
  router.replace({ query: { ...route.query, fieldId: id } })
  search.value = ''
}

/** Group by hop distance so each column is "one step further from the root". */
const columns = computed(() => {
  const nodes = lineage.value?.nodes ?? []
  const byDepth = new Map<number, typeof nodes>()
  for (const node of nodes) {
    const list = byDepth.get(node.depth) ?? []
    list.push(node)
    byDepth.set(node.depth, list)
  }
  return [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, items]) => ({
      depth: d,
      heading:
        d === 0
          ? 'Selected field'
          : d < 0
            ? `${Math.abs(d)} hop${Math.abs(d) === 1 ? '' : 's'} upstream`
            : `${d} hop${d === 1 ? '' : 's'} downstream`,
      items,
    }))
})

const cycleFieldIds = computed(
  () => new Set((lineage.value?.cycles ?? []).flat()),
)

const upstreamCount = computed(
  () => (lineage.value?.nodes ?? []).filter((n) => n.depth < 0).length,
)
const downstreamCount = computed(
  () => (lineage.value?.nodes ?? []).filter((n) => n.depth > 0).length,
)
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Lineage</h1>
      <p class="mt-1 text-sm text-muted">
        Trace a field back to where its value originates, and forward to everything
        that would break if you changed it.
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Find a field to trace…"
        class="min-w-72 flex-1"
      />
      <div class="flex items-center gap-2 text-sm">
        <span class="text-muted">Depth</span>
        <UInput
          v-model.number="depth"
          type="number"
          :min="1"
          :max="50"
          size="sm"
          class="w-20"
        />
      </div>
    </div>

    <div
      v-if="search && candidates?.rows.length"
      class="max-h-64 overflow-y-auto rounded-lg border border-default"
    >
      <button
        v-for="row in candidates.rows"
        :key="row.id"
        type="button"
        class="flex w-full items-center gap-2 border-b border-default px-3 py-2 text-left text-sm last:border-0 hover:bg-elevated/50"
        @click="select(row.id)"
      >
        <EntityName
          :entity="row"
          :prefix="{ apiName: row.recordApiName, label: row.recordLabel, externalId: null }"
        />
        <SourceKindBadge
          class="ml-auto"
          :kind="row.sourceKind"
          :externally-populated="row.isExternallyPopulated"
        />
      </button>
    </div>

    <div
      v-if="!fieldId"
      class="rounded-lg border border-dashed border-default px-4 py-16 text-center"
    >
      <UIcon name="i-lucide-git-branch" class="mx-auto size-6 text-dimmed" />
      <p class="mt-2 text-sm text-muted">Search for a field above to trace it.</p>
    </div>

    <template v-else-if="lineage">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <UBadge
          :label="`${upstreamCount} upstream`"
          color="info"
          variant="subtle"
        />
        <UBadge
          :label="`${downstreamCount} downstream`"
          color="primary"
          variant="subtle"
        />
        <UBadge
          v-if="lineage.cycles.length"
          :label="`${lineage.cycles.length} circular`"
          color="error"
          variant="subtle"
          icon="i-lucide-refresh-cw"
        />
      </div>

      <UAlert
        v-if="lineage.truncated"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="This trace was cut short"
        :description="`Stopped at ${lineage.maxDepthReached} hops. There is more graph beyond this — raise the depth to see it.`"
      />

      <UAlert
        v-if="lineage.cycles.length"
        color="error"
        variant="subtle"
        icon="i-lucide-refresh-cw"
        title="Circular dependency"
        :description="`${lineage.cycles.length} loop${lineage.cycles.length === 1 ? '' : 's'} pass through this trace. Fields in a loop have no valid evaluation order.`"
      />

      <div class="flex gap-4 overflow-x-auto pb-2">
        <div
          v-for="column in columns"
          :key="column.depth"
          class="w-64 shrink-0 space-y-2"
        >
          <div class="text-xs font-medium uppercase tracking-wide text-muted">
            {{ column.heading }}
          </div>

          <NuxtLink
            v-for="node in column.items"
            :key="node.fieldId"
            :to="`/fields/${node.fieldId}`"
            class="block rounded-lg border p-2.5 transition-colors"
            :class="[
              node.depth === 0
                ? 'border-primary bg-primary/5'
                : 'border-default hover:border-accented',
              cycleFieldIds.has(node.fieldId) && node.depth !== 0 && 'border-error/50',
            ]"
          >
            <div class="flex items-start justify-between gap-2">
              <EntityName :entity="node" bold />
              <UIcon
                v-if="cycleFieldIds.has(node.fieldId)"
                name="i-lucide-refresh-cw"
                class="mt-0.5 size-3.5 shrink-0 text-error"
                title="Part of a circular dependency"
              />
            </div>
            <div class="mt-0.5 text-xs text-muted">
              {{ node.recordLabel }}
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-1">
              <SourceKindBadge
                :kind="node.sourceKind"
                :externally-populated="node.isExternallyPopulated"
              />
              <UBadge
                v-if="node.isOrigin"
                label="Origin"
                color="success"
                variant="subtle"
                size="sm"
                title="A person enters this value — the trace ends here"
              />
            </div>
            <div
              v-if="node.sourceExpression"
              class="identifier mt-2 truncate text-xs text-dimmed"
              :title="node.sourceExpression"
            >
              {{ node.sourceExpression }}
            </div>
          </NuxtLink>
        </div>
      </div>
    </template>

    <div v-else-if="status === 'pending'" class="py-16 text-center text-sm text-muted">
      Tracing…
    </div>
  </div>
</template>

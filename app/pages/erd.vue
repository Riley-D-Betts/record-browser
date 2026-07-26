<script setup lang="ts">
// The layout worker and GSAP both need a browser. Rendering this on the server would
// only produce an empty canvas that immediately gets replaced.
definePageMeta({ ssr: false })
useHead({ title: 'ERD' })

const router = useRouter()

const selectedModules = ref<string[]>([])
// USelect reserves '' for the cleared state; use an explicit sentinel.
const ANY = 'any'
const origin = ref(ANY)
const collapseModules = ref(false)
const includeDeprecated = ref(false)

const { data: modules } = await useFetch('/api/modules')

const query = computed(() => ({
  moduleIds: selectedModules.value.length ? selectedModules.value.join(',') : undefined,
  origin: origin.value !== ANY ? origin.value : undefined,
  collapseModules: collapseModules.value ? '1' : undefined,
  includeDeprecated: includeDeprecated.value ? '1' : undefined,
}))

const { data: graph, status } = await useFetch('/api/graph', { query })

const canvas = ref<any>(null)
const selectedId = ref<string | null>(null)

/**
 * The payload's two shapes are told apart by `graph.collapsed`, which sits beside the
 * node array rather than on the nodes themselves — so selecting a node cannot narrow
 * it. These do the narrowing once, here, instead of asserting it at each use.
 */
const selectedRecord = computed(() => {
  const g = graph.value
  if (!g || g.collapsed) return undefined
  return g.nodes.find((n) => n.id === selectedId.value)
})

const selectedModule = computed(() => {
  const g = graph.value
  if (!g || !g.collapsed) return undefined
  return g.nodes.find((n) => n.id === selectedId.value)
})

/** Only the identity all nodes share — enough for the panel heading. */
const selectedNode = computed(() => selectedRecord.value ?? selectedModule.value)

/** Selecting a record dims everything it is not connected to. */
const highlightRecordIds = computed(() => {
  if (!selectedId.value || !graph.value) return null
  const neighbours = new Set<string>([selectedId.value])
  for (const edge of graph.value.edges as any[]) {
    if (edge.parentRecordId === selectedId.value) neighbours.add(edge.childRecordId)
    if (edge.childRecordId === selectedId.value) neighbours.add(edge.parentRecordId)
  }
  return [...neighbours]
})

function onSelect(id: string) {
  selectedId.value = selectedId.value === id ? null : id
  if (selectedId.value) canvas.value?.focusNode(id)
}

function toggleModule(id: string) {
  selectedModules.value = selectedModules.value.includes(id)
    ? selectedModules.value.filter((m) => m !== id)
    : [...selectedModules.value, id]
  selectedId.value = null
}

const nodeCount = computed(() => graph.value?.nodes.length ?? 0)
const TOO_MANY = 400
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-highlighted">Entity relationships</h1>
        <p class="mt-1 text-sm text-muted">
          Drag to pan, scroll to zoom, click a record to isolate it, double-click to
          show all its fields.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <USelect
          v-model="origin"
          :items="[
            { label: 'Native & custom', value: ANY },
            { label: 'Native only', value: 'native' },
            { label: 'Custom only', value: 'custom' },
          ]"
          size="sm"
          class="w-40"
        />
        <UCheckbox v-model="collapseModules" label="Collapse modules" size="sm" />
      </div>
    </div>

    <div v-if="modules?.length" class="flex flex-wrap items-center gap-2">
      <span class="text-xs uppercase tracking-wide text-muted">Modules</span>
      <button
        v-for="mod in modules"
        :key="mod.id"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
        :class="
          selectedModules.includes(mod.id)
            ? 'border-primary bg-primary/10 text-highlighted'
            : 'border-default text-muted hover:border-accented'
        "
        @click="toggleModule(mod.id)"
      >
        <span class="size-2 rounded-full" :style="{ background: mod.color ?? '#94a3b8' }" />
        {{ mod.name }}
        <span class="text-dimmed">{{ mod.recordCount }}</span>
      </button>
      <UButton
        v-if="selectedModules.length"
        variant="link"
        color="neutral"
        size="xs"
        label="Show all"
        @click="selectedModules = []"
      />
    </div>

    <UAlert
      v-if="nodeCount > TOO_MANY"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="That is more than anyone can read"
      :description="`${nodeCount} records at once. Collapse modules or filter to a few — a diagram this size is the problem, not the picture of it.`"
    />

    <div class="grid gap-4" :class="selectedNode ? 'lg:grid-cols-[1fr_20rem]' : ''">
      <ErdCanvas
        v-if="graph && nodeCount > 0"
        ref="canvas"
        :nodes="graph.nodes"
        :edges="graph.edges"
        :collapsed="graph.collapsed"
        :highlight-record-ids="highlightRecordIds"
        @select="onSelect"
      />
      <div
        v-else-if="status !== 'pending'"
        class="rounded-lg border border-dashed border-default px-4 py-24 text-center text-sm text-muted"
      >
        No records match these filters.
      </div>

      <aside
        v-if="selectedNode"
        class="h-fit rounded-lg border border-default p-4"
      >
        <div class="flex items-start justify-between gap-2">
          <h2 class="font-medium text-highlighted">
            {{ selectedNode.label }}
          </h2>
          <UButton
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="selectedId = null"
          />
        </div>

        <template v-if="selectedRecord">
          <div class="identifier mt-1 text-xs text-muted">{{ selectedRecord.apiName }}</div>
          <div class="mt-3 flex flex-wrap gap-1.5">
            <OriginBadge :origin="selectedRecord.origin" />
            <UBadge
              :label="`${selectedRecord.fieldCount} fields`"
              color="neutral"
              variant="subtle"
              size="sm"
            />
          </div>
          <UButton
            class="mt-4"
            size="sm"
            variant="subtle"
            icon="i-lucide-arrow-right"
            label="Open record"
            @click="router.push(`/records/${selectedRecord.id}`)"
          />
        </template>
        <template v-else-if="selectedModule">
          <p class="mt-2 text-sm text-muted">
            {{ selectedModule.recordCount }} records in this module.
          </p>
          <UButton
            class="mt-4"
            size="sm"
            variant="subtle"
            label="Expand this module"
            @click="
              () => {
                selectedModules = [selectedModule!.id]
                collapseModules = false
                selectedId = null
              }
            "
          />
        </template>
      </aside>
    </div>
  </div>
</template>

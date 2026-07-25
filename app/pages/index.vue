<script setup lang="ts">
import { SOURCE_KIND_LABELS } from '#shared/constants'

useHead({ title: 'Overview' })

const { data: stats } = await useFetch('/api/stats')
const { data: reports } = await useFetch('/api/reports')

const totalFindings = computed(() =>
  (reports.value ?? []).reduce((sum, r) => sum + r.count, 0),
)

const tiles = computed(() => [
  { label: 'Records', value: stats.value?.totals.records ?? 0, to: '/browse' },
  { label: 'Fields', value: stats.value?.totals.fields ?? 0, to: '/browse?tab=fields' },
  { label: 'Relationships', value: stats.value?.totals.relationships ?? 0, to: '/erd' },
  { label: 'Source links', value: stats.value?.totals.dependencies ?? 0, to: '/lineage' },
])

const sourceBreakdown = computed(() => {
  const by = stats.value?.fieldsBySourceKind ?? {}
  const total = Object.values(by).reduce((a, b) => a + b, 0) || 1
  return (['user_entry', 'reference', 'derived'] as const).map((kind) => ({
    kind,
    label: SOURCE_KIND_LABELS[kind],
    count: by[kind] ?? 0,
    pct: Math.round(((by[kind] ?? 0) / total) * 100),
  }))
})

const barColor: Record<string, string> = {
  user_entry: 'bg-neutral-400 dark:bg-neutral-500',
  reference: 'bg-info',
  derived: 'bg-primary',
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Catalog overview</h1>
      <p class="mt-1 text-sm text-muted">
        What is documented, where values come from, and what needs attention.
      </p>
    </div>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <NuxtLink
        v-for="tile in tiles"
        :key="tile.label"
        :to="tile.to"
        class="rounded-lg border border-default bg-elevated/40 p-4 transition-colors hover:border-accented"
      >
        <div class="text-2xl font-semibold tabular-nums text-highlighted">
          {{ tile.value }}
        </div>
        <div class="mt-0.5 text-sm text-muted">{{ tile.label }}</div>
      </NuxtLink>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <section class="rounded-lg border border-default p-4">
        <h2 class="text-sm font-medium text-highlighted">Where field values come from</h2>
        <p class="mt-1 text-xs text-muted">
          Every field has exactly one origin. Derived and reference fields are the ones
          with lineage worth tracing.
        </p>

        <div class="mt-4 space-y-3">
          <div v-for="row in sourceBreakdown" :key="row.kind">
            <div class="flex items-baseline justify-between text-sm">
              <span class="text-default">{{ row.label }}</span>
              <span class="tabular-nums text-muted">
                {{ row.count }}
                <span class="text-dimmed">· {{ row.pct }}%</span>
              </span>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-accented">
              <div
                class="h-full rounded-full transition-all"
                :class="barColor[row.kind]"
                :style="{ width: `${row.pct}%` }"
              />
            </div>
          </div>
        </div>

        <div class="mt-5 flex gap-6 border-t border-default pt-4 text-sm">
          <div>
            <div class="text-muted text-xs">Native records</div>
            <div class="tabular-nums text-highlighted">
              {{ stats?.recordsByOrigin?.native ?? 0 }}
            </div>
          </div>
          <div>
            <div class="text-muted text-xs">Custom records</div>
            <div class="tabular-nums text-highlighted">
              {{ stats?.recordsByOrigin?.custom ?? 0 }}
            </div>
          </div>
        </div>
      </section>

      <section class="rounded-lg border border-default p-4">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-medium text-highlighted">Findings</h2>
          <UBadge
            :color="totalFindings > 0 ? 'warning' : 'success'"
            variant="subtle"
            size="sm"
            :label="totalFindings > 0 ? `${totalFindings} to review` : 'All clear'"
          />
        </div>

        <ul class="mt-3 divide-y divide-default">
          <li v-for="report in reports" :key="report.key">
            <NuxtLink
              :to="`/reports?report=${report.key}`"
              class="flex items-center justify-between gap-3 py-2 text-sm hover:text-highlighted"
            >
              <span :class="report.count > 0 ? 'text-default' : 'text-dimmed'">
                {{ report.title }}
              </span>
              <span
                class="shrink-0 tabular-nums"
                :class="report.count > 0 ? 'text-warning' : 'text-dimmed'"
              >{{ report.count }}</span>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>

    <section v-if="stats?.recentChanges?.length" class="rounded-lg border border-default p-4">
      <h2 class="text-sm font-medium text-highlighted">Recent changes</h2>
      <ul class="mt-3 divide-y divide-default text-sm">
        <li
          v-for="change in stats.recentChanges"
          :key="change.id"
          class="flex items-center gap-3 py-2"
        >
          <UBadge :label="change.action" variant="subtle" size="sm" color="neutral" />
          <span class="text-default">{{ change.entityType }}</span>
          <span class="ml-auto text-xs text-dimmed">
            {{ change.userName ?? 'unknown' }} ·
            {{ new Date(change.createdAt).toLocaleString() }}
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
useHead({ title: 'Reports' })

const route = useRoute()
const router = useRouter()

const { data: reports } = await useFetch('/api/reports')

const active = computed({
  get: () => (route.query.report as string) || reports.value?.[0]?.key || 'cycles',
  set: (key: string) => router.replace({ query: { report: key } }),
})

const { data: detail, status } = await useFetch(() => `/api/reports/${active.value}`, {
  watch: [active],
})
</script>

<template>
  <div class="space-y-4">
    <div>
      <h1 class="text-xl font-semibold text-highlighted">Reports</h1>
      <p class="mt-1 text-sm text-muted">
        Questions a diagram cannot answer — what is circular, what disagrees, what
        nothing reads.
      </p>
    </div>

    <div class="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <nav class="space-y-1">
        <button
          v-for="report in reports"
          :key="report.key"
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors"
          :class="
            active === report.key
              ? 'bg-elevated font-medium text-highlighted'
              : 'text-muted hover:bg-elevated/50 hover:text-default'
          "
          @click="active = report.key"
        >
          <span class="truncate">{{ report.title }}</span>
          <UBadge
            :label="String(report.count)"
            :color="report.count > 0 ? 'warning' : 'neutral'"
            variant="subtle"
            size="sm"
          />
        </button>
      </nav>

      <section v-if="detail" class="min-w-0 space-y-4">
        <div>
          <h2 class="font-medium text-highlighted">{{ detail.title }}</h2>
          <p class="mt-1 text-sm text-muted">{{ detail.description }}</p>
        </div>

        <UAlert
          v-if="detail.findings.length > 0"
          color="neutral"
          variant="subtle"
          icon="i-lucide-lightbulb"
          :description="detail.guidance"
        />

        <div
          v-if="detail.findings.length === 0 && status !== 'pending'"
          class="rounded-lg border border-dashed border-default px-4 py-12 text-center"
        >
          <UIcon name="i-lucide-circle-check" class="mx-auto size-6 text-success" />
          <p class="mt-2 text-sm text-muted">Nothing found.</p>
        </div>

        <ul v-else class="space-y-2">
          <li
            v-for="(finding, i) in detail.findings"
            :key="`${finding.entityId}-${i}`"
            class="rounded-lg border border-default p-3"
          >
            <NuxtLink
              :to="
                finding.entityType === 'record'
                  ? `/records/${finding.entityId}`
                  : `/fields/${finding.entityId}`
              "
              class="group flex items-start gap-2"
            >
              <UIcon
                name="i-lucide-triangle-alert"
                class="mt-0.5 size-4 shrink-0 text-warning"
              />
              <div class="min-w-0 flex-1">
                <div
                  class="font-medium text-highlighted group-hover:underline"
                >{{ finding.title }}</div>
                <p class="mt-0.5 text-sm text-muted">{{ finding.detail }}</p>
                <div
                  v-if="finding.context"
                  class="mt-2 flex flex-wrap gap-1.5"
                >
                  <template v-for="(value, key) in finding.context" :key="key">
                    <UBadge
                      v-if="value"
                      :label="`${key}: ${value}`"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                    />
                  </template>
                </div>
              </div>
              <UIcon
                name="i-lucide-chevron-right"
                class="mt-1 size-4 shrink-0 text-dimmed"
              />
            </NuxtLink>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { CARDINALITY_LABELS } from '#shared/constants'

const route = useRoute()
const { data: record } = await useFetch(`/api/records/${route.params.id}`)

if (!record.value) {
  throw createError({ statusCode: 404, statusMessage: 'No such record', fatal: true })
}

useHead({ title: () => record.value?.label ?? 'Record' })

const parents = computed(() =>
  (record.value?.relationships ?? []).filter((r) => r.childRecordId === record.value?.id),
)
const children = computed(() =>
  (record.value?.relationships ?? []).filter((r) => r.parentRecordId === record.value?.id),
)
</script>

<template>
  <div v-if="record" class="space-y-6">
    <div>
      <NuxtLink
        to="/browse"
        class="inline-flex items-center gap-1 text-sm text-muted hover:text-default"
      >
        <UIcon name="i-lucide-chevron-left" class="size-4" /> Browse
      </NuxtLink>

      <div class="mt-2 flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold text-highlighted">
          <EntityName :entity="record" />
        </h1>
        <OriginBadge :origin="record.origin" />
        <UBadge
          v-if="record.isDeprecated"
          label="Deprecated"
          color="warning"
          variant="subtle"
        />
      </div>

      <p v-if="record.description" class="mt-2 max-w-3xl text-sm text-muted">
        {{ record.description }}
      </p>

      <!-- All three identities shown at once: this is the page where you come to
           reconcile them, so hiding two behind the toggle would be unhelpful. -->
      <dl class="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <dt class="text-xs text-muted">Technical name</dt>
          <dd class="identifier text-default">{{ record.apiName }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Display label</dt>
          <dd class="text-default">{{ record.label }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Source ID</dt>
          <dd :class="record.externalId ? 'identifier text-default' : 'text-dimmed italic'">
            {{ record.externalId ?? 'not recorded' }}
          </dd>
        </div>
        <div v-if="record.moduleName">
          <dt class="text-xs text-muted">Module</dt>
          <dd class="inline-flex items-center gap-1.5 text-default">
            <span
              class="size-2 rounded-full"
              :style="{ background: record.moduleColor ?? '#94a3b8' }"
            />
            {{ record.moduleName }}
          </dd>
        </div>
      </dl>
    </div>

    <section>
      <h2 class="mb-2 text-sm font-medium text-highlighted">
        Fields <span class="text-muted">({{ record.fields.length }})</span>
      </h2>

      <div class="overflow-x-auto rounded-lg border border-default">
        <table class="w-full text-sm">
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
              v-for="field in record.fields"
              :key="field.id"
              class="cursor-pointer hover:bg-elevated/40"
              @click="navigateTo(`/fields/${field.id}`)"
            >
              <td class="max-w-sm px-3 py-2">
                <EntityName :entity="field" bold />
                <div v-if="field.description" class="truncate text-xs text-dimmed">
                  {{ field.description }}
                </div>
              </td>
              <td class="whitespace-nowrap px-3 py-2 text-muted">
                {{ field.dataTypeLabel ?? '—' }}
              </td>
              <td class="px-3 py-2">
                <SourceKindBadge
                  :kind="field.sourceKind"
                  :externally-populated="field.isExternallyPopulated"
                />
                <div
                  v-if="field.sourceExpression"
                  class="identifier mt-1 max-w-xs truncate text-xs text-dimmed"
                  :title="field.sourceExpression"
                >
                  {{ field.sourceExpression }}
                </div>
              </td>
              <td class="px-3 py-2"><OriginBadge :origin="field.origin" /></td>
              <td class="whitespace-nowrap px-3 py-2">
                <div class="flex gap-1">
                  <UBadge
                    v-if="field.isPrimaryKey"
                    label="PK"
                    color="warning"
                    variant="subtle"
                    size="sm"
                  />
                  <UBadge
                    v-if="field.isRequired"
                    label="Req"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                  />
                  <UBadge
                    v-if="field.isDeprecated"
                    label="Deprecated"
                    color="warning"
                    variant="subtle"
                    size="sm"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="grid gap-6 lg:grid-cols-2">
      <section>
        <h2 class="mb-2 text-sm font-medium text-highlighted">Parents</h2>
        <div v-if="!parents.length" class="text-sm text-dimmed">
          This record has no parent.
        </div>
        <ul v-else class="space-y-2">
          <li
            v-for="rel in parents"
            :key="rel.id"
            class="rounded-lg border border-default p-3 text-sm"
          >
            <NuxtLink
              :to="`/records/${rel.parentRecordId}`"
              class="font-medium text-highlighted hover:underline"
            >
              <EntityName
                :entity="{ apiName: rel.parentApiName, label: rel.parentLabel, externalId: null }"
              />
            </NuxtLink>
            <div class="mt-1 flex flex-wrap items-center gap-1.5">
              <UBadge
                :label="CARDINALITY_LABELS[rel.cardinality]"
                color="neutral"
                variant="subtle"
                size="sm"
              />
              <UBadge
                v-if="rel.isIdentifying"
                label="Identifying"
                color="info"
                variant="subtle"
                size="sm"
                title="This record cannot exist without its parent"
              />
            </div>
            <p v-if="rel.label" class="mt-1 text-xs text-muted">{{ rel.label }}</p>
          </li>
        </ul>
      </section>

      <section>
        <h2 class="mb-2 text-sm font-medium text-highlighted">Children</h2>
        <div v-if="!children.length" class="text-sm text-dimmed">
          Nothing hangs off this record.
        </div>
        <ul v-else class="space-y-2">
          <li
            v-for="rel in children"
            :key="rel.id"
            class="rounded-lg border border-default p-3 text-sm"
          >
            <NuxtLink
              :to="`/records/${rel.childRecordId}`"
              class="font-medium text-highlighted hover:underline"
            >
              <EntityName
                :entity="{ apiName: rel.childApiName, label: rel.childLabel, externalId: null }"
              />
            </NuxtLink>
            <div class="mt-1 flex flex-wrap items-center gap-1.5">
              <UBadge
                :label="CARDINALITY_LABELS[rel.cardinality]"
                color="neutral"
                variant="subtle"
                size="sm"
              />
              <UBadge
                v-if="rel.isIdentifying"
                label="Identifying"
                color="info"
                variant="subtle"
                size="sm"
              />
            </div>
            <p v-if="rel.label" class="mt-1 text-xs text-muted">{{ rel.label }}</p>
          </li>
        </ul>
      </section>
    </div>

    <section v-if="record.incoming.length">
      <h2 class="mb-2 text-sm font-medium text-highlighted">
        What feeds this record
      </h2>
      <p class="mb-2 text-sm text-muted">
        Fields on other records that populate fields here.
      </p>
      <ul class="divide-y divide-default rounded-lg border border-default">
        <li
          v-for="dep in record.incoming"
          :key="`${dep.fieldId}-${dep.sourceFieldId}`"
          class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
        >
          <NuxtLink :to="`/fields/${dep.sourceFieldId}`" class="hover:underline">
            <EntityName
              :entity="{ apiName: dep.sourceFieldApiName, label: dep.sourceFieldLabel, externalId: null }"
              :prefix="{ apiName: dep.sourceRecordApiName, label: dep.sourceRecordLabel, externalId: null }"
            />
          </NuxtLink>
          <UIcon name="i-lucide-arrow-right" class="size-3.5 text-dimmed" />
          <NuxtLink :to="`/fields/${dep.fieldId}`" class="hover:underline">
            <EntityName
              :entity="record.fields.find((f) => f.id === dep.fieldId)"
            />
          </NuxtLink>
          <UBadge
            :label="dep.kind"
            color="neutral"
            variant="subtle"
            size="sm"
            class="ml-auto"
          />
        </li>
      </ul>
    </section>
  </div>
</template>

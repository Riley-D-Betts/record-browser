<script setup lang="ts">
import { SOURCE_KIND_DESCRIPTIONS } from '#shared/constants'

const route = useRoute()

// Resolved through the list rather than a constant, so a language added in Settings
// renders with its label here too — and one that was retired still renders, because a
// detail page has to show what the row holds, not only what could be chosen today.
const { label: listLabel } = useLists()

const { data: field, refresh } = await useFetch(`/api/fields/${route.params.id}`)

if (!field.value) {
  throw createError({ statusCode: 404, statusMessage: 'No such field', fatal: true })
}

useHead({ title: () => field.value?.label ?? 'Field' })

const isExternalOrigin = computed(
  () => field.value?.sourceKind === 'user_entry' && field.value?.isExternallyPopulated,
)

const canEdit = useCanEdit()
const editing = ref(false)
const deleting = ref(false)
</script>

<template>
  <div v-if="field" class="space-y-6">
    <div>
      <NuxtLink
        :to="`/records/${field.recordId}`"
        class="inline-flex items-center gap-1 text-sm text-muted hover:text-default"
      >
        <UIcon name="i-lucide-chevron-left" class="size-4" />
        <EntityName
          :entity="{ apiName: field.recordApiName, label: field.recordLabel, externalId: null }"
        />
      </NuxtLink>

      <div class="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold text-highlighted">
          <EntityName :entity="field" />
        </h1>
        <OriginBadge :origin="field.origin" />
        <SourceKindBadge
          :kind="field.sourceKind"
          :externally-populated="field.isExternallyPopulated"
        />
        <UBadge
          v-if="field.isPrimaryKey"
          label="Primary key"
          color="warning"
          variant="subtle"
        />
        <UBadge
          v-if="field.isDeprecated"
          label="Deprecated"
          color="warning"
          variant="subtle"
        />
        </div>

        <div v-if="canEdit" class="flex gap-2">
          <UButton
            icon="i-lucide-pencil"
            size="sm"
            variant="subtle"
            label="Edit"
            @click="editing = true"
          />
          <UButton
            icon="i-lucide-trash-2"
            size="sm"
            color="neutral"
            variant="ghost"
            label="Delete"
            @click="deleting = true"
          />
        </div>
      </div>

      <p v-if="field.description" class="mt-2 max-w-3xl text-sm text-muted">
        {{ field.description }}
      </p>

      <dl class="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <dt class="text-xs text-muted">Technical name</dt>
          <dd class="identifier text-default">{{ field.apiName }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Display label</dt>
          <dd class="text-default">{{ field.label }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Source ID</dt>
          <dd :class="field.externalId ? 'identifier text-default' : 'text-dimmed italic'">
            {{ field.externalId ?? 'not recorded' }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Type</dt>
          <dd class="text-default">{{ field.dataTypeLabel ?? '—' }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Constraints</dt>
          <dd class="text-default">
            {{
              [
                field.isRequired ? 'Required' : null,
                field.isUnique ? 'Unique' : null,
                field.isPrimaryKey ? 'Primary key' : null,
              ]
                .filter(Boolean)
                .join(', ') || 'None'
            }}
          </dd>
        </div>
      </dl>
    </div>

    <section class="rounded-lg border border-default p-4">
      <h2 class="text-sm font-medium text-highlighted">Where this value comes from</h2>
      <p class="mt-1 text-sm text-muted">
        {{
          isExternalOrigin
            ? 'Written by an integration or job rather than a person.'
            : SOURCE_KIND_DESCRIPTIONS[field.sourceKind]
        }}
      </p>

      <div v-if="field.sourceNotes" class="mt-3 text-sm text-default">
        {{ field.sourceNotes }}
      </div>

      <div v-if="field.sourceExpression" class="mt-3">
        <div class="mb-1 flex items-center gap-2 text-xs text-muted">
          <span>Expression</span>
          <UBadge
            v-if="field.derivationLanguage"
            :label="listLabel('derivation_language', field.derivationLanguage)"
            color="neutral"
            variant="subtle"
            size="sm"
          />
        </div>
        <pre
          class="identifier overflow-x-auto rounded-md bg-elevated p-3 text-default"
        >{{ field.sourceExpression }}</pre>
      </div>

      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Feeds from ({{ field.upstream.length }})
          </h3>
          <p v-if="!field.upstream.length" class="text-sm text-dimmed">
            Nothing — this is an origin point.
          </p>
          <ul v-else class="space-y-1.5">
            <li v-for="up in field.upstream" :key="up.dependencyId">
              <NuxtLink
                :to="`/fields/${up.fieldId}`"
                class="text-sm hover:underline"
              >
                <EntityName
                  :entity="up"
                  :prefix="{ apiName: up.recordApiName, label: up.recordLabel, externalId: null }"
                />
              </NuxtLink>
            </li>
          </ul>
        </div>

        <div>
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Feeds into ({{ field.downstream.length }})
          </h3>
          <p v-if="!field.downstream.length" class="text-sm text-dimmed">
            Nothing reads this field.
          </p>
          <ul v-else class="space-y-1.5">
            <li v-for="down in field.downstream" :key="down.fieldId">
              <NuxtLink
                :to="`/fields/${down.fieldId}`"
                class="text-sm hover:underline"
              >
                <EntityName
                  :entity="{ apiName: down.fieldApiName, label: down.fieldLabel, externalId: null }"
                  :prefix="{ apiName: down.recordApiName, label: null, externalId: null }"
                />
              </NuxtLink>
            </li>
          </ul>
        </div>
      </div>

      <div class="mt-4 border-t border-default pt-3">
        <UButton
          :to="`/lineage?fieldId=${field.id}`"
          variant="subtle"
          color="primary"
          size="sm"
          icon="i-lucide-git-branch"
          label="Trace full lineage"
        />
      </div>
    </section>

    <template v-if="canEdit">
      <FormFieldFormModal
        v-model:open="editing"
        :record-id="field.recordId"
        :field="field"
        @saved="refresh()"
      />
      <FormDeleteWithImpact
        v-model:open="deleting"
        :endpoint="`/api/fields/${field.id}`"
        :entity-label="field.label"
        entity-kind="field"
        :redirect-to="`/records/${field.recordId}`"
      />
    </template>
  </div>
</template>

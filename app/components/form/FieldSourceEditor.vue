<script setup lang="ts">
import {
  SOURCE_KINDS,
  SOURCE_KIND_DESCRIPTIONS,
  SOURCE_KIND_LABELS,
} from '#shared/constants'
import type { FieldSourceInput } from '#shared/schemas'

/**
 * Edits a field's provenance.
 *
 * Shaped as a discriminated union rather than a bag of optional inputs, so the form
 * cannot express a state the server would reject — a reference with two upstreams, or
 * a derived field with no expression. Switching kind swaps the whole editor, and the
 * previous kind's data is dropped on submit because it no longer applies.
 */
const model = defineModel<FieldSourceInput>({ required: true })

const props = defineProps<{
  /** Nothing may source from itself. */
  currentFieldId?: string | null
}>()

function switchKind(kind: (typeof SOURCE_KINDS)[number]) {
  if (model.value.sourceKind === kind) return
  model.value =
    kind === 'user_entry'
      ? { sourceKind: 'user_entry', isExternallyPopulated: false, sourceNotes: null }
      : kind === 'reference'
        ? { sourceKind: 'reference', sourceFieldId: '', sourceNotes: null }
        : {
            sourceKind: 'derived',
            sourceExpression: '',
            derivationLanguage: null,
            dependsOn: [],
            sourceNotes: null,
          }
}

/** Narrowed views so the template can bind without repeating the discriminant check. */
const referenceFieldId = computed({
  get: () =>
    model.value.sourceKind === 'reference' ? model.value.sourceFieldId || null : null,
  set: (value: string | null) => {
    if (model.value.sourceKind === 'reference') model.value.sourceFieldId = value ?? ''
  },
})

const dependsOn = computed(() =>
  model.value.sourceKind === 'derived' ? model.value.dependsOn : [],
)

const pendingDependency = ref<string | null>(null)

watch(pendingDependency, (id) => {
  if (!id || model.value.sourceKind !== 'derived') return
  if (!model.value.dependsOn.includes(id)) model.value.dependsOn.push(id)
  pendingDependency.value = null
})

function removeDependency(id: string) {
  if (model.value.sourceKind !== 'derived') return
  model.value.dependsOn = model.value.dependsOn.filter((d) => d !== id)
}

// Editable in Settings — a team's expressions are written in whatever its system
// uses, which is not something this app can enumerate up front.
const { options } = useLists()
const languageOptions = computed(() => options('derivation_language', 'Not specified'))

const language = computed({
  get: () =>
    model.value.sourceKind === 'derived'
      ? (model.value.derivationLanguage ?? UNSPECIFIED)
      : UNSPECIFIED,
  set: (value: string) => {
    if (model.value.sourceKind === 'derived') {
      model.value.derivationLanguage = value === UNSPECIFIED ? null : value
    }
  },
})
</script>

<template>
  <div class="space-y-4">
    <div>
      <div class="mb-2 text-sm font-medium text-highlighted">Where does this value come from?</div>
      <div class="grid gap-2 sm:grid-cols-3">
        <button
          v-for="kind in SOURCE_KINDS"
          :key="kind"
          type="button"
          class="rounded-lg border p-3 text-left transition-colors"
          :class="
            model.sourceKind === kind
              ? 'border-primary bg-primary/5'
              : 'border-default hover:border-accented'
          "
          @click="switchKind(kind)"
        >
          <div class="text-sm font-medium text-highlighted">
            {{ SOURCE_KIND_LABELS[kind] }}
          </div>
          <div class="mt-0.5 text-xs text-muted">{{ SOURCE_KIND_DESCRIPTIONS[kind] }}</div>
        </button>
      </div>
    </div>

    <!-- user entry -->
    <template v-if="model.sourceKind === 'user_entry'">
      <UCheckbox
        v-model="model.isExternallyPopulated"
        label="Actually written by an integration or job, not a person"
        help="Keeps lineage honest: flagged fields are not treated as human origin points, so a trace does not stop here and imply nothing feeds it."
      />
      <UFormField
        v-if="model.isExternallyPopulated"
        label="Which process writes it?"
        help="Name the integration, job or feed so someone can find it later."
      >
        <UInput
          :model-value="model.sourceNotes ?? ''"
          placeholder="e.g. Nightly ERP sync (JOB_INV_SYNC)"
          class="w-full"
          @update:model-value="model.sourceNotes = String($event) || null"
        />
      </UFormField>
    </template>

    <!-- reference -->
    <template v-else-if="model.sourceKind === 'reference'">
      <UFormField
        label="Populated from"
        help="Exactly one upstream field. Its value is copied into this one."
        required
      >
        <FormFieldPicker
          v-model="referenceFieldId"
          :exclude-field-id="props.currentFieldId"
          placeholder="Choose the field this one is copied from…"
        />
      </UFormField>
      <UFormField label="Notes" help="Optional.">
        <UInput
          :model-value="model.sourceNotes ?? ''"
          class="w-full"
          @update:model-value="model.sourceNotes = String($event) || null"
        />
      </UFormField>
    </template>

    <!-- derived -->
    <template v-else>
      <UFormField
        label="Expression"
        help="Recorded as text — we deliberately do not parse it, because there is no one expression grammar across systems."
        required
      >
        <UTextarea
          v-model="model.sourceExpression"
          :rows="3"
          placeholder="e.g. Subtotal * (1 - Discount_Rate)"
          class="w-full font-mono text-sm"
        />
      </UFormField>

      <UFormField label="Written in">
        <USelect v-model="language" :items="languageOptions" class="w-full" />
      </UFormField>

      <UFormField
        label="Depends on"
        help="Listed explicitly rather than parsed out of the expression. Anything missing here is invisible to lineage."
      >
        <div class="space-y-2">
          <div
            v-for="depId in dependsOn"
            :key="depId"
            class="flex items-center gap-2"
          >
            <div class="min-w-0 flex-1">
              <FormFieldPicker
                :model-value="depId"
                @update:model-value="
                  (next) => {
                    removeDependency(depId)
                    if (next) pendingDependency = next
                  }
                "
              />
            </div>
            <UButton
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="sm"
              title="Remove this dependency"
              @click="removeDependency(depId)"
            />
          </div>

          <FormFieldPicker
            v-model="pendingDependency"
            :exclude-field-id="props.currentFieldId"
            :exclude-field-ids="dependsOn"
            placeholder="Add a field this one depends on…"
          />
        </div>
      </UFormField>

      <UFormField label="Notes" help="Optional.">
        <UInput
          :model-value="model.sourceNotes ?? ''"
          class="w-full"
          @update:model-value="model.sourceNotes = String($event) || null"
        />
      </UFormField>
    </template>
  </div>
</template>

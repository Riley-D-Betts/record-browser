import { eq, inArray } from 'drizzle-orm'
import { fieldDependencies, fields } from '../db/schema'
import type { FieldSourceInput } from '../../shared/schemas'
import { traverse } from './lineage'
import type { DependencyEdge } from './lineage'
import { assertListValue } from './lists'

/**
 * The single writer of field provenance.
 *
 * The invariant spans two tables — `fields.source_kind` / `source_expression` and the
 * rows in `field_dependencies` — so if more than one code path wrote it, the two would
 * drift. Every API route, the import committer, and the seed all funnel through here.
 *
 *   user_entry -> 0 dependency rows, no expression
 *   reference  -> exactly 1 dependency row, no expression
 *   derived    -> 0..N dependency rows, expression required
 */

export class SourceValidationError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'SourceValidationError'
  }
}

/**
 * Would adding this edge close a loop?
 *
 * Checked on write so the catalog does not accumulate cycles interactively. Imports
 * deliberately do NOT call this — see importCyclePolicy in the import service.
 */
export function wouldCreateCycle(
  edges: DependencyEdge[],
  consumerFieldId: string,
  producerFieldId: string,
): string[] | null {
  if (consumerFieldId === producerFieldId) return [consumerFieldId, consumerFieldId]

  // If the proposed producer is already downstream of the consumer, adding the edge
  // would close a loop.
  const downstream = traverse(edges, consumerFieldId, 'down', 50, 5000)
  const hit = downstream.nodes.find((n) => n.fieldId === producerFieldId)
  return hit ? [...hit.path, consumerFieldId] : null
}

function loadEdges(tx: any): DependencyEdge[] {
  return tx
    .select({
      id: fieldDependencies.id,
      fieldId: fieldDependencies.fieldId,
      sourceFieldId: fieldDependencies.sourceFieldId,
      kind: fieldDependencies.kind,
    })
    .from(fieldDependencies)
    .all()
}

export interface SetFieldSourceOptions {
  /**
   * Imports record cycles rather than rejecting them: a spreadsheet cannot be
   * rejected wholesale, and some source systems genuinely permit circular
   * recalculation. They surface in the cycles report instead.
   */
  allowCycles?: boolean
}

export function setFieldSource(
  tx: any,
  fieldId: string,
  source: FieldSourceInput,
  options: SetFieldSourceOptions = {},
): void {
  const existing = tx.select().from(fields).where(eq(fields.id, fieldId)).all()[0]
  if (!existing) throw new SourceValidationError(`No such field: ${fieldId}`)

  // Clear first — the shape of what is valid differs per kind, and leaving a stale
  // dependency row behind is exactly the drift this function exists to prevent.
  tx.delete(fieldDependencies).where(eq(fieldDependencies.fieldId, fieldId)).run()

  if (source.sourceKind === 'user_entry') {
    tx.update(fields)
      .set({
        sourceKind: 'user_entry',
        sourceExpression: null,
        derivationLanguage: null,
        isExternallyPopulated: source.isExternallyPopulated ?? false,
        sourceNotes: source.sourceNotes ?? null,
      })
      .where(eq(fields.id, fieldId))
      .run()
    return
  }

  if (source.sourceKind === 'reference') {
    assertFieldsExist(tx, [source.sourceFieldId])
    if (source.sourceFieldId === fieldId) {
      throw new SourceValidationError('A field cannot reference itself')
    }
    if (!options.allowCycles) {
      const cycle = wouldCreateCycle(loadEdges(tx), fieldId, source.sourceFieldId)
      if (cycle) {
        throw new SourceValidationError(
          'That reference would create a circular dependency',
          { cycle },
        )
      }
    }

    tx.update(fields)
      .set({
        sourceKind: 'reference',
        sourceExpression: null,
        derivationLanguage: null,
        isExternallyPopulated: false,
        sourceNotes: source.sourceNotes ?? null,
      })
      .where(eq(fields.id, fieldId))
      .run()

    tx.insert(fieldDependencies)
      .values({ fieldId, sourceFieldId: source.sourceFieldId, kind: 'reference' })
      .run()
    return
  }

  // derived
  //
  // The language is checked here rather than in the route because this is the single
  // writer of provenance — putting it anywhere else would leave the import committer
  // and the seed free to write a language no list offers.
  assertListValue(tx, 'derivation_language', source.derivationLanguage, 'derivationLanguage')

  const dependsOn = [...new Set(source.dependsOn ?? [])].filter((id) => id !== fieldId)
  if (dependsOn.length > 0) {
    assertFieldsExist(tx, dependsOn)
    if (!options.allowCycles) {
      const edges = loadEdges(tx)
      for (const producer of dependsOn) {
        const cycle = wouldCreateCycle(edges, fieldId, producer)
        if (cycle) {
          throw new SourceValidationError(
            'That dependency would create a circular dependency',
            { cycle, producer },
          )
        }
      }
    }
  }

  tx.update(fields)
    .set({
      sourceKind: 'derived',
      sourceExpression: source.sourceExpression,
      derivationLanguage: source.derivationLanguage ?? null,
      isExternallyPopulated: false,
      sourceNotes: source.sourceNotes ?? null,
    })
    .where(eq(fields.id, fieldId))
    .run()

  for (const sourceFieldId of dependsOn) {
    tx.insert(fieldDependencies).values({ fieldId, sourceFieldId, kind: 'derived' }).run()
  }
}

function assertFieldsExist(tx: any, ids: string[]): void {
  const found = tx
    .select({ id: fields.id })
    .from(fields)
    .where(inArray(fields.id, ids))
    .all()
    .map((r: { id: string }) => r.id)
  const missing = ids.filter((id) => !found.includes(id))
  if (missing.length > 0) {
    throw new SourceValidationError(`Unknown source field(s): ${missing.join(', ')}`, {
      missing,
    })
  }
}

/** Reads current provenance back out in the shape the API accepts. */
export function getFieldSource(tx: any, fieldId: string): FieldSourceInput | null {
  const field = tx.select().from(fields).where(eq(fields.id, fieldId)).all()[0]
  if (!field) return null

  const deps = tx
    .select()
    .from(fieldDependencies)
    .where(eq(fieldDependencies.fieldId, fieldId))
    .all()

  if (field.sourceKind === 'reference') {
    return {
      sourceKind: 'reference',
      sourceFieldId: deps[0]?.sourceFieldId ?? '',
      sourceNotes: field.sourceNotes,
    }
  }
  if (field.sourceKind === 'derived') {
    return {
      sourceKind: 'derived',
      sourceExpression: field.sourceExpression ?? '',
      derivationLanguage: field.derivationLanguage,
      dependsOn: deps.map((d: { sourceFieldId: string }) => d.sourceFieldId),
      sourceNotes: field.sourceNotes,
    }
  }
  return {
    sourceKind: 'user_entry',
    isExternallyPopulated: field.isExternallyPopulated,
    sourceNotes: field.sourceNotes,
  }
}

/** Fields whose provenance violates the invariant. Backs the integrity report. */
export function findInvariantViolations(tx: any) {
  const rows = tx
    .select({
      id: fields.id,
      apiName: fields.apiName,
      label: fields.label,
      recordId: fields.recordId,
      sourceKind: fields.sourceKind,
      sourceExpression: fields.sourceExpression,
    })
    .from(fields)
    .all()

  const depCounts = new Map<string, number>()
  for (const dep of tx.select().from(fieldDependencies).all()) {
    depCounts.set(dep.fieldId, (depCounts.get(dep.fieldId) ?? 0) + 1)
  }

  const violations: Array<{ field: (typeof rows)[number]; problem: string }> = []
  for (const field of rows) {
    const count = depCounts.get(field.id) ?? 0
    if (field.sourceKind === 'user_entry' && count > 0) {
      violations.push({
        field,
        problem: `Marked as user entry but has ${count} upstream dependenc${count === 1 ? 'y' : 'ies'}`,
      })
    }
    if (field.sourceKind === 'reference' && count !== 1) {
      violations.push({
        field,
        problem:
          count === 0
            ? 'Marked as a reference but no upstream field is recorded'
            : `Marked as a reference but has ${count} upstream fields — a reference has exactly one`,
      })
    }
    if (field.sourceKind === 'derived' && !field.sourceExpression) {
      violations.push({ field, problem: 'Marked as derived but has no expression' })
    }
  }
  return violations
}


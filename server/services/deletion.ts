import { eq, inArray } from 'drizzle-orm'
import { fieldDependencies, fields, records } from '../db/schema'

/**
 * Safe deletion with an impact pre-flight.
 *
 * The database will refuse to delete a field that feeds others (the `restrict` on
 * field_dependencies.source_field_id), which is the behaviour we want — but a raw
 * SQLITE_CONSTRAINT tells the user nothing. These helpers answer "what exactly is in
 * the way" first, so the API can return the blocking list instead of an opaque error.
 */

export interface Dependent {
  fieldId: string
  fieldApiName: string
  fieldLabel: string
  recordId: string
  recordApiName: string
  kind: string
}

/** Fields elsewhere that consume any of the given fields. */
export function findDependents(tx: any, fieldIds: string[]): Dependent[] {
  if (fieldIds.length === 0) return []
  return tx
    .select({
      fieldId: fields.id,
      fieldApiName: fields.apiName,
      fieldLabel: fields.label,
      recordId: records.id,
      recordApiName: records.apiName,
      kind: fieldDependencies.kind,
    })
    .from(fieldDependencies)
    .innerJoin(fields, eq(fields.id, fieldDependencies.fieldId))
    .innerJoin(records, eq(records.id, fields.recordId))
    .where(inArray(fieldDependencies.sourceFieldId, fieldIds))
    .all()
    // A field depending on another field of the same doomed set is not a blocker —
    // both are going away together.
    .filter((d: Dependent) => !fieldIds.includes(d.fieldId))
}

export class DeleteBlockedError extends Error {
  constructor(
    message: string,
    readonly dependents: Dependent[],
  ) {
    super(message)
    this.name = 'DeleteBlockedError'
  }
}

/**
 * Delete a field.
 *
 * Blocks when other fields derive from it, unless `force`, which drops those edges
 * and leaves the dependent fields with their provenance broken — recorded rather than
 * silently erased, so the integrity report picks them up.
 */
export function deleteField(tx: any, fieldId: string, force = false): Dependent[] {
  const dependents = findDependents(tx, [fieldId])

  if (dependents.length > 0) {
    if (!force) {
      throw new DeleteBlockedError(
        `${dependents.length} other field${dependents.length === 1 ? '' : 's'} depend${dependents.length === 1 ? 's' : ''} on this one`,
        dependents,
      )
    }
    tx.delete(fieldDependencies).where(eq(fieldDependencies.sourceFieldId, fieldId)).run()
  }

  tx.delete(fields).where(eq(fields.id, fieldId)).run()
  return dependents
}

/**
 * Delete a record and everything on it.
 *
 * `PRAGMA defer_foreign_keys` is what makes this work: without it the cascade to
 * fields trips the dependency `restrict` even when both ends of the dependency are on
 * the record being deleted. Deferring FK checks to commit time means self-contained
 * dependencies resolve naturally, while a field feeding some *other* record still
 * blocks — exactly the semantics we want, enforced by the database rather than by
 * hand-rolled bookkeeping.
 */
export function deleteRecord(tx: any, recordId: string, force = false): Dependent[] {
  const ownFieldIds = tx
    .select({ id: fields.id })
    .from(fields)
    .where(eq(fields.recordId, recordId))
    .all()
    .map((r: { id: string }) => r.id)

  const dependents = findDependents(tx, ownFieldIds)

  if (dependents.length > 0) {
    if (!force) {
      throw new DeleteBlockedError(
        `${dependents.length} field${dependents.length === 1 ? '' : 's'} on other records depend on this record`,
        dependents,
      )
    }
    if (ownFieldIds.length > 0) {
      tx.delete(fieldDependencies)
        .where(inArray(fieldDependencies.sourceFieldId, ownFieldIds))
        .run()
    }
  }

  tx.run('PRAGMA defer_foreign_keys = ON')
  tx.delete(records).where(eq(records.id, recordId)).run()
  return dependents
}

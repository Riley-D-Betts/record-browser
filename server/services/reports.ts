import { eq } from 'drizzle-orm'
import {
  dataTypes,
  fieldDependencies,
  fields,
  records,
  relationships,
} from '../db/schema'
import { findAllCycles } from './lineage'
import { findInvariantViolations } from './fieldSource'
import type { DependencyEdge } from './lineage'

/**
 * Data-quality reports.
 *
 * These are the payoff for having a catalog at all: questions a static ERD diagram
 * cannot answer. Each returns a flat list of findings so the UI can render them all
 * through one table component.
 */

export interface Finding {
  /** Where to send the user when they click through. */
  entityType: 'record' | 'field'
  entityId: string
  title: string
  detail: string
  /** Extra context rendered as chips. */
  context?: Record<string, string | null>
}

export interface ReportDefinition {
  key: string
  title: string
  description: string
  /** What the user should do about it. */
  guidance: string
}

export const REPORTS: ReportDefinition[] = [
  {
    key: 'cycles',
    title: 'Circular dependencies',
    description: 'Fields that ultimately depend on themselves.',
    guidance:
      'A cycle means no evaluation order exists. Break it by making one field in the loop a stored value rather than a computed one.',
  },
  {
    key: 'type-mismatches',
    title: 'Type mismatches',
    description:
      'Reference fields whose type disagrees with the field they are populated from.',
    guidance:
      'Either the reference is wrong or one of the two types is. Both are silent data-corruption risks a diagram will never show you.',
  },
  {
    key: 'broken-refs',
    title: 'Broken provenance',
    description: 'Fields whose recorded source does not match their source kind.',
    guidance:
      'Usually a half-finished edit or an import that could not resolve an upstream field. Re-set the source on the field.',
  },
  {
    key: 'orphans',
    title: 'Orphan records',
    description: 'Records in no relationship at all.',
    guidance:
      'Either genuinely standalone, or the relationship was never documented. Most orphans are the latter.',
  },
  {
    key: 'unused-fields',
    title: 'Unused fields',
    description:
      'Fields nothing reads: not a key, not required, and no other field sources from them.',
    guidance:
      'Deletion candidates. Verify against real usage before removing — the catalog knows about documented reads, not runtime ones.',
  },
  {
    key: 'identity-drift',
    title: 'Identity problems',
    description:
      'Missing source IDs, duplicated identifiers, and labels that disagree with technical names.',
    guidance:
      'The whole point of tracking three identities is that they stay in step. These are where they have not.',
  },
  {
    key: 'external-origins',
    title: 'Externally populated fields',
    description:
      'Fields flagged as written by an integration or job rather than by a person.',
    guidance:
      'These look like origin points to lineage but are not. Confirm each still has a live upstream process.',
  },
]

function loadEdges(db: any): DependencyEdge[] {
  return db
    .select({
      id: fieldDependencies.id,
      fieldId: fieldDependencies.fieldId,
      sourceFieldId: fieldDependencies.sourceFieldId,
      kind: fieldDependencies.kind,
    })
    .from(fieldDependencies)
    .all()
}

interface FieldWithRecord {
  id: string
  apiName: string
  label: string
  externalId: string | null
  recordId: string
  recordApiName: string
  recordLabel: string
  dataTypeKey: string | null
  dataTypeLabel: string | null
  sourceKind: string
  isRequired: boolean
  isPrimaryKey: boolean
  isDeprecated: boolean
  isExternallyPopulated: boolean
  sourceNotes: string | null
}

function loadFields(db: any): FieldWithRecord[] {
  return db
    .select({
      id: fields.id,
      apiName: fields.apiName,
      label: fields.label,
      externalId: fields.externalId,
      recordId: records.id,
      recordApiName: records.apiName,
      recordLabel: records.label,
      dataTypeKey: dataTypes.key,
      dataTypeLabel: dataTypes.label,
      sourceKind: fields.sourceKind,
      isRequired: fields.isRequired,
      isPrimaryKey: fields.isPrimaryKey,
      isDeprecated: fields.isDeprecated,
      isExternallyPopulated: fields.isExternallyPopulated,
      sourceNotes: fields.sourceNotes,
    })
    .from(fields)
    .innerJoin(records, eq(records.id, fields.recordId))
    .leftJoin(dataTypes, eq(dataTypes.id, fields.dataTypeId))
    .all()
}

const qualify = (f: { recordApiName: string; apiName: string }) =>
  `${f.recordApiName}.${f.apiName}`

export function runReport(db: any, key: string): Finding[] {
  switch (key) {
    case 'cycles':
      return cycles(db)
    case 'type-mismatches':
      return typeMismatches(db)
    case 'broken-refs':
      return brokenRefs(db)
    case 'orphans':
      return orphans(db)
    case 'unused-fields':
      return unusedFields(db)
    case 'identity-drift':
      return identityDrift(db)
    case 'external-origins':
      return externalOrigins(db)
    default:
      throw createError({ statusCode: 404, statusMessage: `Unknown report: ${key}` })
  }
}

function cycles(db: any): Finding[] {
  const byId = new Map(loadFields(db).map((f) => [f.id, f]))
  return findAllCycles(loadEdges(db)).map((cycle) => {
    const names = cycle.map((id) => {
      const f = byId.get(id)
      return f ? qualify(f) : id
    })
    const head = byId.get(cycle[0]!)
    return {
      entityType: 'field' as const,
      entityId: cycle[0]!,
      title: `${cycle.length} field${cycle.length === 1 ? '' : 's'} in a dependency loop`,
      detail:
        cycle.length === 1
          ? `${names[0]} depends on itself.`
          : `${names.join(' → ')} → ${names[0]}`,
      context: { Record: head?.recordLabel ?? null },
    }
  })
}

/**
 * A reference field should carry the same type as the field feeding it. When it does
 * not, either the reference is pointed at the wrong field or one of the two types is
 * wrong — both silent corruption risks, and both invisible on a diagram.
 */
function typeMismatches(db: any): Finding[] {
  const byId = new Map(loadFields(db).map((f) => [f.id, f]))
  const findings: Finding[] = []

  for (const edge of loadEdges(db)) {
    if (edge.kind !== 'reference') continue
    const consumer = byId.get(edge.fieldId)
    const producer = byId.get(edge.sourceFieldId)
    if (!consumer || !producer) continue
    if (!consumer.dataTypeKey || !producer.dataTypeKey) continue
    if (consumer.dataTypeKey === producer.dataTypeKey) continue

    findings.push({
      entityType: 'field',
      entityId: consumer.id,
      title: `${qualify(consumer)} is a ${consumer.dataTypeLabel}, but sources from a ${producer.dataTypeLabel}`,
      detail: `Populated from ${qualify(producer)}. The types disagree, so values may be truncated or coerced on the way across.`,
      context: {
        'This field': consumer.dataTypeLabel,
        'Source field': producer.dataTypeLabel,
      },
    })
  }
  return findings
}

function brokenRefs(db: any): Finding[] {
  const byId = new Map(loadFields(db).map((f) => [f.id, f]))
  return findInvariantViolations(db).map((v: any) => {
    const f = byId.get(v.field.id)
    return {
      entityType: 'field' as const,
      entityId: v.field.id,
      title: f ? qualify(f) : v.field.apiName,
      detail: v.problem,
      context: { 'Source kind': v.field.sourceKind },
    }
  })
}

function orphans(db: any): Finding[] {
  const linked = new Set<string>()
  for (const rel of db.select().from(relationships).all()) {
    linked.add(rel.parentRecordId)
    linked.add(rel.childRecordId)
  }

  return db
    .select()
    .from(records)
    .all()
    .filter((r: any) => !linked.has(r.id) && !r.isDeprecated)
    .map((r: any) => ({
      entityType: 'record' as const,
      entityId: r.id,
      title: `${r.label} (${r.apiName})`,
      detail: 'Appears in no relationship, as either parent or child.',
      context: { Origin: r.origin, 'Source ID': r.externalId },
    }))
}

function unusedFields(db: any): Finding[] {
  const consumed = new Set(loadEdges(db).map((e) => e.sourceFieldId))

  return loadFields(db)
    .filter(
      (f) =>
        !consumed.has(f.id) &&
        !f.isPrimaryKey &&
        !f.isRequired &&
        !f.isDeprecated &&
        f.sourceKind === 'user_entry' &&
        !f.isExternallyPopulated,
    )
    .map((f) => ({
      entityType: 'field' as const,
      entityId: f.id,
      title: qualify(f),
      detail:
        'Not a key, not required, and no other field is populated from it. Nothing in the catalog reads this.',
      context: { Record: f.recordLabel, Type: f.dataTypeLabel },
    }))
}

/**
 * The three-identity model is only worth having if the identities stay in step.
 * Rules are kept few and mechanical — a fuzzy report nobody trusts gets ignored.
 */
function identityDrift(db: any): Finding[] {
  const findings: Finding[] = []
  const allRecords = db.select().from(records).all()
  const allFields = loadFields(db)

  const seenRecordExternal = new Map<string, string>()
  for (const r of allRecords) {
    if (!r.externalId) {
      findings.push({
        entityType: 'record',
        entityId: r.id,
        title: `${r.label} has no source ID`,
        detail:
          'Cannot be matched against an export from the source system, so re-imports will create a duplicate rather than update it.',
        context: { 'Technical name': r.apiName },
      })
      continue
    }
    const prior = seenRecordExternal.get(r.externalId)
    if (prior) {
      findings.push({
        entityType: 'record',
        entityId: r.id,
        title: `Source ID ${r.externalId} is used by two records`,
        detail: `Shared with ${prior}. A source ID must identify exactly one record.`,
      })
    } else {
      seenRecordExternal.set(r.externalId, r.apiName)
    }
  }

  const seenFieldExternal = new Map<string, string>()
  for (const f of allFields) {
    if (f.externalId) {
      const prior = seenFieldExternal.get(f.externalId)
      if (prior) {
        findings.push({
          entityType: 'field',
          entityId: f.id,
          title: `Source ID ${f.externalId} is used by two fields`,
          detail: `Shared with ${prior}.`,
        })
      } else {
        seenFieldExternal.set(f.externalId, qualify(f))
      }
    }

    // A label that is just the technical name means nobody wrote a human name.
    if (f.label === f.apiName && /[_.]/.test(f.apiName)) {
      findings.push({
        entityType: 'field',
        entityId: f.id,
        title: `${qualify(f)} has no human label`,
        detail: `The display label is identical to the technical name (${f.apiName}). Anyone reading the ERD sees the raw identifier.`,
        context: { Record: f.recordLabel },
      })
    }
  }

  return findings
}

function externalOrigins(db: any): Finding[] {
  return loadFields(db)
    .filter((f) => f.isExternallyPopulated)
    .map((f) => ({
      entityType: 'field' as const,
      entityId: f.id,
      title: qualify(f),
      detail:
        f.sourceNotes ??
        'Flagged as written by an integration or job. Lineage treats it as an external origin rather than a person typing it.',
      context: { Record: f.recordLabel, Type: f.dataTypeLabel },
    }))
}

/** Counts for every report in one pass, for the dashboard. */
export function reportSummary(db: any) {
  return REPORTS.map((def) => ({
    ...def,
    count: runReport(db, def.key).length,
  }))
}


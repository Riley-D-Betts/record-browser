import { eq } from 'drizzle-orm'
import {
  dataTypes,
  fieldDependencies,
  fields,
  modules,
  records,
  relationships,
} from '../db/schema'
import { setFieldSource } from './fieldSource'

/**
 * The canonical JSON shape, used by both export and import.
 *
 * References are by human-readable key (`Record.field`), never by internal UUID. That
 * makes an export portable between installs, readable in a review, and — the real
 * payoff — diffable in git. Commit one per release and `git diff` shows exactly what
 * changed in the source application's schema between them.
 */

export const INTERCHANGE_VERSION = 1

export interface InterchangeDocument {
  $schema: string
  version: number
  exportedAt: string
  dataTypes: Array<Record<string, unknown>>
  modules: Array<Record<string, unknown>>
  records: Array<Record<string, unknown>>
  relationships: Array<Record<string, unknown>>
}

export function exportCatalog(db: any, exportedAt: string): InterchangeDocument {
  const typeById = new Map(db.select().from(dataTypes).all().map((t: any) => [t.id, t]))
  const moduleById = new Map(db.select().from(modules).all().map((m: any) => [m.id, m]))
  const recordRows = db.select().from(records).orderBy(records.apiName).all()
  const fieldRows = db.select().from(fields).orderBy(fields.sortOrder, fields.apiName).all()
  const depRows = db.select().from(fieldDependencies).all()

  const fieldById = new Map(fieldRows.map((f: any) => [f.id, f]))
  const recordById = new Map(recordRows.map((r: any) => [r.id, r]))

  /** A field reference as `Record.field`, stable across installs. */
  const ref = (fieldId: string) => {
    const f: any = fieldById.get(fieldId)
    if (!f) return null
    const r: any = recordById.get(f.recordId)
    return r ? { record: r.apiName, field: f.apiName } : null
  }

  const depsByField = new Map<string, any[]>()
  for (const dep of depRows) {
    const list = depsByField.get(dep.fieldId) ?? []
    list.push(dep)
    depsByField.set(dep.fieldId, list)
  }

  const fieldsByRecord = new Map<string, any[]>()
  for (const f of fieldRows) {
    const list = fieldsByRecord.get(f.recordId) ?? []
    list.push(f)
    fieldsByRecord.set(f.recordId, list)
  }

  const serialiseSource = (field: any) => {
    const deps = depsByField.get(field.id) ?? []
    if (field.sourceKind === 'reference') {
      return { kind: 'reference', from: ref(deps[0]?.sourceFieldId) }
    }
    if (field.sourceKind === 'derived') {
      return {
        kind: 'derived',
        expression: field.sourceExpression,
        language: field.derivationLanguage,
        dependsOn: deps.map((d) => ref(d.sourceFieldId)).filter(Boolean),
      }
    }
    return {
      kind: 'user_entry',
      externallyPopulated: field.isExternallyPopulated || undefined,
      notes: field.sourceNotes || undefined,
    }
  }

  const omitEmpty = <T extends Record<string, unknown>>(obj: T) =>
    Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== false),
    )

  return {
    $schema: 'record-browser/catalog-v1',
    version: INTERCHANGE_VERSION,
    exportedAt,
    dataTypes: db
      .select()
      .from(dataTypes)
      .orderBy(dataTypes.sortOrder)
      .all()
      .map((t: any) =>
        omitEmpty({
          key: t.key,
          label: t.label,
          category: t.category,
          description: t.description,
          supportsLength: t.supportsLength,
          supportsPrecision: t.supportsPrecision,
          supportsScale: t.supportsScale,
          supportsOptions: t.supportsOptions,
        }),
      ),
    modules: db
      .select()
      .from(modules)
      .orderBy(modules.sortOrder)
      .all()
      .map((m: any) =>
        omitEmpty({ key: m.key, name: m.name, description: m.description, color: m.color }),
      ),
    records: recordRows.map((r: any) =>
      omitEmpty({
        apiName: r.apiName,
        label: r.label,
        externalId: r.externalId,
        module: r.moduleId ? (moduleById.get(r.moduleId) as any)?.key : null,
        origin: r.origin,
        description: r.description,
        deprecated: r.isDeprecated || undefined,
        fields: (fieldsByRecord.get(r.id) ?? []).map((f: any) =>
          omitEmpty({
            apiName: f.apiName,
            label: f.label,
            externalId: f.externalId,
            type: f.dataTypeId ? (typeById.get(f.dataTypeId) as any)?.key : null,
            typeDetail: f.typeDetail ? JSON.parse(f.typeDetail) : null,
            origin: f.origin,
            required: f.isRequired || undefined,
            unique: f.isUnique || undefined,
            primaryKey: f.isPrimaryKey || undefined,
            deprecated: f.isDeprecated || undefined,
            description: f.description,
            source: serialiseSource(f),
          }),
        ),
      }),
    ),
    relationships: db
      .select()
      .from(relationships)
      .all()
      .map((rel: any) =>
        omitEmpty({
          parent: (recordById.get(rel.parentRecordId) as any)?.apiName,
          child: (recordById.get(rel.childRecordId) as any)?.apiName,
          via: rel.viaFieldId ? ref(rel.viaFieldId) : null,
          cardinality: rel.cardinality,
          identifying: rel.isIdentifying || undefined,
          onDelete: rel.onDelete,
          label: rel.label,
          description: rel.description,
        }),
      ),
  }
}

export interface ImportSummary {
  dataTypes: number
  modules: number
  records: number
  fields: number
  relationships: number
  /**
   * Rows the document described that already existed and were therefore left alone.
   *
   * This path only ever inserts. Without these counts a re-import of a changed export
   * reports "0 records, 0 fields" and looks like a no-op file rather than forty
   * dropped updates. Use the CSV importer when you want existing rows updated.
   */
  skippedExisting: { records: number; fields: number }
  warnings: string[]
}

/**
 * Import a catalog document.
 *
 * Written in dependency order — types, modules, records, fields, then provenance and
 * relationships — because an edge cannot be written before both of its endpoints
 * exist. Provenance is applied last, in a second pass over all fields, so a forward
 * reference to a record defined later in the file still resolves.
 *
 * Cycles are recorded rather than rejected: a document is imported whole or not at
 * all, and refusing the entire file over one circular formula would be useless. They
 * surface in the cycles report instead.
 */
export function importCatalog(
  tx: any,
  doc: InterchangeDocument,
  actorId: string | null,
): ImportSummary {
  const warnings: string[] = []
  const summary: ImportSummary = {
    dataTypes: 0,
    modules: 0,
    records: 0,
    fields: 0,
    relationships: 0,
    skippedExisting: { records: 0, fields: 0 },
    warnings,
  }

  const typeIdByKey = new Map<string, string>()
  for (const row of tx.select().from(dataTypes).all()) typeIdByKey.set(row.key, row.id)
  for (const type of doc.dataTypes ?? []) {
    const key = type.key as string
    if (typeIdByKey.has(key)) continue
    const created = tx
      .insert(dataTypes)
      .values({
        key,
        label: (type.label as string) ?? key,
        category: (type.category as any) ?? 'other',
        description: (type.description as string) ?? null,
        supportsLength: Boolean(type.supportsLength),
        supportsPrecision: Boolean(type.supportsPrecision),
        supportsScale: Boolean(type.supportsScale),
        supportsOptions: Boolean(type.supportsOptions),
      })
      .returning()
      .all()[0]
    typeIdByKey.set(key, created.id)
    summary.dataTypes++
  }

  const moduleIdByKey = new Map<string, string>()
  for (const row of tx.select().from(modules).all()) moduleIdByKey.set(row.key, row.id)
  for (const mod of doc.modules ?? []) {
    const key = mod.key as string
    if (moduleIdByKey.has(key)) continue
    const created = tx
      .insert(modules)
      .values({
        key,
        name: (mod.name as string) ?? key,
        description: (mod.description as string) ?? null,
        color: (mod.color as string) ?? null,
      })
      .returning()
      .all()[0]
    moduleIdByKey.set(key, created.id)
    summary.modules++
  }

  const recordIdByApiName = new Map<string, string>()
  for (const row of tx.select().from(records).all()) {
    recordIdByApiName.set(row.apiName, row.id)
  }
  const fieldIdByRef = new Map<string, string>()
  for (const row of tx
    .select({ id: fields.id, apiName: fields.apiName, recordApiName: records.apiName })
    .from(fields)
    .innerJoin(records, eq(records.id, fields.recordId))
    .all()) {
    fieldIdByRef.set(`${row.recordApiName}.${row.apiName}`, row.id)
  }

  // Pass 1 — records and fields, provenance deferred.
  const deferredSources: Array<{ fieldId: string; source: any; ref: string }> = []

  for (const rec of doc.records ?? []) {
    const apiName = rec.apiName as string
    let recordId = recordIdByApiName.get(apiName)

    if (!recordId) {
      recordId = tx
        .insert(records)
        .values({
          apiName,
          label: (rec.label as string) ?? apiName,
          externalId: (rec.externalId as string) ?? null,
          moduleId: rec.module ? (moduleIdByKey.get(rec.module as string) ?? null) : null,
          origin: (rec.origin as any) ?? 'custom',
          description: (rec.description as string) ?? null,
          isDeprecated: Boolean(rec.deprecated),
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning()
        .all()[0].id
      recordIdByApiName.set(apiName, recordId!)
      summary.records++
    } else {
      summary.skippedExisting.records++
    }

    const incomingFields = (rec.fields as Array<Record<string, unknown>>) ?? []
    for (const [index, f] of incomingFields.entries()) {
      const fieldApiName = f.apiName as string
      const refKey = `${apiName}.${fieldApiName}`
      let fieldId = fieldIdByRef.get(refKey)

      const typeKey = f.type as string | undefined
      if (typeKey && !typeIdByKey.has(typeKey)) {
        warnings.push(`Unknown data type "${typeKey}" on ${refKey} — left unset`)
      }

      if (!fieldId) {
        fieldId = tx
          .insert(fields)
          .values({
            recordId,
            apiName: fieldApiName,
            label: (f.label as string) ?? fieldApiName,
            externalId: (f.externalId as string) ?? null,
            dataTypeId: typeKey ? (typeIdByKey.get(typeKey) ?? null) : null,
            typeDetail: f.typeDetail ? JSON.stringify(f.typeDetail) : null,
            origin: (f.origin as any) ?? 'custom',
            isRequired: Boolean(f.required),
            isUnique: Boolean(f.unique),
            isPrimaryKey: Boolean(f.primaryKey),
            isDeprecated: Boolean(f.deprecated),
            description: (f.description as string) ?? null,
            // Array position *is* the field order. Carrying it implicitly keeps the
            // JSON free of a noisy index while still round-tripping the ordering,
            // which matters: fields are read in the order the source system lists
            // them, not alphabetically.
            sortOrder: index,
            createdBy: actorId,
            updatedBy: actorId,
          })
          .returning()
          .all()[0].id
        fieldIdByRef.set(refKey, fieldId!)
        summary.fields++
      } else {
        summary.skippedExisting.fields++
      }

      if (f.source) deferredSources.push({ fieldId: fieldId!, source: f.source, ref: refKey })
    }
  }

  // Pass 2 — provenance, now that every field referenced by the document exists.
  const resolve = (r: unknown): string | null => {
    if (!r || typeof r !== 'object') return null
    const { record, field } = r as { record?: string; field?: string }
    if (!record || !field) return null
    return fieldIdByRef.get(`${record}.${field}`) ?? null
  }

  for (const { fieldId, source, ref: refKey } of deferredSources) {
    const kind = source.kind as string

    if (kind === 'reference') {
      const sourceFieldId = resolve(source.from)
      if (!sourceFieldId) {
        warnings.push(
          `${refKey} references ${source.from?.record}.${source.from?.field}, which is not in this document or the catalog — left as user entry`,
        )
        continue
      }
      setFieldSource(tx, fieldId, { sourceKind: 'reference', sourceFieldId }, { allowCycles: true })
    } else if (kind === 'derived') {
      const dependsOn = ((source.dependsOn as unknown[]) ?? [])
        .map(resolve)
        .filter((v): v is string => Boolean(v))
      const unresolved = ((source.dependsOn as unknown[]) ?? []).length - dependsOn.length
      if (unresolved > 0) {
        warnings.push(
          `${refKey} has ${unresolved} unresolved dependenc${unresolved === 1 ? 'y' : 'ies'} — the expression is recorded but the lineage is incomplete`,
        )
      }
      setFieldSource(
        tx,
        fieldId,
        {
          sourceKind: 'derived',
          sourceExpression: (source.expression as string) || '(expression not supplied)',
          derivationLanguage: source.language ?? null,
          dependsOn,
        },
        { allowCycles: true },
      )
    } else {
      setFieldSource(
        tx,
        fieldId,
        {
          sourceKind: 'user_entry',
          isExternallyPopulated: Boolean(source.externallyPopulated),
          sourceNotes: (source.notes as string) ?? null,
        },
        { allowCycles: true },
      )
    }
  }

  // Pass 3 — relationships, which need both records and the linking field.
  const existingRelationships = new Set(
    tx
      .select()
      .from(relationships)
      .all()
      .map((r: any) => `${r.parentRecordId}>${r.childRecordId}>${r.viaFieldId ?? ''}`),
  )

  for (const rel of doc.relationships ?? []) {
    const parentId = recordIdByApiName.get(rel.parent as string)
    const childId = recordIdByApiName.get(rel.child as string)
    if (!parentId || !childId) {
      warnings.push(
        `Relationship ${rel.parent} → ${rel.child} skipped: one end is not in the catalog`,
      )
      continue
    }
    const viaId = rel.via ? resolve(rel.via) : null
    if (existingRelationships.has(`${parentId}>${childId}>${viaId ?? ''}`)) continue

    tx.insert(relationships)
      .values({
        parentRecordId: parentId,
        childRecordId: childId,
        viaFieldId: viaId,
        cardinality: (rel.cardinality as any) ?? 'one_to_many',
        isIdentifying: Boolean(rel.identifying),
        onDelete: (rel.onDelete as any) ?? 'none',
        label: (rel.label as string) ?? null,
        description: (rel.description as string) ?? null,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .run()
    summary.relationships++
  }

  return summary
}

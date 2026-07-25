import { eq, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import {
  dataTypes,
  fieldDependencies,
  fields,
  modules,
  records,
  relationships,
  useDb,
} from '../../db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = useDb()

  const record = db
    .select({
      id: records.id,
      apiName: records.apiName,
      label: records.label,
      externalId: records.externalId,
      origin: records.origin,
      description: records.description,
      isDeprecated: records.isDeprecated,
      createdAt: records.createdAt,
      updatedAt: records.updatedAt,
      moduleId: records.moduleId,
      moduleKey: modules.key,
      moduleName: modules.name,
      moduleColor: modules.color,
    })
    .from(records)
    .leftJoin(modules, eq(modules.id, records.moduleId))
    .where(eq(records.id, id))
    .all()[0]

  if (!record) throw createError({ statusCode: 404, statusMessage: 'No such record' })

  const sourceField = alias(fields, 'source_field')
  const sourceRecord = alias(records, 'source_record')

  const recordFields = db
    .select({
      id: fields.id,
      apiName: fields.apiName,
      label: fields.label,
      externalId: fields.externalId,
      origin: fields.origin,
      sourceKind: fields.sourceKind,
      sourceExpression: fields.sourceExpression,
      derivationLanguage: fields.derivationLanguage,
      isExternallyPopulated: fields.isExternallyPopulated,
      sourceNotes: fields.sourceNotes,
      isRequired: fields.isRequired,
      isUnique: fields.isUnique,
      isPrimaryKey: fields.isPrimaryKey,
      isDeprecated: fields.isDeprecated,
      description: fields.description,
      sortOrder: fields.sortOrder,
      dataTypeId: fields.dataTypeId,
      dataTypeKey: dataTypes.key,
      dataTypeLabel: dataTypes.label,
    })
    .from(fields)
    .leftJoin(dataTypes, eq(dataTypes.id, fields.dataTypeId))
    .where(eq(fields.recordId, id))
    .orderBy(fields.sortOrder, fields.apiName)
    .all()

  // Upstream fields feeding anything on this record — the "what feeds us" summary.
  const incoming = db
    .select({
      fieldId: fieldDependencies.fieldId,
      kind: fieldDependencies.kind,
      sourceFieldId: sourceField.id,
      sourceFieldApiName: sourceField.apiName,
      sourceFieldLabel: sourceField.label,
      sourceRecordId: sourceRecord.id,
      sourceRecordApiName: sourceRecord.apiName,
      sourceRecordLabel: sourceRecord.label,
    })
    .from(fieldDependencies)
    .innerJoin(fields, eq(fields.id, fieldDependencies.fieldId))
    .innerJoin(sourceField, eq(sourceField.id, fieldDependencies.sourceFieldId))
    .innerJoin(sourceRecord, eq(sourceRecord.id, sourceField.recordId))
    .where(eq(fields.recordId, id))
    .all()

  const parentRecord = alias(records, 'parent_record')
  const childRecord = alias(records, 'child_record')

  const recordRelationships = db
    .select({
      id: relationships.id,
      cardinality: relationships.cardinality,
      isIdentifying: relationships.isIdentifying,
      onDelete: relationships.onDelete,
      label: relationships.label,
      viaFieldId: relationships.viaFieldId,
      parentRecordId: parentRecord.id,
      parentApiName: parentRecord.apiName,
      parentLabel: parentRecord.label,
      childRecordId: childRecord.id,
      childApiName: childRecord.apiName,
      childLabel: childRecord.label,
    })
    .from(relationships)
    .innerJoin(parentRecord, eq(parentRecord.id, relationships.parentRecordId))
    .innerJoin(childRecord, eq(childRecord.id, relationships.childRecordId))
    .where(
      or(eq(relationships.parentRecordId, id), eq(relationships.childRecordId, id)),
    )
    .all()

  return {
    ...record,
    fields: recordFields,
    incoming,
    relationships: recordRelationships,
  }
})

import { eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { dataTypes, fieldDependencies, fields, modules, records, useDb } from '../../db'
import { findDependents } from '../../services/deletion'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = useDb()

  const field = db
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
      typeDetail: fields.typeDetail,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt,
      dataTypeId: fields.dataTypeId,
      dataTypeKey: dataTypes.key,
      dataTypeLabel: dataTypes.label,
      recordId: records.id,
      recordApiName: records.apiName,
      recordLabel: records.label,
      moduleId: modules.id,
      moduleName: modules.name,
      moduleColor: modules.color,
    })
    .from(fields)
    .innerJoin(records, eq(records.id, fields.recordId))
    .leftJoin(modules, eq(modules.id, records.moduleId))
    .leftJoin(dataTypes, eq(dataTypes.id, fields.dataTypeId))
    .where(eq(fields.id, id))
    .all()[0]

  if (!field) throw createError({ statusCode: 404, statusMessage: 'No such field' })

  const upstreamField = alias(fields, 'upstream_field')
  const upstreamRecord = alias(records, 'upstream_record')

  const upstream = db
    .select({
      dependencyId: fieldDependencies.id,
      kind: fieldDependencies.kind,
      note: fieldDependencies.note,
      fieldId: upstreamField.id,
      apiName: upstreamField.apiName,
      label: upstreamField.label,
      recordId: upstreamRecord.id,
      recordApiName: upstreamRecord.apiName,
      recordLabel: upstreamRecord.label,
    })
    .from(fieldDependencies)
    .innerJoin(upstreamField, eq(upstreamField.id, fieldDependencies.sourceFieldId))
    .innerJoin(upstreamRecord, eq(upstreamRecord.id, upstreamField.recordId))
    .where(eq(fieldDependencies.fieldId, id))
    .all()

  return { ...field, upstream, downstream: findDependents(db, [id]) }
})

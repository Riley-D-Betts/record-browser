import { and, asc, desc, eq, or } from 'drizzle-orm'
import { dataTypes, fields, modules, records, useDb } from '../../db'
import { fieldQuerySchema } from '../../../shared/schemas'
import { containsText } from '../../lib/search'

export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, fieldQuerySchema.parse)
  const db = useDb()

  const filters = []
  if (q.recordId) filters.push(eq(fields.recordId, q.recordId))
  if (q.moduleId) filters.push(eq(records.moduleId, q.moduleId))
  if (q.origin) filters.push(eq(fields.origin, q.origin))
  if (q.sourceKind) filters.push(eq(fields.sourceKind, q.sourceKind))
  if (q.dataTypeId) filters.push(eq(fields.dataTypeId, q.dataTypeId))
  if (!q.includeDeprecated) filters.push(eq(fields.isDeprecated, false))
  if (q.q) {
    filters.push(
      or(
        containsText(fields.apiName, q.q),
        containsText(fields.label, q.q),
        containsText(fields.externalId, q.q),
        containsText(fields.description, q.q),
        containsText(fields.sourceExpression, q.q),
        containsText(records.apiName, q.q),
        containsText(records.label, q.q),
      )!,
    )
  }
  const where = filters.length > 0 ? and(...filters) : undefined

  const sortColumn = {
    apiName: fields.apiName,
    label: fields.label,
    updatedAt: fields.updatedAt,
  }[q.sort]

  const rows = db
    .select({
      id: fields.id,
      apiName: fields.apiName,
      label: fields.label,
      externalId: fields.externalId,
      origin: fields.origin,
      sourceKind: fields.sourceKind,
      sourceExpression: fields.sourceExpression,
      isExternallyPopulated: fields.isExternallyPopulated,
      isRequired: fields.isRequired,
      isPrimaryKey: fields.isPrimaryKey,
      isDeprecated: fields.isDeprecated,
      updatedAt: fields.updatedAt,
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
    .where(where)
    .orderBy(q.dir === 'desc' ? desc(sortColumn) : asc(sortColumn))
    .limit(q.perPage)
    .offset((q.page - 1) * q.perPage)
    .all()

  const total = db
    .select({ id: fields.id })
    .from(fields)
    .innerJoin(records, eq(records.id, fields.recordId))
    .where(where)
    .all().length

  return { rows, total, page: q.page, perPage: q.perPage }
})

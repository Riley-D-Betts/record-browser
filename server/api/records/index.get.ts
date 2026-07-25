import { and, asc, desc, eq, or, sql } from 'drizzle-orm'
import { fields, modules, records, relationships, useDb } from '../../db'
import { recordQuerySchema } from '../../../shared/schemas'
import { containsText } from '../../lib/search'

export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, recordQuerySchema.parse)
  const db = useDb()

  const filters = []
  if (q.moduleId) filters.push(eq(records.moduleId, q.moduleId))
  if (q.origin) filters.push(eq(records.origin, q.origin))
  if (!q.includeDeprecated) filters.push(eq(records.isDeprecated, false))
  if (q.q) {
    // Search hits all three identities. Someone pasting a source ID out of a log is
    // as common as someone typing a label, and both must land.
    filters.push(
      or(
        containsText(records.apiName, q.q),
        containsText(records.label, q.q),
        containsText(records.externalId, q.q),
        containsText(records.description, q.q),
      )!,
    )
  }
  const where = filters.length > 0 ? and(...filters) : undefined

  const fieldCount = db.$count(fields, eq(fields.recordId, records.id))

  const sortColumn = {
    apiName: records.apiName,
    label: records.label,
    updatedAt: records.updatedAt,
    fieldCount,
  }[q.sort]

  const rows = db
    .select({
      id: records.id,
      apiName: records.apiName,
      label: records.label,
      externalId: records.externalId,
      origin: records.origin,
      description: records.description,
      isDeprecated: records.isDeprecated,
      updatedAt: records.updatedAt,
      moduleId: records.moduleId,
      moduleKey: modules.key,
      moduleName: modules.name,
      moduleColor: modules.color,
      fieldCount,
      relationshipCount: sql<number>`(
        select count(*) from ${relationships}
        where ${relationships.parentRecordId} = ${records.id}
           or ${relationships.childRecordId} = ${records.id}
      )`,
    })
    .from(records)
    .leftJoin(modules, eq(modules.id, records.moduleId))
    .where(where)
    .orderBy(q.dir === 'desc' ? desc(sortColumn) : asc(sortColumn))
    .limit(q.perPage)
    .offset((q.page - 1) * q.perPage)
    .all()

  // Standalone $count returns an awaitable builder, unlike the in-select form above
  // which compiles to a correlated subquery.
  const total = await db.$count(records, where)

  return { rows, total, page: q.page, perPage: q.perPage }
})


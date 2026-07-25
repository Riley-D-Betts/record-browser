import { eq } from 'drizzle-orm'
import { dataTypes, fields, useDb } from '../../db'

export default defineEventHandler(async () => {
  const db = useDb()
  return db
    .select({
      id: dataTypes.id,
      key: dataTypes.key,
      label: dataTypes.label,
      category: dataTypes.category,
      description: dataTypes.description,
      isBuiltin: dataTypes.isBuiltin,
      supportsLength: dataTypes.supportsLength,
      supportsPrecision: dataTypes.supportsPrecision,
      supportsScale: dataTypes.supportsScale,
      supportsOptions: dataTypes.supportsOptions,
      sortOrder: dataTypes.sortOrder,
      usageCount: db.$count(fields, eq(fields.dataTypeId, dataTypes.id)),
    })
    .from(dataTypes)
    .orderBy(dataTypes.sortOrder, dataTypes.label)
    .all()
})

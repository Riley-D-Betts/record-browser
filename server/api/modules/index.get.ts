import { eq } from 'drizzle-orm'
import { modules, records, useDb } from '../../db'

export default defineEventHandler(async () => {
  const db = useDb()
  return db
    .select({
      id: modules.id,
      key: modules.key,
      name: modules.name,
      description: modules.description,
      color: modules.color,
      sortOrder: modules.sortOrder,
      recordCount: db.$count(records, eq(records.moduleId, modules.id)),
    })
    .from(modules)
    .orderBy(modules.sortOrder, modules.name)
    .all()
})

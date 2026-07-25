import { desc, eq } from 'drizzle-orm'
import {
  changeLog,
  dataTypes,
  fieldDependencies,
  fields,
  modules,
  records,
  relationships,
  useDb,
  users,
} from '../db'

export default defineEventHandler(async () => {
  const db = useDb()

  const allRecords = db.select().from(records).all()
  const allFields = db.select().from(fields).all()

  const countBy = <T, K extends string>(rows: T[], key: (row: T) => K) => {
    const out: Record<string, number> = {}
    for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1
    return out
  }

  const recent = db
    .select({
      id: changeLog.id,
      entityType: changeLog.entityType,
      entityId: changeLog.entityId,
      action: changeLog.action,
      changedFieldsJson: changeLog.changedFieldsJson,
      createdAt: changeLog.createdAt,
      userName: users.name,
    })
    .from(changeLog)
    .leftJoin(users, eq(users.id, changeLog.userId))
    .orderBy(desc(changeLog.createdAt))
    .limit(15)
    .all()

  return {
    totals: {
      records: allRecords.length,
      fields: allFields.length,
      modules: db.select().from(modules).all().length,
      relationships: db.select().from(relationships).all().length,
      dependencies: db.select().from(fieldDependencies).all().length,
      dataTypes: db.select().from(dataTypes).all().length,
    },
    recordsByOrigin: countBy(allRecords, (r) => r.origin),
    fieldsByOrigin: countBy(allFields, (f) => f.origin),
    fieldsBySourceKind: countBy(allFields, (f) => f.sourceKind),
    recentChanges: recent,
  }
})

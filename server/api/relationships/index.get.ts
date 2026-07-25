import { eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { fields, records, relationships, useDb } from '../../db'

export default defineEventHandler(async () => {
  const db = useDb()
  const parent = alias(records, 'parent_record')
  const child = alias(records, 'child_record')

  return db
    .select({
      id: relationships.id,
      cardinality: relationships.cardinality,
      isIdentifying: relationships.isIdentifying,
      onDelete: relationships.onDelete,
      label: relationships.label,
      description: relationships.description,
      parentRecordId: parent.id,
      parentApiName: parent.apiName,
      parentLabel: parent.label,
      childRecordId: child.id,
      childApiName: child.apiName,
      childLabel: child.label,
      viaFieldId: fields.id,
      viaFieldApiName: fields.apiName,
      viaFieldLabel: fields.label,
    })
    .from(relationships)
    .innerJoin(parent, eq(parent.id, relationships.parentRecordId))
    .innerJoin(child, eq(child.id, relationships.childRecordId))
    .leftJoin(fields, eq(fields.id, relationships.viaFieldId))
    .orderBy(parent.apiName, child.apiName)
    .all()
})

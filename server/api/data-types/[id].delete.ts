import { eq } from 'drizzle-orm'
import { dataTypes, fields, records, useDb } from '../../db'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

/**
 * `fields.data_type_id` is `set null`, so a delete would succeed and silently leave
 * every field that used the type with no type at all. That is precisely the sort of
 * quiet damage this catalog is meant to surface, so the delete is refused and the
 * fields still using it are named — the same contract as deleting a field with
 * dependents.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const db = useDb()

  return db.transaction((tx) => {
    const before = tx.select().from(dataTypes).where(eq(dataTypes.id, id)).all()[0]
    if (!before) throw createError({ statusCode: 404, statusMessage: 'No such field type' })

    if (before.isBuiltin) {
      throw createError({
        statusCode: 409,
        statusMessage: `"${before.label}" ships with the catalog and cannot be deleted.`,
      })
    }

    const dependents = tx
      .select({
        id: fields.id,
        apiName: fields.apiName,
        label: fields.label,
        recordApiName: records.apiName,
      })
      .from(fields)
      .innerJoin(records, eq(records.id, fields.recordId))
      .where(eq(fields.dataTypeId, id))
      .limit(25)
      .all()

    if (dependents.length > 0) {
      const one = dependents.length === 1
      const count = dependents.length === 25 ? '25+' : String(dependents.length)
      throw createError({
        statusCode: 409,
        statusMessage: `${count} field${one ? '' : 's'} still ${one ? 'uses' : 'use'} "${before.label}". Retype ${one ? 'it' : 'them'} first — deleting would leave ${one ? 'it' : 'them'} with no type at all.`,
        data: { dependents },
      })
    }

    tx.delete(dataTypes).where(eq(dataTypes.id, id)).run()

    recordChange(tx, { userId: actor.id }, {
      entityType: 'data_type',
      entityId: id,
      action: 'delete',
      before,
    })

    return { ok: true }
  })
})

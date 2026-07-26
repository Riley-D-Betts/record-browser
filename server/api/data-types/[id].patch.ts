import { eq } from 'drizzle-orm'
import { dataTypes, useDb } from '../../db'
import { dataTypePatchSchema } from '../../../shared/schemas'
import { assertListValue } from '../../services/lists'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const patch = await readValidated(event, dataTypePatchSchema)
  const db = useDb()

  return db.transaction((tx) => {
    const before = tx.select().from(dataTypes).where(eq(dataTypes.id, id)).all()[0]
    if (!before) throw createError({ statusCode: 404, statusMessage: 'No such field type' })

    if (patch.category != null) {
      assertListValue(tx, 'data_type_category', patch.category, 'category')
    }

    /**
     * A built-in type's key is quoted in the seed, in the NetSuite type mapping, and
     * in whatever anyone has scripted against an export. Its label and behaviour flags
     * are presentation and are freely editable; the key is not.
     */
    if (before.isBuiltin && patch.key != null && patch.key !== before.key) {
      throw createError({
        statusCode: 409,
        statusMessage: `"${before.label}" ships with the catalog, so its key stays "${before.key}". The label and the detail inputs it offers are yours to change.`,
      })
    }

    if (patch.key != null && patch.key !== before.key) {
      const clash = tx
        .select()
        .from(dataTypes)
        .where(eq(dataTypes.key, patch.key))
        .all()[0]
      if (clash) {
        throw createError({
          statusCode: 409,
          statusMessage: `A type with the key "${patch.key}" already exists`,
        })
      }
    }

    const after = tx
      .update(dataTypes)
      .set(patch)
      .where(eq(dataTypes.id, id))
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'data_type',
      entityId: id,
      action: 'update',
      before,
      after,
    })

    return after
  })
})

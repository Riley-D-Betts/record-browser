import { eq } from 'drizzle-orm'
import { fields, useDb } from '../../db'
import { fieldPatchSchema } from '../../../shared/schemas'
import { SourceValidationError, setFieldSource } from '../../services/fieldSource'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const { source, typeDetail, ...patch } = await readValidated(event, fieldPatchSchema)
  const db = useDb()

  try {
    return db.transaction((tx) => {
      const before = tx.select().from(fields).where(eq(fields.id, id)).all()[0]
      if (!before) throw createError({ statusCode: 404, statusMessage: 'No such field' })

      if (Object.keys(patch).length > 0 || typeDetail !== undefined) {
        tx.update(fields)
          .set({
            ...patch,
            ...(typeDetail !== undefined
              ? { typeDetail: typeDetail ? JSON.stringify(typeDetail) : null }
              : {}),
            updatedBy: actor.id,
          })
          .where(eq(fields.id, id))
          .run()
      }

      if (source) setFieldSource(tx, id, source)

      const after = tx.select().from(fields).where(eq(fields.id, id)).all()[0]!

      recordChange(tx, { userId: actor.id }, {
        entityType: 'field',
        entityId: id,
        action: 'update',
        before,
        after,
      })
      return after
    })
  } catch (error) {
    if (error instanceof SourceValidationError) {
      throw createError({
        statusCode: 422,
        statusMessage: error.message,
        data: error.detail,
      })
    }
    throw error
  }
})

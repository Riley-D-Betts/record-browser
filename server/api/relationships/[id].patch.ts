import { eq } from 'drizzle-orm'
import { fields, relationships, useDb } from '../../db'
import { relationshipPatchSchema } from '../../../shared/schemas'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const patch = await readValidated(event, relationshipPatchSchema)
  const db = useDb()

  return db.transaction((tx) => {
    const before = tx.select().from(relationships).where(eq(relationships.id, id)).all()[0]
    if (!before) {
      throw createError({ statusCode: 404, statusMessage: 'No such relationship' })
    }

    // The linking field lives on the child — that is what "the child points at the
    // parent" means. Re-checked here because either end may be moving in this patch.
    const childRecordId = patch.childRecordId ?? before.childRecordId
    const viaFieldId = patch.viaFieldId !== undefined ? patch.viaFieldId : before.viaFieldId

    if (viaFieldId) {
      const via = tx.select().from(fields).where(eq(fields.id, viaFieldId)).all()[0]
      if (!via) {
        throw createError({ statusCode: 422, statusMessage: 'No such linking field' })
      }
      if (via.recordId !== childRecordId) {
        throw createError({
          statusCode: 422,
          statusMessage:
            'The linking field must belong to the child record — it is the child that points at the parent',
        })
      }
    }

    const after = tx
      .update(relationships)
      .set({ ...patch, updatedBy: actor.id })
      .where(eq(relationships.id, id))
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'relationship',
      entityId: id,
      action: 'update',
      before,
      after,
    })
    return after
  })
})

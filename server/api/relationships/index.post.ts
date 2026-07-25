import { eq } from 'drizzle-orm'
import { fields, relationships, useDb } from '../../db'
import { relationshipInputSchema } from '../../../shared/schemas'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const input = await readValidated(event, relationshipInputSchema)
  const db = useDb()

  return db.transaction((tx) => {
    // The linking field has to live on the child — that is what "the child points at
    // the parent" means. SQLite cannot express this as a CHECK across tables.
    if (input.viaFieldId) {
      const via = tx.select().from(fields).where(eq(fields.id, input.viaFieldId)).all()[0]
      if (!via) {
        throw createError({ statusCode: 422, statusMessage: 'No such linking field' })
      }
      if (via.recordId !== input.childRecordId) {
        throw createError({
          statusCode: 422,
          statusMessage:
            'The linking field must belong to the child record — it is the child that points at the parent',
        })
      }
    }

    const created = tx
      .insert(relationships)
      .values({ ...input, createdBy: actor.id, updatedBy: actor.id })
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'relationship',
      entityId: created.id,
      action: 'create',
      after: created,
    })
    setResponseStatus(event, 201)
    return created
  })
})

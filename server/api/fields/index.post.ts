import { eq } from 'drizzle-orm'
import { fields, useDb } from '../../db'
import { fieldInputSchema } from '../../../shared/schemas'
import { SourceValidationError, setFieldSource } from '../../services/fieldSource'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const { source, typeDetail, ...input } = await readValidatedBody(
    event,
    fieldInputSchema.parse,
  )
  const db = useDb()

  try {
    return db.transaction((tx) => {
      // Created as user_entry first, then provenance is applied through the one
      // service that owns the invariant. Inserting the source columns directly here
      // would be a second writer, and the two would drift.
      const created = tx
        .insert(fields)
        .values({
          ...input,
          typeDetail: typeDetail ? JSON.stringify(typeDetail) : null,
          createdBy: actor.id,
          updatedBy: actor.id,
        })
        .returning()
        .all()[0]!

      setFieldSource(tx, created.id, source)

      const final = tx.select().from(fields).where(eq(fields.id, created.id)).all()[0]!

      recordChange(tx, { userId: actor.id }, {
        entityType: 'field',
        entityId: created.id,
        action: 'create',
        after: final,
      })

      setResponseStatus(event, 201)
      return final
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


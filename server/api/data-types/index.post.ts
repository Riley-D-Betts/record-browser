import { eq } from 'drizzle-orm'
import { dataTypes, useDb } from '../../db'
import { dataTypeInputSchema } from '../../../shared/schemas'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const input = await readValidated(event, dataTypeInputSchema)
  const db = useDb()

  return db.transaction((tx) => {
    const clash = tx.select().from(dataTypes).where(eq(dataTypes.key, input.key)).all()[0]
    if (clash) {
      throw createError({
        statusCode: 409,
        statusMessage: `A type with the key "${input.key}" already exists`,
      })
    }

    const created = tx
      .insert(dataTypes)
      .values({ ...input, isBuiltin: false })
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'data_type',
      entityId: created.id,
      action: 'create',
      after: created,
    })
    setResponseStatus(event, 201)
    return created
  })
})

import { eq } from 'drizzle-orm'
import { fields, useDb } from '../../db'
import { DeleteBlockedError, deleteField } from '../../services/deletion'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const force = getQuery(event).force === '1'
  const db = useDb()

  try {
    return db.transaction((tx) => {
      const before = tx.select().from(fields).where(eq(fields.id, id)).all()[0]
      if (!before) throw createError({ statusCode: 404, statusMessage: 'No such field' })

      const broken = deleteField(tx, id, force)

      recordChange(tx, { userId: actor.id }, {
        entityType: 'field',
        entityId: id,
        action: 'delete',
        before,
      })
      return { ok: true, brokenDependencies: broken }
    })
  } catch (error) {
    if (error instanceof DeleteBlockedError) {
      throw createError({
        statusCode: 409,
        statusMessage: error.message,
        data: { dependents: error.dependents },
      })
    }
    throw error
  }
})

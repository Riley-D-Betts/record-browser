import { eq } from 'drizzle-orm'
import { relationships, useDb } from '../../db'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const db = useDb()

  return db.transaction((tx) => {
    const before = tx.select().from(relationships).where(eq(relationships.id, id)).all()[0]
    if (!before) {
      throw createError({ statusCode: 404, statusMessage: 'No such relationship' })
    }
    tx.delete(relationships).where(eq(relationships.id, id)).run()
    recordChange(tx, { userId: actor.id }, {
      entityType: 'relationship',
      entityId: id,
      action: 'delete',
      before,
    })
    return { ok: true }
  })
})

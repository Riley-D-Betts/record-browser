import { eq } from 'drizzle-orm'
import { records, useDb } from '../../db'
import { DeleteBlockedError, deleteRecord } from '../../services/deletion'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const force = getQuery(event).force === '1'
  const db = useDb()

  try {
    return db.transaction((tx) => {
      const before = tx.select().from(records).where(eq(records.id, id)).all()[0]
      if (!before) throw createError({ statusCode: 404, statusMessage: 'No such record' })

      const broken = deleteRecord(tx, id, force)

      recordChange(tx, { userId: actor.id }, {
        entityType: 'record',
        entityId: id,
        action: 'delete',
        before,
      })
      return { ok: true, brokenDependencies: broken }
    })
  } catch (error) {
    if (error instanceof DeleteBlockedError) {
      // 409 with the actual blockers — a bare constraint error tells the user nothing
      // about which fields elsewhere are relying on this record.
      throw createError({
        statusCode: 409,
        statusMessage: error.message,
        data: { dependents: error.dependents },
      })
    }
    throw error
  }
})

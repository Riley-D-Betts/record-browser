import { eq } from 'drizzle-orm'
import { records, useDb } from '../../db'
import { recordPatchSchema } from '../../../shared/schemas'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const patch = await readValidatedBody(event, recordPatchSchema.parse)
  const db = useDb()

  return db.transaction((tx) => {
    const before = tx.select().from(records).where(eq(records.id, id)).all()[0]
    if (!before) throw createError({ statusCode: 404, statusMessage: 'No such record' })

    const after = tx
      .update(records)
      .set({ ...patch, updatedBy: actor.id })
      .where(eq(records.id, id))
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'record',
      entityId: id,
      action: 'update',
      before,
      after,
    })
    return after
  })
})

import { eq } from 'drizzle-orm'
import { modules, useDb } from '../../db'
import { moduleInputSchema } from '../../../shared/schemas'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const patch = await readValidated(event, moduleInputSchema.partial())
  const db = useDb()

  return db.transaction((tx) => {
    const before = tx.select().from(modules).where(eq(modules.id, id)).all()[0]
    if (!before) throw createError({ statusCode: 404, statusMessage: 'No such module' })

    const after = tx
      .update(modules)
      .set(patch)
      .where(eq(modules.id, id))
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'module',
      entityId: id,
      action: 'update',
      before,
      after,
    })
    return after
  })
})

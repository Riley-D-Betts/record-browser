import { eq } from 'drizzle-orm'
import { modules, records, useDb } from '../../db'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const id = getRouterParam(event, 'id')!
  const db = useDb()

  return db.transaction((tx) => {
    const before = tx.select().from(modules).where(eq(modules.id, id)).all()[0]
    if (!before) throw createError({ statusCode: 404, statusMessage: 'No such module' })

    // records.module_id is `set null`, so the records survive and land in "No module"
    // rather than being deleted with their grouping. Reported back so the caller can
    // say how many moved instead of leaving it as a silent side effect.
    const orphaned = tx
      .select({ id: records.id })
      .from(records)
      .where(eq(records.moduleId, id))
      .all().length

    tx.delete(modules).where(eq(modules.id, id)).run()

    recordChange(tx, { userId: actor.id }, {
      entityType: 'module',
      entityId: id,
      action: 'delete',
      before,
    })
    return { ok: true, recordsUngrouped: orphaned }
  })
})

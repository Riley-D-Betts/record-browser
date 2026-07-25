import { useDb, records } from '../../db'
import { recordInputSchema } from '../../../shared/schemas'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const input = await readValidated(event, recordInputSchema)
  const db = useDb()

  return db.transaction((tx) => {
    const created = tx
      .insert(records)
      .values({ ...input, createdBy: actor.id, updatedBy: actor.id })
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'record',
      entityId: created.id,
      action: 'create',
      after: created,
    })

    setResponseStatus(event, 201)
    return created
  })
})

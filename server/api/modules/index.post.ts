import { modules, useDb } from '../../db'
import { moduleInputSchema } from '../../../shared/schemas'
import { recordChange } from '../../utils/audit'
import { requireEditor } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const input = await readValidated(event, moduleInputSchema)
  const db = useDb()

  return db.transaction((tx) => {
    const created = tx.insert(modules).values(input).returning().all()[0]!
    recordChange(tx, { userId: actor.id }, {
      entityType: 'module',
      entityId: created.id,
      action: 'create',
      after: created,
    })
    setResponseStatus(event, 201)
    return created
  })
})

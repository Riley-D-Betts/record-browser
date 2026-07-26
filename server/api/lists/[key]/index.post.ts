import { and, eq } from 'drizzle-orm'
import { listItems, useDb } from '../../../db'
import { findManagedList, listItemInputSchema } from '../../../../shared/lists'
import { readList } from '../../../services/lists'
import { recordChange } from '../../../utils/audit'
import { requireEditor } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const listKey = getRouterParam(event, 'key')!

  if (!findManagedList(listKey)) {
    throw createError({ statusCode: 404, statusMessage: `No editable list "${listKey}"` })
  }

  const input = await readValidated(event, listItemInputSchema)
  const db = useDb()

  return db.transaction((tx) => {
    const clash = tx
      .select()
      .from(listItems)
      .where(and(eq(listItems.listKey, listKey), eq(listItems.key, input.key)))
      .all()[0]

    if (clash) {
      // Re-adding something that was hidden is the common case here, and it is a
      // different problem from a genuine collision — so say which one it is.
      throw createError({
        statusCode: 409,
        statusMessage: clash.isActive
          ? `"${input.key}" is already on this list`
          : `"${input.key}" is on this list but hidden — re-enable it instead of adding it again`,
      })
    }

    const created = tx
      .insert(listItems)
      .values({ ...input, listKey, isBuiltin: false })
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'list_item',
      entityId: created.id,
      action: 'create',
      after: created,
    })

    setResponseStatus(event, 201)
    return readList(tx, listKey)
  })
})

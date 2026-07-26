import { and, eq } from 'drizzle-orm'
import { listItems, useDb } from '../../../db'
import { findManagedList, listItemPatchSchema } from '../../../../shared/lists'
import { readList, usageCounts, usageNoun } from '../../../services/lists'
import { recordChange } from '../../../utils/audit'
import { requireEditor } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const listKey = getRouterParam(event, 'key')!
  const id = getRouterParam(event, 'id')!

  if (!findManagedList(listKey)) {
    throw createError({ statusCode: 404, statusMessage: `No editable list "${listKey}"` })
  }

  const patch = await readValidated(event, listItemPatchSchema)
  const db = useDb()

  return db.transaction((tx) => {
    const before = tx
      .select()
      .from(listItems)
      .where(and(eq(listItems.id, id), eq(listItems.listKey, listKey)))
      .all()[0]

    if (!before) {
      throw createError({ statusCode: 404, statusMessage: 'No such list item' })
    }

    const after = tx
      .update(listItems)
      .set(patch)
      .where(eq(listItems.id, id))
      .returning()
      .all()[0]!

    recordChange(tx, { userId: actor.id }, {
      entityType: 'list_item',
      entityId: id,
      action: 'update',
      before,
      after,
    })

    return {
      list: readList(tx, listKey),
      /**
       * Hiding a value in use is allowed and deliberate — it stops the value being
       * chosen again without touching the rows that already hold it. Reported so the
       * UI can say how many those are rather than leaving it to be discovered.
       */
      hiddenWhileInUse:
        before.isActive && after.isActive === false
          ? {
              count: usageCounts(tx, listKey).get(before.key) ?? 0,
              noun: usageNoun(listKey),
            }
          : null,
    }
  })
})

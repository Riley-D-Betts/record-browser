import { and, eq } from 'drizzle-orm'
import { listItems, useDb } from '../../../db'
import { findManagedList } from '../../../../shared/lists'
import { readList, usageCounts, usageNoun } from '../../../services/lists'
import { recordChange } from '../../../utils/audit'
import { requireEditor } from '../../../utils/auth'

/**
 * Deleting a list member is only ever allowed when nothing chose it.
 *
 * Nothing points at these rows by id — a record stores the member's key — so a delete
 * would not fail at the database level. It would just quietly leave rows holding a
 * value no list explains, which is the failure this catalog exists to prevent. Both
 * refusals below name the alternative that does work: hide it.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const listKey = getRouterParam(event, 'key')!
  const id = getRouterParam(event, 'id')!

  if (!findManagedList(listKey)) {
    throw createError({ statusCode: 404, statusMessage: `No editable list "${listKey}"` })
  }

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

    if (before.isBuiltin) {
      throw createError({
        statusCode: 409,
        statusMessage: `"${before.label}" ships with the catalog and cannot be deleted. Hide it instead — that stops it being offered without touching anything that already uses it.`,
      })
    }

    const inUse = usageCounts(tx, listKey).get(before.key) ?? 0
    if (inUse > 0) {
      const noun = usageNoun(listKey)
      const one = inUse === 1
      throw createError({
        statusCode: 409,
        statusMessage: `${inUse} ${noun}${one ? '' : 's'} still ${one ? 'uses' : 'use'} "${before.label}". Hide it instead — that stops it being chosen again and leaves ${one ? 'it' : 'them'} as ${one ? 'it is' : 'they are'}.`,
        data: { usageCount: inUse },
      })
    }

    tx.delete(listItems).where(eq(listItems.id, id)).run()

    recordChange(tx, { userId: actor.id }, {
      entityType: 'list_item',
      entityId: id,
      action: 'delete',
      before,
    })

    return { ok: true, list: readList(tx, listKey) }
  })
})

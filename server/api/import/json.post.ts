import { useDb } from '../../db'
import { importCatalog } from '../../services/interchange'
import { requireEditor } from '../../utils/auth'
import { recordChange } from '../../utils/audit'

export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const doc = await readBody(event)

  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.records)) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Not a catalog document — expected a top-level "records" array',
    })
  }

  const db = useDb()
  const batchId = crypto.randomUUID()
  const dryRun = getQuery(event).dryRun === '1'

  /**
   * The dry run applies everything and then throws, so the preview reflects real
   * constraint behaviour rather than a simulation that can drift from it. The
   * rollback is the mechanism, not a side effect.
   */
  if (dryRun) {
    let preview: unknown
    try {
      db.transaction((tx) => {
        preview = importCatalog(tx, doc, actor.id)
        throw new RollbackSignal()
      })
    } catch (error) {
      if (!(error instanceof RollbackSignal)) throw error
    }
    return { dryRun: true, batchId, ...(preview as object) }
  }

  return db.transaction((tx) => {
    const summary = importCatalog(tx, doc, actor.id)
    recordChange(tx, { userId: actor.id, batchId }, {
      entityType: 'record',
      entityId: batchId,
      action: 'import',
      after: summary as unknown as Record<string, unknown>,
    })
    return { dryRun: false, batchId, ...summary }
  })
})

class RollbackSignal extends Error {}

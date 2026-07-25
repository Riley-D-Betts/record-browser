import { z } from 'zod'
import { useDb } from '../../db'
import { STRATEGIES } from '../../../shared/csvColumns'
import { applyCsvImport, planCsvImport } from '../../services/csvImport'
import { requireEditor } from '../../utils/auth'
import { readValidated } from '../../utils/validate'

const MAX_ROWS = 20_000

const bodySchema = z.object({
  mapping: z.record(z.string(), z.string().nullable()),
  rows: z
    .array(z.record(z.string(), z.string()))
    .max(MAX_ROWS, `A single import is capped at ${MAX_ROWS.toLocaleString()} rows`),
  strategy: z.enum(STRATEGIES).default('fill-blanks'),
  emptyCellsClear: z.boolean().default(false),
  approvedRenames: z.array(z.number().int()).default([]),
})

/**
 * Plan the import, then either report the plan or apply it.
 *
 * The JSON importer previews by applying everything and rolling back, which is honest
 * when the only outcome is an insert. Here rows can update existing values, so the
 * preview has to say *what would change* — which means computing the plan before
 * writing anything. Planning still runs inside a rolled-back transaction so it reads a
 * consistent snapshot, but what comes back is the plan, not the aftermath.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireEditor(event)
  const body = await readValidated(event, bodySchema)
  const db = useDb()
  const dryRun = getQuery(event).dryRun === '1'
  const batchId = crypto.randomUUID()

  const input = {
    mapping: Object.fromEntries(
      Object.entries(body.mapping).filter(([, v]) => Boolean(v)),
    ) as Record<string, string>,
    rows: body.rows,
    strategy: body.strategy,
    emptyCellsClear: body.emptyCellsClear,
    approvedRenames: body.approvedRenames,
  }

  if (dryRun) {
    let preview: unknown
    try {
      db.transaction((tx) => {
        preview = planCsvImport(tx, input, batchId).preview
        throw new RollbackSignal()
      })
    } catch (error) {
      if (!(error instanceof RollbackSignal)) throw error
    }
    return { dryRun: true, ...(preview as object) }
  }

  return db.transaction((tx) => {
    const planned = planCsvImport(tx, input, batchId)

    // A row the planner could not make sense of is not silently dropped: the whole
    // import stops, because a partial apply is the thing that leaves someone unsure
    // what state their catalog is in.
    if (planned.preview.errors.length > 0) {
      throw createError({
        statusCode: 422,
        statusMessage: `${planned.preview.errors.length} row${planned.preview.errors.length === 1 ? '' : 's'} could not be imported — nothing was written`,
        data: { errors: planned.preview.errors.slice(0, 50) },
      })
    }

    const applied = applyCsvImport(tx, planned, actor.id, batchId)
    return { dryRun: false, batchId, ...applied, warnings: planned.preview.warnings }
  })
})

class RollbackSignal extends Error {}

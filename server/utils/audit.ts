import { changeLog } from '../db/schema'
import type { ChangeAction, EntityType } from '../../shared/constants'

/**
 * Attribution is taken from the session, never from the request body — a client that
 * could name its own author would make the audit trail worthless.
 */
export interface AuditContext {
  userId: string | null
  batchId?: string | null
}

export interface AuditEntry {
  entityType: EntityType
  entityId: string
  action: ChangeAction
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

/** Column names whose values actually differ. Lets the UI show a tight diff. */
function changedColumns(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before || !after) return []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const key of keys) {
    if (key === 'updatedAt' || key === 'createdAt') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key)
  }
  return changed
}

export function recordChange(tx: any, ctx: AuditContext, entry: AuditEntry): void {
  const changed = changedColumns(entry.before, entry.after)

  // An update that changed nothing is noise in the history.
  if (entry.action === 'update' && changed.length === 0) return

  tx.insert(changeLog)
    .values({
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      // Imports touch thousands of rows; storing both blobs per row bloats the file
      // for no benefit, so they keep only the diff.
      beforeJson:
        entry.action === 'import' || !entry.before ? null : JSON.stringify(entry.before),
      afterJson:
        entry.action === 'import' || !entry.after ? null : JSON.stringify(entry.after),
      changedFieldsJson: changed.length > 0 ? JSON.stringify(changed) : null,
      userId: ctx.userId,
      batchId: ctx.batchId ?? null,
    })
    .run()
}

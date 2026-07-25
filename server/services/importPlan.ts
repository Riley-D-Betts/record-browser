import type { Blankness, Strategy } from '../../shared/csvColumns'

/**
 * The upsert planner.
 *
 * Pure: no database, no Drizzle, no I/O. Everything that decides whether an import
 * changes a row lives here, so it can be tested exhaustively with plain objects — and
 * so the preview a user approves is computed by the same code that later applies it.
 */

export type { Strategy }

export interface ColumnChange {
  column: string
  before: unknown
  after: unknown
}

/** The file said something, and we declined to apply it. */
export interface SuppressedChange {
  column: string
  existing: unknown
  incoming: unknown
}

export interface UpsertPlan {
  action: 'create' | 'update' | 'unchanged' | 'skip'
  /** create: the whole row. update: only the columns that change. */
  values: Record<string, unknown>
  changes: ColumnChange[]
  suppressed: SuppressedChange[]
  /** Always present when action is 'skip'. */
  reason?: string
}

export interface PlanOptions {
  strategy: Strategy
  /**
   * Canonical targets present in the file, derived from the header row **once per
   * file**. The planner considers nothing outside this set, which is what makes a
   * sparse CSV structurally incapable of wiping the columns it omits — those columns
   * are never candidates, rather than being candidates that happen to be guarded.
   */
  columns: ReadonlySet<string>
  blankness: Record<string, Blankness>
  /** Applied on create only. */
  defaults?: Record<string, unknown>
  /** Never changed implicitly; a change here has to be opted into elsewhere. */
  protectedColumns?: ReadonlySet<string>
  /**
   * Whether an empty cell means "clear this". Off by default and deliberately separate
   * from strategy: in a CSV, "clear it" and "I don't have that data" are the same
   * bytes, so letting `overwrite` imply destruction is how sparse files cause damage.
   */
  emptyCellsClear?: boolean
}

/** An incoming cell that was present but empty. */
export const EMPTY_CELL = Symbol('empty-cell')

/**
 * Is a value already-written, from the catalog's point of view?
 *
 * `value` columns — every boolean, and sortOrder — are never blank. `false` is an
 * answer, not a hole. If it counted as blank, fill-blanks would flip every `false` to
 * `true` from any file carrying those columns, which is an overwrite wearing a
 * fill-blanks badge. The visible consequence: fill-blanks cannot change a boolean on a
 * row that already exists.
 */
export function isBlankExisting(value: unknown, kind: Blankness): boolean {
  if (kind === 'value') return false
  if (value === null || value === undefined) return true
  if (kind === 'text') return typeof value === 'string' && value.trim() === ''
  return false
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  // null and '' are the same absence as far as a spreadsheet is concerned.
  if ((a === null || a === '') && (b === null || b === '')) return true
  return a === b
}

export function planUpsert(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
  opts: PlanOptions,
): UpsertPlan {
  const protectedCols = opts.protectedColumns ?? new Set<string>()
  const changes: ColumnChange[] = []
  const suppressed: SuppressedChange[] = []

  // --- create ---------------------------------------------------------------
  if (!existing) {
    const values: Record<string, unknown> = { ...(opts.defaults ?? {}) }
    for (const column of opts.columns) {
      const raw = incoming[column]
      if (raw === undefined || raw === EMPTY_CELL) continue
      values[column] = raw
    }
    return { action: 'create', values, changes: [], suppressed: [] }
  }

  // --- create-only ----------------------------------------------------------
  if (opts.strategy === 'create-only') {
    return {
      action: 'skip',
      values: {},
      changes: [],
      suppressed: [],
      reason: 'Already in the catalog, and this import only adds new rows',
    }
  }

  // --- update / unchanged ---------------------------------------------------
  for (const column of opts.columns) {
    const raw = incoming[column]
    if (raw === undefined) continue

    const kind = opts.blankness[column] ?? 'text'
    const current = existing[column]

    if (raw === EMPTY_CELL) {
      // Present but empty. Only ever destructive when explicitly asked for, and never
      // for a column the row must have a value in.
      if (!opts.emptyCellsClear || kind === 'value') continue
      if (isBlankExisting(current, kind)) continue
      if (protectedCols.has(column)) {
        suppressed.push({ column, existing: current, incoming: null })
        continue
      }
      changes.push({ column, before: current, after: null })
      continue
    }

    if (sameValue(current, raw)) continue

    if (protectedCols.has(column)) {
      suppressed.push({ column, existing: current, incoming: raw })
      continue
    }

    if (opts.strategy === 'fill-blanks' && !isBlankExisting(current, kind)) {
      suppressed.push({ column, existing: current, incoming: raw })
      continue
    }

    changes.push({ column, before: current, after: raw })
  }

  if (changes.length === 0) {
    // Distinct from 'skip' on purpose. "Nothing to do" and "we declined" are different
    // answers, and collapsing them hides the one thing a fill-blanks preview exists to
    // surface: what the file said that the catalog disagrees with.
    return {
      action: 'unchanged',
      values: {},
      changes: [],
      suppressed,
    }
  }

  return {
    action: 'update',
    values: Object.fromEntries(changes.map((c) => [c.column, c.after])),
    changes,
    suppressed,
  }
}

// ---------------------------------------------------------------------------
// Tallies
// ---------------------------------------------------------------------------

export interface Tally {
  create: number
  update: number
  unchanged: number
  skip: number
  error: number
}

export const emptyTally = (): Tally => ({
  create: 0,
  update: 0,
  unchanged: 0,
  skip: 0,
  error: 0,
})

/**
 * Rows touching each column, most-touched first.
 *
 * This is what makes an update preview scannable: "description: 412 rows, label: 3"
 * answers "is this doing what I meant" at a glance, and a 3 against `label` when you
 * expected none is the signal to stop and look.
 */
export function summariseColumnImpact(
  plans: Array<{ entity: 'record' | 'field'; plan: UpsertPlan }>,
): Array<{ entity: 'record' | 'field'; column: string; rows: number }> {
  const counts = new Map<string, number>()
  for (const { entity, plan } of plans) {
    for (const change of plan.changes) {
      const key = `${entity}:${change.column}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([key, rows]) => {
      const [entity, column] = key.split(':') as ['record' | 'field', string]
      return { entity, column, rows }
    })
    .sort((a, b) => b.rows - a.rows)
}

import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../db'
import { dataTypes, fields, listItems, relationships } from '../db'
import { MANAGED_LISTS, findManagedList } from '../../shared/lists'
import type { ManagedList } from '../../shared/lists'

/**
 * Reads and guards for the editable lists.
 *
 * A member's `key` is the value stored on every row that chose it, so this module is
 * where "is that still a real member?" and "is anything using it?" are answered. Both
 * questions need the database — the list is data now, not a constant.
 */

type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

// ---------------------------------------------------------------------------
// Where each list's values actually get stored
// ---------------------------------------------------------------------------

/**
 * The column a list's members are written into. Spelled out per list rather than
 * derived, because this is exactly the mapping that must not be guessed: getting it
 * wrong would report a value as unused and let it be deleted out from under live rows.
 */
function usageColumn(listKey: string) {
  switch (listKey) {
    case 'derivation_language':
      return { table: fields, column: fields.derivationLanguage, noun: 'field' }
    case 'delete_behavior':
      return {
        table: relationships,
        column: relationships.onDelete,
        noun: 'relationship',
      }
    case 'data_type_category':
      return { table: dataTypes, column: dataTypes.category, noun: 'field type' }
    default:
      return null
  }
}

/** How many rows currently hold each value of this list, keyed by value. */
export function usageCounts(db: Tx, listKey: string): Map<string, number> {
  const target = usageColumn(listKey)
  if (!target) return new Map()

  const rows = db
    .select({ value: target.column, count: sql<number>`count(*)` })
    .from(target.table as never)
    .where(isNotNull(target.column))
    .groupBy(target.column)
    .all() as Array<{ value: string | null; count: number }>

  return new Map(rows.filter((r) => r.value != null).map((r) => [r.value!, r.count]))
}

export function usageNoun(listKey: string): string {
  return usageColumn(listKey)?.noun ?? 'row'
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Insert any built-in member the database does not have yet.
 *
 * Keyed on absence rather than on a version number, so it is safe to run on every
 * migrate: a member someone has hidden is still present, and stays hidden.
 */
export function ensureBuiltinLists(db: Tx): number {
  let added = 0
  for (const list of MANAGED_LISTS) {
    for (const [i, seed] of list.seeds.entries()) {
      const existing = db
        .select({ id: listItems.id })
        .from(listItems)
        .where(and(eq(listItems.listKey, list.key), eq(listItems.key, seed.key)))
        .all()[0]
      if (existing) continue

      db.insert(listItems)
        .values({
          listKey: list.key,
          key: seed.key,
          label: seed.label,
          description: 'description' in seed ? (seed.description ?? null) : null,
          isBuiltin: true,
          sortOrder: i,
        })
        .run()
      added++
    }
  }
  return added
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListItemView {
  id: string
  key: string
  label: string
  description: string | null
  isBuiltin: boolean
  isActive: boolean
  sortOrder: number
  usageCount: number
  /** A built-in cannot be deleted, and neither can anything still in use. */
  canDelete: boolean
}

export interface ListView extends ManagedList {
  items: ListItemView[]
  /**
   * Values sitting on real rows that no member accounts for.
   *
   * A JSON import carries whatever the exporting install had, so a catalog can end up
   * holding a value this list never offered. Reporting it beats it being invisible —
   * the dropdown would simply show nothing for those rows and no screen would say why.
   */
  unknownValuesInUse: Array<{ value: string; count: number }>
}

export function readList(db: Tx, listKey: string): ListView | null {
  const definition = findManagedList(listKey)
  if (!definition) return null

  const rows = db
    .select()
    .from(listItems)
    .where(eq(listItems.listKey, listKey))
    .orderBy(listItems.sortOrder, listItems.label)
    .all()

  const usage = usageCounts(db, listKey)
  const known = new Set(rows.map((r) => r.key))

  return {
    ...definition,
    items: rows.map((r) => {
      const usageCount = usage.get(r.key) ?? 0
      return {
        id: r.id,
        key: r.key,
        label: r.label,
        description: r.description,
        isBuiltin: r.isBuiltin,
        isActive: r.isActive,
        sortOrder: r.sortOrder,
        usageCount,
        canDelete: !r.isBuiltin && usageCount === 0,
      }
    }),
    unknownValuesInUse: [...usage.entries()]
      .filter(([value]) => !known.has(value))
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
  }
}

export function readAllLists(db: Tx): ListView[] {
  return MANAGED_LISTS.map((l) => readList(db, l.key)!).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Reject a value that is not an offered member of the list.
 *
 * Shaped like the zod failures from server/utils/validate.ts — a 422 carrying
 * `{ issues: [{ path, message }] }` — so the form puts the message next to the input
 * that caused it instead of showing an unattached banner.
 */
export function assertListValue(
  db: Tx,
  listKey: string,
  value: string | null | undefined,
  path: string,
): void {
  if (value == null || value === '') return

  const item = db
    .select({ isActive: listItems.isActive })
    .from(listItems)
    .where(and(eq(listItems.listKey, listKey), eq(listItems.key, value)))
    .all()[0]

  const list = findManagedList(listKey)
  const title = list?.title ?? listKey

  if (!item) {
    throw createError({
      statusCode: 422,
      statusMessage: `"${value}" is not one of the ${title.toLowerCase()}`,
      data: {
        issues: [
          {
            path,
            message: `"${value}" is not on this list. Add it in Settings if your system uses it.`,
          },
        ],
      },
    })
  }

  // Hidden members stay valid on the rows that already hold them; what is refused is
  // *newly choosing* one. Anything else would make retiring a value a destructive act.
  if (!item.isActive) {
    throw createError({
      statusCode: 422,
      statusMessage: `"${value}" has been retired`,
      data: {
        issues: [
          {
            path,
            message: `"${value}" is hidden and cannot be chosen. Re-enable it in Settings to use it again.`,
          },
        ],
      },
    })
  }
}

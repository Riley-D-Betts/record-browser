import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'

/**
 * Substring search that treats the user's term as literal text.
 *
 * SQL `LIKE` gives `%` and `_` wildcard meaning. That is a real problem here rather
 * than a theoretical one: technical names are mostly underscores, so a search for
 * `Sales_Order` would otherwise also match `SalesXOrder`, and `Credit_Limit` would
 * match text nobody asked about. Since searching by technical name is the whole point
 * of the tool, the wildcards have to be escaped away.
 *
 * Backslash is the escape character, declared explicitly — SQLite has no default one.
 */
const ESCAPE_CHAR = '\\'

export function escapeLikeTerm(term: string): string {
  // Backslash first, or it would double-escape the escapes added after it.
  return term
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}

/** `column LIKE '%term%' ESCAPE '\'`, with the term taken literally. */
export function containsText(column: SQLiteColumn, term: string): SQL {
  const pattern = `%${escapeLikeTerm(term)}%`
  return sql`${column} LIKE ${pattern} ESCAPE ${ESCAPE_CHAR}`
}

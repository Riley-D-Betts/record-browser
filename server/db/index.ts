import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { schema } from './schema'

export type Db = ReturnType<typeof createDb>

let cached: Db | null = null

export function createDb(databasePath: string) {
  const absolute = resolve(databasePath)
  mkdirSync(dirname(absolute), { recursive: true })

  const sqlite = new Database(absolute)

  // SQLite ships with foreign key enforcement OFF. Without this the `restrict` on
  // field_dependencies.source_field_id and the cascades elsewhere are decorative —
  // deletes would silently orphan rows, which is the precise failure this catalog
  // exists to catch.
  sqlite.pragma('foreign_keys = ON')

  // WAL keeps reads from blocking during an import transaction.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')

  return drizzle(sqlite, { schema })
}

/**
 * Process-wide singleton. Nitro reuses the module across requests, and better-sqlite3
 * is synchronous, so one connection is both sufficient and correct.
 */
export function useDb(): Db {
  if (!cached) {
    const path =
      process.env.NUXT_DATABASE_PATH ??
      useRuntimeConfig().databasePath ??
      '.data/record-browser.db'
    cached = createDb(path)
  }
  return cached
}

export * from './schema'

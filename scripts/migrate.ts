import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from '../server/db'
import { ensureBuiltinLists } from '../server/services/lists'

const here = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.NUXT_DATABASE_PATH ?? '.data/record-browser.db'

const db = createDb(dbPath)
migrate(db, { migrationsFolder: resolve(here, '../server/db/migrations') })

/**
 * Seeded here rather than in the migration SQL so that adding a built-in list member
 * later is a code change, not a new migration — and so an existing install picks it up
 * on the next migrate. Insert-if-absent, so a member someone has hidden stays hidden.
 */
const added = ensureBuiltinLists(db)

console.log(`Migrations applied to ${resolve(dbPath)}`)
if (added > 0) console.log(`Editable lists: ${added} built-in values seeded`)

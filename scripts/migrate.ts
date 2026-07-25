import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb } from '../server/db'

const here = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.NUXT_DATABASE_PATH ?? '.data/record-browser.db'

const db = createDb(dbPath)
migrate(db, { migrationsFolder: resolve(here, '../server/db/migrations') })

console.log(`Migrations applied to ${resolve(dbPath)}`)

/**
 * Verifies that the database actually enforces what the schema claims.
 *
 * SQLite silently ignores foreign keys unless the pragma is set, and a CHECK that
 * never fires looks identical to one that passes. Both failure modes are invisible
 * until data is already corrupt, so they get asserted explicitly.
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDb, dataTypes, fieldDependencies, fields, records } from '../server/db'

const DB_PATH = '.data/smoke.db'
rmSync(resolve(DB_PATH), { force: true })
rmSync(resolve(`${DB_PATH}-wal`), { force: true })
rmSync(resolve(`${DB_PATH}-shm`), { force: true })

const db = createDb(DB_PATH)
migrate(db, { migrationsFolder: resolve('server/db/migrations') })

let failures = 0
const ok = (msg: string) => console.log(`  ok   ${msg}`)
const fail = (msg: string) => {
  failures++
  console.error(`  FAIL ${msg}`)
}

function expectReject(what: string, fn: () => void) {
  try {
    fn()
    fail(`${what} was allowed`)
  } catch {
    ok(`${what} was rejected`)
  }
}

const dt = db.insert(dataTypes).values({ key: 'text', label: 'Text' }).returning().all()[0]!
const rec = db
  .insert(records)
  .values({ apiName: 'Invoice', label: 'Invoice' })
  .returning()
  .all()[0]!

console.log('\nCHECK constraint — derived fields must carry an expression')
expectReject('derived field with no expression', () =>
  db
    .insert(fields)
    .values({ recordId: rec.id, apiName: 'Bad', label: 'Bad', sourceKind: 'derived' })
    .run(),
)
expectReject('user_entry field carrying an expression', () =>
  db
    .insert(fields)
    .values({
      recordId: rec.id,
      apiName: 'Bad2',
      label: 'Bad2',
      sourceKind: 'user_entry',
      sourceExpression: '1 + 1',
    })
    .run(),
)

console.log('\nForeign keys — a field that feeds others cannot be deleted')
const upstream = db
  .insert(fields)
  .values({ recordId: rec.id, apiName: 'Subtotal', label: 'Subtotal', dataTypeId: dt.id })
  .returning()
  .all()[0]!
const downstream = db
  .insert(fields)
  .values({
    recordId: rec.id,
    apiName: 'Total',
    label: 'Total',
    dataTypeId: dt.id,
    sourceKind: 'derived',
    sourceExpression: 'Subtotal * 1.2',
  })
  .returning()
  .all()[0]!
db
  .insert(fieldDependencies)
  .values({ fieldId: downstream.id, sourceFieldId: upstream.id, kind: 'derived' })
  .run()

expectReject('deleting a field that another field derives from', () =>
  db.delete(fields).where(eq(fields.id, upstream.id)).run(),
)

console.log('\nUnique constraints')
expectReject('a second field with the same api_name on one record', () =>
  db
    .insert(fields)
    .values({ recordId: rec.id, apiName: 'Total', label: 'Duplicate', dataTypeId: dt.id })
    .run(),
)
expectReject('a second record with the same api_name', () =>
  db.insert(records).values({ apiName: 'Invoice', label: 'Another' }).run(),
)

console.log('\nCascade — deleting a record removes its fields and their edges')
db.delete(records).where(eq(records.id, rec.id)).run()
const remainingFields = db.select().from(fields).all().length
const remainingDeps = db.select().from(fieldDependencies).all().length
remainingFields === 0
  ? ok('fields cascaded away')
  : fail(`${remainingFields} fields survived the record delete`)
remainingDeps === 0
  ? ok('dependency edges cascaded away')
  : fail(`${remainingDeps} dependency edges survived`)

rmSync(resolve(DB_PATH), { force: true })
rmSync(resolve(`${DB_PATH}-wal`), { force: true })
rmSync(resolve(`${DB_PATH}-shm`), { force: true })

console.log(failures === 0 ? '\nAll constraint checks passed.\n' : `\n${failures} failed.\n`)
process.exit(failures === 0 ? 0 : 1)

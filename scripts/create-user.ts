/**
 * Add an editor account.
 *
 *   pnpm user:create <email> <name> <password> [admin|editor|viewer]
 *
 * Uses the same hashing as the login handler (server/lib/password.ts), so an account
 * made here can log in through the browser.
 */
import { eq } from 'drizzle-orm'
import { createDb, users } from '../server/db'
import { hashPassword } from '../server/lib/password'
import { USER_ROLES } from '../shared/constants'
import type { UserRole } from '../shared/constants'

const [email, name, password, role = 'editor'] = process.argv.slice(2)

if (!email || !name || !password) {
  console.error('Usage: pnpm user:create <email> <name> <password> [admin|editor|viewer]')
  process.exit(1)
}
if (!USER_ROLES.includes(role as UserRole)) {
  console.error(`Role must be one of: ${USER_ROLES.join(', ')}`)
  process.exit(1)
}
if (password.length < 10) {
  console.error('Use a password of at least 10 characters.')
  process.exit(1)
}

const db = createDb(process.env.NUXT_DATABASE_PATH ?? '.data/record-browser.db')
const normalised = email.toLowerCase()

if (db.select().from(users).where(eq(users.email, normalised)).all()[0]) {
  console.error(`${normalised} already has an account.`)
  process.exit(1)
}

db.insert(users)
  .values({
    email: normalised,
    name,
    passwordHash: await hashPassword(password),
    role: role as UserRole,
  })
  .run()

console.log(`Created ${role} account for ${normalised}`)

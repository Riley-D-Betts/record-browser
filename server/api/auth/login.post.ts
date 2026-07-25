import { eq } from 'drizzle-orm'
import { useDb, users } from '../../db'
import { loginSchema } from '../../../shared/schemas'
import { hashPassword, verifyPassword } from '../../lib/password'

/**
 * A hash of a throwaway password. Verifying against it burns the same scrypt time on
 * a missing account as on a real one, so response latency does not reveal which email
 * addresses exist.
 *
 * Computed lazily rather than at module load — Nitro's build target has no top-level
 * await, and doing the work on first login costs nothing.
 */
let decoyHash: Promise<string> | null = null
const getDecoyHash = () =>
  (decoyHash ??= hashPassword(`decoy-${crypto.randomUUID()}`))

export default defineEventHandler(async (event) => {
  const { email, password } = await readValidated(event, loginSchema)
  const db = useDb()

  const user = db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .all()[0]

  const valid = user
    ? user.isActive && (await verifyPassword(password, user.passwordHash))
    : await verifyPassword(password, await getDecoyHash())

  if (!user || !valid) {
    throw createError({ statusCode: 401, statusMessage: 'Email or password is incorrect' })
  }

  await setUserSession(event, {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    loggedInAt: new Date().toISOString(),
  })

  return { id: user.id, email: user.email, name: user.name, role: user.role }
})

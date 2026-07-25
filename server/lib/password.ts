import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

const KEY_LENGTH = 64
const SALT_LENGTH = 16

/**
 * scrypt via node:crypto rather than nuxt-auth-utils' helper, so the CLI scripts and
 * the login handler share one implementation. A user created from the terminal must
 * be able to log in through the browser, and that only holds if both sides hash
 * identically.
 *
 * Lives in server/lib/ rather than server/utils/ deliberately: Nitro auto-imports
 * server/utils/, which would collide with nuxt-auth-utils' own hashPassword. Whichever
 * won that race would decide the hash format, and a flip would silently invalidate
 * every stored password. Explicit imports from here make that impossible.
 *
 * Stored as `scrypt$<salt-hex>$<key-hex>` — self-describing, so the format can be
 * migrated later without guessing what produced an existing row.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false

  const salt = Buffer.from(parts[1]!, 'hex')
  const expected = Buffer.from(parts[2]!, 'hex')
  if (expected.length !== KEY_LENGTH) return false

  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer
  // Constant-time — a length-varying or early-exit compare leaks the hash prefix.
  return timingSafeEqual(derived, expected)
}

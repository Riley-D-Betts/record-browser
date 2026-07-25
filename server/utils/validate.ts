import type { H3Event } from 'h3'
import type { ZodType, z } from 'zod'

/**
 * Body and query validation that tells the client *which* field is wrong.
 *
 * h3's `readValidatedBody(event, schema.parse)` throws a 400 whose message is the bare
 * string "Validation Error", with the zod issues buried in whatever shape the thrown
 * error happened to serialise to. A form receiving that can only show a banner saying
 * nothing — the user is left to guess which input the server objected to.
 *
 * These return a 422 with a stable `{ issues: [{ path, message }] }` payload so forms
 * can put each message next to the input that caused it.
 */

interface Issue {
  path: string
  message: string
}

function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

function fail(issues: Issue[]): never {
  throw createError({
    statusCode: 422,
    statusMessage:
      issues.length === 1 ? issues[0]!.message : 'Some fields need attention',
    data: { issues },
  })
}

export async function readValidated<S extends ZodType>(
  event: H3Event,
  schema: S,
): Promise<z.infer<S>> {
  const body = await readBody(event)
  const result = schema.safeParse(body)
  if (!result.success) fail(toIssues(result.error))
  return result.data
}

export async function queryValidated<S extends ZodType>(
  event: H3Event,
  schema: S,
): Promise<z.infer<S>> {
  const query = getQuery(event)
  const result = schema.safeParse(query)
  if (!result.success) fail(toIssues(result.error))
  return result.data
}

import { useDb } from '../../db'
import { REPORTS, runReport } from '../../services/reports'

export default defineEventHandler(async (event) => {
  const key = getRouterParam(event, 'key')!
  const definition = REPORTS.find((r) => r.key === key)
  if (!definition) {
    throw createError({ statusCode: 404, statusMessage: `Unknown report: ${key}` })
  }
  return { ...definition, findings: runReport(useDb(), key) }
})

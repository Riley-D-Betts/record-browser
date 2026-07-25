import { useDb } from '../../db'
import { reportSummary } from '../../services/reports'

export default defineEventHandler(async () => reportSummary(useDb()))

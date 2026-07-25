import { useDb } from '../../db'
import { exportCatalog } from '../../services/interchange'

export default defineEventHandler(async (event) => {
  const doc = exportCatalog(useDb(), new Date().toISOString())

  if (getQuery(event).download === '1') {
    const stamp = doc.exportedAt.slice(0, 10)
    setHeader(event, 'content-type', 'application/json')
    setHeader(
      event,
      'content-disposition',
      `attachment; filename="catalog-${stamp}.json"`,
    )
  }
  return doc
})

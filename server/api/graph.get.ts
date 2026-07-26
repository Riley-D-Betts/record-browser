import { and, eq, inArray } from 'drizzle-orm'
import { fields, modules, records, relationships, useDb } from '../db'
import { graphQuerySchema } from '../../shared/schemas'

/**
 * Nodes and edges for the ERD.
 *
 * Layout happens on the client (elkjs in a worker) — the server's job is to decide
 * what is in scope and, when modules are collapsed, to fold the record graph into a
 * module graph with weighted edges. Collapsing is the main lever against an ERD that
 * has outgrown a single screen.
 */
export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, graphQuerySchema.parse)
  const db = useDb()

  const moduleIds = q.moduleIds?.split(',').filter(Boolean) ?? []

  const filters = []
  if (moduleIds.length > 0) filters.push(inArray(records.moduleId, moduleIds))
  if (q.origin) filters.push(eq(records.origin, q.origin))
  if (!q.includeDeprecated) filters.push(eq(records.isDeprecated, false))

  const recordRows = db
    .select({
      id: records.id,
      apiName: records.apiName,
      label: records.label,
      externalId: records.externalId,
      origin: records.origin,
      isDeprecated: records.isDeprecated,
      moduleId: records.moduleId,
      moduleKey: modules.key,
      moduleName: modules.name,
      moduleColor: modules.color,
      fieldCount: db.$count(fields, eq(fields.recordId, records.id)),
    })
    .from(records)
    .leftJoin(modules, eq(modules.id, records.moduleId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .all()

  const inScope = new Set(recordRows.map((r) => r.id))

  const relationshipRows = db
    .select({
      id: relationships.id,
      parentRecordId: relationships.parentRecordId,
      childRecordId: relationships.childRecordId,
      cardinality: relationships.cardinality,
      isIdentifying: relationships.isIdentifying,
      label: relationships.label,
      viaFieldId: relationships.viaFieldId,
    })
    .from(relationships)
    .all()
    .filter((r) => inScope.has(r.parentRecordId) && inScope.has(r.childRecordId))

  const moduleRows = db.select().from(modules).orderBy(modules.sortOrder).all()

  if (!q.collapseModules) {
    // Top few fields per record, so a node can show something useful before expanding.
    const previews = db
      .select({
        id: fields.id,
        recordId: fields.recordId,
        apiName: fields.apiName,
        label: fields.label,
        sourceKind: fields.sourceKind,
        isPrimaryKey: fields.isPrimaryKey,
        isRequired: fields.isRequired,
        sortOrder: fields.sortOrder,
      })
      .from(fields)
      .where(eq(fields.isDeprecated, false))
      .orderBy(fields.sortOrder, fields.apiName)
      .all()

    const byRecord = new Map<string, typeof previews>()
    for (const f of previews) {
      if (!inScope.has(f.recordId)) continue
      const list = byRecord.get(f.recordId) ?? []
      list.push(f)
      byRecord.set(f.recordId, list)
    }

    return {
      // `as const` so the two payloads form a discriminated union rather than both
      // widening to `collapsed: boolean` — that is what lets a caller narrow the node
      // shape from the flag instead of asserting it.
      collapsed: false as const,
      modules: moduleRows,
      nodes: recordRows.map((r) => ({ ...r, fields: byRecord.get(r.id) ?? [] })),
      edges: relationshipRows,
    }
  }

  // Collapsed: one node per module, edges folded and weighted by how many record
  // relationships they stand for. Records with no module share an "unassigned" node.
  const UNASSIGNED = '__unassigned__'
  const moduleOf = new Map(recordRows.map((r) => [r.id, r.moduleId ?? UNASSIGNED]))

  const usedModules = new Set(moduleOf.values())
  const nodes = moduleRows
    .filter((m) => usedModules.has(m.id))
    .map((m) => ({
      id: m.id,
      apiName: m.key,
      label: m.name,
      moduleColor: m.color,
      recordCount: recordRows.filter((r) => r.moduleId === m.id).length,
    }))

  if (usedModules.has(UNASSIGNED)) {
    nodes.push({
      id: UNASSIGNED,
      apiName: 'unassigned',
      label: 'No module',
      moduleColor: '#94a3b8',
      recordCount: recordRows.filter((r) => !r.moduleId).length,
    })
  }

  const folded = new Map<
    string,
    { id: string; parentRecordId: string; childRecordId: string; weight: number }
  >()
  for (const rel of relationshipRows) {
    const parent = moduleOf.get(rel.parentRecordId)!
    const child = moduleOf.get(rel.childRecordId)!
    if (parent === child) continue // internal to a module — invisible when collapsed
    const key = `${parent}->${child}`
    const existing = folded.get(key)
    if (existing) existing.weight++
    else
      folded.set(key, {
        id: key,
        parentRecordId: parent,
        childRecordId: child,
        weight: 1,
      })
  }

  return {
    collapsed: true as const,
    modules: moduleRows,
    nodes,
    edges: [...folded.values()],
  }
})

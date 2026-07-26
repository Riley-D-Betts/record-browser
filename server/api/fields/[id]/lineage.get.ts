import { eq, inArray } from 'drizzle-orm'
import { dataTypes, fieldDependencies, fields, modules, records, useDb } from '../../../db'
import { lineageQuerySchema } from '../../../../shared/schemas'
import { traverse } from '../../../services/lineage'
import type { DependencyEdge } from '../../../services/lineage'

/**
 * Lineage for one field, both directions.
 *
 * The whole edge table is loaded and walked in memory — at catalog scale that is a
 * sub-millisecond read, and it keeps the traversal a pure function that unit tests can
 * cover without a database. See server/services/lineage.ts for the reasoning.
 */
const handler = defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const q = await getValidatedQuery(event, lineageQuerySchema.parse)
  const db = useDb()

  const root = db.select().from(fields).where(eq(fields.id, id)).all()[0]
  if (!root) throw createError({ statusCode: 404, statusMessage: 'No such field' })

  const edges: DependencyEdge[] = db
    .select({
      id: fieldDependencies.id,
      fieldId: fieldDependencies.fieldId,
      sourceFieldId: fieldDependencies.sourceFieldId,
      kind: fieldDependencies.kind,
    })
    .from(fieldDependencies)
    .all()

  const result = traverse(edges, id, q.direction, q.depth)

  // Hydrate only the fields the walk actually reached.
  const reached = result.nodes.map((n) => n.fieldId)
  const details = db
    .select({
      id: fields.id,
      apiName: fields.apiName,
      label: fields.label,
      externalId: fields.externalId,
      origin: fields.origin,
      sourceKind: fields.sourceKind,
      sourceExpression: fields.sourceExpression,
      isExternallyPopulated: fields.isExternallyPopulated,
      sourceNotes: fields.sourceNotes,
      dataTypeKey: dataTypes.key,
      dataTypeLabel: dataTypes.label,
      recordId: records.id,
      recordApiName: records.apiName,
      recordLabel: records.label,
      moduleId: modules.id,
      moduleName: modules.name,
      moduleColor: modules.color,
    })
    .from(fields)
    .innerJoin(records, eq(records.id, fields.recordId))
    .leftJoin(modules, eq(modules.id, records.moduleId))
    .leftJoin(dataTypes, eq(dataTypes.id, fields.dataTypeId))
    .where(inArray(fields.id, reached))
    .all()

  const byId = new Map(details.map((d) => [d.id, d]))

  return {
    ...result,
    nodes: result.nodes.flatMap((node) => {
      const detail = byId.get(node.fieldId)
      // Every reached id is either the root or one end of a dependency edge, and both
      // are foreign keys into `fields` — so this cannot miss. Dropping rather than
      // spreading a possible `undefined` keeps that certainty in the type instead of
      // handing every consumer a node whose every property might be absent.
      if (!detail) return []
      return [
        {
          ...node,
          ...detail,
          /**
           * A true origin: a person types it. A field flagged as externally populated
           * is NOT one, even though its source kind says user entry — calling it an
           * origin would hide a whole upstream system from whoever reads the trace.
           */
          isOrigin:
            node.depth <= 0 &&
            detail.sourceKind === 'user_entry' &&
            !detail.isExternallyPopulated,
        },
      ]
    }),
  }
})

export default handler

/** See the note on FieldDetailResponse — a runtime-built path defeats route inference. */
export type LineageResponse = Awaited<ReturnType<typeof handler>>

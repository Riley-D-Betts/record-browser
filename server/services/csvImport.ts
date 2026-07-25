import { eq } from 'drizzle-orm'
import { dataTypes, fields, modules, records } from '../db/schema'
import { COLUMNS_BY_KEY, blanknessFor, detectShape } from '../../shared/csvColumns'
import { apiNameSchema } from '../../shared/schemas'
import { recordChange } from '../utils/audit'
import {
  EMPTY_CELL,
  emptyTally,
  planUpsert,
  summariseColumnImpact,
} from './importPlan'
import type { Strategy, Tally, UpsertPlan } from './importPlan'

/**
 * CSV import: resolve identity against the catalog, plan every row, then either report
 * the plan or apply it.
 *
 * Records are planned before fields, and the field resolver consults existing records
 * *union the ones this file will create*, so a field row can name a record defined
 * earlier in the same file.
 */

export type ErrorCode =
  | 'AMBIGUOUS_EXTERNAL_ID'
  | 'DUPLICATE_IN_FILE'
  | 'PARENT_RECORD_NOT_FOUND'
  | 'MISSING_REQUIRED'
  | 'INVALID_API_NAME'
  | 'UNKNOWN_ENUM'
  | 'UNKNOWN_DATA_TYPE'
  | 'UNKNOWN_MODULE'
  | 'RENAME_TARGET_TAKEN'

export interface RowError {
  rowNumber: number
  code: ErrorCode
  message: string
  column?: string
}

export interface PreviewRow {
  /** 1-based line in the source file, so a reported problem is findable in it. */
  rowNumber: number
  entity: 'record' | 'field'
  key: string
  matchedBy: 'apiName' | 'externalId' | null
  action: UpsertPlan['action']
  changes: UpsertPlan['changes']
  suppressed: UpsertPlan['suppressed']
  reason?: string
}

export interface RenameNotice {
  entity: 'record' | 'field'
  externalId: string
  from: string
  to: string
  rowNumber: number
}

export interface ImportPreview {
  batchId: string
  strategy: Strategy
  emptyCellsClear: boolean
  shape: 'records' | 'fields'
  counts: { records: Tally; fields: Tally }
  columnImpact: Array<{ entity: 'record' | 'field'; column: string; rows: number }>
  renames: RenameNotice[]
  warnings: string[]
  rows: PreviewRow[]
  truncatedRows: number
  errors: RowError[]
}

export interface CsvImportInput {
  /** Canonical column key -> header name, as confirmed in the mapping UI. */
  mapping: Record<string, string>
  /** Parsed rows, keyed by original header. */
  rows: Array<Record<string, string>>
  strategy: Strategy
  emptyCellsClear: boolean
  /** Renames the user explicitly ticked, keyed by row number. */
  approvedRenames?: number[]
}

const PREVIEW_ROW_CAP = 300

/** apiName is never changed implicitly — a rename has to be opted into per row. */
const PROTECTED = new Set(['apiName'])

const RECORD_DEFAULTS = { origin: 'custom', isDeprecated: false }
const FIELD_DEFAULTS = {
  origin: 'custom',
  isRequired: false,
  isUnique: false,
  isPrimaryKey: false,
  isDeprecated: false,
  sourceKind: 'user_entry',
}

interface ParsedRow {
  rowNumber: number
  record: Record<string, unknown>
  field: Record<string, unknown>
  errors: RowError[]
  /** Raw module / type names, resolved to ids later. */
  moduleRef?: string
  typeRef?: string
}

/**
 * Turn raw cells into typed values, collecting per-cell problems rather than throwing
 * on the first one — a person fixing a spreadsheet wants the whole list.
 */
function parseRows(input: CsvImportInput): {
  parsed: ParsedRow[]
  presentTargets: { record: Set<string>; field: Set<string> }
} {
  const active = Object.entries(input.mapping).filter(([, header]) => Boolean(header))
  const presentTargets = { record: new Set<string>(), field: new Set<string>() }

  for (const [key] of active) {
    const col = COLUMNS_BY_KEY.get(key)
    if (!col) continue
    // typeDetail.* are assembled separately; the planner sees one `typeDetail` column.
    const target = col.target.startsWith('typeDetail.') ? 'typeDetail' : col.target
    presentTargets[col.entity].add(target)
  }

  const parsed = input.rows.map((raw, index) => {
    const rowNumber = index + 2 // 1-based, plus the header line
    const out: ParsedRow = { rowNumber, record: {}, field: {}, errors: [] }
    const detail: Record<string, unknown> = {}
    let sawDetail = false

    for (const [key, header] of active) {
      const col = COLUMNS_BY_KEY.get(key)
      if (!col) continue

      const cell = (raw[header] ?? '').trim()
      const bucket = col.entity === 'record' ? out.record : out.field

      if (cell === '') {
        if (!col.target.startsWith('typeDetail.')) bucket[col.target] = EMPTY_CELL
        continue
      }

      const coerced = col.coerce ? col.coerce(cell) : { ok: true as const, value: cell }
      if (!coerced.ok) {
        out.errors.push({
          rowNumber,
          code: 'UNKNOWN_ENUM',
          column: col.key,
          message: coerced.message,
        })
        continue
      }

      if (col.target.startsWith('typeDetail.')) {
        detail[col.target.slice('typeDetail.'.length)] = coerced.value
        sawDetail = true
        continue
      }

      // Module and type arrive as names and are resolved against the catalog below.
      if (col.key === 'record_module') out.moduleRef = String(coerced.value)
      else if (col.key === 'field_type') out.typeRef = String(coerced.value)
      else bucket[col.target] = coerced.value
    }

    if (sawDetail) out.field.typeDetail = JSON.stringify(detail)
    return out
  })

  return { parsed, presentTargets }
}

const nameOf = (row: Record<string, unknown>, key: string): string | null => {
  const v = row[key]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

export function planCsvImport(db: any, input: CsvImportInput, batchId: string) {
  const shape = detectShape(
    Object.entries(input.mapping)
      .filter(([, header]) => Boolean(header))
      .map(([key]) => key),
  )

  const { parsed, presentTargets } = parseRows(input)
  const errors: RowError[] = parsed.flatMap((p) => p.errors)
  const warnings: string[] = []
  const renames: RenameNotice[] = []
  const previewRows: PreviewRow[] = []
  const counts = { records: emptyTally(), fields: emptyTally() }
  const impactInput: Array<{ entity: 'record' | 'field'; plan: UpsertPlan }> = []

  // --- lookups --------------------------------------------------------------
  const existingRecords = db.select().from(records).all() as Array<Record<string, any>>
  const byApiName = new Map(existingRecords.map((r) => [r.apiName, r]))
  const byExternalId = new Map<string, Array<Record<string, any>>>()
  for (const r of existingRecords) {
    if (!r.externalId) continue
    const list = byExternalId.get(r.externalId) ?? []
    list.push(r)
    byExternalId.set(r.externalId, list)
  }

  const moduleIdByName = new Map<string, string>()
  for (const m of db.select().from(modules).all()) {
    moduleIdByName.set(m.key.toLowerCase(), m.id)
    moduleIdByName.set(m.name.toLowerCase(), m.id)
  }
  const typeIdByName = new Map<string, string>()
  for (const t of db.select().from(dataTypes).all()) {
    typeIdByName.set(t.key.toLowerCase(), t.id)
    typeIdByName.set(t.label.toLowerCase(), t.id)
  }

  const approvedRenames = new Set(input.approvedRenames ?? [])

  /**
   * Match one incoming row against the catalog.
   *
   * apiName wins because it is unique: matching on externalId first can bind to one
   * row and then collide on insert against another. An externalId matching more than
   * one row is a hard error rather than a guess.
   */
  function resolve(
    incoming: Record<string, unknown>,
    candidatesByApiName: Map<string, any>,
    candidatesByExternalId: Map<string, any[]>,
    rowNumber: number,
    entity: 'record' | 'field',
  ): { existing: any | null; matchedBy: 'apiName' | 'externalId' | null; failed?: true } {
    const apiName = nameOf(incoming, 'apiName')
    const externalId = nameOf(incoming, 'externalId')

    if (apiName) {
      const hit = candidatesByApiName.get(apiName)
      if (hit) return { existing: hit, matchedBy: 'apiName' }
    }

    if (externalId) {
      const hits = candidatesByExternalId.get(externalId) ?? []
      if (hits.length > 1) {
        errors.push({
          rowNumber,
          code: 'AMBIGUOUS_EXTERNAL_ID',
          message: `Source ID ${externalId} matches ${hits.length} ${entity}s (${hits
            .map((h) => h.apiName)
            .join(', ')}) — set a technical name to disambiguate`,
        })
        return { existing: null, matchedBy: null, failed: true }
      }
      if (hits.length === 1) {
        const hit = hits[0]!
        // The source system renamed something. Worth noticing — that is part of why a
        // catalog exists — but never applied silently.
        if (apiName && apiName !== hit.apiName) {
          if (candidatesByApiName.has(apiName)) {
            errors.push({
              rowNumber,
              code: 'RENAME_TARGET_TAKEN',
              message: `Source ID ${externalId} is on "${hit.apiName}", but "${apiName}" already exists as a different ${entity}`,
            })
            return { existing: null, matchedBy: null, failed: true }
          }
          renames.push({
            entity,
            externalId,
            from: hit.apiName,
            to: apiName,
            rowNumber,
          })
        }
        return { existing: hit, matchedBy: 'externalId' }
      }
    }

    return { existing: null, matchedBy: null }
  }

  // --- duplicates within the file ------------------------------------------
  function flagDuplicates(
    keys: Array<{ rowNumber: number; key: string | null }>,
    entity: 'record' | 'field',
  ): Set<number> {
    const seen = new Map<string, number[]>()
    for (const { rowNumber, key } of keys) {
      if (!key) continue
      const list = seen.get(key) ?? []
      list.push(rowNumber)
      seen.set(key, list)
    }
    const bad = new Set<number>()
    for (const [key, rowNumbers] of seen) {
      if (rowNumbers.length < 2) continue
      for (const rowNumber of rowNumbers) {
        bad.add(rowNumber)
        errors.push({
          rowNumber,
          code: 'DUPLICATE_IN_FILE',
          message: `"${key}" appears on ${rowNumbers.length} rows (${rowNumbers.join(', ')}) — one ${entity} cannot be described twice in one file`,
        })
      }
    }
    return bad
  }

  // --- records --------------------------------------------------------------
  const recordPlans: Array<{
    rowNumber: number
    apiName: string
    plan: UpsertPlan
    existing: any | null
  }> = []
  /** api_name -> a record that exists or will after this import. */
  const resolvedRecordIds = new Map<string, string | null>()
  for (const r of existingRecords) resolvedRecordIds.set(r.apiName, r.id)

  // In a flat sheet the same record repeats on every field row; plan it once.
  const seenRecordRows = new Set<string>()
  const recordRows = parsed.filter((p) => {
    const apiName = nameOf(p.record, 'apiName')
    if (!apiName) return false
    if (shape === 'fields') {
      if (seenRecordRows.has(apiName)) return false
      seenRecordRows.add(apiName)
    }
    return true
  })

  const dupRecords =
    shape === 'records'
      ? flagDuplicates(
          recordRows.map((p) => ({ rowNumber: p.rowNumber, key: nameOf(p.record, 'apiName') })),
          'record',
        )
      : new Set<number>()

  const recordBlankness = blanknessFor('record')

  for (const row of recordRows) {
    if (dupRecords.has(row.rowNumber)) {
      counts.records.error++
      continue
    }

    const incoming = { ...row.record }
    const apiName = nameOf(incoming, 'apiName')!

    const nameCheck = apiNameSchema.safeParse(apiName)
    if (!nameCheck.success) {
      errors.push({
        rowNumber: row.rowNumber,
        code: 'INVALID_API_NAME',
        column: 'record_api_name',
        message: `"${apiName}": ${nameCheck.error.issues[0]?.message}`,
      })
      counts.records.error++
      continue
    }

    if (row.moduleRef) {
      const moduleId = moduleIdByName.get(row.moduleRef.toLowerCase())
      if (moduleId) incoming.moduleId = moduleId
      else {
        warnings.push(
          `Row ${row.rowNumber}: no module called "${row.moduleRef}" — left ungrouped. Modules are not created by import.`,
        )
      }
    }

    const { existing, matchedBy, failed } = resolve(
      incoming,
      byApiName,
      byExternalId,
      row.rowNumber,
      'record',
    )
    if (failed) {
      counts.records.error++
      continue
    }

    // A record row must be able to name the record. Creating needs a label too.
    if (!existing && !nameOf(incoming, 'label')) {
      // Fall back to the technical name rather than refusing — a sheet that names a
      // record but not its label is common, and a label is required by the schema.
      incoming.label = apiName
    }

    const plan = planUpsert(existing, incoming, {
      strategy: input.strategy,
      columns: presentTargets.record,
      blankness: recordBlankness,
      defaults: RECORD_DEFAULTS,
      protectedColumns:
        existing && approvedRenames.has(row.rowNumber) ? new Set() : PROTECTED,
      emptyCellsClear: input.emptyCellsClear,
    })

    recordPlans.push({ rowNumber: row.rowNumber, apiName, plan, existing })
    counts.records[plan.action]++
    impactInput.push({ entity: 'record', plan })
    resolvedRecordIds.set(apiName, existing?.id ?? null)

    previewRows.push({
      rowNumber: row.rowNumber,
      entity: 'record',
      key: apiName,
      matchedBy,
      action: plan.action,
      changes: plan.changes,
      suppressed: plan.suppressed,
      reason: plan.reason,
    })
  }

  // --- fields ---------------------------------------------------------------
  const fieldPlans: Array<{
    rowNumber: number
    recordApiName: string
    apiName: string
    plan: UpsertPlan
    existing: any | null
  }> = []

  if (shape === 'fields') {
    const existingFields = db
      .select({
        id: fields.id,
        recordId: fields.recordId,
        apiName: fields.apiName,
        label: fields.label,
        externalId: fields.externalId,
        dataTypeId: fields.dataTypeId,
        typeDetail: fields.typeDetail,
        origin: fields.origin,
        isRequired: fields.isRequired,
        isUnique: fields.isUnique,
        isPrimaryKey: fields.isPrimaryKey,
        isDeprecated: fields.isDeprecated,
        description: fields.description,
        recordApiName: records.apiName,
      })
      .from(fields)
      .innerJoin(records, eq(records.id, fields.recordId))
      .all() as Array<Record<string, any>>

    /*
     * Keyed by record **id**, not by the record's name.
     *
     * A file can rename a record — that is the whole point of matching on source ID —
     * and at this stage the incoming name may not be the name the catalog still holds.
     * Keying by name loses every existing field on a renamed record, so each one gets
     * planned as a create and then dies on the (record_id, api_name) unique index.
     */
    const fieldsByRecordId = new Map<string, Map<string, any>>()
    const fieldsByRecordIdExternal = new Map<string, Map<string, any[]>>()
    for (const f of existingFields) {
      const nameMap = fieldsByRecordId.get(f.recordId) ?? new Map()
      nameMap.set(f.apiName, f)
      fieldsByRecordId.set(f.recordId, nameMap)

      if (f.externalId) {
        const extMap = fieldsByRecordIdExternal.get(f.recordId) ?? new Map()
        const list = extMap.get(f.externalId) ?? []
        list.push(f)
        extMap.set(f.externalId, list)
        fieldsByRecordIdExternal.set(f.recordId, extMap)
      }
    }

    const dupFields = flagDuplicates(
      parsed.map((p) => {
        const rec = nameOf(p.record, 'apiName')
        const fld = nameOf(p.field, 'apiName')
        return { rowNumber: p.rowNumber, key: rec && fld ? `${rec}.${fld}` : null }
      }),
      'field',
    )

    const fieldBlankness = blanknessFor('field')

    for (const row of parsed) {
      const fieldApiName = nameOf(row.field, 'apiName')
      if (!fieldApiName) continue

      if (dupFields.has(row.rowNumber)) {
        counts.fields.error++
        continue
      }

      const recordApiName = nameOf(row.record, 'apiName')
      if (!recordApiName || !resolvedRecordIds.has(recordApiName)) {
        errors.push({
          rowNumber: row.rowNumber,
          code: 'PARENT_RECORD_NOT_FOUND',
          message: recordApiName
            ? `No record called "${recordApiName}" — import the records first, or add a record column to this file`
            : 'No record named on this row',
        })
        counts.fields.error++
        continue
      }

      const nameCheck = apiNameSchema.safeParse(fieldApiName)
      if (!nameCheck.success) {
        errors.push({
          rowNumber: row.rowNumber,
          code: 'INVALID_API_NAME',
          column: 'field_api_name',
          message: `"${fieldApiName}": ${nameCheck.error.issues[0]?.message}`,
        })
        counts.fields.error++
        continue
      }

      const incoming = { ...row.field }
      if (row.typeRef) {
        const typeId = typeIdByName.get(row.typeRef.toLowerCase())
        if (typeId) incoming.dataTypeId = typeId
        else {
          warnings.push(
            `Row ${row.rowNumber}: no type called "${row.typeRef}" — left unset. Types are not created by import.`,
          )
        }
      }

      // null means the parent is being created by this same import, so it has no
      // existing fields to match against.
      const parentId = resolvedRecordIds.get(recordApiName) ?? null

      const { existing, matchedBy, failed } = resolve(
        incoming,
        (parentId && fieldsByRecordId.get(parentId)) || new Map(),
        (parentId && fieldsByRecordIdExternal.get(parentId)) || new Map(),
        row.rowNumber,
        'field',
      )
      if (failed) {
        counts.fields.error++
        continue
      }

      if (!existing && !nameOf(incoming, 'label')) incoming.label = fieldApiName

      const plan = planUpsert(existing, incoming, {
        strategy: input.strategy,
        columns: presentTargets.field,
        blankness: fieldBlankness,
        defaults: FIELD_DEFAULTS,
        protectedColumns:
          existing && approvedRenames.has(row.rowNumber) ? new Set() : PROTECTED,
        emptyCellsClear: input.emptyCellsClear,
      })

      fieldPlans.push({
        rowNumber: row.rowNumber,
        recordApiName,
        apiName: fieldApiName,
        plan,
        existing,
      })
      counts.fields[plan.action]++
      impactInput.push({ entity: 'field', plan })

      previewRows.push({
        rowNumber: row.rowNumber,
        entity: 'field',
        key: `${recordApiName}.${fieldApiName}`,
        matchedBy,
        action: plan.action,
        changes: plan.changes,
        suppressed: plan.suppressed,
        reason: plan.reason,
      })
    }
  }

  const preview: ImportPreview = {
    batchId,
    strategy: input.strategy,
    emptyCellsClear: input.emptyCellsClear,
    shape,
    counts,
    columnImpact: summariseColumnImpact(impactInput),
    renames,
    warnings,
    rows: previewRows.slice(0, PREVIEW_ROW_CAP),
    truncatedRows: Math.max(0, previewRows.length - PREVIEW_ROW_CAP),
    errors,
  }

  return { preview, recordPlans, fieldPlans, resolvedRecordIds }
}

/**
 * Apply a plan. Writes a per-entity audit row sharing the batch id, fed the same
 * before/after the planner produced — so the preview's "3 columns changed" and the
 * audit trail cannot disagree.
 */
export function applyCsvImport(
  tx: any,
  planned: ReturnType<typeof planCsvImport>,
  actorId: string | null,
  batchId: string,
) {
  const ctx = { userId: actorId, batchId }
  const applied = { recordsCreated: 0, recordsUpdated: 0, fieldsCreated: 0, fieldsUpdated: 0 }
  const recordIds = new Map(planned.resolvedRecordIds)

  for (const { apiName, plan, existing } of planned.recordPlans) {
    if (plan.action === 'create') {
      const created = tx
        .insert(records)
        .values({ ...plan.values, createdBy: actorId, updatedBy: actorId })
        .returning()
        .all()[0]
      recordIds.set(apiName, created.id)
      applied.recordsCreated++
      recordChange(tx, ctx, {
        entityType: 'record',
        entityId: created.id,
        action: 'create',
        after: created,
      })
    } else if (plan.action === 'update') {
      const after = tx
        .update(records)
        .set({ ...plan.values, updatedBy: actorId })
        .where(eq(records.id, existing.id))
        .returning()
        .all()[0]
      applied.recordsUpdated++
      recordChange(tx, ctx, {
        entityType: 'record',
        entityId: existing.id,
        action: 'update',
        before: existing,
        after,
      })
    }
  }

  for (const { recordApiName, plan, existing } of planned.fieldPlans) {
    if (plan.action === 'create') {
      const recordId = recordIds.get(recordApiName)
      if (!recordId) continue
      const created = tx
        .insert(fields)
        .values({ ...plan.values, recordId, createdBy: actorId, updatedBy: actorId })
        .returning()
        .all()[0]
      applied.fieldsCreated++
      recordChange(tx, ctx, {
        entityType: 'field',
        entityId: created.id,
        action: 'create',
        after: created,
      })
    } else if (plan.action === 'update') {
      const after = tx
        .update(fields)
        .set({ ...plan.values, updatedBy: actorId })
        .where(eq(fields.id, existing.id))
        .returning()
        .all()[0]
      applied.fieldsUpdated++
      recordChange(tx, ctx, {
        entityType: 'field',
        entityId: existing.id,
        action: 'update',
        before: existing,
        after,
      })
    }
  }

  return applied
}

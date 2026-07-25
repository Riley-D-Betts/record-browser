import { ORIGINS } from './constants'
import type { Origin } from './constants'

/**
 * The vocabulary of a catalog CSV.
 *
 * Shared between the mapping UI and the server so the two agree by construction —
 * the browser decides which header means what, and the server must interpret that
 * decision identically or an import means something different from its preview.
 *
 * Deliberately covers records and fields only. `source_kind` is absent: it is NOT NULL
 * with a CHECK tying it to `source_expression`, so a spreadsheet naming `derived` with
 * no expression would be a database-level failure rather than a warning. Provenance is
 * edited through the form or the JSON path, where it can be routed through
 * setFieldSource and keep its dependency rows consistent.
 */

/**
 * How an import treats a row that already exists. Chosen per import.
 *
 * Lives here rather than beside the planner because the wizard needs it too, and a
 * client component reaching into server/ would drag server code into the browser
 * bundle.
 */
export const STRATEGIES = ['create-only', 'fill-blanks', 'overwrite'] as const
export type Strategy = (typeof STRATEGIES)[number]

export const STRATEGY_LABELS: Record<Strategy, string> = {
  'create-only': 'Only add new rows',
  'fill-blanks': 'Fill blanks, never overwrite',
  overwrite: 'The file wins',
}

export const STRATEGY_DESCRIPTIONS: Record<Strategy, string> = {
  'create-only': 'Existing records and fields are left completely alone.',
  'fill-blanks':
    'Updates a value only where the catalog has none. Anything already written here is kept, and disagreements are listed rather than applied.',
  overwrite:
    'Every value in the file replaces what the catalog holds, including descriptions your team wrote.',
}

/** Which entity a column belongs to, and how blankness works for it. */
export type ColumnEntity = 'record' | 'field'
export type Blankness = 'text' | 'ref' | 'value'

export interface ColumnDef {
  /** Canonical key used in the mapping and on the wire. */
  key: string
  entity: ColumnEntity
  /** Property on the record/field row this writes to, or a synthetic target. */
  target: string
  label: string
  help?: string
  blankness: Blankness
  /** Coerces a trimmed cell into the stored representation. */
  coerce?: (raw: string) => { ok: true; value: unknown } | { ok: false; message: string }
  /** Headers that map here without the user having to say so. */
  aliases: readonly string[]
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'x', '✓', 'checked', 'required'])
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', '-', '—'])

export function coerceBoolean(raw: string) {
  const v = raw.trim().toLowerCase()
  if (TRUE_WORDS.has(v)) return { ok: true as const, value: true }
  if (FALSE_WORDS.has(v)) return { ok: true as const, value: false }
  return {
    ok: false as const,
    message: `Cannot read "${raw}" as yes or no — use true/false, yes/no, 1/0 or x`,
  }
}

/**
 * Accepts both vocabularies a source system might use: a literal Origin column
 * ("native" / "custom") and a "Custom?" checkbox column (true / false). Both are
 * common, and guessing wrong silently mislabels the native-vs-custom split the whole
 * catalog turns on.
 */
const NATIVE_WORDS = new Set(['native', 'standard', 'system', 'built-in', 'builtin'])
const CUSTOM_WORDS = new Set(['custom', 'custom field', 'user', 'user-defined'])

export function coerceOrigin(raw: string) {
  const v = raw.trim().toLowerCase()
  if (NATIVE_WORDS.has(v)) return { ok: true as const, value: 'native' as Origin }
  if (CUSTOM_WORDS.has(v)) return { ok: true as const, value: 'custom' as Origin }
  // A boolean column headed "Custom?" — true means custom.
  if (TRUE_WORDS.has(v)) return { ok: true as const, value: 'custom' as Origin }
  if (FALSE_WORDS.has(v)) return { ok: true as const, value: 'native' as Origin }
  return {
    ok: false as const,
    message: `Cannot read "${raw}" as an origin — use ${ORIGINS.join(' or ')}`,
  }
}

function coerceInteger(raw: string) {
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { ok: false as const, message: `Cannot read "${raw}" as a whole number` }
  }
  return { ok: true as const, value: n }
}

const coerceText = (raw: string) => ({ ok: true as const, value: raw.trim() })

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const COLUMNS: readonly ColumnDef[] = [
  // --- record ---
  {
    key: 'record_api_name',
    entity: 'record',
    target: 'apiName',
    label: 'Record technical name',
    help: 'The identifier used in code. Primary way rows are matched to the catalog.',
    blankness: 'text',
    coerce: coerceText,
    aliases: [
      'record api name', 'record name', 'record', 'object api name', 'object name',
      'object', 'table name', 'table', 'entity name', 'entity', 'sobject',
    ],
  },
  {
    key: 'record_label',
    entity: 'record',
    target: 'label',
    label: 'Record display label',
    blankness: 'text',
    coerce: coerceText,
    aliases: ['record label', 'object label', 'table label', 'entity label'],
  },
  {
    key: 'record_external_id',
    entity: 'record',
    target: 'externalId',
    label: 'Record source ID',
    help: "The source system's own identifier for the record.",
    blankness: 'text',
    coerce: coerceText,
    aliases: ['record id', 'record source id', 'object id', 'table id', 'entity id'],
  },
  {
    key: 'record_module',
    entity: 'record',
    target: 'moduleId',
    label: 'Module',
    help: 'Matched against existing modules by key or name. Missing modules are reported, not created.',
    blankness: 'ref',
    coerce: coerceText,
    aliases: ['module', 'record module', 'area', 'domain', 'package', 'namespace'],
  },
  {
    key: 'record_origin',
    entity: 'record',
    target: 'origin',
    label: 'Record origin',
    blankness: 'text',
    coerce: coerceOrigin,
    aliases: ['record origin', 'object origin', 'record custom', 'object custom'],
  },
  {
    key: 'record_description',
    entity: 'record',
    target: 'description',
    label: 'Record description',
    blankness: 'text',
    coerce: coerceText,
    aliases: ['record description', 'object description', 'table description'],
  },
  {
    key: 'record_deprecated',
    entity: 'record',
    target: 'isDeprecated',
    label: 'Record deprecated',
    blankness: 'value',
    coerce: coerceBoolean,
    aliases: ['record deprecated', 'object deprecated', 'record retired'],
  },

  // --- field ---
  {
    key: 'field_api_name',
    entity: 'field',
    target: 'apiName',
    label: 'Field technical name',
    help: 'Presence of this column is what marks the file as a field sheet.',
    blankness: 'text',
    coerce: coerceText,
    aliases: [
      'field api name', 'field name', 'field', 'api name', 'column name', 'column',
      'attribute name', 'attribute', 'property', 'name',
    ],
  },
  {
    key: 'field_label',
    entity: 'field',
    target: 'label',
    label: 'Field display label',
    blankness: 'text',
    coerce: coerceText,
    aliases: ['field label', 'column label', 'display label', 'label', 'title'],
  },
  {
    key: 'field_external_id',
    entity: 'field',
    target: 'externalId',
    label: 'Field source ID',
    blankness: 'text',
    coerce: coerceText,
    aliases: ['field id', 'field source id', 'column id', 'source id', 'external id', 'id'],
  },
  {
    key: 'field_type',
    entity: 'field',
    target: 'dataTypeId',
    label: 'Type',
    help: 'Matched against the type catalog by key or label. Unknown types are reported and left unset.',
    blankness: 'ref',
    coerce: coerceText,
    aliases: ['type', 'data type', 'field type', 'column type', 'datatype'],
  },
  {
    key: 'field_origin',
    entity: 'field',
    target: 'origin',
    label: 'Field origin',
    help: 'Accepts native/custom, or a true/false "Custom?" column.',
    blankness: 'text',
    coerce: coerceOrigin,
    aliases: ['field origin', 'origin', 'custom', 'is custom', 'custom field', 'native or custom'],
  },
  {
    key: 'field_required',
    entity: 'field',
    target: 'isRequired',
    label: 'Required',
    blankness: 'value',
    coerce: coerceBoolean,
    aliases: ['required', 'is required', 'mandatory', 'not null', 'nullable no'],
  },
  {
    key: 'field_unique',
    entity: 'field',
    target: 'isUnique',
    label: 'Unique',
    blankness: 'value',
    coerce: coerceBoolean,
    aliases: ['unique', 'is unique'],
  },
  {
    key: 'field_primary_key',
    entity: 'field',
    target: 'isPrimaryKey',
    label: 'Primary key',
    blankness: 'value',
    coerce: coerceBoolean,
    aliases: ['primary key', 'is primary key', 'pk', 'is pk', 'key'],
  },
  {
    key: 'field_deprecated',
    entity: 'field',
    target: 'isDeprecated',
    label: 'Field deprecated',
    blankness: 'value',
    coerce: coerceBoolean,
    aliases: ['deprecated', 'is deprecated', 'retired', 'obsolete'],
  },
  {
    key: 'field_description',
    entity: 'field',
    target: 'description',
    label: 'Field description',
    blankness: 'text',
    coerce: coerceText,
    aliases: ['description', 'field description', 'help text', 'comment', 'notes', 'remarks'],
  },

  // --- type detail, assembled into the fields.type_detail JSON column ---
  {
    key: 'field_length',
    entity: 'field',
    target: 'typeDetail.length',
    label: 'Length',
    blankness: 'value',
    coerce: coerceInteger,
    aliases: ['length', 'size', 'max length', 'character length'],
  },
  {
    key: 'field_precision',
    entity: 'field',
    target: 'typeDetail.precision',
    label: 'Precision',
    blankness: 'value',
    coerce: coerceInteger,
    aliases: ['precision', 'numeric precision'],
  },
  {
    key: 'field_scale',
    entity: 'field',
    target: 'typeDetail.scale',
    label: 'Scale',
    blankness: 'value',
    coerce: coerceInteger,
    aliases: ['scale', 'decimal places', 'numeric scale'],
  },
  {
    key: 'field_options',
    entity: 'field',
    target: 'typeDetail.options',
    label: 'Allowed values',
    help: 'Semicolon, pipe or newline separated.',
    blankness: 'value',
    coerce: (raw) => ({
      ok: true as const,
      value: raw
        .split(/[;|\n]/)
        .map((o) => o.trim())
        .filter(Boolean),
    }),
    aliases: ['allowed values', 'picklist values', 'options', 'enum values', 'valid values'],
  },
] as const

export const COLUMNS_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]))

/** Blankness lookup keyed by the row property, for the planner. */
export function blanknessFor(entity: ColumnEntity): Record<string, Blankness> {
  const out: Record<string, Blankness> = {}
  for (const col of COLUMNS) {
    if (col.entity === entity) out[col.target] = col.blankness
  }
  return out
}

// ---------------------------------------------------------------------------
// Header matching
// ---------------------------------------------------------------------------

const normalise = (header: string) =>
  header
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/[?()[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Best guess at what each header means.
 *
 * Only a guess: the mapping UI shows every decision and lets the user correct it
 * before anything is read. Ambiguous unqualified headers ("Name", "Label", "ID") are
 * read as field-level, because in the flat shape the record columns repeat and the
 * field columns vary — so the unqualified one is nearly always the field.
 */
export function autoMapHeaders(headers: string[]): Record<string, string | null> {
  const mapping: Record<string, string | null> = {}
  const taken = new Set<string>()

  // Two passes so an exact, qualified match always beats a loose unqualified one.
  for (const pass of ['exact', 'loose'] as const) {
    for (const header of headers) {
      if (mapping[header]) continue
      const n = normalise(header)

      for (const col of COLUMNS) {
        if (taken.has(col.key)) continue
        const hit =
          pass === 'exact'
            ? n === normalise(col.key) || col.aliases.some((a) => a === n)
            : col.aliases.some((a) => n === a || n.replace(/s$/, '') === a)
        if (hit) {
          mapping[header] = col.key
          taken.add(col.key)
          break
        }
      }
    }
  }

  for (const header of headers) if (!(header in mapping)) mapping[header] = null
  return mapping
}

/**
 * A file is a field sheet if it names fields, and a record sheet otherwise.
 *
 * That single test covers both shapes the user asked for: the flat export (record
 * columns repeated on every field row) and a records-only sheet. The two-sheet
 * workflow is just two uploads.
 */
export function detectShape(mappedKeys: Iterable<string>): 'fields' | 'records' {
  return [...mappedKeys].includes('field_api_name') ? 'fields' : 'records'
}

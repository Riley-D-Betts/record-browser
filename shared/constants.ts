/**
 * Vocabulary for the catalog.
 *
 * Deliberately platform-agnostic: a "record" is whatever the source system calls an
 * entity/table/object, and a "field" is whatever it calls a column/attribute. Nothing
 * here is specific to any vendor.
 *
 * Imported by both the Drizzle schema and the client, so the enum values can never
 * drift between the database and the UI.
 */

/** Did this ship with the product, or did the team add it? */
export const ORIGINS = ['native', 'custom'] as const
export type Origin = (typeof ORIGINS)[number]

export const ORIGIN_LABELS: Record<Origin, string> = {
  native: 'Native',
  custom: 'Custom',
}

/**
 * Where a field's value comes from. Exactly one applies per field.
 *
 *  user_entry — a human types it. An origin point; nothing upstream.
 *  reference  — copied from exactly one field on another record.
 *  derived    — computed from an expression over zero or more other fields.
 */
export const SOURCE_KINDS = ['user_entry', 'reference', 'derived'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  user_entry: 'User entry',
  reference: 'Reference',
  derived: 'Derived',
}

export const SOURCE_KIND_DESCRIPTIONS: Record<SourceKind, string> = {
  user_entry: 'A person enters this value directly. Nothing feeds it.',
  reference: 'Populated from a single field on another record.',
  derived: 'Computed from an expression over other fields.',
}

/** Edge kinds in field_dependencies — mirrors the consuming field's source_kind. */
export const DEPENDENCY_KINDS = ['reference', 'derived'] as const
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number]

/**
 * How a derived field is computed. Metadata only — we never parse these.
 * Platform-agnostic, so the list is a hint for readers rather than a contract.
 */
export const DERIVATION_LANGUAGES = [
  'formula',
  'sql',
  'code',
  'workflow',
  'other',
] as const
export type DerivationLanguage = (typeof DERIVATION_LANGUAGES)[number]

export const DERIVATION_LANGUAGE_LABELS: Record<DerivationLanguage, string> = {
  formula: 'Formula',
  sql: 'SQL',
  code: 'Application code',
  workflow: 'Workflow / automation',
  other: 'Other',
}

export const CARDINALITIES = [
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
] as const
export type Cardinality = (typeof CARDINALITIES)[number]

export const CARDINALITY_LABELS: Record<Cardinality, string> = {
  one_to_one: '1:1',
  one_to_many: '1:N',
  many_to_one: 'N:1',
  many_to_many: 'N:N',
}

export const DELETE_BEHAVIORS = ['cascade', 'restrict', 'set_null', 'none'] as const
export type DeleteBehavior = (typeof DELETE_BEHAVIORS)[number]

export const USER_ROLES = ['admin', 'editor', 'viewer'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** Roles permitted to mutate the catalog. */
export const EDITOR_ROLES: readonly UserRole[] = ['admin', 'editor']

export const CHANGE_ACTIONS = ['create', 'update', 'delete', 'import'] as const
export type ChangeAction = (typeof CHANGE_ACTIONS)[number]

export const ENTITY_TYPES = [
  'module',
  'record',
  'field',
  'relationship',
  'data_type',
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

/**
 * Which of the three identities the UI is currently displaying.
 * The whole point of the tool: names and IDs are different things and both matter.
 */
export const IDENTITY_MODES = ['label', 'api', 'external'] as const
export type IdentityMode = (typeof IDENTITY_MODES)[number]

export const IDENTITY_MODE_LABELS: Record<IdentityMode, string> = {
  label: 'Display label',
  api: 'Technical name',
  external: 'Source ID',
}

export const DATA_TYPE_CATEGORIES = [
  'text',
  'numeric',
  'temporal',
  'boolean',
  'choice',
  'relationship',
  'complex',
  'other',
] as const
export type DataTypeCategory = (typeof DATA_TYPE_CATEGORIES)[number]

/**
 * Seeded on first run. Users can add more — we cannot know every system's types.
 *
 * The `supports*` flags are what make a user-extensible type catalog actually usable:
 * they drive which detail inputs the field form renders (a length box for text, a
 * precision/scale pair for decimals, an options list for picklists). Without them a
 * custom type is an inert label.
 */
export const BUILTIN_DATA_TYPES = [
  { key: 'text', label: 'Text', category: 'text', supportsLength: true },
  { key: 'long_text', label: 'Long text', category: 'text', supportsLength: true },
  { key: 'integer', label: 'Integer', category: 'numeric' },
  {
    key: 'decimal',
    label: 'Decimal',
    category: 'numeric',
    supportsPrecision: true,
    supportsScale: true,
  },
  {
    key: 'currency',
    label: 'Currency',
    category: 'numeric',
    supportsPrecision: true,
    supportsScale: true,
  },
  { key: 'boolean', label: 'Boolean', category: 'boolean' },
  { key: 'date', label: 'Date', category: 'temporal' },
  { key: 'datetime', label: 'Date & time', category: 'temporal' },
  { key: 'enum', label: 'Enum / picklist', category: 'choice', supportsOptions: true },
  {
    key: 'multi_enum',
    label: 'Multi-select picklist',
    category: 'choice',
    supportsOptions: true,
  },
  { key: 'reference', label: 'Reference / foreign key', category: 'relationship' },
  { key: 'email', label: 'Email', category: 'text' },
  { key: 'url', label: 'URL', category: 'text' },
  { key: 'json', label: 'JSON / structured', category: 'complex' },
  { key: 'binary', label: 'Binary / blob', category: 'complex' },
  { key: 'unknown', label: 'Unknown', category: 'other' },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  category: DataTypeCategory
  supportsLength?: boolean
  supportsPrecision?: boolean
  supportsScale?: boolean
  supportsOptions?: boolean
}>

/** Default hop limit for lineage traversal. Overridable per request. */
export const DEFAULT_LINEAGE_DEPTH = 10
export const MAX_LINEAGE_DEPTH = 50

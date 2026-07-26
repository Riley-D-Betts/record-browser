import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import {
  CARDINALITIES,
  CHANGE_ACTIONS,
  DEPENDENCY_KINDS,
  ENTITY_TYPES,
  ORIGINS,
  SOURCE_KINDS,
  USER_ROLES,
} from '../../shared/constants'

/**
 * Text UUID primary keys throughout.
 *
 * The catalog is exported to JSON and re-imported (round-tripping is a first-class
 * feature), so IDs must survive leaving the database. Autoincrement integers would be
 * reassigned on import and every edge would have to be rewritten.
 */
const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())

const createdAt = () =>
  text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())

const updatedAt = () =>
  text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
    .$onUpdateFn(() => new Date().toISOString())

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull().default('editor'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_unq').on(t.email)],
)

// ---------------------------------------------------------------------------
// Grouping — the primary lever against ERD complexity
// ---------------------------------------------------------------------------

export const modules = sqliteTable(
  'modules',
  {
    id: id(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Hex colour used to tint the module's nodes in the ERD. */
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('modules_key_unq').on(t.key)],
)

// ---------------------------------------------------------------------------
// Editable lists
// ---------------------------------------------------------------------------

/**
 * Members of the dropdowns that are lists rather than structure — derivation
 * languages, delete behaviours, field type categories. See shared/lists.ts for which
 * lists these are and why the others are not among them.
 *
 * One table rather than one per list: they have identical shape and identical
 * lifecycle, and three near-copies would mean three sets of routes to keep in step.
 *
 * Nothing points at these rows by id. A record stores the member's `key` — the same
 * string the columns held when the list was a TypeScript constant — so adopting this
 * table changed no existing data, and a list can be edited without rewriting anything
 * that chose from it.
 */
export const listItems = sqliteTable(
  'list_items',
  {
    id: id(),
    /** Which list this belongs to; one of shared/lists.ts' MANAGED_LISTS. */
    listKey: text('list_key').notNull(),
    /** The stored value. Immutable once created — see the note in shared/lists.ts. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description'),

    /** Seeded by the app. Cannot be deleted, only hidden. */
    isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),

    /**
     * Whether the member is still offered.
     *
     * Retiring a value must not rewrite the rows that already chose it — the history
     * of what used to be true is the point of a catalog. Hiding stops it being picked
     * from here on and leaves every existing row exactly as it was.
     */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('list_items_list_key_unq').on(t.listKey, t.key),
    index('list_items_list_idx').on(t.listKey),
  ],
)

// ---------------------------------------------------------------------------
// Type catalog — seeded, but user-extensible
// ---------------------------------------------------------------------------

export const dataTypes = sqliteTable(
  'data_types',
  {
    id: id(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    // Not a TS enum any more: the members live in `list_items` under
    // 'data_type_category' and a team may add its own. Drizzle's `enum` option only
    // ever narrowed the type — it emitted no constraint — so nothing about the stored
    // data changes by dropping it.
    category: text('category').notNull().default('other'),
    description: text('description'),
    /** Seeded types cannot be deleted, only supplemented. */
    isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),

    /**
     * Which detail inputs the field form should render for this type.
     *
     * These are what make a user-extensible type catalog more than an inert lookup
     * table: a user adding "geo_point" can say it takes precision, and the form
     * adapts without a code change.
     */
    supportsLength: integer('supports_length', { mode: 'boolean' })
      .notNull()
      .default(false),
    supportsPrecision: integer('supports_precision', { mode: 'boolean' })
      .notNull()
      .default(false),
    supportsScale: integer('supports_scale', { mode: 'boolean' })
      .notNull()
      .default(false),
    supportsOptions: integer('supports_options', { mode: 'boolean' })
      .notNull()
      .default(false),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('data_types_key_unq').on(t.key),
    index('data_types_category_idx').on(t.category),
  ],
)

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const records = sqliteTable(
  'records',
  {
    id: id(),
    moduleId: text('module_id').references(() => modules.id, {
      onDelete: 'set null',
    }),

    /** The three identities. All three are searchable; the UI displays one at a time. */
    apiName: text('api_name').notNull(),
    label: text('label').notNull(),
    externalId: text('external_id'),

    origin: text('origin', { enum: ORIGINS }).notNull().default('custom'),
    description: text('description'),

    /**
     * Retired records are hidden by default but never deleted — the history of what
     * used to exist is exactly what a catalog is for.
     */
    isDeprecated: integer('is_deprecated', { mode: 'boolean' })
      .notNull()
      .default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('records_api_name_unq').on(t.apiName),
    index('records_module_idx').on(t.moduleId),
    index('records_external_idx').on(t.externalId),
    index('records_origin_idx').on(t.origin),
  ],
)

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export const fields = sqliteTable(
  'fields',
  {
    id: id(),
    recordId: text('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),

    apiName: text('api_name').notNull(),
    label: text('label').notNull(),
    externalId: text('external_id'),

    dataTypeId: text('data_type_id').references(() => dataTypes.id, {
      onDelete: 'set null',
    }),
    /** Length, precision, enum members — shape varies by type, so JSON. */
    typeDetail: text('type_detail'),

    origin: text('origin', { enum: ORIGINS }).notNull().default('custom'),

    /**
     * Provenance. See the invariants enforced in server/services/fieldSource.ts:
     *   user_entry -> 0 dependency rows, sourceExpression null
     *   reference  -> exactly 1 dependency row, sourceExpression null
     *   derived    -> 0..N dependency rows, sourceExpression required
     */
    sourceKind: text('source_kind', { enum: SOURCE_KINDS })
      .notNull()
      .default('user_entry'),
    sourceExpression: text('source_expression'),
    /** How the expression is written. Metadata only — never parsed. Editable list. */
    derivationLanguage: text('derivation_language'),

    /**
     * Escape valve for a real gap in the three source kinds.
     *
     * A field populated by an integration, a batch job, or a nightly feed is not
     * typed by a human — but with only three kinds it gets coded `user_entry`, which
     * makes lineage report a human origin point that does not exist. Rather than add
     * a fourth kind, this flags such fields so traversal can mark them as external
     * origins and reports can list them. See the note in README.md.
     */
    isExternallyPopulated: integer('is_externally_populated', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** Free text: which integration, job, or feed writes this. */
    sourceNotes: text('source_notes'),

    isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(false),
    isUnique: integer('is_unique', { mode: 'boolean' }).notNull().default(false),
    isPrimaryKey: integer('is_primary_key', { mode: 'boolean' })
      .notNull()
      .default(false),
    isDeprecated: integer('is_deprecated', { mode: 'boolean' })
      .notNull()
      .default(false),

    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('fields_record_api_name_unq').on(t.recordId, t.apiName),
    index('fields_record_idx').on(t.recordId),
    index('fields_source_kind_idx').on(t.sourceKind),
    index('fields_data_type_idx').on(t.dataTypeId),
    index('fields_external_idx').on(t.externalId),
    // Belt and braces alongside the service-layer guard: a derived field must carry
    // an expression, and nothing else may. Catches any write that bypasses the
    // service — imports, migrations, someone at the sqlite3 prompt.
    check(
      'fields_derived_shape',
      sql`(${t.sourceKind} = 'derived' AND ${t.sourceExpression} IS NOT NULL)
          OR (${t.sourceKind} <> 'derived' AND ${t.sourceExpression} IS NULL)`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Provenance edges
// ---------------------------------------------------------------------------

/**
 * One edge table serves both `reference` and `derived` provenance.
 *
 * Splitting them would mean every lineage traversal and every report had to union two
 * relations for no analytical gain — the graph is the same graph either way. `kind`
 * preserves the semantic difference for rendering.
 */
export const fieldDependencies = sqliteTable(
  'field_dependencies',
  {
    id: id(),
    /** The downstream consumer — the field whose value depends on something else. */
    fieldId: text('field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'cascade' }),
    /**
     * The upstream producer.
     *
     * `restrict`, not `cascade`: deleting a field that feeds others must fail loudly
     * with the list of dependents rather than silently orphaning them. Silent breakage
     * is the exact failure mode this tool exists to prevent.
     */
    sourceFieldId: text('source_field_id')
      .notNull()
      .references(() => fields.id, { onDelete: 'restrict' }),

    kind: text('kind', { enum: DEPENDENCY_KINDS }).notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('field_deps_unq').on(t.fieldId, t.sourceFieldId),
    index('field_deps_field_idx').on(t.fieldId),
    // Required for downstream ("what breaks if I change this?") traversal.
    index('field_deps_source_idx').on(t.sourceFieldId),
  ],
)

// ---------------------------------------------------------------------------
// Record relationships
// ---------------------------------------------------------------------------

export const relationships = sqliteTable(
  'relationships',
  {
    id: id(),
    parentRecordId: text('parent_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    childRecordId: text('child_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    /** The field on the child that implements the link, when one is known. */
    viaFieldId: text('via_field_id').references(() => fields.id, {
      onDelete: 'set null',
    }),

    cardinality: text('cardinality', { enum: CARDINALITIES })
      .notNull()
      .default('one_to_many'),
    /** Child cannot exist without its parent. */
    isIdentifying: integer('is_identifying', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** What the source system does to children. Descriptive only; editable list. */
    onDelete: text('on_delete').notNull().default('none'),

    label: text('label'),
    description: text('description'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('relationships_unq').on(t.parentRecordId, t.childRecordId, t.viaFieldId),
    index('relationships_parent_idx').on(t.parentRecordId),
    index('relationships_child_idx').on(t.childRecordId),
  ],
)

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export const changeLog = sqliteTable(
  'change_log',
  {
    id: id(),
    entityType: text('entity_type', { enum: ENTITY_TYPES }).notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action', { enum: CHANGE_ACTIONS }).notNull(),

    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    /** Names of the columns that actually changed, so the UI can show a tight diff. */
    changedFieldsJson: text('changed_fields_json'),

    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Groups every row written by a single import, making it reviewable as a unit. */
    batchId: text('batch_id'),

    createdAt: createdAt(),
  },
  (t) => [
    index('change_log_entity_idx').on(t.entityType, t.entityId),
    index('change_log_created_idx').on(t.createdAt),
    index('change_log_batch_idx').on(t.batchId),
  ],
)

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Module = typeof modules.$inferSelect
export type NewModule = typeof modules.$inferInsert
export type ListItem = typeof listItems.$inferSelect
export type NewListItem = typeof listItems.$inferInsert
export type DataType = typeof dataTypes.$inferSelect
export type NewDataType = typeof dataTypes.$inferInsert
export type RecordRow = typeof records.$inferSelect
export type NewRecordRow = typeof records.$inferInsert
export type Field = typeof fields.$inferSelect
export type NewField = typeof fields.$inferInsert
export type FieldDependency = typeof fieldDependencies.$inferSelect
export type NewFieldDependency = typeof fieldDependencies.$inferInsert
export type Relationship = typeof relationships.$inferSelect
export type NewRelationship = typeof relationships.$inferInsert
export type ChangeLogRow = typeof changeLog.$inferSelect

export const schema = {
  users,
  modules,
  listItems,
  dataTypes,
  records,
  fields,
  fieldDependencies,
  relationships,
  changeLog,
}

/** Kept for callers that want to reference the raw SQL helper. */
export { sql }

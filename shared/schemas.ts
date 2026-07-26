import { z } from 'zod'
import {
  CARDINALITIES,
  DATA_TYPE_CATEGORIES,
  DELETE_BEHAVIORS,
  DEPENDENCY_KINDS,
  DERIVATION_LANGUAGES,
  MAX_LINEAGE_DEPTH,
  ORIGINS,
  SOURCE_KINDS,
  USER_ROLES,
} from './constants'

/**
 * Validation contracts shared by Nitro handlers and Vue forms.
 *
 * Nuxt 4's `shared/` directory is auto-imported on both sides, so there is exactly one
 * definition of what a valid record is — the form and the endpoint cannot drift.
 */

/** IDs are permissive: imported catalogs bring their own, and they are not all UUIDs. */
const idSchema = z.string().min(1).max(128)

/**
 * Technical names get a deliberately tight grammar. This is the identifier that gets
 * typed into code, so spaces and punctuation are a correctness problem, not a style one.
 */
export const apiNameSchema = z
  .string({ error: 'Technical name is required' })
  .min(1, 'Technical name is required')
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_.]*$/,
    'Must start with a letter or underscore and contain only letters, digits, underscores or dots',
  )

const labelSchema = z
  .string({ error: 'Display label is required' })
  .min(1, 'Display label is required')
  .max(256)
const externalIdSchema = z.string().max(256).nullish()
const descriptionSchema = z.string().max(4000).nullish()

const originSchema = z.enum(ORIGINS)

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export const moduleInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, digits and hyphens only'),
  name: z.string().min(1).max(128),
  description: descriptionSchema,
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #3b82f6')
    .nullish(),
  sortOrder: z.number().int().default(0),
})
export type ModuleInput = z.infer<typeof moduleInputSchema>

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export const dataTypeInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'Lowercase letters, digits and underscores only'),
  label: z.string().min(1).max(128),
  category: z.enum(DATA_TYPE_CATEGORIES).default('other'),
  description: descriptionSchema,
  /** Drive which detail inputs the field form renders for this type. */
  supportsLength: z.boolean().default(false),
  supportsPrecision: z.boolean().default(false),
  supportsScale: z.boolean().default(false),
  supportsOptions: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
})
export type DataTypeInput = z.infer<typeof dataTypeInputSchema>

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const recordInputSchema = z.object({
  moduleId: idSchema.nullish(),
  apiName: apiNameSchema,
  label: labelSchema,
  externalId: externalIdSchema,
  origin: originSchema.default('custom'),
  description: descriptionSchema,
  isDeprecated: z.boolean().default(false),
})
export type RecordInput = z.infer<typeof recordInputSchema>

export const recordPatchSchema = recordInputSchema.partial()

export const recordQuerySchema = z.object({
  q: z.string().max(256).optional(),
  moduleId: z.string().optional(),
  origin: originSchema.optional(),
  includeDeprecated: z.coerce.boolean().default(false),
  sort: z.enum(['apiName', 'label', 'updatedAt', 'fieldCount']).default('label'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
})
export type RecordQuery = z.infer<typeof recordQuerySchema>

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * A field's provenance, modelled as a discriminated union so an impossible state is
 * unrepresentable at the edge of the system rather than caught by a later report.
 *
 * The database stores these flat (source_kind + source_expression + dependency rows);
 * this union is what the API accepts, and server/services/fieldSource.ts is what
 * translates between the two.
 */
export const fieldSourceSchema = z.discriminatedUnion('sourceKind', [
  z.object({
    sourceKind: z.literal('user_entry'),
    /**
     * Set when an integration, batch job, or feed writes the value rather than a
     * person. Keeps lineage honest without inventing a fourth source kind.
     */
    isExternallyPopulated: z.boolean().default(false),
    sourceNotes: z.string().max(1000).nullish(),
  }),
  z.object({
    sourceKind: z.literal('reference'),
    /** Exactly one upstream field. */
    sourceFieldId: z
      .string({ error: 'Choose the field this one is populated from' })
      .min(1, 'Choose the field this one is populated from')
      .max(128),
    sourceNotes: z.string().max(1000).nullish(),
  }),
  z.object({
    sourceKind: z.literal('derived'),
    // The message is on the type as well as the length check: a *missing* key fails
    // the type check first, and zod's default ("expected string, received undefined")
    // is not something to show a person.
    sourceExpression: z
      .string({ error: 'A derived field needs an expression describing how it is computed' })
      .min(1, 'A derived field needs an expression describing how it is computed')
      .max(4000),
    derivationLanguage: z.enum(DERIVATION_LANGUAGES).nullish(),
    /** Recorded explicitly — we cannot parse every system's expression grammar. */
    dependsOn: z.array(idSchema).default([]),
    sourceNotes: z.string().max(1000).nullish(),
  }),
])
export type FieldSourceInput = z.infer<typeof fieldSourceSchema>

export const fieldInputSchema = z.object({
  recordId: idSchema,
  apiName: apiNameSchema,
  label: labelSchema,
  externalId: externalIdSchema,
  dataTypeId: idSchema.nullish(),
  typeDetail: z.record(z.string(), z.unknown()).nullish(),
  origin: originSchema.default('custom'),
  // Spelled out rather than `{ sourceKind: 'user_entry' }`: zod applies a default as
  // the parsed *output*, so it never picks up the branch's own inner defaults.
  source: fieldSourceSchema.default({
    sourceKind: 'user_entry',
    isExternallyPopulated: false,
  }),
  isRequired: z.boolean().default(false),
  isUnique: z.boolean().default(false),
  isPrimaryKey: z.boolean().default(false),
  isDeprecated: z.boolean().default(false),
  description: descriptionSchema,
  sortOrder: z.number().int().default(0),
})
export type FieldInput = z.infer<typeof fieldInputSchema>

export const fieldPatchSchema = fieldInputSchema.partial().omit({ recordId: true })

export const fieldQuerySchema = z.object({
  q: z.string().max(256).optional(),
  recordId: z.string().optional(),
  moduleId: z.string().optional(),
  origin: originSchema.optional(),
  sourceKind: z.enum(SOURCE_KINDS).optional(),
  dataTypeId: z.string().optional(),
  includeDeprecated: z.coerce.boolean().default(false),
  sort: z.enum(['apiName', 'label', 'updatedAt']).default('apiName'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
})
export type FieldQuery = z.infer<typeof fieldQuerySchema>

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export const relationshipInputSchema = z
  .object({
    parentRecordId: idSchema,
    childRecordId: idSchema,
    viaFieldId: idSchema.nullish(),
    cardinality: z.enum(CARDINALITIES).default('one_to_many'),
    isIdentifying: z.boolean().default(false),
    onDelete: z.enum(DELETE_BEHAVIORS).default('none'),
    label: z.string().max(256).nullish(),
    description: descriptionSchema,
  })
  .refine((v) => v.parentRecordId !== v.childRecordId || v.viaFieldId != null, {
    // Self-relationships are legitimate (a tree), but only when the linking field is
    // named — otherwise it is indistinguishable from a data-entry mistake.
    message: 'A self-relationship must name the field that links parent to child',
    path: ['viaFieldId'],
  })
export type RelationshipInput = z.infer<typeof relationshipInputSchema>

export const relationshipPatchSchema = z.object({
  parentRecordId: idSchema.optional(),
  childRecordId: idSchema.optional(),
  viaFieldId: idSchema.nullish(),
  cardinality: z.enum(CARDINALITIES).optional(),
  isIdentifying: z.boolean().optional(),
  onDelete: z.enum(DELETE_BEHAVIORS).optional(),
  label: z.string().max(256).nullish(),
  description: descriptionSchema,
})

// ---------------------------------------------------------------------------
// Dependencies (used directly by the import pipeline)
// ---------------------------------------------------------------------------

export const dependencyInputSchema = z.object({
  fieldId: idSchema,
  sourceFieldId: idSchema,
  kind: z.enum(DEPENDENCY_KINDS),
  note: z.string().max(1000).nullish(),
})

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export const lineageQuerySchema = z.object({
  direction: z.enum(['up', 'down', 'both']).default('both'),
  depth: z.coerce.number().int().min(1).max(MAX_LINEAGE_DEPTH).default(10),
})

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export const graphQuerySchema = z.object({
  moduleIds: z.string().optional(),
  origin: originSchema.optional(),
  includeDeprecated: z.coerce.boolean().default(false),
  /** Collapse each module to a single node — the escape hatch for large schemas. */
  collapseModules: z.coerce.boolean().default(false),
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

export const userInputSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(128),
  password: z.string().min(10, 'Use at least 10 characters'),
  role: z.enum(USER_ROLES).default('editor'),
})
